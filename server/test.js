"use strict";
// Self-test:  node server/test.js      (no network, no Solana; the chain layer is replaced by a fake)
// It starts the real server on a temp data file and attacks it the way a cheater would.
const os = require("os"), path = require("path"), fs = require("fs"), assert = require("assert");
const DATA = path.join(os.tmpdir(), "idle-miner-test-" + Date.now() + ".json");
process.env.DATA_FILE = DATA; process.env.RATE_LIMIT = "1000000"; delete process.env.DATABASE_URL;
const tryReq = (n) => { try { return require(n); } catch { return null; } };
const nacl = tryReq("tweetnacl"), bs58 = tryReq("bs58") || require("./test-shims/bs58.js");
if (!nacl) { console.error("tweetnacl is required for the wallet-login tests: npm install"); process.exit(1); }
const { createApp } = require("./server.js");
const { analyzeDeposit, analyzePayment } = require("./chain.js");
const S = require("../js/shared.js");
const { C, PACKS } = require("./config.js");

let n = 0;
const AL = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const sig = (i) => "Z".repeat(60) + "2".repeat(26) + AL[Math.floor(i / 24) % 24] + AL[i % 24]; // looks like a base58 signature
function fakeChain() {
  const ch = {
    enabled: true, tokenEnabled: true, payEnabled: true, merchant: "MerchantAddr", treasury: "TreasuryAddr", mint: "MintAddr", missing: [],
    treasuryTokens: 10n ** 15n, deposits: {}, payments: {}, wStatus: "confirmed", broadcasts: [], signed: [], signFails: 0,
    fromBase: (b) => Number(b) / 1e6,
    treasuryBalance: async () => ch.treasuryTokens, userBalance: async () => 10n ** 12n,
    buildDepositTx: async () => "AAAA", buildPackTx: async () => "AAAA",
    verifyDeposit: async (s) => ch.deposits[s] || { status: "pending" },
    verifyPayment: async (s, w, lamports, memo) => { const r = ch.payments[s]; return r && r.status === "ok" && !(r.lamports >= lamports && r.memo === memo) ? { status: "error", error: "bad payment" } : r || { status: "pending" }; },
    signWithdrawal: async (w, base) => { if (ch.signFails-- > 0) throw new Error("rpc down"); const s = { sig: sig(900 + ch.signed.length), raw: "RAW", lastValid: 100 }; ch.signed.push({ w, base }); return s; },
    broadcast: async (raw) => { ch.broadcasts.push(raw); },
    withdrawalStatus: async () => ch.wStatus,
  };
  return ch;
}

(async () => {
  const chain = fakeChain();
  const app = await createApp({ chain, bs58, nacl });
  const { game, bank, server } = app;
  await new Promise((r) => server.listen(0, r));
  const B = "http://localhost:" + server.address().port;
  const call = async (m, p, body, tok, headers) => {
    const r = await fetch(B + p, { method: m, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}), ...headers }, body: m === "POST" ? JSON.stringify(body || {}) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})), h: r.headers };
  };
  const act = (tok, body) => call("POST", "/api/act", body, tok);
  const T = async (name, fn) => { try { await fn(); console.log("  ok  ", name); n++; } catch (e) { console.error("  FAIL", name, "\n", e); process.exit(1); } };
  const advance = (ms) => game.setClock(game.now() - Date.now() + ms + 0); // server clock jumps by ms (absolute offset, see helper below)
  let clock = 0; const step = (ms) => { clock += ms; game.setClock(clock); };

  console.log("chain verification rules");
  await T("analyzeDeposit only credits what the player's wallet really sent to the treasury", () => {
    const mk = (pre, post, err) => ({ meta: { err, preTokenBalances: pre, postTokenBalances: post } });
    const tb = (owner, amount) => ({ owner, mint: "M", uiTokenAmount: { amount: String(amount) } });
    const ok = analyzeDeposit(mk([tb("W", 500), tb("T", 0)], [tb("W", 200), tb("T", 300)]), { wallet: "W", treasuryOwner: "T", mint: "M" });
    assert(ok.status === "ok" && ok.baseUnits === 300n);
    assert(analyzeDeposit(mk([tb("X", 500), tb("T", 0)], [tb("X", 200), tb("T", 300)]), { wallet: "W", treasuryOwner: "T", mint: "M" }).status === "error", "someone else's transfer");
    assert(analyzeDeposit(mk([tb("W", 500), tb("T", 0)], [tb("W", 500), tb("T", 0)]), { wallet: "W", treasuryOwner: "T", mint: "M" }).status === "error", "nothing moved");
    assert(analyzeDeposit(mk([tb("W", 500), tb("T", 0)], [tb("W", 400), tb("T", 300)]), { wallet: "W", treasuryOwner: "T", mint: "M" }).status === "error", "treasury got more than the wallet lost");
    assert(analyzeDeposit({ meta: { err: { x: 1 } } }, {}).status === "error" && analyzeDeposit(null, {}).status === "pending");
    assert(analyzeDeposit(mk([tb("W", 500), tb("T", 0)], [tb("W", 200), { owner: "T", mint: "OTHER", uiTokenAmount: { amount: "300" } }]), { wallet: "W", treasuryOwner: "T", mint: "M" }).status === "error", "wrong mint");
  });
  await T("analyzePayment needs the right amount, signer, receiver and order memo", () => {
    const tx = (o = {}) => ({ meta: { err: null, preBalances: [10e9, 0], postBalances: [10e9 - 500005000, 500000000], ...o.meta },
      transaction: { message: { accountKeys: o.keys || [{ pubkey: "W", signer: true }, { pubkey: "M", signer: false }], instructions: o.ix || [{ program: "spl-memo", parsed: "idle-miner:abc" }] } } });
    const ctx = { wallet: "W", merchant: "M", lamports: 500000000, memo: "idle-miner:abc" };
    assert(analyzePayment(tx(), ctx).status === "ok");
    assert(analyzePayment(tx(), { ...ctx, lamports: 600000000 }).status === "error", "underpaid");
    assert(analyzePayment(tx(), { ...ctx, memo: "idle-miner:other" }).status === "error", "other order");
    assert(analyzePayment(tx({ ix: [] }), ctx).status === "error", "no memo");
    assert(analyzePayment(tx({ keys: [{ pubkey: "W", signer: false }, { pubkey: "M" }] }), ctx).status === "error", "not signed");
    assert(analyzePayment(tx(), { ...ctx, wallet: "Q" }).status === "error", "other wallet");
  });

  console.log("accounts & sign-in");
  let guest, gTok;
  await T("guest account is created; the server sends a full state, no secrets", async () => {
    const r = await call("POST", "/api/guest", { name: "Alice" });
    assert(r.s === 200 && r.j.token && r.j.guest === true && r.j.cash === 50 && r.j.mine.unlockedShaftCount === 1);
    guest = r.j; gTok = r.j.token;
    assert(!JSON.stringify(r.j).includes('"sessions"') && !r.j.key);
  });
  await T("bad / missing tokens are rejected", async () => {
    assert((await call("POST", "/api/sync", {}, "bad.token")).s === 401);
    assert((await call("POST", "/api/sync", {})).s === 401);
    assert((await call("POST", "/api/sync", {}, guest.id + "." + "0".repeat(48))).s === 401);
  });
  await T("wallet sign-in: challenge/response with a real ed25519 signature", async () => {
    const kp = nacl.sign.keyPair(), wallet = bs58.encode(kp.publicKey);
    const nr = (await call("POST", "/api/auth/nonce", { wallet })).j;
    assert(nr.nonce && nr.message.includes(wallet) && nr.message.includes(nr.nonce));
    const good = Buffer.from(nacl.sign.detached(Buffer.from(nr.message), kp.secretKey)).toString("base64");
    // wrong signer
    const other = nacl.sign.keyPair();
    const evil = Buffer.from(nacl.sign.detached(Buffer.from(nr.message), other.secretKey)).toString("base64");
    assert((await call("POST", "/api/auth/wallet", { wallet, nonce: nr.nonce, signature: evil })).s === 401, "forged signature");
    assert((await call("POST", "/api/auth/wallet", { wallet, nonce: nr.nonce, signature: good })).s === 401, "nonce is burnt after a failed try");
    const nr2 = (await call("POST", "/api/auth/nonce", { wallet })).j;
    const sig2 = Buffer.from(nacl.sign.detached(Buffer.from(nr2.message), kp.secretKey)).toString("base64");
    // message signed for a different nonce is refused
    const wrong = Buffer.from(nacl.sign.detached(Buffer.from(nr.message), kp.secretKey)).toString("base64");
    assert((await call("POST", "/api/auth/wallet", { wallet, nonce: nr2.nonce, signature: wrong })).s === 401);
    const nr3 = (await call("POST", "/api/auth/nonce", { wallet })).j;
    const sig3 = Buffer.from(nacl.sign.detached(Buffer.from(nr3.message), kp.secretKey)).toString("base64");
    const ok = await call("POST", "/api/auth/wallet", { wallet, nonce: nr3.nonce, signature: sig3 }, gTok);  // guest links the wallet
    assert(ok.s === 200 && ok.j.linked === true && ok.j.wallet === wallet && ok.j.id === guest.id, "guest progress moves onto the wallet");
    assert((await call("POST", "/api/auth/wallet", { wallet, nonce: nr3.nonce, signature: sig3 })).s === 401, "replay of the same login");
    // second device: same wallet -> same account
    const nr4 = (await call("POST", "/api/auth/nonce", { wallet })).j;
    const sig4 = Buffer.from(nacl.sign.detached(Buffer.from(nr4.message), kp.secretKey)).toString("base64");
    const dev2 = await call("POST", "/api/auth/wallet", { wallet, nonce: nr4.nonce, signature: sig4 });
    assert(dev2.s === 200 && dev2.j.id === guest.id && dev2.j.token !== ok.j.token);
    assert((await call("POST", "/api/sync", {}, ok.j.token)).s === 200 && (await call("POST", "/api/sync", {}, dev2.j.token)).s === 200);
    await call("POST", "/api/logout", {}, dev2.j.token);
    assert((await call("POST", "/api/sync", {}, dev2.j.token)).s === 401, "logged-out token is dead");
    gTok = ok.j.token; guest.wallet = wallet; guest.kp = kp;
    assert((await call("POST", "/api/auth/nonce", { wallet: "not-a-wallet" })).s === 400);
  });

  console.log("server-side time & anti-cheat");
  await T("client-supplied time/cash/levels in the request are ignored", async () => {
    const r = await call("POST", "/api/sync", { now: Date.now() + 1e10, cash: 1e12, level: 99, power: 1e9, token: 1e9, serverNow: 1 }, gTok);
    assert(r.j.cash < 100 && r.j.hero.lvl === 1 && r.j.balance === 0 && r.j.power < 500);
  });
  await T("income is paid from the server clock; being online for 10 min pays ~ rate * 600s", async () => {
    const p = game.db.players[guest.id];
    p.cash = 0; game.touchPlayer(p);
    const rate = S.income(p, game.now()).perSec;
    for (let i = 0; i < 40; i++) { step(15e3); game.touchPlayer(p); }
    const earned = p.cash;
    assert(Math.abs(earned - rate * 600) < rate * 600 * 0.02, `expected ~${rate * 600}, got ${earned}`);
  });
  await T("offline income is capped at 8 hours and paid at 50 %", async () => {
    const p = game.db.players[guest.id];
    game.touchPlayer(p); p.pendingOffline = 0; const rate = S.income(p, game.now()).perSec;
    step(30 * 3600e3);                                            // away for 30 hours
    const res = await call("POST", "/api/sync", {}, gTok);
    assert(res.j.pendingOffline > 0);
    const expect = rate * 8 * 3600 * 0.5;
    assert(Math.abs(res.j.pendingOffline - expect) < expect * 0.01, `pending ${res.j.pendingOffline} vs ${expect}`);
    const cash0 = res.j.cash;
    const c = await act(gTok, { type: "claimOffline" });
    assert(c.j.ok && Math.abs(c.j.cash - cash0 - expect) < expect * 0.02 + 1, "claimed");
    assert((await act(gTok, { type: "claimOffline" })).s === 400, "nothing left to claim twice");
  });
  await T("double-offline costs $MINE the player does not have", async () => {
    const p = game.db.players[guest.id]; p.pendingOffline = 1000;
    const r = await act(gTok, { type: "claimOffline", double: true });
    assert(r.s === 400 && /Not enough/.test(r.j.error) && p.pendingOffline === 1000);
  });
  await T("malformed / malicious actions are refused and change nothing", async () => {
    const p = game.db.players[guest.id], snap = () => JSON.stringify([p.mines, p.inv, p.balance, p.eq, p.hero.crates, p.researchUnlocked]), before = snap(), cash0 = p.cash;
    const bads = [{ type: "upgrade", target: "shaft", idx: -1, n: 1 }, { type: "upgrade", target: "shaft", idx: 29, n: 1 }, { type: "upgrade", target: "shaft", idx: 0, n: 1e9 },
      { type: "upgrade", target: "shaft", idx: 0, n: -5 }, { type: "upgrade", target: "shaft", idx: "0", n: 1 }, { type: "upgrade", target: "__proto__", n: 1 }, { type: "constructor" },
      { type: "__proto__" }, { type: "toString" }, {}, { type: 5 }, { type: "equip", id: 99999 }, { type: "sell", id: "x" }, { type: "buy", item: "free_money2" }, { type: "buy", item: "page" },
      { type: "buy", item: "tome" }, { type: "fuse", slot: "Pickaxe", r: 9 }, { type: "crate", slot: "Pickaxe" }, { type: "research", id: "nope" },
      { type: "claimPrize" }, { type: "prestige" }];
    for (const b of bads) { const r = await act(gTok, b); assert(r.s === 400, JSON.stringify(b) + " -> " + r.s + " " + JSON.stringify(r.j.error)); }
    assert(snap() === before && p.cash >= cash0, "state unchanged (cash may only have grown by real income)");
  });
  await T("upgrades are priced by the server and need real cash", async () => {
    const p = game.db.players[guest.id]; p.cash = 100;
    const info = S.upInfo(p, "shaft", 0, game.now()), cost = S.upgradeCost(info.base, info.level, 1, info.cm);
    let r = await act(gTok, { type: "upgrade", target: "shaft", idx: 0, n: 1 });
    assert(r.j.ok && r.j.cash >= 100 - cost - 1e-6 && r.j.cash < 100 - cost + 20 && r.j.mine.shafts[0].level === info.level + 1, JSON.stringify([r.j.cash, cost, r.j.mine.shafts[0].level, info.level]));
    p.cash = 1; assert((await act(gTok, { type: "upgrade", target: "elevator", n: 50 })).s === 400);
    p.cash = 1e9; r = await act(gTok, { type: "upgrade", target: "shaft", idx: 0, n: "max" });
    assert(r.j.ok && r.j.mine.shafts[0].level > 100 && r.j.cash >= 0);
  });
  await T("free money has a cooldown (no infinite cash loop)", async () => {
    const a = await act(gTok, { type: "buy", item: "free_money" });
    assert(a.j.ok, JSON.stringify(a.j));
    assert((await act(gTok, { type: "buy", item: "free_money" })).s === 400);
  });
  await T("items can only be sold / equipped when really owned; gear above hero level can't be equipped", async () => {
    const p = game.db.players[guest.id];
    const hi = game.ACTIONS; // internal helper not needed
    p.inv.push({ id: 9001, slot: "Ring", r: 5, il: 50, v: 0.2, dur: 500, max: 500, aff: [], lock: false });
    assert((await act(gTok, { type: "equip", id: 9001 })).s === 400);
    const eqId = p.eq.Pickaxe;
    assert((await act(gTok, { type: "sell", id: eqId })).s === 400, "equipped item");
    const c0 = p.cash; const r = await act(gTok, { type: "sell", id: 9001 });
    assert(r.j.ok && r.j.cash > c0);
  });
  await T("drops are rolled by the server: ~expected count over a long online stretch, never from the client", async () => {
    const q = game.createPlayer("Dropper"); const m = q.mines.start; m.unlockedShaftCount = 30; m.shafts.forEach((s) => (s.level = 50)); q.invPages = 5;
    game.touchPlayer(q);
    for (let i = 0; i < 4 * 60 * 24; i++) { step(15e3); game.settle(q); } // 24 h online
    assert(q.items > 5 && q.items < 400, "items found in a day: " + q.items);
    assert(q.hero.n <= q.items + q.hero.crates + 1);
  });

  console.log("$MINE: free cap, fast start, offline window");
  await T("first 20 000 $MINE take ~90 minutes of play; free players then stop at 20 000", async () => {
    const q = game.createPlayer("Newbie"); q.lastSeen = game.now();
    const t0 = clock; let at20k = 0;
    for (let i = 0; i < 12 * 140; i++) { // 140 minutes in 5-second steps
      step(5e3); if (i % 3 === 0) game.touchPlayer(q);
      game.tick();
      if (!at20k && q.earned >= C.ONBOARD_CAP - 1) at20k = (clock - t0) / 60e3;
    }
    assert(at20k > 80 && at20k < 100, "reached 20k after " + at20k + " min");
    assert(q.earned <= C.FREE_EARN_CAP + 1e-6, "free cap holds: " + q.earned);
    assert(q.balance <= C.FREE_EARN_CAP + 1e-6);
    const e0 = q.earned; for (let i = 0; i < 100; i++) { step(5e3); game.touchPlayer(q); game.tick(); }
    assert(q.earned === e0, "no new $MINE for a free player at the cap");
    q.packs[1] = true; // after buying any pack mining continues at the normal rate (much slower than the fast start)
    for (let i = 0; i < 12 * 60; i++) { step(5e3); if (i % 3 === 0) game.touchPlayer(q); game.tick(); }
    const gain = q.earned - e0;
    assert(gain > 0 && gain < 200, "normal rate after the fast start: " + gain + " $MINE per hour");
  });
  await T("nobody mines while away for more than 8 hours", async () => {
    const q = game.createPlayer("Sleeper"); q.packs[1] = true; q.power = 500; game.touchPlayer(q);
    const e0 = q.earned; step(9 * 3600e3);
    for (let i = 0; i < 12; i++) { step(5e3); game.tick(); }
    assert(game.isActive(q, game.now()) === false, "inactive after 8h");
  });

  console.log("packs & bank");
  const wallet = () => guest.wallet;
  const gp = () => game.db.players[guest.id];
  await T("free players cannot withdraw; guests cannot bank at all", async () => {
    gp().balance = 5000;
    const w = await call("POST", "/api/bank/withdraw", { amount: 1000 }, gTok);
    assert(w.s === 400 && /pack/i.test(w.j.error), w.j.error);
    const g2 = (await call("POST", "/api/guest", { name: "Gus" })).j;
    assert((await call("POST", "/api/bank/withdraw", { amount: 1000 }, g2.token)).s === 400);
    assert((await call("POST", "/api/bank/deposit/prepare", { amount: 5 }, g2.token)).s === 400);
    assert((await call("POST", "/api/pack/mine", { pack: 1 }, g2.token)).s === 400, "guest can't buy packs");
  });
  await T("deposit: credited once after server-side verification; a signature can never be reused", async () => {
    const s1 = sig(1);
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: s1 }, gTok)).j.status === "pending");
    chain.deposits[s1] = { status: "ok", baseUnits: 25_000_000n };
    const b0 = gp().balance;
    const r = await call("POST", "/api/bank/deposit/confirm", { signature: s1 }, gTok);
    assert(r.j.status === "ok" && Math.abs(gp().balance - b0 - 25) < 1e-9, JSON.stringify(r.j));
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: s1 }, gTok)).s === 400, "replay");
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: "short" }, gTok)).s === 400);
    chain.deposits[sig(2)] = { status: "error", error: "not yours" };
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: sig(2) }, gTok)).s === 400);
    const pr = await call("POST", "/api/bank/deposit/prepare", { amount: 10 }, gTok);
    assert(pr.j.tx && pr.j.amount === 10);
    assert((await call("POST", "/api/bank/deposit/prepare", { amount: -5 }, gTok)).s === 400);
    assert((await call("POST", "/api/bank/deposit/prepare", { amount: "abc" }, gTok)).s === 400);
  });
  await T("buying a pack with $MINE: price enforced, once only, gear + cash + xp granted", async () => {
    const p = gp(); p.balance = 39999;
    assert((await call("POST", "/api/pack/mine", { pack: 1 }, gTok)).s === 400, "1 short");
    p.balance = 60000; const cash0 = p.cash;
    const r = await call("POST", "/api/pack/mine", { pack: 1 }, gTok);
    assert(r.j.pack === 1 && Math.abs(r.j.balance - 20000) < 1e-6 && r.j.packs[1] && r.j.paid);
    assert(r.j.hero.lvl >= 8 && r.j.cash >= cash0 + 250e3);
    const epics = p.inv.filter((i) => i.r === 3 && i.il === p.hero.lvl);
    assert(epics.length === 8 && S.SLOTS.every((s) => p.eq[s] && S.itemById(p, p.eq[s]).r >= 3), "8 Epic items equipped");
    assert((await call("POST", "/api/pack/mine", { pack: 1 }, gTok)).s === 400, "only once");
    assert((await call("POST", "/api/pack/mine", { pack: 7 }, gTok)).s === 400);
    assert(PACKS[0].mine === 40000 && Math.abs(PACKS[0].lamports / 1e9 * 100000 * 0.9 - 40000) < 15, "SOL price is 10% above the $MINE price");
  });
  await T("buying a pack with SOL: order memo, verified payment, one use", async () => {
    const o = await call("POST", "/api/pack/order", { pack: 2 }, gTok);
    assert(o.j.orderId && o.j.tx && o.j.lamports === PACKS[1].lamports);
    const order = game.db.orders[o.j.orderId];
    const sp = sig(10);
    const pc = await call("POST", "/api/pack/confirm", { order: o.j.orderId, signature: sp }, gTok);
    assert(pc.j.status === "pending", JSON.stringify(pc));
    chain.payments[sp] = { status: "ok", lamports: order.lamports - 1, memo: order.memo };
    assert((await call("POST", "/api/pack/confirm", { order: o.j.orderId, signature: sp }, gTok)).s === 400, "underpaid");
    chain.payments[sp] = { status: "ok", lamports: order.lamports, memo: order.memo };
    const r = await call("POST", "/api/pack/confirm", { order: o.j.orderId, signature: sp }, gTok);
    assert(r.j.status === "ok" && r.j.packs[2], JSON.stringify(r.j));
    assert((await call("POST", "/api/pack/confirm", { order: o.j.orderId, signature: sp }, gTok)).s === 400, "replay");
    assert((await call("POST", "/api/pack/order", { pack: 2 }, gTok)).s === 400, "already owned");
    assert((await call("POST", "/api/pack/confirm", { order: "ffffffffffffffff", signature: sig(11) }, gTok)).s === 400, "unknown order");
    // an order belongs to its owner
    const o3 = await call("POST", "/api/pack/order", { pack: 3 }, gTok);
    const other = (await call("POST", "/api/guest", { name: "Mallory" })).j;
    assert((await call("POST", "/api/pack/confirm", { order: o3.j.orderId, signature: sig(12) }, other.token)).s === 400);
  });
  await T("withdraw: balance deducted first, paid to the player's own wallet, limits enforced", async () => {
    const p = gp(); p.balance = 5000; p.lastWithdrawAt = 0;
    assert((await call("POST", "/api/bank/withdraw", { amount: 50 }, gTok)).s === 400, "below minimum");
    assert((await call("POST", "/api/bank/withdraw", { amount: 99999999 }, gTok)).s === 400, "more than balance");
    assert((await call("POST", "/api/bank/withdraw", { amount: -1 }, gTok)).s === 400);
    const r = await call("POST", "/api/bank/withdraw", { amount: 1000, wallet: "Attacker111", to: "Attacker111" }, gTok);
    assert(r.s === 200 && Math.abs(r.j.balance - 4000) < 1e-6, JSON.stringify(r.j));
    await bank.processWithdrawals();
    const w = Object.values(game.db.withdrawals).find((x) => x.pid === p.id);
    assert(w.state === "done" && w.wallet === wallet() && chain.signed[0].w === wallet() && chain.signed[0].base === 1_000_000_000n, JSON.stringify(w));
    assert((await call("POST", "/api/bank/withdraw", { amount: 500 }, gTok)).s === 429, "cooldown");
    p.lastWithdrawAt = 0; p.balance = 1e6;
    const lim = await call("POST", "/api/bank/withdraw", { amount: C && 400000 }, gTok);
    assert(lim.s === 400 && /limit/i.test(lim.j.error), lim.j.error);
  });
  await T("failed or expired withdrawals are refunded exactly once; crash after signing never pays twice", async () => {
    const p = gp(); p.balance = 1000; p.lastWithdrawAt = 0; p.withdrawLog = [];
    chain.wStatus = "pending";
    await call("POST", "/api/bank/withdraw", { amount: 300 }, gTok);
    await bank.processWithdrawals();
    let w = Object.values(game.db.withdrawals).filter((x) => x.pid === p.id).pop();
    assert(w.state === "sent" && chain.broadcasts.length >= 1 && Math.abs(p.balance - 700) < 1e-9);
    chain.wStatus = "expired"; await bank.processWithdrawals(); await bank.processWithdrawals();
    assert(w.state === "failed" && Math.abs(p.balance - 1000) < 1e-9, "refunded once: " + p.balance);
    // rpc failures while signing: nothing is lost
    p.lastWithdrawAt = 0; chain.signFails = 2; chain.wStatus = "confirmed";
    await call("POST", "/api/bank/withdraw", { amount: 200 }, gTok);
    await bank.processWithdrawals(); await bank.processWithdrawals(); await bank.processWithdrawals();
    w = Object.values(game.db.withdrawals).filter((x) => x.pid === p.id).pop();
    assert(w.state === "done" && Math.abs(p.balance - 800) < 1e-9, w.state + " " + p.balance + " " + JSON.stringify(w) + " signFails=" + chain.signFails);
    // treasury out of tokens: request refused, nothing deducted
    p.lastWithdrawAt = 0; chain.treasuryTokens = 1n;
    assert((await call("POST", "/api/bank/withdraw", { amount: 300 }, gTok)).s === 503 && Math.abs(p.balance - 800) < 1e-9);
    chain.treasuryTokens = 10n ** 15n;
  });

  console.log("persistence & leaderboard & web security");
  await T("a restart keeps everything, including a withdrawal that was signed but not yet confirmed", async () => {
    app.resetLimits(); const p = gp(); p.lastWithdrawAt = 0; p.withdrawLog = []; chain.wStatus = "pending";
    const wr = await call("POST", "/api/bank/withdraw", { amount: 150 }, gTok);
    assert(wr.s === 200, JSON.stringify(wr.j));
    await bank.processWithdrawals();
    const bal = p.balance, wid = wr.j.withdrawalId;
    await game.flush();
    const chain2 = fakeChain(); chain2.wStatus = "confirmed";
    const app2 = await createApp({ chain: chain2, bs58, nacl, now: () => game.now() });
    const p2 = app2.game.db.players[guest.id], w2 = app2.game.db.withdrawals[wid];
    assert(p2 && p2.wallet === wallet() && Math.abs(p2.balance - bal) < 1e-6 && p2.packs[1] && p2.packs[2], "player restored");
    assert(w2 && w2.state === "sent" && w2.sig, "withdrawal restored with its stored signature: " + JSON.stringify(w2) + " all=" + JSON.stringify(Object.keys(app2.game.db.withdrawals)) + " wid=" + wid);
    await app2.bank.processWithdrawals();
    assert(w2.state === "done" && chain2.signed.length === 0, "finished by checking the stored signature, no second transfer");
    assert(app2.game.findByWallet(wallet()) === p2);
    app2.server.close();
    chain.wStatus = "confirmed";
  });
  await T("leaderboard works and season prizes need a pack", async () => {
    app.resetLimits();
    const lb = (await call("GET", "/api/leaderboard", null, gTok)).j;
    assert(lb.rows.length > 3 && lb.me && Math.abs(lb.rows.reduce((s, r) => s + r.prize, 0) - C.LB_POOL) < 1 || lb.rows.length < 100);
    assert((await act(gTok, { type: "claimPrize" })).s === 400, "season running");
    game.db.season.start -= 31 * 864e5;
    const free = (await call("POST", "/api/guest", { name: "Freeloader" })).j;
    assert((await act(free.token, { type: "claimPrize" })).s === 400, "free players can't claim");
    const r = await act(gTok, { type: "claimPrize" });
    assert(r.j.ok, JSON.stringify(r.j));
    assert((await act(gTok, { type: "claimPrize" })).s === 400);
    game.db.season.start += 31 * 864e5;
  });
  await T("only game files are served; security headers are set; no CORS", async () => {
    for (const u of ["/server/server.js", "/server/data.json", "/.git/config", "/package.json", "/node_modules/pg/package.json", "/js/../server/config.js", "/%2e%2e/server/config.js", "/index.html/../package.json", "/js/shared.js.map"]) {
      const r = await fetch(B + u); assert(r.status === 404 || r.status === 400, u + " -> " + r.status);
    }
    const idx = await fetch(B + "/"); assert(idx.status === 200 && /Idle Mountain Miner/.test(await idx.text()));
    assert(/script-src 'self'/.test(idx.headers.get("content-security-policy")) && idx.headers.get("x-content-type-options") === "nosniff");
    assert((await fetch(B + "/js/shared.js")).status === 200);
    const api = await fetch(B + "/api/health", { headers: { Origin: "https://evil.example" } });
    assert(!api.headers.get("access-control-allow-origin"), "no CORS header");
  });
  await T("request size limit and junk bodies", async () => {
    const r = await fetch(B + "/api/guest", { method: "POST", body: "x".repeat(50000) }).catch(() => ({ status: 0 }));
    assert(r.status === 0 || r.status >= 400);
    assert((await fetch(B + "/api/guest", { method: "POST", body: "[1,2]" })).status === 400);
    assert((await fetch(B + "/api/guest", { method: "POST", body: "{bad" })).status === 400);
  });
  await T("guest creation is rate limited per IP", async () => {
    let lim = 0; for (let i = 0; i < 30; i++) if ((await call("POST", "/api/guest", {})).s === 429) lim++;
    assert(lim > 0);
  });

  console.log(`\nALL ${n} CHECKS PASSED`);
  await app.shutdown(); try { fs.unlinkSync(DATA); } catch {}
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
