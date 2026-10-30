"use strict";
// Deposits, withdrawals and pack purchases. All money rules live here. The ONLY real blockchain operations are SOL deposits and SOL withdrawals.
//  * The player's wallet is the ONLY address that can ever receive a withdrawal (never taken from the request).
//  * A deposit is credited only after the server re-reads the confirmed transaction from the RPC node.
//  * Every blockchain signature can be used once, ever (recorded atomically together with the credit).
//  * Withdrawals are deducted + stored durably BEFORE anything is signed; the signed transaction (and so its signature)
//    is stored BEFORE it is broadcast, so a crash can never lead to paying twice or losing the balance.
//  * Solvency: the treasury ledger (assets = deposits - withdrawals) must always cover every player's SOL balance (see game.solvency()).
//    A withdrawal is refused (503) when the treasury - ledger or the real on-chain wallet - cannot cover it.
const crypto = require("crypto");
const S = require("../js/shared.js");
const { SOL, PACKS, C, PRICES } = require("./config.js");

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const DAY = 864e5;

function createBank(game, chain) {
  const { db, bad } = game;
  const busy = new Set(), inflight = new Set();

  async function locked(p, fn) {
    if (busy.has(p.id)) bad("Another bank request is still running — try again in a moment", 429);
    busy.add(p.id);
    try { return await fn(); } finally { busy.delete(p.id); }
  }
  const needWallet = (p) => { if (!p.wallet) bad("Connect a Solana wallet first"); };
  const needChain = () => { if (!chain.enabled) bad("SOL deposits/withdrawals are not set up on this server yet", 503); };
  const lamports = (x) => { // validate a user-supplied amount: whole lamports only (never floats)
    const b = S.toBig(x);
    if (b === null || b <= 0n || b > BigInt(Number.MAX_SAFE_INTEGER)) bad("Enter a valid amount");
    return Number(b);
  };
  const solText = (l) => (l / 1e9).toFixed(l % 1e7 === 0 ? 2 : 4).replace(/0+$/, "").replace(/\.$/, "");

  // ---- public numbers the client needs ------------------------------------------------------------
  function publicConfig() {
    return {
      cluster: SOL.cluster, treasury: chain.treasury || "", enabled: !!chain.enabled, mineDiscount: SOL.mineDiscount,
      minDeposit: SOL.minDepositLamports, maxDeposit: SOL.maxDepositLamports, minWithdraw: SOL.minWithdrawLamports, maxWithdraw: SOL.maxWithdrawLamports,
      withdrawFee: SOL.withdrawFeeBps / 10000, withdrawCooldownMs: SOL.withdrawCooldownMs,
      freeCap: C.FREE_EARN_CAP, devFaucet: C.DEV_FAUCET, devMine: C.DEV_MINE_AMOUNT, prices: PRICES, tradeFeeBps: C.TRADE_FEE_BPS,
      packs: PACKS.map((p) => ({ id: p.id, name: p.name, mine: game.packMinePrice(p), lamports: p.lamports, sol: p.lamports / 1e9, blurb: p.blurb, cash: p.cash, xp: p.xp, crates: p.crates, gear: p.gearRarity, pieces: p.slots.length, slots: p.slots })),
    };
  }
  function bankView(p) {
    const t = game.now();
    const withdrawals = Object.values(db.withdrawals).filter((w) => w.pid === p.id).sort((a, b) => b.created - a.created).slice(0, 15)
      .map((w) => ({ id: w.id, unit: w.unit === "lamports" ? "sol" : "afkmine", amount: w.amount, fee: w.fee, net: w.net == null ? w.amount : w.net, state: w.state, status: w.unit === "lamports" ? statusOf(w) : w.state, reason: w.reason || null, sig: w.sig || null, created: w.created, error: w.state === "failed" ? "The transfer failed — an admin will retry it or refund you" : null }));
    const lockedAmount = Object.values(db.withdrawals).filter((w) => w.pid === p.id && w.unit === "lamports" && (w.state === "pending" || w.state === "failed")).reduce((a, w) => a + w.amount, 0);
    return {
      wallet: p.wallet, balance: p.balance, solBalance: p.solBalance, lockedSol: lockedAmount, canWithdraw: !!p.wallet && game.isPaid(p),
      cooldownLeft: Math.max(0, (p.lastWithdrawAt || 0) + SOL.withdrawCooldownMs - t),
      deposits: p.history.filter((h) => h.type === "deposit" && h.lamports).slice(0, 15), withdrawals,
    };
  }

  // ---- deposits (SOL) ------------------------------------------------------------------------------------------
  async function prepareDeposit(p, amount) {
    needChain(); needWallet(p);
    const lam = lamports(amount);
    if (lam < SOL.minDepositLamports) bad("Minimum deposit is " + solText(SOL.minDepositLamports) + " SOL");
    if (lam > SOL.maxDepositLamports) bad("Maximum deposit is " + solText(SOL.maxDepositLamports) + " SOL");
    const have = await chain.walletBalance(p.wallet);
    if (have < BigInt(lam) + 10000n) bad("Your wallet only holds " + solText(Number(have)) + " SOL on " + SOL.cluster);
    return { tx: await chain.buildDepositTx(p.wallet, lam), lamports: lam, treasury: chain.treasury };
  }
  function confirmDeposit(p, signature) {
    return locked(p, async () => {
      needChain(); needWallet(p);
      const sig = String(signature || "");
      if (!SIG_RE.test(sig)) bad("That is not a transaction signature");
      if (inflight.has(sig) || (await db_hasSig(sig))) bad("This transaction was already credited");
      inflight.add(sig);
      try {
        const r = await chain.verifyDeposit(sig, p.wallet);
        if (r.status === "pending") return { status: "pending" };
        if (r.status === "error") bad(r.error);
        const credit = Number(r.lamports);
        if (!Number.isSafeInteger(credit) || credit <= 0) bad("Invalid deposit amount");
        game.creditDeposit(p, credit, sig);   // SOL balance + treasury ledger (+ quest progress: tradeStats.depositedLamports)
        game.addHistory(p, { type: "deposit", lamports: credit, sig });
        const ok = await game.saveNow([p], { sig, info: { pid: p.id, kind: "deposit", lamports: credit, at: Date.now() } });
        if (!ok) { game.undoDeposit(p, credit); p.history.shift(); bad("This transaction was already credited"); }
        return { status: "ok", credited: credit };
      } finally { inflight.delete(sig); }
    });
  }
  const db_hasSig = (sig) => game.store.hasSig(sig);

  // ---- withdrawals (SOL) -------------------------------------------------------------------------------------------
  // The player asks for `gross` lamports to leave the SOL balance. SOL.withdrawFeeBps (20 %) of it stays with the game,
  // the rest is sent to the player's own wallet. Min/max per request in config, one request per 24 h.
  // A withdrawal request only LOCKS the money and creates a record (state "pending"). Nothing is sent until the admin approves it.
  // States: pending -> (approve) queued -> signed -> sent -> done | (reject) rejected | send failed -> failed (funds stay locked until retry or refund)
  function requestWithdraw(p, amount) {
    return locked(p, async () => {
      needChain(); needWallet(p);
      if (!game.isPaid(p)) bad("Buy a pack to unlock withdrawals");
      const gross = lamports(amount), t = game.now();
      if (gross < SOL.minWithdrawLamports) bad("Minimum withdrawal is " + solText(SOL.minWithdrawLamports) + " SOL");
      if (gross > SOL.maxWithdrawLamports) bad("Maximum per withdrawal is " + solText(SOL.maxWithdrawLamports) + " SOL");
      if (Object.values(db.withdrawals).some((w) => w.pid === p.id && w.unit === "lamports" && (w.state === "pending" || w.state === "failed"))) bad("You already have a withdrawal waiting for approval");
      const left = (p.lastWithdrawAt || 0) + SOL.withdrawCooldownMs - t;
      if (left > 0) bad("Withdrawals have a 24 hour cooldown — next one in " + Math.floor(left / 3600e3) + "h " + String(Math.ceil((left % 3600e3) / 60e3)).padStart(2, "0") + "m", 429);
      game.touchPlayer(p);
      if (p.solBalance < gross) bad("Not enough SOL in your balance");
      const fee = Math.ceil((gross * SOL.withdrawFeeBps) / 10000), net = gross - fee;     // fee rounded up: rounding favours the house
      if (net < 1) bad("Amount is too small");
      // --- everything below is synchronous: no other request can interleave ---
      const prevAt = p.lastWithdrawAt || 0;
      p.lastWithdrawAt = t;
      const w = { id: crypto.randomBytes(8).toString("hex"), pid: p.id, wallet: p.wallet, unit: "lamports", amount: gross, fee, net, base: String(net), state: "pending", created: t, prevAt, tries: 0 };
      db.withdrawals[w.id] = w;
      game.lockWithdraw(p, w);
      game.touch(p); game.touchMeta();
      await game.saveNow([p]);
      return { withdrawalId: w.id, amount: gross, fee, net, state: w.state, status: statusOf(w) };
    });
  }
  const statusOf = (w) => ({ pending: "pending", queued: "approved", signed: "approved", sent: "sent", done: "sent", rejected: "rejected", failed: "failed" }[w.state] || w.state);
  const getW = (id) => { const w = db.withdrawals[String(id)]; if (!w || w.unit !== "lamports") bad("Unknown withdrawal", 404); return w; };
  const audit = (admin, action, w, extra) => game.audit && game.audit(admin, action, { withdrawal: w.id, player: w.pid, amount: w.amount, ...extra });
  const giveBackCooldown = (w) => { const p = db.players[w.pid]; if (p && p.lastWithdrawAt === w.created) { p.lastWithdrawAt = w.prevAt || 0; game.touch(p); } };

  // ---- admin decisions (called by the admin routes; the HTTP layer authenticates, rate limits and audits) ----
  // approve: compare-and-set on the state, entirely synchronous after the on-chain balance check => approving twice can never send twice
  async function adminApprove(id, admin) {
    const w0 = getW(id);
    if (w0.state !== "pending") bad("This withdrawal is already " + statusOf(w0), 409);
    needChain();
    const onchain = await chain.treasuryBalance();      // the real wallet must hold this, every transfer in flight, and a fee reserve
    const w = getW(id);
    if (w.state !== "pending") bad("This withdrawal is already " + statusOf(w), 409);     // re-check after the await
    const inFlight = Object.values(db.withdrawals).filter((x) => x.unit === "lamports" && (x.state === "queued" || x.state === "signed" || x.state === "sent")).reduce((a, x) => a + x.net, 0);
    if (onchain < BigInt(w.net + inFlight + C.TREASURY_RESERVE_LAMPORTS)) bad("The treasury wallet does not hold enough SOL to send this", 503);
    w.state = "queued"; w.approvedAt = game.now(); w.approvedBy = String(admin || "admin").slice(0, 40); w.tries = 0; w.error = null;
    game.bookWithdraw(w);
    audit(admin, "withdrawal.approve", w);
    await game.saveNow([db.players[w.pid]].filter(Boolean));
    kick();
    return { id: w.id, status: statusOf(w) };
  }
  async function adminReject(id, reason, admin) {
    const w = getW(id), why = String(reason || "").trim().slice(0, 200);
    if (!why) bad("A reason is required");
    if (w.state !== "pending") bad("This withdrawal is already " + statusOf(w), 409);
    w.state = "rejected"; w.reason = why; w.rejectedAt = game.now(); w.rejectedBy = String(admin || "admin").slice(0, 40);
    game.releaseWithdraw(w, "Rejected: " + why); giveBackCooldown(w);
    audit(admin, "withdrawal.reject", w, { reason: why });
    await game.saveNow([db.players[w.pid]].filter(Boolean));
    return { id: w.id, status: statusOf(w) };
  }
  // a failed send (never reached the chain, failed on-chain, or the blockhash expired => provably not paid): admin picks retry or refund
  async function adminRetry(id, admin) {
    const w = getW(id);
    if (w.state !== "failed") bad("Only a failed withdrawal can be retried", 409);
    w.state = "queued"; w.tries = 0; w.error = null; w.retriedAt = game.now(); delete w.sig; delete w.raw; delete w.lastValid;
    game.bookWithdraw(w);
    audit(admin, "withdrawal.retry", w);
    await game.saveNow([db.players[w.pid]].filter(Boolean));
    kick();
    return { id: w.id, status: statusOf(w) };
  }
  async function adminRefund(id, reason, admin) {
    const w = getW(id), why = String(reason || "Refunded after a failed send").trim().slice(0, 200);
    if (w.state !== "failed") bad("Only a failed withdrawal can be refunded", 409);
    w.state = "rejected"; w.reason = why; w.rejectedAt = game.now(); w.rejectedBy = String(admin || "admin").slice(0, 40);
    game.releaseWithdraw(w, why); giveBackCooldown(w);
    audit(admin, "withdrawal.refund", w, { reason: why });
    await game.saveNow([db.players[w.pid]].filter(Boolean));
    return { id: w.id, status: statusOf(w) };
  }

  // old token withdrawals only (auto refund as $AFKMINE)
  function refund(w, reason) {
    if (w.state === "done" || w.state === "failed") return;
    w.state = "failed"; w.error = String(reason).slice(0, 200);
    game.refundWithdraw(w, reason);
    const p = db.players[w.pid];
    if (p) {
      if (p.lastWithdrawAt === w.created) p.lastWithdrawAt = w.prevAt || 0;
      game.touch(p);
    }
    game.touchMeta();
  }
  // a SOL transfer that did not go through: the ledger outflow is reversed, the funds stay LOCKED, the admin chooses retry or refund
  function failSend(w, reason) {
    if (w.state === "failed" || w.state === "done") return;
    w.state = "failed"; w.error = String(reason).slice(0, 200); w.failedAt = game.now();
    game.unbookWithdraw(w);
    game.audit && game.audit("system", "withdrawal.failed", { withdrawal: w.id, player: w.pid, reason: w.error });
    game.touchMeta();
  }
  const dropSend = (w, reason) => (w.unit === "lamports" && !w.legacy ? failSend(w, reason) : refund(w, reason));
  let run = null, again = false;
  async function step(w) {
    if (w.state === "queued") {
      if (w.legacy) { refund(w, "Token withdrawals were discontinued — refunded as $AFKMINE"); await game.saveNow(db.players[w.pid] ? [db.players[w.pid]] : []); return; }
      if (!chain.signWithdrawal) return;
      try {
        const s = await chain.signWithdrawal(w.wallet, BigInt(w.base));
        Object.assign(w, { sig: s.sig, raw: s.raw, lastValid: s.lastValid, state: "signed", signedAt: game.now() });
        game.touchMeta(); await game.saveNow([]);     // signature stored durably BEFORE broadcast
      } catch (e) {
        w.tries = (w.tries || 0) + 1; w.error = String(e.message).slice(0, 200);
        if (w.tries >= 6) { dropSend(w, "Could not prepare the transfer: " + w.error); await game.saveNow(db.players[w.pid] ? [db.players[w.pid]] : []); }
        return;
      }
    }
    if (w.state === "signed" || w.state === "sent") {
      const st = await chain.withdrawalStatus(w.sig, w.lastValid);
      if (st === "confirmed") { w.state = "done"; w.doneAt = game.now(); delete w.raw; game.touchMeta(); await game.saveNow([]); return; }
      if (st === "failed") { dropSend(w, "The transaction failed on-chain"); await game.saveNow([db.players[w.pid]].filter(Boolean)); return; }
      if (st === "expired") { dropSend(w, "The transaction expired before it was confirmed"); await game.saveNow([db.players[w.pid]].filter(Boolean)); return; }
      // still pending: (re)broadcast the very same signed transaction (idempotent)
      if (w.state === "signed" || game.now() - (w.sentAt || 0) > 20e3) {
        try { await chain.broadcast(w.raw); w.state = "sent"; w.sentAt = game.now(); w.error = null; }
        catch (e) { w.error = String(e.message).slice(0, 200); w.sentAt = game.now(); }
        game.touchMeta();
      }
    }
  }
  function processWithdrawals() {
    if (!chain.withdrawalStatus) return Promise.resolve();
    if (run) { again = true; return run; }      // a run is active: ask it to loop once more and wait for it
    run = (async () => {
      await null; // let `run` be assigned before the body can finish (otherwise an empty run would leave it set forever)
      try {
        do {
          again = false;
          for (const w of Object.values(db.withdrawals)) {
            if (w.state === "queued" || w.state === "signed" || w.state === "sent") {
              try { await step(w); } catch (e) { console.error("withdrawal step failed", w.id, e.message); }
            }
          }
        } while (again);
      } finally { run = null; }
      const t = game.now(); // forget finished withdrawals after 90 days
      for (const [id, w] of Object.entries(db.withdrawals)) if ((w.state === "done" || w.state === "failed") && t - w.created > 90 * DAY) { delete db.withdrawals[id]; game.touchMeta(); }
    })();
    return run;
  }
  const kick = () => { setImmediate(() => processWithdrawals().catch((e) => console.error(e))); };

  // ---- packs ---------------------------------------------------------------------------------------------------------
  const packOf = (id) => PACKS.find((x) => x.id === id) || bad("Unknown pack");
  // paid in $AFKMINE at the pool's current price (10 % cheaper than SOL). The tokens are burned/recycled, 25 % of them go to the referrer.
  function buyPackWithMine(p, packId, maxMine) {
    return locked(p, async () => {
      needWallet(p);
      const pack = packOf(packId);
      if (p.packs[pack.id]) bad("You already own this pack");
      game.touchPlayer(p);
      const price = game.packMinePrice(pack);
      if (maxMine != null && !(price <= Number(maxMine))) bad("The price changed — check the new price and try again", 409);
      game.debitMine(p, price);
      const ref = game.grantPack(p, pack, "mine", price);   // returns the referrer who got their 25 % (saved in the same write)
      await game.saveNow([p, ref].filter(Boolean));
      return { pack: pack.id, paid: price };
    });
  }
  // paid from the SOL balance: the SOL becomes pack revenue; the referrer's 25 % is paid out of that revenue
  function buyPackWithSol(p, packId) {
    return locked(p, async () => {
      needWallet(p);
      const pack = packOf(packId);
      if (p.packs[pack.id]) bad("You already own this pack");
      game.touchPlayer(p);
      game.spendSol(p, pack.lamports, pack.id);
      const ref = game.grantPack(p, pack, "sol");
      await game.saveNow([p, ref].filter(Boolean));
      return { pack: pack.id, paid: pack.lamports };
    });
  }
  // LEGACY: confirm a pack order that was created (and maybe already paid to the merchant wallet) before packs moved to the SOL balance.
  // New orders cannot be created any more. No referral is paid for these (that money never reached the treasury).
  function confirmPackOrder(p, orderId, signature) {
    return locked(p, async () => {
      needWallet(p);
      const o = db.orders[String(orderId)];
      if (!o || o.pid !== p.id) bad("Unknown order");
      const pack = packOf(o.pack);
      if (o.done || p.packs[pack.id]) bad("You already own this pack");
      if (!chain.verifyPayment) bad("Pack orders are not available on this server", 503);
      const sig = String(signature || "");
      if (!SIG_RE.test(sig)) bad("That is not a transaction signature");
      if (inflight.has(sig) || (await db_hasSig(sig))) bad("This transaction was already used");
      inflight.add(sig);
      try {
        const r = await chain.verifyPayment(sig, p.wallet, o.lamports, o.memo);
        if (r.status === "pending") return { status: "pending" };
        if (r.status === "error") bad(r.error);
        o.done = true; o.sig = sig; db.treasury.legacyPacks += o.lamports;
        const ref = game.grantPack(p, pack, "legacy");
        game.touchMeta();
        const ok = await game.saveNow([p, ref].filter(Boolean), { sig, info: { pid: p.id, kind: "pack", pack: pack.id, order: o.id, at: Date.now() } });
        if (!ok) console.error("signature was already claimed while granting", sig);
        return { status: "ok", pack: pack.id };
      } finally { inflight.delete(sig); }
    });
  }

  return { publicConfig, bankView, prepareDeposit, confirmDeposit, requestWithdraw, adminApprove, adminReject, adminRetry, adminRefund, statusOf, buyPackWithMine, buyPackWithSol, confirmPackOrder, processWithdrawals, kick };
}

module.exports = { createBank };
