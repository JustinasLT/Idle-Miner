"use strict";
// Deposits, withdrawals and pack purchases. All money rules live here.
//  * The player's wallet is the ONLY address that can ever receive a withdrawal (never taken from the request).
//  * A deposit / SOL payment is credited only after the server re-reads the confirmed transaction from the RPC node.
//  * Every blockchain signature can be used once, ever (recorded atomically together with the credit).
//  * Withdrawals are deducted + stored durably BEFORE anything is signed; the signed transaction (and so its signature)
//    is stored BEFORE it is broadcast, so a crash can never lead to paying twice or losing the balance.
const crypto = require("crypto");
const { SOL, PACKS, C } = require("./config.js");

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const DAY = 864e5;

function createBank(game, chain) {
  const { db, bad } = game;
  const busy = new Set(), inflight = new Set();
  const dec = SOL.decimals, unit = 10 ** dec;

  async function locked(p, fn) {
    if (busy.has(p.id)) bad("Another bank request is still running — try again in a moment", 429);
    busy.add(p.id);
    try { return await fn(); } finally { busy.delete(p.id); }
  }
  const needWallet = (p) => { if (!p.wallet) bad("Connect a Solana wallet first"); };
  const needToken = () => { if (!chain.tokenEnabled) bad("$MINE deposits/withdrawals are not set up on this server yet", 503); };
  const tokens = (x) => { // validate a user-supplied token amount -> whole base units
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0) bad("Enter an amount");
    const base = Math.floor(n * unit + 1e-6);
    if (base < 1) bad("Amount is too small");
    return base;
  };

  // ---- public numbers the client needs ------------------------------------------------------------
  function publicConfig() {
    return {
      cluster: SOL.cluster, decimals: dec, mint: chain.mint || SOL.mint || "", treasury: chain.treasury || "", merchant: chain.merchant || "",
      tokenEnabled: !!chain.tokenEnabled, payEnabled: !!chain.payEnabled, mineDiscount: SOL.mineDiscount,
      minDeposit: SOL.minDeposit, minWithdraw: SOL.minWithdraw, maxWithdrawDay: SOL.maxWithdrawDay,
      freeCap: C.FREE_EARN_CAP,
      packs: PACKS.map((p) => ({ id: p.id, name: p.name, mine: p.mine, lamports: p.lamports, sol: p.lamports / 1e9, blurb: p.blurb, cash: p.cash, xp: p.xp, crates: p.crates, gear: p.gearRarity })),
    };
  }
  function bankView(p) {
    const t = game.now();
    const withdrawals = Object.values(db.withdrawals).filter((w) => w.pid === p.id).sort((a, b) => b.created - a.created).slice(0, 15)
      .map((w) => ({ id: w.id, amount: w.amount, state: w.state, sig: w.sig || null, created: w.created, error: w.error || null }));
    const used = p.withdrawLog.filter((x) => t - x.t < DAY).reduce((s, x) => s + x.amount, 0);
    return {
      wallet: p.wallet, balance: p.balance, canWithdraw: !!p.wallet && game.isPaid(p),
      withdrawnToday: used, withdrawLeft: Math.max(0, SOL.maxWithdrawDay - used),
      deposits: p.history.filter((h) => h.type === "deposit").slice(0, 15), withdrawals,
    };
  }

  // ---- deposits ------------------------------------------------------------------------------------------
  async function prepareDeposit(p, amount) {
    needToken(); needWallet(p);
    const base = tokens(amount);
    if (base < SOL.minDeposit * unit) bad("Minimum deposit is " + SOL.minDeposit + " $MINE");
    if (base > SOL.maxDeposit * unit) bad("Amount is too large");
    const have = await chain.userBalance(p.wallet);
    if (have < BigInt(base)) bad("Your wallet only holds " + chain.fromBase(have) + " $MINE on " + SOL.cluster);
    return { tx: await chain.buildDepositTx(p.wallet, BigInt(base)), amount: base / unit };
  }
  function confirmDeposit(p, signature) {
    return locked(p, async () => {
      needToken(); needWallet(p);
      const sig = String(signature || "");
      if (!SIG_RE.test(sig)) bad("That is not a transaction signature");
      if (inflight.has(sig) || (await db_hasSig(sig))) bad("This transaction was already credited");
      inflight.add(sig);
      try {
        const r = await chain.verifyDeposit(sig, p.wallet);
        if (r.status === "pending") return { status: "pending" };
        if (r.status === "error") bad(r.error);
        const credit = chain.fromBase(r.baseUnits);
        p.balance += credit;
        game.addHistory(p, { type: "deposit", amount: credit, sig });
        game.touch(p);
        const ok = await game.saveNow([p], { sig, info: { pid: p.id, kind: "deposit", amount: credit, at: Date.now() } });
        if (!ok) { p.balance -= credit; p.history.shift(); bad("This transaction was already credited"); }
        return { status: "ok", credited: credit };
      } finally { inflight.delete(sig); }
    });
  }
  const db_hasSig = (sig) => game.store.hasSig(sig);

  // ---- withdrawals -------------------------------------------------------------------------------------------
  function requestWithdraw(p, amount) {
    return locked(p, async () => {
      needToken(); needWallet(p);
      if (!game.isPaid(p)) bad("Buy a pack to unlock withdrawals");
      const base = tokens(amount), amt = base / unit, t = game.now();
      if (amt < SOL.minWithdraw) bad("Minimum withdrawal is " + SOL.minWithdraw + " $MINE");
      if (t - p.lastWithdrawAt < SOL.withdrawCooldownMs) bad("Please wait a few seconds between withdrawals", 429);
      p.withdrawLog = p.withdrawLog.filter((x) => t - x.t < DAY);
      const used = p.withdrawLog.reduce((s, x) => s + x.amount, 0);
      if (used + amt > SOL.maxWithdrawDay) bad("Daily withdrawal limit is " + SOL.maxWithdrawDay + " $MINE (" + Math.max(0, SOL.maxWithdrawDay - used).toFixed(2) + " left)");
      game.touchPlayer(p);
      if (p.balance < amt) bad("Not enough $MINE");
      const treasury = await chain.treasuryBalance();
      if (treasury < BigInt(base)) bad("The game treasury is temporarily out of $MINE — try a smaller amount later", 503);
      // --- everything below is synchronous: no other request can interleave ---
      if (p.balance < amt) bad("Not enough $MINE");
      p.balance -= amt;
      p.lastWithdrawAt = t;
      p.withdrawLog.push({ t, amount: amt });
      const w = { id: crypto.randomBytes(8).toString("hex"), pid: p.id, wallet: p.wallet, amount: amt, base: String(base), state: "queued", created: t, tries: 0 };
      db.withdrawals[w.id] = w;
      game.touch(p); game.touchMeta();
      await game.saveNow([p]);           // durable BEFORE any chain activity
      kick();
      return { withdrawalId: w.id, amount: amt, state: w.state };
    });
  }

  function refund(w, reason) {
    if (w.state === "done" || w.state === "failed") return;
    w.state = "failed"; w.error = String(reason).slice(0, 200);
    const p = db.players[w.pid];
    if (p) {
      p.balance += w.amount;
      const i = p.withdrawLog.findIndex((x) => x.amount === w.amount);
      if (i >= 0) p.withdrawLog.splice(i, 1);
      game.touch(p);
    }
    game.touchMeta();
  }
  let run = null, again = false;
  async function step(w) {
    if (w.state === "queued") {
      try {
        const s = await chain.signWithdrawal(w.wallet, BigInt(w.base));
        Object.assign(w, { sig: s.sig, raw: s.raw, lastValid: s.lastValid, state: "signed", signedAt: game.now() });
        game.touchMeta(); await game.saveNow([]);     // signature stored durably BEFORE broadcast
      } catch (e) {
        w.tries = (w.tries || 0) + 1; w.error = String(e.message).slice(0, 200);
        if (w.tries >= 6) { refund(w, "Could not prepare the transfer: " + w.error); await game.saveNow(db.players[w.pid] ? [db.players[w.pid]] : []); }
        return;
      }
    }
    if (w.state === "signed" || w.state === "sent") {
      const st = await chain.withdrawalStatus(w.sig, w.lastValid);
      if (st === "confirmed") { w.state = "done"; w.doneAt = game.now(); delete w.raw; game.touchMeta(); await game.saveNow([]); return; }
      if (st === "failed") { refund(w, "The transaction failed on-chain"); await game.saveNow([db.players[w.pid]].filter(Boolean)); return; }
      if (st === "expired") { refund(w, "The transaction expired before it was confirmed"); await game.saveNow([db.players[w.pid]].filter(Boolean)); return; }
      // still pending: (re)broadcast the very same signed transaction (idempotent)
      if (w.state === "signed" || game.now() - (w.sentAt || 0) > 20e3) {
        try { await chain.broadcast(w.raw); w.state = "sent"; w.sentAt = game.now(); w.error = null; }
        catch (e) { w.error = String(e.message).slice(0, 200); w.sentAt = game.now(); }
        game.touchMeta();
      }
    }
  }
  function processWithdrawals() {
    if (!chain.tokenEnabled) return Promise.resolve();
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
  function buyPackWithMine(p, packId) {
    return locked(p, async () => {
      needWallet(p);
      const pack = packOf(packId);
      if (p.packs[pack.id]) bad("You already own this pack");
      game.touchPlayer(p);
      game.spendMine(p, pack.mine);
      game.grantPack(p, pack, "mine");
      await game.saveNow([p]);
      return { pack: pack.id };
    });
  }
  function createPackOrder(p, packId) {
    return locked(p, async () => {
      needWallet(p);
      if (!chain.payEnabled) bad("SOL payments are not set up on this server yet", 503);
      const pack = packOf(packId);
      if (p.packs[pack.id]) bad("You already own this pack");
      const id = crypto.randomBytes(8).toString("hex"), order = { id, pid: p.id, pack: pack.id, lamports: pack.lamports, memo: "idle-miner:" + id, created: game.now(), done: false };
      const tx = await chain.buildPackTx(p.wallet, pack.lamports, order.memo);
      db.orders[id] = order; game.touchMeta();
      return { orderId: id, tx, lamports: pack.lamports };
    });
  }
  function confirmPackOrder(p, orderId, signature) {
    return locked(p, async () => {
      needWallet(p);
      const o = db.orders[String(orderId)];
      if (!o || o.pid !== p.id) bad("Unknown order");
      const pack = packOf(o.pack);
      if (o.done || p.packs[pack.id]) bad("You already own this pack");
      const sig = String(signature || "");
      if (!SIG_RE.test(sig)) bad("That is not a transaction signature");
      if (inflight.has(sig) || (await db_hasSig(sig))) bad("This transaction was already used");
      inflight.add(sig);
      try {
        const r = await chain.verifyPayment(sig, p.wallet, o.lamports, o.memo);
        if (r.status === "pending") return { status: "pending" };
        if (r.status === "error") bad(r.error);
        o.done = true; o.sig = sig;
        game.grantPack(p, pack, "sol");
        game.touchMeta();
        const ok = await game.saveNow([p], { sig, info: { pid: p.id, kind: "pack", pack: pack.id, order: o.id, at: Date.now() } });
        if (!ok) console.error("signature was already claimed while granting", sig);
        return { status: "ok", pack: pack.id };
      } finally { inflight.delete(sig); }
    });
  }

  return { publicConfig, bankView, prepareDeposit, confirmDeposit, requestWithdraw, buyPackWithMine, createPackOrder, confirmPackOrder, processWithdrawals, kick };
}

module.exports = { createBank };
