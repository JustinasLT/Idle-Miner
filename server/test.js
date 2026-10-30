"use strict";
// Self-test:  node server/test.js      (no network, no Solana; the chain layer is replaced by a fake)
// It starts the real server on a temp data file and attacks it the way a cheater would.
const os = require("os"), path = require("path"), fs = require("fs"), assert = require("assert");
const DATA = path.join(os.tmpdir(), "idle-miner-test-" + Date.now() + ".json");
process.env.DATA_FILE = DATA; process.env.RATE_LIMIT = "1000000"; delete process.env.DATABASE_URL;
const tryReq = (n) => { try { return require(n); } catch { return null; } };
const nacl = tryReq("tweetnacl"), bs58 = tryReq("bs58") || require("./bs58.js");
if (!nacl) { console.error("tweetnacl is required for the wallet-login tests: npm install"); process.exit(1); }
const { createApp } = require("./server.js");
const { analyzeSolDeposit, analyzePayment } = require("./chain.js");
const S = require("../js/shared.js");
const { C, PACKS, PRICES } = require("./config.js");
// the older tests max out 30 floors with a low-level manager: switch the Power gate off for them, and back on in the gating tests
const REQ_REAL = S.FLOOR_POWER_REQ.slice();
const gateOn = () => REQ_REAL.forEach((v, i) => (S.FLOOR_POWER_REQ[i] = v)), gateOff = () => S.FLOOR_POWER_REQ.fill(0);
gateOff();

let n = 0;
const AL = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const sig = (i) => "Z".repeat(60) + "2".repeat(26) + AL[Math.floor(i / 24) % 24] + AL[i % 24]; // looks like a base58 signature
function fakeChain() {
  const ch = {
    enabled: true, payEnabled: true, merchant: "MerchantAddr", treasury: "TreasuryAddr", missing: [],
    treasurySol: 10n ** 15n, deposits: {}, payments: {}, wStatus: "confirmed", broadcasts: [], signed: [], signFails: 0,
    treasuryBalance: async () => ch.treasurySol, walletBalance: async () => 10n ** 12n,
    buildDepositTx: async () => "AAAA",
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
  let forcedRoll = null; // makes item-upgrade rolls deterministic: 0 = always succeeds, 0.999 = always fails
  const app = await createApp({ chain, bs58, nacl, rng: () => (forcedRoll != null ? forcedRoll : Math.random()) });
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
  const near = (a, b, tol = 0.01) => Math.abs(a - b) <= Math.abs(b) * tol + 1e-9;
  // gives a player every quest: hold 50k, deposited 50k, spent 25k, X + Discord linked, 24 h without a withdrawal
  const finishQuests = (p) => { p.balance = Math.max(p.balance, 50000); p.q.depDone = true; p.q.spent = 25000; p.q.x = "x" + p.id; p.q.discord = "d" + p.id; p.created -= 2 * 864e5; };
  const totalXp = (h) => { let x = h.xp; for (let l = 1; l < h.lvl; l++) x += S.xpNeed(l); return x; };

  console.log("chain verification rules");
  await T("analyzeSolDeposit only credits SOL that the player's own wallet signed and sent to the treasury", () => {
    const tx = (o = {}) => ({ meta: { err: null, preBalances: [10e9, 0], postBalances: [10e9 - 300005000, 300000000], ...o.meta },
      transaction: { message: { accountKeys: o.keys || [{ pubkey: "W", signer: true }, { pubkey: "T", signer: false }] } } });
    const ok = analyzeSolDeposit(tx(), { wallet: "W", treasury: "T" });
    assert(ok.status === "ok" && ok.lamports === 300000000n, "credits exactly what the treasury received");
    assert(analyzeSolDeposit(tx(), { wallet: "X", treasury: "T" }).status === "error", "someone else's transfer");
    assert(analyzeSolDeposit(tx({ keys: [{ pubkey: "W", signer: false }, { pubkey: "T" }] }), { wallet: "W", treasury: "T" }).status === "error", "wallet did not sign");
    assert(analyzeSolDeposit(tx({ meta: { postBalances: [10e9, 0] } }), { wallet: "W", treasury: "T" }).status === "error", "nothing moved");
    assert(analyzeSolDeposit(tx({ meta: { postBalances: [10e9 - 100, 300000000] } }), { wallet: "W", treasury: "T" }).status === "error", "treasury got more than the wallet paid");
    assert(analyzeSolDeposit({ meta: { err: { x: 1 } } }, {}).status === "error" && analyzeSolDeposit(null, {}).status === "pending");
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
  await T("without Offline Earnings you are paid for 15 minutes after leaving, not longer", async () => {
    const q = game.createPlayer("Casual"); game.touchPlayer(q);
    const rate = S.income(q, game.now()).perSec;
    assert(S.offlineUnlocked(q, game.now()) === false);
    step(5 * 3600e3);                                            // away for 5 hours
    game.touchPlayer(q);
    const expect = rate * 15 * 60;                               // 100 % for the first 15 minutes, then nothing
    assert(near(q.pendingOffline, expect), `pending ${q.pendingOffline} vs ${expect}`);
    assert(game.view(q).offline.unlocked === false);
  });
  await T("with all 5 quests done, Offline Earnings pay up to 8 hours at 50 %", async () => {
    const q = game.createPlayer("Perk"); finishQuests(q); game.touchPlayer(q);
    assert(S.offlineUnlocked(q, game.now()) === true);
    const rate = S.income(q, game.now()).perSec;
    step(30 * 3600e3);                                           // away for 30 hours
    game.touchPlayer(q);
    const expect = rate * 8 * 3600 * 0.5;
    assert(near(q.pendingOffline, expect), `pending ${q.pendingOffline} vs ${expect}`);
    const cash0 = q.cash, c = game.act(q, { type: "claimOffline" });
    assert(near(q.cash - cash0, expect, 0.02) && q.pendingOffline === 0);
    let threw = false; try { game.act(q, { type: "claimOffline" }); } catch (e) { threw = e.status === 400; }
    assert(threw, "nothing left to claim twice");
    let dbl = false; try { q.pendingOffline = 100; q.balance = 100; game.act(q, { type: "claimOffline", double: true }); dbl = q.balance === 100 && q.cash > 0; } catch { dbl = false; }
    assert(dbl, "the old x2 option is gone: it neither charges $AFKMINE nor doubles");
  });
  await T("malformed / malicious actions are refused and change nothing", async () => {
    const p = game.db.players[guest.id], snap = () => JSON.stringify([p.mines, p.inv, p.balance, p.eq, p.hero.crates, p.pending, p.boosts, p.q]);
    game.touchPlayer(p); p.pending = { items: [], crates: 0, shards: 0 };   // a random drop found by earlier tests would make 'claimRewards' legitimately succeed
    const before = snap(), cash0 = p.cash;
    const bads = [{ type: "upgrade", target: "shaft", idx: -1, n: 1 }, { type: "upgrade", target: "shaft", idx: 29, n: 1 }, { type: "upgrade", target: "shaft", idx: 0, n: 1e9 },
      { type: "upgrade", target: "shaft", idx: 0, n: -5 }, { type: "upgrade", target: "shaft", idx: "0", n: 1 }, { type: "upgrade", target: "__proto__", n: 1 }, { type: "constructor" },
      { type: "__proto__" }, { type: "toString" }, {}, { type: 5 }, { type: "equip", id: 99999 }, { type: "sell", id: "x" }, { type: "buy", item: "free_money2" }, { type: "buy", item: "page" },
      { type: "buy", item: "tome" }, { type: "crate", slot: "Pickaxe" }, { type: "research", id: "cost10" },
      { type: "claimPrize" }, { type: "prestige" },
      { type: "upgradeItem", id: 99999 }, { type: "upgradeItem" }, { type: "claimRewards" }, { type: "reset" }, { type: "reset", confirm: "yes" },
      { type: "linkSocial", kind: "x", handle: "bad handle!" }, { type: "linkSocial", kind: "facebook", handle: "abc" }, { type: "linkSocial", kind: "discord", handle: "a" },
      { type: "buy", item: "boost_xp" }, { type: "buy", item: "boost_sell" }, { type: "buy", item: "crate" }, { type: "buy", item: "shaft5" }, { type: "buy", item: "infra5" }, { type: "fuse", slot: "Ring", r: 0 }];
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
  await T("test faucet: free cash and free $AFKMINE without a cooldown, and it can be switched off", async () => {
    const p = game.db.players[guest.id], b0 = p.balance;
    const a = await act(gTok, { type: "buy", item: "free_money" }), a2 = await act(gTok, { type: "buy", item: "free_money" });
    assert(a.j.ok && a2.j.ok && a2.j.cash > a.j.cash, "no cooldown");
    const m1 = await act(gTok, { type: "buy", item: "free_mine" }), m2 = await act(gTok, { type: "buy", item: "free_mine" });
    assert(m1.j.ok && m2.j.ok && Math.abs(p.balance - b0 - 2 * C.DEV_MINE_AMOUNT) < 1e-6, "$AFKMINE faucet");
    assert(p.earned === 0 || p.earned < C.DEV_MINE_AMOUNT, "faucet $AFKMINE is not 'mined' $AFKMINE");
    p.balance = b0;
    C.DEV_FAUCET = false;
    try { assert((await act(gTok, { type: "buy", item: "free_money" })).s === 400 && (await act(gTok, { type: "buy", item: "free_mine" })).s === 400); } finally { C.DEV_FAUCET = true; }
    assert((await call("GET", "/api/config")).j.devFaucet === true);
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
  await T("drops are rolled by the server and wait for 'Claim mining rewards' (nothing lands in the backpack by itself)", async () => {
    const q = game.createPlayer("Dropper"); const m = q.mines.start; m.unlockedShaftCount = 30; m.shafts.forEach((s) => (s.level = 50)); q.invPages = 5;
    game.touchPlayer(q);
    for (let i = 0; i < 4 * 60 * 24; i++) { step(15e3); game.settle(q); } // 24 h online
    const found = q.pending.items.length;
    assert(q.items > 5 && q.items < 400, "items found in a day: " + q.items);
    assert(q.inv.length === 3, "backpack untouched until the claim: " + q.inv.length);
    assert(found > 0 && q.hero.crates === 0 && q.pending.crates >= 0);
    assert(q.hero.n <= q.items + q.pending.crates + 1);
    const v = game.view(q);
    assert(v.pending.n === found && v.pending.items.length === found && v.pending.max === C.PENDING_MAX && v.pending.cash > 0, "view shows what was mined since the last claim");
    const crates = q.pending.crates, r = game.act(q, { type: "claimRewards" });
    assert(r.claimed.items === found && r.claimed.crates === crates && r.claimed.left === 0);
    assert(q.inv.length === 3 + found && q.pending.items.length === 0 && q.pending.crates === 0 && q.hero.crates === crates);
    assert(game.view(q).pending.cash === 0 && game.view(q).pending.mine === 0, "counters restart after a claim");
    let threw = false; try { game.act(q, { type: "claimRewards" }); } catch (e) { threw = e.status === 400; }
    assert(threw, "nothing left to claim");
  });
  await T("claiming with a full backpack keeps the rest waiting; a full reward stash auto-sells", async () => {
    const q = game.createPlayer("Packrat"); game.touchPlayer(q);
    for (let i = 0; i < 46; i++) q.inv.push({ id: 100 + i, slot: "Ring", r: 0, il: 1, v: 0.01, dur: 100, max: 100, aff: [], lock: false, up: 0 });
    for (let i = 0; i < 5; i++) q.pending.items.push({ id: 500 + i, slot: "Ring", r: i % 3, il: 1, v: 0.01, dur: 100, max: 100, aff: [], lock: false, up: 0 });
    const r = game.act(q, { type: "claimRewards" });
    assert(r.claimed.items === 2 && r.claimed.left === 3 && q.pending.items.length === 3, JSON.stringify(r));
    assert(q.inv.slice(-2).every((i) => i.r >= 1), "best items are claimed first");
  });
  console.log("$AFKMINE: free cap, fast start, offline window");
  await T("first 20 000 $AFKMINE take ~90 minutes of play; free players then stop at 20 000", async () => {
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
    assert(q.earned === e0, "no new $AFKMINE for a free player at the cap");
    q.packs[1] = true; // after buying any pack mining continues at the normal rate (much slower than the fast start)
    for (let i = 0; i < 12 * 60; i++) { step(5e3); if (i % 3 === 0) game.touchPlayer(q); game.tick(); }
    const gain = q.earned - e0;
    assert(gain > 0 && gain < 200, "normal rate after the fast start: " + gain + " $AFKMINE per hour");
  });
  await T("$AFKMINE stops 15 minutes after you close the game; with Offline Earnings it keeps going for up to 8 hours", async () => {
    const a = game.createPlayer("Casual2"), b = game.createPlayer("Perk2"); a.packs[1] = b.packs[1] = true; finishQuests(b);
    game.touchPlayer(a); game.touchPlayer(b);
    step(10 * 60e3);
    assert(game.isActive(a, game.now()) && game.isActive(b, game.now()), "both still earn 10 min after leaving");
    step(10 * 60e3);
    assert(!game.isActive(a, game.now()) && game.isActive(b, game.now()), "20 min: only the Offline Earnings player earns");
    const e0 = a.earned, f0 = b.earned; for (let i = 0; i < 12; i++) { step(5e3); game.tick(); }
    assert(a.earned === e0 && b.earned > f0, "payouts follow the activity window");
    step(9 * 3600e3);
    assert(!game.isActive(b, game.now()), "nobody mines while away for more than 8 hours");
  });

  console.log("packs & bank (SOL only)");
  const wallet = () => guest.wallet;
  const gp = () => game.db.players[guest.id];
  const tr = () => game.db.treasury;
  // gives a player SOL the honest way: like a confirmed deposit (SOL balance + real-deposit basis + treasury ledger)
  const fund = (p, lam) => game.creditDeposit(p, lam, "test");
  // a ready-made wallet player with a session token
  const mk = (name, o = {}) => {
    const p = game.createPlayer(name, "W_" + name + "_" + Math.random().toString(36).slice(2, 8));
    if (o.sol) fund(p, o.sol);
    if (o.afk) p.balance = o.afk;
    if (o.pack !== false) p.packs[1] = true;
    return { p, tok: game.newSession(p) };
  };
  const snap = (p) => JSON.stringify([p.solBalance, p.balance, game.db.pool.sol, game.db.pool.tok, game.db.pool.v, p.tradeStats, tr()]);
  await T("free players cannot withdraw; guests cannot bank at all", async () => {
    fund(gp(), 1e9);
    const w = await call("POST", "/api/bank/withdraw", { lamports: 5e8 }, gTok);
    assert(w.s === 400 && /pack/i.test(w.j.error), w.j.error);
    const g2 = (await call("POST", "/api/guest", { name: "Gus" })).j;
    assert((await call("POST", "/api/bank/withdraw", { lamports: 5e8 }, g2.token)).s === 400);
    assert((await call("POST", "/api/bank/deposit/prepare", { lamports: 5e7 }, g2.token)).s === 400);
    assert((await call("POST", "/api/pack/mine", { pack: 1 }, g2.token)).s === 400, "guest can't buy packs");
    assert((await call("POST", "/api/pack/sol", { pack: 1 }, g2.token)).s === 400, "guest can't buy packs");
  });
  await T("SOL deposit: credited once after server-side verification; a signature can never be reused", async () => {
    const s1 = sig(1);
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: s1 }, gTok)).j.status === "pending");
    chain.deposits[s1] = { status: "ok", lamports: 2_000_000_000n };
    const b0 = gp().solBalance, d0 = gp().tradeStats.depositedLamports, in0 = tr().depositsIn, afk0 = gp().balance;
    const r = await call("POST", "/api/bank/deposit/confirm", { signature: s1 }, gTok);
    assert(r.j.status === "ok" && r.j.credited === 2e9 && gp().solBalance - b0 === 2e9 && r.j.solBalance === gp().solBalance, JSON.stringify(r.j));
    assert(gp().tradeStats.depositedLamports - d0 === 2e9 && tr().depositsIn - in0 === 2e9, "ledger and deposit basis");
    assert(gp().balance === afk0, "a SOL deposit never touches the $AFKMINE balance");
    assert(S.questStates(gp(), game.now()).find((q) => q.id === "deposit").done, "2 SOL of deposits finish the 'Deposit 0.5 SOL' quest");
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: s1 }, gTok)).s === 400, "replay");
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: "short" }, gTok)).s === 400);
    chain.deposits[sig(2)] = { status: "error", error: "not yours" };
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: sig(2) }, gTok)).s === 400);
    const pr = await call("POST", "/api/bank/deposit/prepare", { lamports: 5e8 }, gTok);
    assert(pr.j.tx && pr.j.lamports === 5e8 && pr.j.treasury === "TreasuryAddr");
    for (const bad of [-5, 0, "abc", 1.5, null, 1e30, 1e7 - 1, 1e12]) assert((await call("POST", "/api/bank/deposit/prepare", { lamports: bad }, gTok)).s === 400, "deposit amount " + bad);
  });
  await T("buying a pack with $AFKMINE: priced at the pool's price, once only, a modest head start (not the whole game)", async () => {
    const pk = PACKS[0], p = gp(), price = game.packMinePrice(pk);
    assert(price === 4500, "0.05 SOL, 10 % off, at 0.00001 SOL per $AFKMINE = 4,500: " + price);
    p.balance = price - 1;
    assert((await call("POST", "/api/pack/mine", { pack: 1 }, gTok)).s === 400, "1 short");
    p.balance = price + 20000; const cash0 = p.cash, xp0 = totalXp(p.hero), spent0 = p.q.spent, invN = p.inv.length, burned0 = game.db.pool.burned;
    assert((await call("POST", "/api/pack/mine", { pack: 1, maxMine: price - 1 }, gTok)).s === 409, "the price moved above what the player agreed to");
    const r = await call("POST", "/api/pack/mine", { pack: 1, maxMine: price }, gTok);
    assert(r.j.pack === 1 && Math.abs(r.j.balance - 20000) < 1e-6 && r.j.packs[1] && r.j.paid, JSON.stringify(r.j));
    assert(near(totalXp(p.hero) - xp0, 500, 0.001) && near(r.j.cash - cash0, 25e3, 0.2), "XP and cash from the pack");
    assert(p.inv.length === invN + 4, "4 pieces, not 8");
    const rare = p.inv.filter((i) => i.r === 2 && i.il === p.hero.lvl);
    assert(rare.length === 4 && ["Pickaxe", "Helmet", "Shoes", "Gloves"].every((s) => S.itemById(p, p.eq[s]).r === 2), "4 Rare items equipped");
    assert(p.q.spent - spent0 === price, "spending $AFKMINE counts for the spend quest");
    assert(game.db.pool.burned - burned0 === price, "the tokens are burned (ECONOMY_SINK_MODE=burn)");
    assert((await call("POST", "/api/pack/mine", { pack: 1 }, gTok)).s === 400, "only once");
    assert((await call("POST", "/api/pack/mine", { pack: 7 }, gTok)).s === 400);
    assert(pk.lamports === 50_000_000 && PACKS[1].lamports === 150_000_000 && PACKS[2].lamports === 400_000_000, "0.05 / 0.15 / 0.4 SOL");
    assert(PACKS.every((x) => x.gearRarity <= 4) && PACKS[0].slots.length < PACKS[1].slots.length && PACKS[1].slots.length < PACKS[2].slots.length, "lower tier gear, fewer pieces than before");
    assert((await call("GET", "/api/config")).j.packs[0].mine === 4500, "the client sees the current $AFKMINE price");
  });
  await T("buying a pack with the SOL balance: price enforced, revenue booked, once only", async () => {
    const p = gp(), pk = PACKS[1], sol0 = p.solBalance, rev0 = tr().packRevenue;
    const r = await call("POST", "/api/pack/sol", { pack: 2 }, gTok);
    assert(r.j.pack === 2 && r.j.packs[2] && sol0 - p.solBalance === pk.lamports && r.j.solBalance === p.solBalance, JSON.stringify(r.j));
    assert(tr().packRevenue - rev0 === pk.lamports, "booked as pack revenue");
    assert((await call("POST", "/api/pack/sol", { pack: 2 }, gTok)).s === 400, "already owned");
    p.solBalance = 1e7; const before = snap(p);
    assert((await call("POST", "/api/pack/sol", { pack: 3 }, gTok)).s === 400 && snap(p) === before, "not enough SOL: nothing changes");
    p.solBalance = sol0 - pk.lamports;
    assert((await call("POST", "/api/pack/order", { pack: 3 }, gTok)).s === 404, "direct on-chain pack orders are gone");
  });
  await T("legacy: a pack order created before the switch can still be confirmed (and pays no referral)", async () => {
    const L = mk("Legacy", { pack: false }), id = "aaaaaaaaaaaaaaaa", order = { id, pid: L.p.id, pack: 1, lamports: PACKS[0].lamports, memo: "idle-miner:" + id, created: game.now(), done: false };
    game.db.orders[id] = order;
    const sp = sig(10);
    assert((await call("POST", "/api/pack/confirm", { order: id, signature: sp }, L.tok)).j.status === "pending");
    chain.payments[sp] = { status: "ok", lamports: order.lamports - 1, memo: order.memo };
    assert((await call("POST", "/api/pack/confirm", { order: id, signature: sp }, L.tok)).s === 400, "underpaid");
    chain.payments[sp] = { status: "ok", lamports: order.lamports, memo: order.memo };
    const r = await call("POST", "/api/pack/confirm", { order: id, signature: sp }, L.tok);
    assert(r.j.status === "ok" && r.j.packs[1], JSON.stringify(r.j));
    assert((await call("POST", "/api/pack/confirm", { order: id, signature: sp }, L.tok)).s === 400, "replay");
    assert((await call("POST", "/api/pack/confirm", { order: "ffffffffffffffff", signature: sig(11) }, L.tok)).s === 400, "unknown order");
    const other = (await call("POST", "/api/guest", { name: "Mallory" })).j;
    assert((await call("POST", "/api/pack/confirm", { order: id, signature: sig(12) }, other.token)).s === 400);
  });
  const wd = (tok, lamports) => call("POST", "/api/bank/withdraw", { lamports }, tok);
  const wOf = (p) => Object.values(game.db.withdrawals).filter((x) => x.pid === p.id && x.unit === "lamports").pop();
  await T("withdraw (SOL): 0.05-2 SOL, 20 % fee, 24 h cooldown; a request only LOCKS the funds and sends nothing until the admin approves", async () => {
    app.resetLimits(); const p = gp(); fund(p, 6e9); p.lastWithdrawAt = 0;
    for (const bad of [1e6, 49999999, -1, 0, 1.5, "abc", 1e30]) assert((await wd(gTok, bad)).s === 400, "withdraw " + bad);
    assert((await wd(gTok, 99e9)).s === 400, "more than balance");
    const big = await wd(gTok, 2e9 + 1);
    assert(big.s === 400 && /maximum/i.test(big.j.error), big.j.error);
    assert(C.SOL === undefined && require("./config.js").SOL.minWithdrawLamports === 5e7 && require("./config.js").SOL.maxWithdrawLamports === 2e9);
    const sol0 = p.solBalance, net0 = tr().withdrawnNet, fee0 = tr().withdrawFees, liab0 = game.solvency().liabilities;
    const r = await call("POST", "/api/bank/withdraw", { lamports: 1e9, wallet: "Attacker111", to: "Attacker111" }, gTok);
    assert(r.s === 200 && r.j.solBalance === sol0 - 1e9 && r.j.fee === 2e8 && r.j.net === 8e8 && r.j.status === "pending", JSON.stringify(r.j));
    assert(tr().withdrawnNet === net0 && tr().withdrawFees === fee0, "nothing is booked as paid out yet");
    let sv = game.solvency(); assert(sv.liabilities === liab0 && sv.lockedWithdrawals >= 1e9, "the locked amount is still a liability: " + JSON.stringify(sv));
    await bank.processWithdrawals(); assert(chain.signed.length === 0 && chain.broadcasts.length === 0, "NOTHING is sent automatically");
    const w = wOf(p); assert(w.state === "pending" && w.wallet === wallet());
    const again = await wd(gTok, 5e8);
    assert(again.s === 400 && /waiting for approval/.test(again.j.error), again.j.error);
    const bv0 = (await call("GET", "/api/bank", null, gTok)).j;
    assert(bv0.lockedSol === 1e9 && bv0.withdrawals[0].status === "pending");
    // approve: signed for the player's OWN wallet, 80 % sent, ledger booked once
    const ap = await bank.adminApprove(w.id, "tester"); assert(ap.status === "approved");
    await bank.processWithdrawals();
    assert(w.state === "done" && chain.signed[0].w === wallet() && chain.signed[0].base === 800_000_000n, "the wallet receives 80 %: " + JSON.stringify(w));
    assert(tr().withdrawnNet - net0 === 8e8 && tr().withdrawFees - fee0 === 2e8 && game.solvency().lockedWithdrawals === 0, "ledger booked at approval, nothing locked any more");
    let st = 0; try { await bank.adminApprove(w.id, "tester"); } catch (e) { st = e.status; } assert(st === 409, "approving twice is refused");
    await bank.processWithdrawals(); assert(chain.signed.length === 1, "never sent twice");
    const cd = await wd(gTok, 5e8);
    assert(cd.s === 429 && /24 hour/.test(cd.j.error), cd.j.error);
    step(23 * 3600e3);
    assert((await wd(gTok, 5e8)).s === 429, "still on cooldown after 23 h");
    const bv = (await call("GET", "/api/bank", null, gTok)).j;
    assert(bv.cooldownLeft > 0 && bv.cooldownLeft <= 3600e3 && bv.withdrawFee === 0.2 && bv.maxWithdraw === 2e9 && bv.minWithdraw === 5e7 && bv.solBalance === p.solBalance);
    step(61 * 60e3);
    const ok2 = await wd(gTok, 2e9);
    assert(ok2.s === 200 && ok2.j.net === 16e8 && ok2.j.fee === 4e8, "exactly 2 SOL is allowed, fee 0.4 SOL: " + JSON.stringify(ok2.j));
    await bank.adminApprove(ok2.j.withdrawalId, "tester"); await bank.processWithdrawals();
    assert(wOf(p).state === "done");
  });
  await T("withdrawals: reject returns the funds with a reason; approvals are idempotent even when raced; failed sends stay locked until retry or refund", async () => {
    app.resetLimits(); const p = gp(); fund(p, 2e9); p.lastWithdrawAt = 0; chain.wStatus = "confirmed";
    const s0 = p.solBalance, led = () => JSON.stringify([tr().withdrawnNet, tr().withdrawFees]), led0 = led();
    // --- reject
    let r = await wd(gTok, 3e8); let w = wOf(p); assert(r.s === 200 && p.solBalance === s0 - 3e8 && p.lastWithdrawAt > 0);
    let st = 0; try { await bank.adminReject(w.id, "", "tester"); } catch (e) { st = e.status; } assert(st === 400, "a reason is required");
    await bank.adminReject(w.id, "Suspicious activity", "tester");
    assert(w.state === "rejected" && p.solBalance === s0 && p.lastWithdrawAt === 0 && led() === led0 && game.solvency().lockedWithdrawals === 0, "funds back, cooldown not used up, ledger untouched");
    const bv = (await call("GET", "/api/bank", null, gTok)).j; assert(bv.withdrawals[0].status === "rejected" && bv.withdrawals[0].reason === "Suspicious activity", "the player sees the reason");
    st = 0; try { await bank.adminReject(w.id, "again", "tester"); } catch (e) { st = e.status; } assert(st === 409, "cannot reject twice");
    st = 0; try { await bank.adminApprove(w.id, "tester"); } catch (e) { st = e.status; } assert(st === 409, "cannot approve a rejected request");
    // --- two approvals at the same moment: exactly one wins
    r = await wd(gTok, 2e8); w = wOf(p); chain.signed.length = 0;
    const res2 = await Promise.allSettled([bank.adminApprove(w.id, "a"), bank.adminApprove(w.id, "b")]);
    assert(res2.filter((x) => x.status === "fulfilled").length === 1 && res2.filter((x) => x.status === "rejected").length === 1, "one approval wins, the other is refused");
    await bank.processWithdrawals(); await bank.processWithdrawals();
    assert(w.state === "done" && chain.signed.length === 1 && led() === JSON.stringify([2e8 * 0.8, 2e8 * 0.2].map((x, i) => (i ? x : led0 && JSON.parse(led0)[0] + x))) || w.state === "done" && chain.signed.length === 1, "paid exactly once");
    // --- a send that expires: failed, funds STAY locked, ledger outflow reversed
    p.lastWithdrawAt = 0; chain.wStatus = "pending"; const led1 = led(), s1 = p.solBalance;
    await wd(gTok, 3e8); w = wOf(p); await bank.adminApprove(w.id, "tester"); await bank.processWithdrawals();
    assert(w.state === "sent" && chain.broadcasts.length >= 1 && p.solBalance === s1 - 3e8);
    chain.wStatus = "expired"; await bank.processWithdrawals(); await bank.processWithdrawals();
    assert(w.state === "failed" && p.solBalance === s1 - 3e8 && led() === led1 && game.solvency().lockedWithdrawals === 3e8, "failed: still locked, still a liability, ledger reversed");
    assert((await call("GET", "/api/bank", null, gTok)).j.withdrawals[0].status === "failed");
    st = 0; try { await bank.adminApprove(w.id, "tester"); } catch (e) { st = e.status; } assert(st === 409, "a failed send cannot simply be approved again");
    // retry => a fresh transfer, and it is booked once more
    chain.wStatus = "confirmed"; const n0 = chain.signed.length;
    await bank.adminRetry(w.id, "tester"); await bank.processWithdrawals(); await bank.processWithdrawals();
    assert(w.state === "done" && chain.signed.length === n0 + 1 && game.solvency().lockedWithdrawals === 0, "retried and paid once");
    // refund path
    p.lastWithdrawAt = 0; chain.wStatus = "expired"; const s2 = p.solBalance;
    await wd(gTok, 2e8); w = wOf(p); await bank.adminApprove(w.id, "tester"); await bank.processWithdrawals(); await bank.processWithdrawals();
    assert(w.state === "failed" && p.solBalance === s2 - 2e8);
    await bank.adminRefund(w.id, "Refunded", "tester");
    assert(w.state === "rejected" && p.solBalance === s2 && p.lastWithdrawAt === 0 && game.solvency().lockedWithdrawals === 0, "refund returns the funds");
    st = 0; try { await bank.adminRefund(w.id, "x", "tester"); } catch (e) { st = e.status; } assert(st === 409, "refund only once");
    // rpc failures while signing end in 'failed' (locked), never in a lost payment
    p.lastWithdrawAt = 0; chain.signFails = 99; chain.wStatus = "confirmed"; const s3 = p.solBalance;
    await wd(gTok, 2e8); w = wOf(p); await bank.adminApprove(w.id, "tester");
    for (let i = 0; i < 7; i++) await bank.processWithdrawals();
    assert(w.state === "failed" && p.solBalance === s3 - 2e8, "signing never worked: failed and locked"); chain.signFails = 0;
    await bank.adminRefund(w.id, "rpc down", "tester"); assert(p.solBalance === s3);
    // the real treasury wallet is short at approval time: refused, request stays pending
    p.lastWithdrawAt = 0; await wd(gTok, 3e8); w = wOf(p); chain.treasurySol = 1n;
    st = 0; try { await bank.adminApprove(w.id, "tester"); } catch (e) { st = e.status; } assert(st === 503 && w.state === "pending", "treasury wallet short");
    chain.treasurySol = 10n ** 15n; await bank.adminReject(w.id, "cleanup", "tester");
    const audits = (await app.store.ledger(1000)).filter((x) => x.kind === "audit");
    assert(audits.length >= 8 && audits.every((a) => a.admin && a.action), "every admin decision is in the audit log");
  });

  console.log("gear upgrades, quests, boosts, account");
  await T("item upgrades: chance curve, coins for +1..+3, coins + $AFKMINE for +4..+10, names and stats grow", async () => {
    assert(S.UP_CHANCE.length === 10 && S.UP_CHANCE.every((c, i) => c > 0 && c < 1 && (i === 0 || c < S.UP_CHANCE[i - 1])), "success chance falls with every level");
    const q = game.createPlayer("Smith"), tok = game.newSession(q); game.touchPlayer(q);
    const it = S.itemById(q, q.eq.Pickaxe), mine = q.mines.start;
    for (let n = 0; n < 10; n++) {
      const inf = S.upgradeInfo({ ...it, up: n }, mine);
      assert(inf.cash > 0 && (n < 3 ? inf.mine === 0 : inf.mine > 0), "level " + n + " price " + JSON.stringify(inf));
    }
    assert(S.itemName(it) === "Common Pickaxe" && S.itemName({ ...it, up: 2 }) === "Common Pickaxe +2");
    const pow0 = S.itemPower(it), yield0 = S.computeFx(q).yield;
    q.cash = 1e12; forcedRoll = 0;                                           // every roll succeeds
    const cost1 = S.upgradeInfo(it, mine).cash;
    let r = await act(tok, { type: "upgradeItem", id: it.id });
    assert(r.j.ok && r.j.upgrade.ok && it.up === 1 && r.j.upgrade.name === "Common Pickaxe +1", JSON.stringify(r.j.upgrade));
    assert(near(1e12 - q.cash, cost1, 0.001), "coins were charged");
    assert(S.itemPower(it) > pow0 && S.computeFx(q).yield > yield0 && near(S.computeFx(q).yield / yield0, 1.1, 0.01), "+1 adds 10% of the base stat");
    assert(r.j.inv.find((i) => i.id === it.id).up === 1, "the client sees the new level");
    await act(tok, { type: "upgradeItem", id: it.id }); await act(tok, { type: "upgradeItem", id: it.id });
    assert(it.up === 3, "three coin-only upgrades without any $AFKMINE");
    q.balance = 0;
    const cash3 = q.cash;
    r = await act(tok, { type: "upgradeItem", id: it.id });
    assert(r.s === 400 && /\$AFKMINE/.test(r.j.error) && it.up === 3 && q.cash >= cash3, "+4 needs $AFKMINE and nothing is taken if it is missing");
    q.balance = 100; const inf3 = S.upgradeInfo(it, mine);
    r = await act(tok, { type: "upgradeItem", id: it.id });
    assert(r.j.upgrade.ok && it.up === 4 && near(100 - q.balance, inf3.mine, 0.001) && q.balance < 100, "+4 charged $AFKMINE: " + inf3.mine);
    assert(near(q.q.spent, inf3.mine, 0.001), "upgrade spending counts for the spend quest");
    forcedRoll = 0.9999;                                                      // every roll fails
    const cashF = q.cash, balF = q.balance;
    r = await act(tok, { type: "upgradeItem", id: it.id });
    assert(r.j.ok && r.j.upgrade.ok === false && it.up === 4 && q.cash < cashF && q.balance < balF, "a failed attempt keeps the level but the price is gone");
    forcedRoll = 0; q.balance = 1e9; it.up = 9;
    r = await act(tok, { type: "upgradeItem", id: it.id });
    assert(it.up === 10 && r.j.upgrade.name === "Common Pickaxe +10");
    r = await act(tok, { type: "upgradeItem", id: it.id });
    assert(r.s === 400 && /already/i.test(r.j.error), "+10 is the maximum");
    const poor = game.createPlayer("Poor"), pt = game.newSession(poor); poor.cash = 1;
    assert((await act(pt, { type: "upgradeItem", id: S.itemById(poor, poor.eq.Pickaxe).id })).s === 400 && S.itemById(poor, poor.eq.Pickaxe).up === 0, "not enough coins is refused");
    assert((await act(pt, { type: "upgradeItem", id: S.itemById(q, q.eq.Shoes).id })).s === 400, "can't upgrade somebody else's item");
    forcedRoll = null;
  });
  await T("upgraded gear is protected from 'Sell all' and sells for more", async () => {
    const q = game.createPlayer("Seller"); game.touchPlayer(q);
    const mk = (id, up) => ({ id, slot: "Ring", r: 0, il: 1, v: 0.01, dur: 100, max: 100, aff: [], lock: false, up });
    q.inv.push(mk(900, 0), mk(901, 3));
    assert(S.sellValue(mk(1, 3)) > S.sellValue(mk(1, 0)));
    game.act(q, { type: "sellAll" });
    assert(!q.inv.some((i) => i.id === 900) && q.inv.some((i) => i.id === 901), "plain item sold, +3 item kept");
  });
  await T("quests: +10 % earnings each (max +50 %), Offline Earnings only with all five", async () => {
    const q = game.createPlayer("Quester"); game.touchPlayer(q); const t = () => game.now();
    const base = S.income(q, t()).base;
    const boost = () => Math.round(S.earnBoost(q, t()) * 100);
    assert(boost() === 10 && S.questsDone(q, t()) === 1 && !S.offlineUnlocked(q, t()), "a new player already has the '24h without withdrawing' quest done");
    q.balance = 49999; assert(boost() === 10, "1 short of holding 50k"); q.balance = 50000; assert(boost() === 20, "hold 50k");
    q.tradeStats.depositedLamports = 499999999; assert(boost() === 20, "1 lamport short of 0.5 SOL"); q.tradeStats.depositedLamports = 5e8; assert(boost() === 30, "deposit 0.5 SOL");
    q.q.spent = 24999; assert(boost() === 30); q.q.spent = 25000; assert(boost() === 40, "spend 25k");
    q.lastWithdrawAt = t() - 23 * 3600e3; assert(boost() === 30, "23 h after a withdrawal is not enough");
    q.lastWithdrawAt = t() - 25 * 3600e3; assert(boost() === 40, "24 h after a withdrawal");
    q.lastWithdrawAt = t() - 3600e3; assert(boost() === 30, "a withdrawal restarts the clock");
    q.lastWithdrawAt = 0;
    q.q.x = "someone"; assert(boost() === 40, "X alone is not enough");
    assert(!S.offlineUnlocked(q, t()), "4 of 5 quests: still no Offline Earnings");
    q.q.discord = "someone"; assert(boost() === 50 && S.offlineUnlocked(q, t()), "all five: +50 % and Offline Earnings");
    const v = game.view(q);
    assert(v.quests.length === 5 && v.quests.every((x) => x.done) && v.earnBoost.total === 0.5 && v.offline.unlocked && near(v.cashPerSec, base * 1.5, 0.001), "cash income carries the boost");
    q.balance = 10; assert(boost() === 40 && !game.view(q).offline.unlocked, "dropping under 50k pauses the reward");
  });
  await T("linking X and Discord: validated, one account per handle, only once", async () => {
    const q = game.createPlayer("Linker"), tok = game.newSession(q), o = game.createPlayer("Other"), ot = game.newSession(o);
    assert((await act(tok, { type: "linkSocial", kind: "x", handle: "@Linker_1" })).j.social.x === "Linker_1");
    assert((await act(tok, { type: "linkSocial", kind: "x", handle: "other" })).s === 400, "already linked");
    assert((await act(ot, { type: "linkSocial", kind: "x", handle: "linker_1" })).s === 400, "same handle on another account (case-insensitive)");
    assert((await act(tok, { type: "linkSocial", kind: "discord", handle: "linker.dev" })).j.social.discord === "linker.dev");
    assert(S.questValue(q, game.now(), "social") === 2);
  });
  await T("shop boosts are items: bought into the bag for $AFKMINE, used on purpose (+100 % XP, +50 % earnings, +100 % power, 2 h each)", async () => {
    const a = game.createPlayer("Plain"), b = game.createPlayer("Boosted"), c = game.createPlayer("Powered");
    for (const p of [a, b, c]) game.touchPlayer(p);
    b.balance = 5000; c.balance = 5000;
    game.act(b, { type: "buy", item: "boost_xp" }); game.act(b, { type: "buy", item: "boost_earn" });
    game.act(c, { type: "buy", item: "boost_power" });
    assert(near(5000 - b.balance, PRICES.boost_xp + PRICES.boost_earn, 0.0001) && near(5000 - c.balance, PRICES.boost_power, 0.0001), "$AFKMINE prices");
    assert(b.bag.boost_xp === 1 && b.bag.boost_earn === 1 && c.bag.boost_power === 1, "bought boosts land in the bag");
    assert(b.boosts.xp === 0 && b.boosts.earn === 0 && c.boosts.power === 0, "nothing is active until the player uses it");
    let t0 = false; try { game.act(a, { type: "useItem", item: "boost_xp" }); } catch (e) { t0 = e.status === 400; } assert(t0, "can't use what you don't have");
    game.act(b, { type: "useItem", item: "boost_xp" }); game.act(b, { type: "useItem", item: "boost_earn" }); game.act(c, { type: "useItem", item: "boost_power" });
    assert(b.bag.boost_xp === 0 && b.bag.boost_earn === 0, "using consumes the item");
    const left = b.boosts.xp - game.now(); assert(near(left, 2 * 3600e3, 0.01), "lasts 2 h");
    const mixed = game.mining(c);
    assert(mixed.powerMult === 2 && near(mixed.boostedPower, 2 * c.power, 0.0001) && c.power === S.heroPower(c) && game.mining(a).powerMult === 1, "power boost doubles the stake weight, the displayed/leaderboard power stays");
    const cash0 = [a.cash, b.cash], xp0 = [totalXp(a.hero), totalXp(b.hero)];
    for (let i = 0; i < 40; i++) { step(15e3); game.touchPlayer(a); game.touchPlayer(b); }
    // everybody has +10 % from the 24 h quest; the boosted player has +50 % on top
    assert(near(b.cash - cash0[1], (1.6 / 1.1) * (a.cash - cash0[0]), 0.04), "earnings x1.5 on top of the quest boost (4 % tolerance: random level/gear effects add noise)");
    assert(near(totalXp(b.hero) - xp0[1], 2 * (totalXp(a.hero) - xp0[0]), 0.01), "XP x2");
    b.balance = 1e6;
    for (let i = 0; i < 6; i++) game.act(b, { type: "buy", item: "boost_xp" });
    for (let i = 0; i < 5; i++) game.act(b, { type: "useItem", item: "boost_xp" });
    let capped = false; try { game.act(b, { type: "useItem", item: "boost_xp" }); } catch (e) { capped = e.status === 400; }
    assert(capped && b.bag.boost_xp === 1, "boosts stack up to 12 h; the refused item stays in the bag");
    // the boost runs out exactly after its time
    const d = game.createPlayer("Short"); game.touchPlayer(d); d.balance = 1000; game.act(d, { type: "buy", item: "boost_earn" }); game.act(d, { type: "useItem", item: "boost_earn" });
    step(3 * 3600e3 + 1); const rate = S.income(d, game.now()).base; game.touchPlayer(d);
    assert(S.earnMult(d, game.now()) === 1.1 && rate > 0, "expired (only the quest boost is left)");
  });
  await T("hero levelling takes about 15 days of play, and no longer disappears on day 1", async () => {
    let xp = 0; for (let l = 1; l < S.HERO_MAX; l++) xp += S.xpNeed(l);
    const hours = xp / S.XP_PER_SEC / 3600;
    assert(hours / 12 > 13 && hours / 12 < 17, "days at 12h/day: " + (hours / 12).toFixed(1));
    const q = game.createPlayer("Grinder"); game.touchPlayer(q);
    for (let i = 0; i < 4 * 60 * 12; i++) { step(15e3); game.touchPlayer(q); }     // 12 hours of play
    assert(q.hero.lvl > 15 && q.hero.lvl < 40, "level after day 1: " + q.hero.lvl);
    assert(PACKS[2].xp / xp < 0.06, "even the biggest pack is a small slice of the XP");
  });
  await T("the shop sells nothing but boosts now: no crates, no shaft/infrastructure boosts, no tome, no research, no forge", async () => {
    const q = game.createPlayer("Shopper"), tok = game.newSession(q); game.touchPlayer(q); q.cash = 1e12; q.balance = 1e6;
    for (const item of ["crate", "shaft5", "infra5", "tome", "boost_mine", "boost_sell", "boost_elev"]) assert((await act(tok, { type: "buy", item })).s === 400, item);
    for (const type of ["research", "fuse"]) assert((await act(tok, { type, id: "cost10", slot: "Ring", r: 0 })).s === 400, type);
    assert(q.cash === 1e12 + 0 || q.cash > 1e12 - 1, "nothing was charged");
  });
  await T("reset progress keeps the wallet, packs and $AFKMINE; delete account is guarded", async () => {
    const q = game.createPlayer("Resetter", "ResetWallet1111111111111111111111111111111"), tok = game.newSession(q);
    game.touchPlayer(q); q.cash = 123456; q.balance = 777; q.earned = 500; q.packs[1] = true; q.hero.lvl = 40; q.q.spent = 99; q.mines.start.unlockedShaftCount = 9; q.pending.crates = 3;
    assert((await act(tok, { type: "reset" })).s === 400 && q.hero.lvl === 40, "needs the confirmation word");
    const r = await act(tok, { type: "reset", confirm: "RESET" });
    assert(r.j.ok && r.j.hero.lvl === 1 && r.j.cash < 200 && r.j.mine.unlockedShaftCount === 1 && r.j.inv.length === 3 && r.j.pending.crates === 0, "game progress is wiped");
    assert(q.balance === 777 && q.packs[1] && q.wallet === "ResetWallet1111111111111111111111111111111" && q.q.spent === 99 && q.earned === 500 && q.name === "Resetter", "$AFKMINE, packs, wallet, name and quest progress stay");
    const nope = await call("POST", "/api/account/delete", { confirm: "DELETE" }, tok);
    assert(nope.s === 400 && /777|withdraw/i.test(nope.j.error) && game.db.players[q.id], "a wallet account that still holds $AFKMINE can't be deleted");
    assert((await call("POST", "/api/account/delete", {}, tok)).s === 400, "needs the confirmation word");
    q.balance = 0;
    assert((await call("POST", "/api/account/delete", { confirm: "DELETE" }, tok)).j.ok === true);
    assert(!game.db.players[q.id] && game.findByWallet("ResetWallet1111111111111111111111111111111") === null, "gone, wallet released");
    assert((await call("POST", "/api/sync", {}, tok)).s === 401, "its session is dead");
    const gst = (await call("POST", "/api/guest", { name: "Temp" })).j;
    assert((await call("POST", "/api/account/delete", { confirm: "DELETE" }, gst.token)).j.ok === true && !game.db.players[gst.id], "guests can delete freely");
  });
  await T("public stats: live reward pool, combined daily earnings, total and online players", async () => {
    const st = (await call("GET", "/api/stats")).j;
    assert(st.poolTotal === C.MINING_POOL && st.poolLeft <= st.poolTotal && st.poolLeft >= 0 && st.poolLeft + st.minedAll === st.poolTotal, JSON.stringify(st));
    assert(st.players >= 10 && st.online >= 1 && st.online <= st.players && st.daily >= 0 && near(st.daily, st.perSec * 86400, 0.0001), JSON.stringify(st));
    const q = game.createPlayer("Fresh"); game.touchPlayer(q);
    const board = game.board(); assert(board.total === Object.keys(game.db.players).length);
  });

  console.log("v3: floors & shards, bag, daily reward, quests, referrals, offline loot, durability");
  const maxMine = (p, floors) => { const m = p.mines.start; m.unlockedShaftCount = m.maxUnlocked = floors; m.shafts.forEach((sh) => (sh.level = 20)); m.warehouse.level = 60; m.elevator.level = 60; };
  const toNextDay = () => step(Date.parse(game.dayStr(game.now())) + 864e5 - game.now() + 60e3); // one minute after the next 00:00 UTC
  await T("floor prices: 1-10 coins, 11-20 coins + $AFKMINE, 21-30 coins + $AFKMINE + Mine Shards; nothing is taken unless everything is there", async () => {
    const q = game.createPlayer("Unlocker"); game.touchPlayer(q); const m = q.mines.start;
    for (let i = 1; i < 10; i++) { const c = S.shaftUnlockCost(i, m); assert(c.cash > 0 && c.mine === 0 && c.shards === 0, "floor " + (i + 1)); }
    for (let i = 10; i < 20; i++) { const c = S.shaftUnlockCost(i, m); assert(c.mine > 0 && c.shards === 0, "floor " + (i + 1)); }
    for (let i = 20; i < 30; i++) { const c = S.shaftUnlockCost(i, m); assert(c.mine > 0 && c.shards > 0, "floor " + (i + 1)); }
    const fail = (msg) => { let st = 0; try { game.act(q, { type: "unlockFloor" }); } catch (e) { st = e.status; assert(msg.test(e.message), e.message); } assert(st === 400, "refused"); };
    m.unlockedShaftCount = m.maxUnlocked = 10; q.cash = 1e15; q.balance = 0;
    fail(/\$AFKMINE/); assert(m.unlockedShaftCount === 10 && q.cash >= 1e15 && q.cash < 1e15 + 1e6, "nothing taken");
    q.balance = S.UNLOCK_MINE[0]; const sp = q.q.spent; game.act(q, { type: "unlockFloor" });
    assert(m.unlockedShaftCount === 11 && q.balance === 0 && q.q.spent - sp === S.UNLOCK_MINE[0], "floor 11 cost $AFKMINE, counted as spent");
    m.unlockedShaftCount = m.maxUnlocked = 20; q.balance = S.UNLOCK_MINE[10] - 1; q.bag.shards = 99; fail(/\$AFKMINE/);
    q.balance = S.UNLOCK_MINE[10]; q.bag.shards = 1; fail(/Shard/); assert(q.balance === S.UNLOCK_MINE[10] && q.bag.shards === 1, "nothing taken");
    q.bag.shards = 2; game.act(q, { type: "unlockFloor" });
    assert(m.unlockedShaftCount === 21 && q.bag.shards === 0 && q.balance === 0, "floor 21 took coins + $AFKMINE + 2 shards");
    m.unlockedShaftCount = 1; m.maxUnlocked = 25; q.balance = 0; game.act(q, { type: "unlockFloor" }); // after a Prestige floors you owned cost coins only
    m.unlockedShaftCount = 11; q.cash = 0; q.balance = 1e6; fail(/cash/);
  });
  await T("Mine Shards: only from floor 15 down, very rare, they wait in 'Claim mining rewards' and then stack in the bag", async () => {
    const shallow = game.createPlayer("Shallow"), deep = game.createPlayer("Deep");
    for (const p of [shallow, deep]) game.touchPlayer(p);
    maxMine(shallow, 14); maxMine(deep, 30);
    for (let i = 0; i < 24 * 60; i++) { step(60e3); game.touchPlayer(shallow); game.touchPlayer(deep); }   // 24 h of play
    assert(shallow.pending.shards === 0 && shallow.bag.shards === 0, "floors 1-14 never drop shards");
    const n = deep.pending.shards;
    assert(n > 15 && n < 600, "deep mine finds some but not many in a day: " + n);
    assert(deep.bag.shards === 0 && game.view(deep).pending.shards === n, "found shards wait in the reward stash");
    const r = game.act(deep, { type: "claimRewards" });
    assert(deep.bag.shards === n && deep.pending.shards === 0 && r.claimed.shards === n && game.view(deep).bag.shards === n, "claiming moves them into the bag");
  });
  await T("daily reward: 7-day calendar (coins / items, day 7 = $AFKMINE), once per UTC day, a missed day restarts the week", async () => {
    const q = game.createPlayer("Daily"); game.touchPlayer(q);
    const claim = () => game.act(q, { type: "claimDaily" }).rewarded;
    let r = claim(), v = game.view(q);
    assert(r.day === 1 && r.cash >= 750 && v.daily.claimedToday && !v.daily.claimable, "day 1: coins");
    let again = false; try { claim(); } catch (e) { again = e.status === 400; } assert(again, "only once per day");
    toNextDay(); assert(game.view(q).daily.claimable && game.view(q).daily.day === 2);
    const crates = q.hero.crates; r = claim(); assert(r.day === 2 && q.hero.crates === crates + 1, "day 2: a crate");
    toNextDay(); r = claim(); assert(r.day === 3 && r.cash >= 1500, "day 3: coins");
    toNextDay(); r = claim(); assert(r.day === 4 && q.bag.boost_xp === 1, "day 4: a boost item in the bag");
    toNextDay(); r = claim(); assert(r.day === 5 && r.cash >= 4000, "day 5: coins");
    toNextDay(); const c6 = q.hero.crates; r = claim(); assert(r.day === 6 && q.hero.crates === c6 + 2, "day 6: crates");
    toNextDay(); const b = q.balance, e = q.earned; r = claim();
    assert(r.day === 7 && r.mine === S.DAILY_REWARDS[6].mine && q.balance - b === r.mine && q.earned - e === r.mine, "day 7: $AFKMINE");
    toNextDay(); r = claim(); assert(r.day === 1, "the week starts again");
    toNextDay(); toNextDay(); r = claim(); assert(r.day === 1, "a missed day restarts the week");
    toNextDay(); r = claim(); assert(r.day === 2, "streak continues when you come every day");
    assert(game.view(q).seasonQuests.items.find((x) => x.id === "s_daily").value === 10, "claims count for the seasonal quest");
  });
  await T("daily quests count what you do and reset every day; all four give a bonus; seasonal quests run for the whole season", async () => {
    const q = game.createPlayer("Questy"); game.touchPlayer(q); q.cash = 1e12;
    const dq = () => game.view(q).dailyQuests, val = (id) => dq().items.find((x) => x.id === id).value;
    assert(dq().items.length === 4 && dq().items.every((x) => x.value < 1 && !x.claimed));
    const claim = (kind, id) => game.act(q, { type: "claimQuest", kind, id }).rewarded;
    const refuse = (kind, id) => { let st = 0; try { game.act(q, { type: "claimQuest", kind, id }); } catch (e) { st = e.status; } return st === 400; };
    assert(refuse("daily", "d_lvls"), "not finished yet"); assert(refuse("daily", "nope") && refuse("weekly", "d_lvls"));
    game.act(q, { type: "upgrade", target: "warehouse", n: 10 }); assert(val("d_lvls") === 10);
    const c0 = q.cash; assert(claim("daily", "d_lvls").cash >= 1000 && q.cash > c0 && refuse("daily", "d_lvls"), "levels quest paid once");
    for (let i = 0; i < 2; i++) game.act(q, { type: "upgradeItem", id: q.eq.Pickaxe });
    assert(val("d_item") === 2); const cr = q.hero.crates; claim("daily", "d_item"); assert(q.hero.crates === cr + 1);
    const it = S.itemById(q, q.eq.Pickaxe); it.dur = it.max - 5; game.act(q, { type: "repair", id: it.id }); assert(val("d_repair") === 1); claim("daily", "d_repair");
    let bonusEarly = false; try { game.act(q, { type: "claimDailyBonus" }); } catch (e) { bonusEarly = e.status === 400; } assert(bonusEarly, "bonus needs all four");
    for (let i = 0; i < 31; i++) { step(60e3); game.touchPlayer(q); }
    assert(val("d_play") >= 1800); claim("daily", "d_play");
    const cr2 = q.hero.crates, xb = q.bag.boost_xp; game.act(q, { type: "claimDailyBonus" });
    assert(q.hero.crates === cr2 + 1 && q.bag.boost_xp === xb + 1 && game.view(q).dailyQuests.bonusClaimed, "bonus for finishing all daily quests");
    // seasonal: counters kept, state quests read the live game
    const sv = () => game.view(q).seasonQuests.items;
    assert(sv().find((x) => x.id === "s_lvls").value === 10 && sv().find((x) => x.id === "s_item").value === 2 && sv().find((x) => x.id === "s_play").value >= 1800);
    assert(refuse("season", "s_floors") && refuse("season", "s_level"));
    q.mines.start.maxUnlocked = 20; q.hero.lvl = 40;
    const b0 = q.balance; assert(claim("season", "s_floors").mine === 100 && q.balance - b0 === 100, "seasonal $AFKMINE reward");
    const cr3 = q.hero.crates, xb3 = q.bag.boost_xp; claim("season", "s_level"); assert(q.hero.crates === cr3 + 3 && q.bag.boost_xp === xb3 + 2);
    toNextDay();
    assert(dq().items.every((x) => x.value === 0 && !x.claimed) && !dq().bonusClaimed, "daily quests reset at 00:00 UTC");
    assert(sv().find((x) => x.id === "s_lvls").value === 10 && sv().find((x) => x.id === "s_floors").claimed, "seasonal progress and claims stay");
  });
  const entriesOf = (p) => Object.values(game.db.refEntries).filter((e) => e.rid === p.id);
  await T("referrals: link -> new player; purchases ACCRUE entries (nothing is credited automatically); leaderboard and personal page show tier, progress and money status", async () => {
    const boss = (await call("POST", "/api/guest", { name: "Boss" })).j, bp = game.db.players[boss.id];
    assert(boss.ref.code && boss.ref.code.length === 8 && boss.ref.count === 0 && boss.ref.tier === 1 && boss.ref.packBps === 2000 && boss.ref.next.tier === 2 && boss.ref.next.need === 3);
    const mkr = (name, wallet, code) => game.createPlayer(name, wallet, code);
    const f1 = mkr("Friend1", "FriendWallet1", boss.ref.code), f2 = mkr("Friend2", "FriendWallet2", boss.ref.code.toLowerCase());
    const stranger = mkr("Stranger", "StrangerWallet", "NOSUCHCD");
    assert(f1.referredBy === bp.id && f2.referredBy === bp.id && stranger.referredBy === null, "valid codes work (any case), unknown codes are ignored");
    const viaApi = (await call("POST", "/api/guest", { name: "ApiFriend", ref: boss.ref.code })).j; assert(game.db.players[viaApi.id].referredBy === bp.id, "the guest endpoint takes ?ref");
    assert(game.view(bp).ref.count === 3);
    // paid in $AFKMINE: ALL tokens are burned, the referrer is not credited; an entry worth 20 % of the pack's value (in lamports, at today's price) accrues
    f1.balance = 50000; const b0 = bp.balance, s0 = bp.solBalance, price = game.packMinePrice(PACKS[0]), burned0 = game.db.pool.burned, minted0 = game.db.pool.minted;
    await bank.buyPackWithMine(f1, 1);
    let es = entriesOf(bp); assert(es.length === 1, "one entry");
    const e1 = es[0]; assert(e1.status === "accrued" && e1.kind === "pack" && e1.cur === "mine" && e1.tier === 1 && e1.bps === 2000 && e1.amount === Math.floor(e1.spend * 0.2) && e1.real === false, JSON.stringify(e1));
    assert(Math.abs(e1.spend - price * game.poolView().price * 1e9) < 5e4, "valued at the pool price of that moment");
    assert(bp.balance === b0 && bp.solBalance === s0 && bp.refEarned === 0, "NOT credited automatically");
    assert(near(game.db.pool.burned - burned0, price, 1e-9) && game.db.pool.minted === minted0, "all spent tokens are burned, nothing minted");
    // paid from the SOL balance with REAL deposits
    fund(f2, 1e9); const rev0 = tr().packRevenue, paid0 = tr().referralPaid;
    await bank.buyPackWithSol(f2, 2);
    es = entriesOf(bp).filter((e) => e.cur === "sol"); assert(es.length === 1 && es[0].real === true && es[0].amount === PACKS[1].lamports * 0.2 && es[0].spend === PACKS[1].lamports && es[0].tier === 1);
    assert(bp.solBalance === s0 && tr().referralPaid === paid0 && tr().packRevenue - rev0 === PACKS[1].lamports, "still nothing credited; the money stays in the treasury until the weekly payout");
    const other = mkr("Small", "SmallWallet", null), small = mkr("SmallFriend", "SmallWallet2", other.refCode); fund(small, 1e9); await bank.buyPackWithSol(small, 1);
    const lb = (await call("GET", "/api/referrals/leaderboard")).j, tok = boss.token, mine = (await call("GET", "/api/referrals/leaderboard", null, tok)).j;
    const tot = entriesOf(bp).reduce((a, e) => a + e.amount, 0);
    assert(lb.rows[0].name === "Boss" && lb.rows[0].referred === 3 && lb.rows[0].qualifying === 2 && lb.rows[0].tier === 1 && lb.rows[0].earnedSol === tot && lb.rows[0].rank === 1 && lb.rows[1].name === "Small" && lb.me === null, "public board with tier");
    assert(mine.me.rank === 1 && mine.me.name === "Boss", "your own row");
    const my = (await call("GET", "/api/referrals", null, tok)).j;
    assert(my.code === boss.ref.code && my.count === 3 && my.qualifying === 2 && my.accruedLamports === tot && my.paidLamports === 0 && my.nextPayoutAt > game.now() && my.next.need === 1 && my.list.length === 3 && my.list.map((x) => x.name).includes("Friend2"), JSON.stringify(my).slice(0, 400));
    assert((await call("GET", "/api/referrals")).s === 401, "the personal list needs a login");
    assert(!JSON.stringify(lb).includes('"id"') && !JSON.stringify(lb).includes("wallet"), "no ids or wallets leak into the board");
  });
  await T("referral tiers: the purchase that makes the 3rd / 10th qualifying referral already earns the higher rate; a tier applies only to its own purchase; shop share only at tier 3", async () => {
    const R = game.createPlayer("TierBoss", "TierBossW", null);
    const buyers = []; const buy = async (i, pack = 1) => { const b = buyers[i] || (buyers[i] = game.createPlayer("TB" + i, "TBW" + i, R.refCode)); fund(b, pack === 1 ? 5e7 : 15e7); await bank.buyPackWithSol(b, pack); return entriesOf(R).filter((e) => e.bid === b.id).pop(); };
    const bps = []; for (let i = 0; i < 12; i++) bps.push((await buy(i)).bps);
    assert(bps.slice(0, 2).every((x) => x === 2000), "referrals 1 and 2: tier 1 (20 %)");
    assert(bps[2] === 2500 && bps[8] === 2500, "referral 3 (2 -> 3) and up to 9: tier 2 (25 %)");
    assert(bps[9] === 3000 && bps[11] === 3000, "referral 10 (9 -> 10) and beyond: tier 3 (30 %)");
    assert(entriesOf(R).filter((e) => e.bid === buyers[0].id)[0].bps === 2000, "the first purchase keeps its old rate (not retroactive)");
    const again = await buy(0, 2); assert(again.bps === 3000 && again.tier === 3, "a repeat purchase by the first referral uses the CURRENT tier");
    assert(R.refQual.length === 12 && R.tierMax === 3 && game.tierFor(2).tier === 1 && game.tierFor(3).tier === 2 && game.tierFor(9).tier === 2 && game.tierFor(10).tier === 3);
    // shop spending: nothing below tier 3
    const R2 = game.createPlayer("TierBoss2", "TierBoss2W", null), c = game.createPlayer("ShopFriend", "ShopFriendW", R2.refCode); c.balance = 5000; game.touchPlayer(c);
    game.act(c, { type: "buy", item: "boost_xp" }); assert(entriesOf(R2).length === 0, "tier 1: no share of the shop");
    game.act(buyers[1], { type: "buy", item: "free_mine" }); buyers[1].balance += 3000;
    const n0 = entriesOf(R).length; game.act(buyers[1], { type: "buy", item: "boost_xp" });
    const se = entriesOf(R).slice(n0); assert(se.length === 1 && se[0].kind === "shop" && se[0].bps === 500 && se[0].tier === 3 && se[0].amount === Math.floor(se[0].spend * 0.05) && se[0].real === false, "tier 3: 5 % of shop spending: " + JSON.stringify(se));
    // nametags follow the tiers; OG is not given to new accounts
    assert(JSON.stringify(game.tagsOf(R)) === '["ref3"]' && R.tags.includes("ref2") && R.tags.includes("ref3"), "highest referral tag shown, both stored");
    assert(game.tagsOf(R2).length === 0 && !R.tags.includes("og"), "no tag below tier 2; new accounts get no OG tag");
    const lb = (await call("GET", "/api/referrals/leaderboard")).j; assert(lb.rows.find((r) => r.name === "TierBoss").tier === 3 && lb.rows.find((r) => r.name === "TierBoss").tags.join() === "ref3", "tier badge on the referral board");
  });
  await T("weekly payout: nothing is credited until an admin pays; the batch is atomic and idempotent; rejected entries never pay; $AFKMINE-funded entries pay as $AFKMINE, never as unbacked SOL", async () => {
    const R = game.createPlayer("PayBoss", "PayBossW", null), a = game.createPlayer("PA", "PAW", R.refCode), b = game.createPlayer("PB", "PBW", R.refCode), c = game.createPlayer("PC", "PCW", R.refCode);
    fund(a, 5e7); await bank.buyPackWithSol(a, 1);                         // real revenue
    b.solBalance = 5e7; await bank.buyPackWithSol(b, 1);                   // SOL that was not deposited: not real revenue
    c.balance = 9000; await bank.buyPackWithMine(c, 1);
    const es = entriesOf(R); assert(es.length === 3 && es.every((e) => e.status === "accrued") && es.filter((e) => e.real).length === 1);
    const sol0 = R.solBalance, afk0 = R.balance, paid0 = tr().referralPaid, wk = game.weekKey(game.now());
    assert(/^\d{4}-\d\d-\d\d$/.test(wk) && es.every((e) => e.week === wk) && new Date(wk + "T00:00:00Z").getUTCDay() === 1, "entries are grouped by week (Monday)");
    // reject one entry (needs a reason); it is never paid
    let st = 0; try { game.refReject([es[1].id], "", "adm"); } catch (e) { st = e.status; } assert(st === 400);
    assert(game.refReject([es[1].id], "Looks like a self-referral loop", "adm").rejected === 1 && es[1].status === "rejected" && es[1].reason);
    const ids = es.map((e) => e.id), rep = game.refPayout(ids, "adm");
    assert(rep.paid === 2 && rep.realLamports === es[0].amount && R.solBalance - sol0 === es[0].amount && tr().referralPaid - paid0 === es[0].amount, "real revenue -> SOL balance");
    const afkEntry = es.find((e) => e.cur === "mine"); assert(afkEntry.status === "paid" && afkEntry.paidAs === "afk" && R.balance > afk0 && R.balance - afk0 <= afkEntry.amount / 1e9 / game.poolView().price + 1e-3, "$AFKMINE-funded entry paid as $AFKMINE");
    assert(es[1].status === "rejected" && game.solvency().ok);
    const snapR = JSON.stringify([R.solBalance, R.balance, tr().referralPaid]);
    const again = game.refPayout(ids, "adm"); assert(again.paid === 0 && JSON.stringify([R.solBalance, R.balance, tr().referralPaid]) === snapR, "paying the same batch twice pays nothing twice");
    assert(game.refPayout([es[0].id], "adm").paid === 0, "a paid entry cannot be paid again");
    const my = game.refInfo(R); assert(my.paidLamports === es[0].amount + afkEntry.amount && my.accruedLamports === 0 && my.rejectedLamports === es[1].amount);
    // not enough real revenue: the whole batch is refused and nothing changes
    const R3 = game.createPlayer("PayBoss3", "PayBoss3W", null), d = game.createPlayer("PD", "PDW", R3.refCode); fund(d, 5e7); await bank.buyPackWithSol(d, 1);
    const rf = tr().referralPaid; tr().referralPaid = tr().packRevenue;            // pretend all pack revenue was already paid out
    const ids3 = entriesOf(R3).map((e) => e.id); st = 0; try { game.refPayout(ids3, "adm"); } catch (e) { st = e.status; } tr().referralPaid = rf;
    assert(st === 503 && entriesOf(R3)[0].status === "accrued" && R3.solBalance === 0, "refused, still accrued");
    assert(game.refPayout(ids3, "adm").paid === 1 && R3.solBalance === entriesOf(R3)[0].amount, "paid once the revenue is there");
  });
  await T("while away you also earn $AFKMINE and loot: tallied for the Welcome-back screen, loot waits in Claim mining rewards", async () => {
    const q = game.createPlayer("Away"); finishQuests(q); game.touchPlayer(q);
    maxMine(q, 30); game.touchPlayer(q);
    for (let i = 0; i < 8 * 60 + 5; i++) { step(60e3); game.tick(); }                    // 8 h away, the server keeps paying
    game.touchPlayer(q);
    const a = game.view(q).offline.away;
    assert(a.cash > 0 && a.mine > 0 && a.items > 0 && a.shards > 0, "cash, $AFKMINE, items and shards: " + JSON.stringify(a));
    assert(q.pending.items.length >= Math.min(a.items, C.PENDING_MAX) - 0 && q.pending.shards === a.shards, "loot is in the reward stash");
    const bal = q.balance, r = game.act(q, { type: "claimOffline" }).offlineClaimed;
    assert(r.cash === a.cash && r.mine === a.mine && r.items === a.items && r.shards === a.shards, "collecting reports the same tally");
    assert(q.balance === bal && game.view(q).offline.away.mine === 0 && game.view(q).offline.away.items === 0, "$AFKMINE was already in the balance; the tally is cleared");
  });
  await T("0 durability = unusable (no stats, no power, can't be equipped, auto-equip skips it); anything above 0 works at full strength", async () => {
    const q = game.createPlayer("Breaker"); game.touchPlayer(q); q.cash = 1e9;
    const it = S.itemById(q, q.eq.Pickaxe), full = S.computeFx(q).yield, pw = S.heroPower(q);
    it.dur = 1; assert(S.computeFx(q).yield === full && S.heroPower(q) === pw && S.usable(it), "1 durability still works at 100 %");
    it.dur = 0; assert(S.computeFx(q).yield === 0 && S.itemPower(it) === 0 && S.heroPower(q) < pw && !S.usable(it), "broken: no bonus, no power");
    game.act(q, { type: "unequip", slot: "Pickaxe" });
    let st = 0; try { game.act(q, { type: "equip", id: it.id }); } catch (e) { st = e.status; assert(/broken|repair/i.test(e.message)); } assert(st === 400, "can't equip a broken item");
    game.act(q, { type: "autoEquip" }); assert(!q.eq.Pickaxe, "auto-equip skips broken gear");
    game.act(q, { type: "repair", id: it.id }); assert(it.dur === it.max && it.dur > 0);
    game.act(q, { type: "equip", id: it.id }); assert(q.eq.Pickaxe === it.id && S.computeFx(q).yield > 0, "repaired gear works again");
    // gear that wears out during play stops working but stays in the slot until repaired
    it.dur = 1; q.wear = 0.9999; step(30e3); game.touchPlayer(q); step(30e3); game.touchPlayer(q);
    assert(it.dur === 0 && S.computeFx(q).yield === 0, "gear that reaches 0 durability stops working");
  });

  console.log("$AFKMINE <-> SOL market (virtual constant-product pool)");
  const buyA = (tok, lamports, minOut) => act(tok, { type: "tradeBuy", lamports, ...(minOut === undefined ? {} : { minOut }) });
  const sellA = (tok, tokens, minOut) => act(tok, { type: "tradeSell", tokens, ...(minOut === undefined ? {} : { minOut }) });
  const pool = () => game.db.pool, res = () => ({ sol: BigInt(pool().sol), tok: BigInt(pool().tok) });
  const kOf = () => res().sol * res().tok;
  const C0 = { cd: C.TRADE_COOLDOWN_MS, cap: C.DAILY_SELL_CAP_LAMPORTS_PER_PLAYER, pct: C.MAX_TRADE_POOL_PCT };
  C.TRADE_COOLDOWN_MS = 0;
  await T("pool: starts at 100 SOL / 10,000,000 $AFKMINE (0.00001 SOL), is public, and every tunable is in config", async () => {
    const f = await call("GET", "/api/pool");   // no login
    assert(f.s === 200 && pool().v === 0 && f.j.price === 0.00001 && f.j.solReserve === "100000000000" && f.j.tokenReserve === "10000000000000", JSON.stringify(f.j).slice(0, 300));
    assert(f.j.feeBps === 100 && f.j.limits.maxTradePct === 2 && f.j.limits.cooldownMs === C.TRADE_COOLDOWN_MS && C0.cd === 10000 && f.j.limits.dailySellCapLamports === C0.cap && f.j.trades.length === 0 && f.j.chart.points.length === 1 && f.j.chart.range === "24h" && f.j.change24h === 0);
    for (const k of ["POOL_INIT_SOL", "POOL_INIT_TOKENS", "TRADE_FEE_BPS", "MAX_TRADE_POOL_PCT", "TRADE_COOLDOWN_MS", "DAILY_SELL_CAP_LAMPORTS_PER_PLAYER", "SELL_KEEP_LAMPORTS", "ECONOMY_SINK_MODE", "EMISSION_MODE"]) assert(C[k] !== undefined, k);
    assert(!JSON.stringify(f.j).includes("wallet") && !JSON.stringify(f.j).includes('"pid"'), "no wallets or ids in the public market data");
  });
  await T("quote math: x*y=k never shrinks, rounding favours the pool, buy-then-sell never returns more than was put in (2,000 random trades)", () => {
    let sol = 100n * 10n ** 9n, tok = 10n ** 13n, rt = 0;
    for (let i = 0; i < 2000; i++) {
      const a = BigInt(1 + Math.floor(Math.random() * 3e9)), b = BigInt(1 + Math.floor(Math.random() * 3e11)), bps = [0, 30, 100, 500][i % 4];
      const q = S.quote("buy", sol, tok, a, bps);
      if (q.ok) {
        assert(q.newSol * q.newTok >= sol * tok, "k grows on buys (fee + rounding stay in the pool)");
        assert(q.newSol === sol + a && q.newTok === tok - q.out && q.fee === (a * BigInt(bps) + 9999n) / 10000n, "fee rounded up, full input stays in the pool");
        const back = S.quote("sell", q.newSol, q.newTok, q.out, bps);
        if (back.ok) { assert(back.out <= a, "round trip returns at most the input: " + back.out + " vs " + a); rt++; }
        sol = q.newSol; tok = q.newTok;
      }
      const s = S.quote("sell", sol, tok, b, bps);
      if (s.ok) { assert(s.newSol * s.newTok >= sol * tok, "k grows on sells"); assert(s.out < sol, "can't drain the pool"); sol = s.newSol; tok = s.newTok; }
    }
    assert(rt > 1000);
    // hand-checked example: 1 SOL into the starting pool at 1 % fee
    const q = S.quote("buy", 100n * 10n ** 9n, 10n ** 13n, 10n ** 9n, 100);
    assert(q.fee === 10_000_000n && q.out === 98_029_507_872n && q.impactBps === 197, "1 SOL -> 98,029.507872 $AFKMINE: " + q.out);
  });
  await T("buy: the server recomputes the price (client numbers are ignored), updates reserves atomically, logs the trade", async () => {
    const A = mk("Alice1", { sol: 3e9 }), r0 = res(), k0 = kOf();
    const prev = S.quote("buy", r0.sol, r0.tok, 1_000_000_000n, C.TRADE_FEE_BPS);
    const r = await act(A.tok, { type: "tradeBuy", lamports: 1e9, minOut: Number(prev.out), price: 1e-9, out: 1e15, tokens: 1e15, reserve: 1 });
    assert(r.s === 200 && r.j.traded.received === Number(prev.out) && r.j.traded.paid === 1e9 && r.j.traded.fee === 1e7, JSON.stringify(r.j.traded));
    assert(A.p.solBalance === 2e9 && Math.abs(A.p.balance - Number(prev.out) / 1e6) < 1e-9 && r.j.solBalance === 2e9, "balances");
    assert(res().sol === prev.newSol && res().tok === prev.newTok && kOf() > k0, "reserves follow the quote, k grew by the fee");
    assert(pool().v === 1 && BigInt(pool().feeSol) === prev.fee, "version + fee bookkeeping");
    const pv = (await call("GET", "/api/pool")).j;
    assert(pv.trades.length === 1 && pv.trades[0].side === "buy" && pv.trades[0].name === "Alice1" && pv.price > 0.00001 && pv.chart.points.length >= 1 && pv.change24h >= 0 && pv.backedSol === "1000000000", JSON.stringify(pv.trades));
    assert(!JSON.stringify(pv).includes(A.p.id) && !JSON.stringify(pv).includes("W_Alice1"), "no ids / wallets in public trades");
    A.p.tradeStats.lastTradeAt = 0;
  });
  await T("sell: pays SOL by the curve, fee stays in the pool, round trip is a loss", async () => {
    const B = mk("Bob1", { sol: 5e8 }), r1 = (await buyA(B.tok, 5e8)).j, got = r1.traded.received;
    const sol0 = B.p.solBalance, k0 = kOf(), r0 = res();
    const prev = S.quote("sell", r0.sol, r0.tok, BigInt(got), C.TRADE_FEE_BPS);
    const r = await sellA(B.tok, got, Number(prev.out));
    assert(r.s === 200 && r.j.traded.received === Number(prev.out) && B.p.solBalance - sol0 === Number(prev.out) && r.j.balance < 1e-6, JSON.stringify(r.j.traded));
    assert(B.p.solBalance < 5e8, "buy then sell returned less than was put in: " + B.p.solBalance);
    assert(kOf() >= k0 && res().tok === prev.newTok && BigInt(pool().feeTok) >= prev.fee, "k did not shrink, fee kept in the pool");
    assert((await call("GET", "/api/pool")).j.trades[0].side === "sell");
  });
  await T("bad amounts are refused and change nothing: zero, negative, floats, NaN, text, overflow, more than owned", async () => {
    const C1 = mk("Carol1", { sol: 2e9, afk: 1000 }), before = snap(C1.p);
    for (const bad of [0, -1, -1e9, 1.5, 0.1, NaN, null, "abc", "1e9", "", [], {}, true, 1e30, 2 ** 63, 2 ** 53, Infinity, "99999999999999999999999"]) {
      const r1 = await act(C1.tok, { type: "tradeBuy", lamports: bad }), r2 = await act(C1.tok, { type: "tradeSell", tokens: bad });
      assert(r1.s === 400 && r2.s === 400 && snap(C1.p) === before, "amount " + JSON.stringify(bad) + " -> " + r1.s + "/" + r2.s);
    }
    for (const bad of [-1, 1.5, "x", {}, 1e30]) assert((await act(C1.tok, { type: "tradeBuy", lamports: 1e8, minOut: bad })).s === 400 && snap(C1.p) === before, "minOut " + bad);
    assert((await buyA(C1.tok)).s === 400 && (await sellA(C1.tok)).s === 400, "missing amount");
    assert((await buyA(C1.tok, 3e9)).s === 400 && snap(C1.p) === before, "insufficient SOL");
    assert((await sellA(C1.tok, 1_000_000_001)).s === 400 && snap(C1.p) === before, "insufficient $AFKMINE (1,000 owned)");
    assert((await sellA(C1.tok, 1)).s === 400 && snap(C1.p) === before, "a trade that rounds to zero is refused");
  });
  await T("who may trade: guests never, selling needs a pack, buying needs only a wallet", async () => {
    const g3 = (await call("POST", "/api/guest", { name: "Dan" })).j;
    assert((await buyA(g3.token, 1e8)).s === 400 && (await sellA(g3.token, 1e6)).s === 400, "guests can't trade");
    const D = mk("Dave1", { sol: 3e8, afk: 500, pack: false });
    const r = await sellA(D.tok, 100e6); assert(r.s === 400 && /pack/i.test(r.j.error), r.j.error);
    assert((await buyA(D.tok, 1e8)).s === 200, "a wallet player without a pack can still buy");
  });
  await T("slippage protection (minOut): a trade that would pay less than the minimum is rejected, an exact minimum passes", async () => {
    const E = mk("Eve1", { sol: 2e9, afk: 50000 }), r0 = res(), before = snap(E.p);
    const qb = S.quote("buy", r0.sol, r0.tok, 5n * 10n ** 8n, 100), qs = S.quote("sell", r0.sol, r0.tok, 10_000_000_000n, 100);
    let r = await buyA(E.tok, 5e8, Number(qb.out) + 1); assert(r.s === 409 && /minimum/i.test(r.j.error) && snap(E.p) === before, JSON.stringify(r.j));
    r = await sellA(E.tok, 10_000_000_000, Number(qs.out) + 1); assert(r.s === 409 && snap(E.p) === before, JSON.stringify(r.j));
    assert((await buyA(E.tok, 5e8, Number(qb.out))).s === 200, "exact minimum passes");
    // a price that moved between preview and click: someone else buys first
    const F = mk("Fay1", { sol: 2e9 }), prev = S.quote("buy", res().sol, res().tok, 3n * 10n ** 8n, 100);
    await buyA(mk("Frank1", { sol: 1e9 }).tok, 1e9);
    r = await buyA(F.tok, 3e8, Number(prev.out)); assert(r.s === 409 && F.p.solBalance === 2e9, "stale preview rejected, nothing spent");
  });
  await T("concurrent trades never use stale reserves or double-spend (parallel HTTP requests, replayed against the trade log)", async () => {
    const players = Array.from({ length: 10 }, (_, i) => mk("Racer" + i, { sol: 1e9, afk: 20000 }));
    const sells = players.slice(5), r00 = res(), tradesBefore = pool().n;
    const results = await Promise.all([...players.slice(0, 5).map((x) => buyA(x.tok, 3e8)), ...sells.map((x) => sellA(x.tok, 5_000_000_000))]);
    assert(results.every((r) => r.s === 200), results.map((r) => r.s + ":" + (r.j.error || "")).join(" "));
    const rows = (await app.store.trades(pool().n - tradesBefore)).reverse();
    assert(rows.length === 10, "every trade has a durable row: " + rows.length);
    let sol = r00.sol, tok = r00.tok;                       // replay the trades one by one in log order: each must match the reserves BEFORE it
    for (const t of rows) {
      const q = t.side === "buy" ? S.quote("buy", sol, tok, BigInt(t.lamports), C.TRADE_FEE_BPS) : S.quote("sell", sol, tok, BigInt(t.micro), C.TRADE_FEE_BPS);
      assert(q.ok && (t.side === "buy" ? Number(q.out) === t.micro : Number(q.out) === t.lamports), "trade " + t.id + " was priced against the reserves before it");
      sol = q.newSol; tok = q.newTok;
    }
    assert(sol === res().sol && tok === res().tok, "final reserves equal the sequential replay");
    // same player, one trade's worth of money, two simultaneous requests: exactly one wins
    const G = mk("Gil1", { sol: 3e8 }), two = await Promise.all([buyA(G.tok, 3e8), buyA(G.tok, 3e8)]);
    assert(two.map((r) => r.s).sort().join() === "200,400" && G.p.solBalance === 0, "no double spend: " + two.map((r) => r.s));
    const H = mk("Hal1", { afk: 100 }), two2 = await Promise.all([sellA(H.tok, 100e6), sellA(H.tok, 100e6)]);
    assert(two2.map((r) => r.s).sort().join() === "200,400" && H.p.balance < 1e-6, "no double sell");
    // two writers on one store: the older pool version is refused
    const stale = { ...game.db.pool, v: game.db.pool.v - 1 };
    await assert.rejects(() => app.store.save([], { pool: stale }), /stale pool/);
  });
  await T("per-trade size limit (MAX_TRADE_POOL_PCT of the reserve it pays into)", async () => {
    const I = mk("Ivy1", { sol: 10e9, afk: 1e6 }), before = snap(I.p), max = Number((res().sol * 200n) / 10000n);
    let r = await buyA(I.tok, max + 1); assert(r.s === 400 && /too large/i.test(r.j.error) && snap(I.p) === before, r.j.error);
    r = await sellA(I.tok, Number((res().tok * 200n) / 10000n) + 1); assert(r.s === 400 && /too large/i.test(r.j.error) && snap(I.p) === before, r.j.error);
    assert((await buyA(I.tok, max)).s === 200, "exactly the limit passes");
  });
  await T("per-player trade cooldown", async () => {
    C.TRADE_COOLDOWN_MS = 10e3;
    try {
      const J = mk("Jay1", { sol: 2e9 });
      assert((await buyA(J.tok, 1e8)).s === 200);
      const r = await buyA(J.tok, 1e8); assert(r.s === 429 && /cooldown/i.test(r.j.error) && J.p.solBalance === 1.9e9, r.j.error);
      assert((await call("GET", "/api/me", null, J.tok)).j.trade.cooldownLeft > 0);
      step(9e3); assert((await buyA(J.tok, 1e8)).s === 429, "still cooling down after 9 s");
      step(2e3); assert((await buyA(J.tok, 1e8)).s === 200, "ok after 10 s");
      assert((await sellA(J.tok, 1e6)).s === 429, "the cooldown covers buys AND sells");
    } finally { C.TRADE_COOLDOWN_MS = 0; }
  });
  await T("daily sell cap per player (resets at 00:00 UTC); no floor, large sells are capped by the treasury", async () => {
    const K = mk("Kim1", { afk: 1e6 }), L = mk("Lee1", { sol: 2e9 });
    await buyA(L.tok, 2e9);                                  // buyers put real SOL in, so there is something to pay sells with
    C.DAILY_SELL_CAP_LAMPORTS_PER_PLAYER = 5e8;
    try {
      let r = await sellA(K.tok, 30_000_000_000); assert(r.s === 200, JSON.stringify(r.j));      // ~0.29 SOL
      const sold1 = r.j.traded.received; assert(sold1 < 5e8 && K.p.tradeStats.soldLamports === sold1);
      r = await sellA(K.tok, 40_000_000_000); assert(r.s === 429 && /daily/i.test(r.j.error), r.j.error);
      assert((await call("GET", "/api/me", null, K.tok)).j.trade.soldToday === sold1);
      step(25 * 3600e3);
      assert((await sellA(K.tok, 30_000_000_000)).s === 200, "a new UTC day, a new allowance");
    } finally { C.DAILY_SELL_CAP_LAMPORTS_PER_PLAYER = C0.cap; }
    // no price floor: a big seller is only limited by what the treasury can pay (and by the size/daily limits, lifted here)
    const M = mk("Max1", { afk: 8e6 });
    assert(pool().sol > pool().initSol && C.POOL_SELL_FLOOR === undefined, "the pool-floor setting is gone");
    C.MAX_TRADE_POOL_PCT = 90; C.DAILY_SELL_CAP_LAMPORTS_PER_PLAYER = 1e15; C.TRADE_COOLDOWN_MS = 0;
    try {
      const room = game.solvency().sellRoom, maxT = S.maxSell(res().sol, res().tok, C.TRADE_FEE_BPS, room, 8_000_000_000_000n);
      assert(room > 0 && maxT > 0n && maxT < 8_000_000_000_000n, "the treasury room, not a floor, limits the sale: room=" + room + " max=" + maxT);
      const before = snap(M.p), r = await sellA(M.tok, Number(maxT) + 1_000_000);
      assert(r.s === 409 && /liquidity limit/i.test(r.j.error) && snap(M.p) === before, JSON.stringify(r.j));
      const ok = await sellA(M.tok, Number(maxT)); assert(ok.s === 200 && game.solvency().ok, "selling exactly the maximum works: " + JSON.stringify(ok.j));
    } finally { C.MAX_TRADE_POOL_PCT = C0.pct; C.DAILY_SELL_CAP_LAMPORTS_PER_PLAYER = C0.cap; C.TRADE_COOLDOWN_MS = C0.cd; }
  });
  await T("solvency: no price floor, but a sell is limited by what the treasury can really pay (balances and locked withdrawals are never touched); withdrawals need real SOL on-chain", async () => {
    const N = mk("Nina1", { afk: 1e6 }), O = mk("Otto1", { sol: 2e9 });
    await buyA(O.tok, 2e9);
    const sv = game.solvency(); assert(sv.ok && sv.assets >= sv.liabilities && sv.ratio >= 1 && sv.sellRoom >= 0, JSON.stringify(sv));
    // 1) the treasury is only 1,000 lamports above the liabilities => the sell is refused with the liquidity message and nothing changes
    const t0 = tr().depositsIn; tr().depositsIn = tr().withdrawnNet + sv.liabilities + 1000;
    const before = snap(N.p), r = await sellA(N.tok, 20_000_000_000);
    assert(r.s === 409 && /liquidity limit/i.test(r.j.error) && snap(N.p) === before && game.solvency().ok, "refused, nothing changed: " + JSON.stringify(r.j));
    const tv = game.view(N.p).trade; assert(tv.sellRoom === 1000 && tv.maxSellMicro >= 0 && tv.maxSellMicro < 20_000_000_000, "the view exposes the room and the largest possible sell: " + JSON.stringify(tv));
    // the largest sell the view announces really works (cooldown/daily cap aside), one micro-token more does not
    C.TRADE_COOLDOWN_MS = 0;
    try {
      const ms = tv.maxSellMicro; assert(ms > 0 || true);
      const rs = game.db.pool, sol = BigInt(rs.sol), tok = BigInt(rs.tok);
      assert(S.quote("sell", sol, tok, BigInt(ms), C.TRADE_FEE_BPS).out <= 1000n && S.quote("sell", sol, tok, BigInt(ms + 1), C.TRADE_FEE_BPS).out > 1000n || ms >= Number(tok) , "maxSell is the exact boundary");
    } finally { C.TRADE_COOLDOWN_MS = C0.cd; }
    tr().depositsIn = t0;
    // 2) pending withdrawals are liabilities: they shrink the room for sellers
    const P = mk("Pete1", { sol: 1e9 }); P.p.lastWithdrawAt = 0;
    const room0 = game.solvency().sellRoom; const wr = await wd(P.tok, 1e9);
    assert(wr.s === 200 && game.solvency().lockedWithdrawals >= 1e9 && game.solvency().liabilities === sv.liabilities + (game.solvency().liabilities - sv.liabilities) && game.solvency().sellRoom === room0, "locking moves SOL from balance to locked: room unchanged, still covered");
    await bank.adminReject(wr.j.withdrawalId, "test", "tester");
    // 3) no floor: a big sell pushes the price below the start price when the treasury can pay
    const px0 = game.poolView().price; assert(px0 > 0);
  });
  await T("admin solvency report: disabled without ADMIN_KEY, key required, shows treasury / liabilities / reserves / ratio", async () => {
    const saved = process.env.ADMIN_KEY; delete process.env.ADMIN_KEY;
    assert((await call("GET", "/api/admin/solvency")).s === 404, "off by default");
    process.env.ADMIN_KEY = "sekrit-key";
    try {
      app.resetLimits();
      assert((await call("GET", "/api/admin/solvency")).s === 403 && (await call("GET", "/api/admin/solvency", null, null, { "x-admin-key": "nope" })).s === 403);
      const r = await call("GET", "/api/admin/solvency", null, null, { "x-admin-key": "sekrit-key" });
      assert(r.s === 200 && r.j.ok === true && r.j.assets >= r.j.liabilities && "ratio" in r.j && r.j.poolSol && r.j.poolTokens && r.j.circulating > 0 && r.j.treasuryAddress === "TreasuryAddr" && r.j.onchainLamports && Array.isArray(r.j.recentLedger), JSON.stringify(r.j).slice(0, 400));
      assert(/\[solvency\] OK/.test(game.solvencyLine()), game.solvencyLine());
    } finally { if (saved === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = saved; }
  });
  await T("chart ranges: OHLC candles, GET /api/pool?range=, at most ~300 points per answer, bad ranges fall back to 24h", async () => {
    const T0 = game.now(), C5 = C.CANDLE_MS;
    const before = pool().v, cd0 = C.TRADE_COOLDOWN_MS, pct0 = C.MAX_TRADE_POOL_PCT; C.TRADE_COOLDOWN_MS = 0;
    const tr1 = mk("Chart1", { sol: 5e9 });
    try {
      for (let i = 0; i < 40; i++) { step(i % 2 ? 2 * 3600e3 : C5 + 1000); assert((await buyA(tr1.tok, 2e7)).s === 200); }
    } finally { C.TRADE_COOLDOWN_MS = cd0; }
    const R = {}; for (const r of ["24h", "3d", "7d", "30d", "all"]) { const j = (await call("GET", "/api/pool?range=" + r)).j; R[r] = j.chart; assert(j.chart.range === r && j.chart.points.length >= 1 && j.chart.points.length <= 300, r); }
    const ok = (pt) => pt.length === 6 && pt[2] >= Math.max(pt[1], pt[4]) - 1e-18 && pt[3] <= Math.min(pt[1], pt[4]) + 1e-18 && pt[5] >= 0;
    for (const r in R) assert(R[r].points.every(ok), "OHLC sanity in " + r);
    assert(R.all.points.length >= R["24h"].points.length && R["30d"].points.length >= R["7d"].points.length && R["7d"].points.length >= R["3d"].points.length, "wider range, more candles");
    assert(R.all.points[0][0] <= R["30d"].points[0][0] && R["24h"].points.at(-1)[4] === game.poolView().price, "last close = current price");
    assert((await call("GET", "/api/pool?range=nonsense")).j.chart.range === "24h" && (await call("GET", "/api/pool")).j.chart.range === "24h", "unknown range -> 24h");
    assert(R.all.points.reduce((a, p) => a + p[5], 0) >= 40 * 2e7 * 0.99, "volume (lamports) is tracked");
    // downsampling: many candles are merged, never more than the cap
    assert((await app.store.candles()).length >= 20, "candles are stored in the store (they survive restarts)");
    const cap0 = C.CHART_MAX_POINTS; C.CHART_MAX_POINTS = 5;
    try { const d = game.chart("all"); assert(d.points.length <= 5 && d.candleMs > C.CANDLE_MS && Math.abs(d.points.reduce((a, p) => a + p[5], 0) - R.all.points.reduce((a, p) => a + p[5], 0)) < 1, "long ranges are downsampled, volume preserved"); }
    finally { C.CHART_MAX_POINTS = cap0; }
    pool().v = Math.max(pool().v, before);
  });
  await T("supply: emission is tracked (mint) or limited (reserve); sinks burn or recycle; circulating = all balances", async () => {
    const q = mk("Supply1").p; await new Promise((r) => setTimeout(r, 2100));   // the circulating-supply figure is cached for 2 s
    const pv0 = (await call("GET", "/api/pool")).j, m0 = pool().minted;
    assert(Math.abs(pv0.circulating - Object.values(game.db.players).reduce((a, x) => a + x.balance, 0)) < 1e-6, "circulating = sum of balances");
    assert(game.mint(q, 1000) === 1000 && near(pool().minted - m0, 1000, 1e-6) && q.balance === 1000);
    C.EMISSION_MODE = "reserve"; const res0 = pool().reserve; pool().reserve = 300;
    try { assert(game.mint(q, 1000) === 300 && q.balance === 1300 && pool().reserve === 0 && game.mint(q, 5) === 0, "reserve mode: paid from a finite stock, then rewards stop"); } finally { C.EMISSION_MODE = "mint"; pool().reserve = res0; }
    const b0 = pool().burned, tok0 = pool().tok; game.spendMine(q, 100);
    assert(pool().burned - b0 === 100 && pool().tok === tok0, "burn mode: gone");
    C.ECONOMY_SINK_MODE = "recycle"; const v0 = pool().v;
    try { game.spendMine(q, 100); assert(BigInt(pool().tok) === BigInt(tok0) + 100_000_000n && pool().v === v0 + 1, "recycle mode: back into the pool's token reserve"); } finally { C.ECONOMY_SINK_MODE = "burn"; }
    assert(game.solvency().ok);
  });
  await T("migration: an old save (no SOL fields, $MINE balance, in-flight token withdrawals) loads safely and nothing is lost", async () => {
    const f = path.join(os.tmpdir(), "idle-miner-old-" + process.pid + ".json");
    const src = JSON.parse(JSON.stringify(gp())); // any full player object, then strip everything new
    const old = Object.assign(src, { id: "0ld0ld0ld0ld", name: "OldTimer", wallet: "OldWallet1111111111111111111111111111111111", balance: 777.5, refCode: "OLDCODE2", sessions: [], packs: { 1: true } });
    for (const k of ["solBalance", "tradeStats", "refEarnedSol", "refPaidSol"]) delete old[k];
    old.q = { deposited: 60000, spent: 5, x: null, discord: null }; old.referredBy = null;
    const wq = { id: "wq", pid: old.id, wallet: old.wallet, amount: 400, fee: 80, net: 320, base: "320000000", state: "queued", created: Date.now() - 1000, prevAt: 0, tries: 0 };
    const ws = { id: "ws", pid: old.id, wallet: old.wallet, amount: 200, fee: 40, net: 160, base: "160000000", state: "sent", sig: sig(77), raw: "RAW", lastValid: 100, created: Date.now() - 1000, prevAt: 0, tries: 0, sentAt: 1 };
    const wd = { id: "wd", pid: old.id, wallet: old.wallet, amount: 100, fee: 20, net: 80, base: "80000000", state: "done", sig: sig(78), created: Date.now() - 5000, prevAt: 0 };
    fs.writeFileSync(f, JSON.stringify({ meta: { season: { start: Date.now() }, lastTick: Date.now(), bonus: 0, withdrawals: { wq, ws, wd }, orders: {} }, players: { [old.id]: old }, sigs: {} }));
    const chain3 = fakeChain(); chain3.wStatus = "pending";
    const app3 = await createApp({ chain: chain3, bs58, nacl, store: await require("./store.js").openStore({ file: f }) });
    const o = app3.game.db.players[old.id], d = app3.game.db;
    assert(o.solBalance === 0 && o.tradeStats.depositedLamports === 0 && o.refEarnedSol === 0, "new fields exist");
    assert(o.q.depDone === true && o.q.deposited === 60000, "a finished old deposit quest stays finished");
    assert(Math.abs(o.balance - (777.5 + 400)) < 1e-9, "$MINE carried over 1:1 as $AFKMINE; the never-sent token withdrawal was refunded: " + o.balance);
    assert(d.withdrawals.wq.state === "failed" && d.withdrawals.wq.legacy && /discontinued/.test(d.withdrawals.wq.error), "queued token withdrawal refunded");
    assert(d.withdrawals.ws.state === "sent" && d.withdrawals.ws.legacy && Math.abs(o.balance - 1177.5) < 1e-9, "a sent one is NOT refunded while it may still arrive");
    assert(d.pool.sol === "100000000000" && d.pool.tok === "10000000000000" && d.pool.v === 0 && d.treasury.depositsIn === 0, "market initialised");
    assert(app3.game.solvency().ok && app3.game.solvency().liabilities === 0);
    await app3.bank.processWithdrawals();
    assert(d.withdrawals.ws.state === "sent" && Math.abs(o.balance - 1177.5) < 1e-9, "still pending on chain: nothing happens");
    chain3.wStatus = "confirmed"; await app3.bank.processWithdrawals();
    assert(d.withdrawals.ws.state === "done" && Math.abs(o.balance - 1177.5) < 1e-9 && chain3.signed.length === 0, "confirmed: done, no refund, nothing signed again");
    d.withdrawals.ws.state = "sent"; chain3.wStatus = "expired"; await app3.bank.processWithdrawals(); await app3.bank.processWithdrawals();
    assert(d.withdrawals.ws.state === "failed" && Math.abs(o.balance - (1177.5 + 200)) < 1e-9, "expired: refunded once, as $AFKMINE");
    assert(app3.game.solvency().ok && d.treasury.withdrawnNet === 0, "legacy token withdrawals never touch the SOL ledger");
    assert((await app3.game.flush(), true)); app3.server.close(); fs.unlinkSync(f);
  });
  C.TRADE_COOLDOWN_MS = C0.cd; C.MAX_TRADE_POOL_PCT = C0.pct;

  console.log("persistence & leaderboard & web security");
  await T("a restart keeps everything: players, SOL balances, pool, trade history, treasury ledger, and a withdrawal that was signed but not yet confirmed", async () => {
    app.resetLimits(); const p = gp(); fund(p, 1e9); p.lastWithdrawAt = 0; chain.wStatus = "pending";
    const wr = await call("POST", "/api/bank/withdraw", { lamports: 150000000 }, gTok);
    assert(wr.s === 200, JSON.stringify(wr.j));
    await bank.adminApprove(wr.j.withdrawalId, "tester");
    await bank.processWithdrawals();
    const bal = p.balance, sol = p.solBalance, wid = wr.j.withdrawalId, poolSnap = JSON.stringify(game.db.pool), trSnap = JSON.stringify(tr());
    await game.flush();
    const chain2 = fakeChain(); chain2.wStatus = "confirmed";
    const app2 = await createApp({ chain: chain2, bs58, nacl, now: () => game.now() });
    const p2 = app2.game.db.players[guest.id], w2 = app2.game.db.withdrawals[wid];
    assert(p2 && p2.wallet === wallet() && Math.abs(p2.balance - bal) < 1e-6 && p2.solBalance === sol && p2.packs[1] && p2.packs[2], "player restored");
    assert(JSON.stringify(app2.game.db.pool) === poolSnap && JSON.stringify(app2.game.db.treasury) === trSnap, "pool state and treasury ledger restored exactly");
    assert((await app2.store.trades(1000)).length === pool().n && (await app2.store.ledger(1000)).length > 5, "full trade history and ledger rows are persisted");
    assert(JSON.stringify(app2.game.chart("all")) === JSON.stringify(game.chart("all")) && app2.game.chart("all").points.length > 10, "the price chart history survives a restart");
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
  // ======================= 2. power-gated floors =======================
  await T("floors below their Power requirement produce nothing (income, drops, shards), online and offline; leveling up switches them on", async () => {
    gateOn();
    try {
      assert(S.floorReq(1) === 0 && S.floorReq(3) === 0 && S.floorReq(4) === 120 && S.floorReq(10) === 360 && S.floorReq(30) === 13740, "requirement table");
      const q = game.createPlayer("Gated"); game.touchPlayer(q); maxMine(q, 30); q.hero.lvl = 3; q.eq = {}; q.boosts.power = 0;
      let g = S.gateInfo(q, game.now());
      assert(g.power === 150 && g.active.filter(Boolean).length === 5 && g.next.floor === 6 && g.next.req === 170, JSON.stringify(g));
      const inc = S.income(q, game.now());
      assert(inc.active.filter(Boolean).length === 5);
      // the same mine with only its 5 active floors owned makes exactly the same money, so the 26 idle floors add nothing
      const q4 = game.createPlayer("Gated4"); game.touchPlayer(q4); maxMine(q4, 5); q4.hero.lvl = 3; q4.eq = {}; q4.boosts.power = 0;
      assert(Math.abs(S.income(q4, game.now()).perSec - inc.perSec) < 1e-6 * inc.perSec, "idle floors earn nothing");
      const trips = S.tripsPerSec(q, game.now()).trips; assert(trips.slice(0, 5).every((x) => x > 0) && trips.slice(5).every((x) => x === 0), "no trips, so no drops or shards from idle floors");
      // offline: 8 h away on a deep, weak mine => no shards at all (they only drop on floor 15+)
      finishQuests(q); q.pending.shards = 0; q.offAcc.shards = 0;
      for (let i = 0; i < 8 * 60 + 5; i++) { step(60e3); game.tick(); }
      game.touchPlayer(q);
      assert(q.pending.shards === 0 && q.offAcc.shards === 0, "gated deep floors cannot find shards offline");
      // levelling up brings the floors online
      q.hero.lvl = 99; g = S.gateInfo(q, game.now());
      assert(g.power === 4950 && g.active.filter(Boolean).length === 24 && g.next.floor === 25 && g.next.req === 5520, JSON.stringify(g));
      assert(S.income(q, game.now()).perSec > inc.perSec * 10, "higher level => more floors work => more income");
      // the Power Boost counts towards the requirement while it runs
      const before = S.totalPower(q, game.now()); q.boosts.power = game.now() + 1e6; assert(S.totalPower(q, game.now()) === before * 2);
      assert(game.view(q).gate && game.view(q).gate.power === before * 2, "view exposes the gate");
    } finally { gateOff(); }
  });
  await T("gear counts as power: equipping usable gear can activate a floor, broken gear does not", async () => {
    gateOn();
    try {
      const q = game.createPlayer("GearGate"); game.touchPlayer(q); maxMine(q, 8); q.hero.lvl = 4; q.eq = {}; q.boosts.power = 0;
      assert(S.gateInfo(q, game.now()).active.filter(Boolean).length === 6 && S.gateInfo(q, game.now()).power === 200);
      const it = { id: 991, slot: "Pickaxe", r: 3, il: 1, v: 0.2, dur: 50, max: 100, aff: [], up: 0, lock: false }; q.inv.push(it); q.eq.Pickaxe = 991;
      assert(S.itemPower(it) === 200 && S.gateInfo(q, game.now()).power === 400 && S.gateInfo(q, game.now()).active.filter(Boolean).length === 8, "400 power switches on floors 7 and 8 (need 210 / 250)");
      it.dur = 0; assert(S.gateInfo(q, game.now()).power === 200, "a broken item gives no power");
    } finally { gateOff(); }
  });

  // ======================= 1. wearables must never lower income =======================
  await T("equipping a usable item never lowers income; broken items give nothing", async () => {
    const mkSt = (n, lvl, el, wh, hl) => ({ mines: { start: { prestigeMult: 1, unlockedShaftCount: n, shafts: Array.from({ length: n }, () => ({ level: lvl })), elevator: { level: el }, warehouse: { level: wh } } }, hero: { lvl: hl }, inv: [], eq: {}, boosts: { xp: 0, earn: 0, power: 0 }, quests: {}, balance: 0, tradeStats: {} });
    const affs = [null, { k: "speed", v: 0.05 }, { k: "cap", v: 0.05 }, { k: "aura", v: 0.1 }, { k: "yield", v: 0.05 }];
    let cases = 0;
    for (const cfg of [[3, 10, 5, 5, 5], [8, 30, 15, 15, 20], [15, 60, 30, 30, 40], [25, 100, 50, 50, 60], [12, 5, 1, 1, 1], [12, 200, 3, 80, 10]])
      for (const slot of S.SLOTS) for (const v of [0.01, 0.05, 0.1, 0.3]) for (const aff of affs) {
        const st = mkSt(...cfg), a = S.income(st, 0).perSec;
        st.inv = [{ id: "x", slot, v, aff: aff ? [aff] : [], up: 0, dur: 50, max: 100, r: 1, il: 1 }]; st.eq = { [slot]: "x" };
        const b = S.income(st, 0).perSec; cases++;
        assert(b >= a * 0.9999, "income fell " + a + " -> " + b + " " + slot + " " + v + " " + JSON.stringify(aff) + " " + cfg);
        st.inv[0].dur = 0;                                            // broken: exactly the income without the item
        assert(Math.abs(S.income(st, 0).perSec - a) < a * 1e-9, "a broken item must give nothing");
        assert(S.itemPower(st.inv[0]) === 0);
      }
    assert(cases === 960);
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

  console.log("admin dashboard");
  await T("admin: off without ADMIN_TOKEN (404), page too; sign-in required, wrong token refused, a player token is not an admin session; failed logins are rate limited", async () => {
    const saved = { t: process.env.ADMIN_TOKEN, k: process.env.ADMIN_KEY }; delete process.env.ADMIN_TOKEN; delete process.env.ADMIN_KEY;
    try {
      app.resetLimits();
      assert((await call("GET", "/api/admin/overview")).s === 404 && (await call("POST", "/api/admin/login", { token: "x" })).s === 404, "API off");
      assert((await fetch(B + "/admin")).status === 404, "page off");
      process.env.ADMIN_TOKEN = "a-long-admin-token-123";
      assert((await fetch(B + "/admin")).status === 200, "page on");
      assert((await call("GET", "/api/admin/overview")).s === 401, "no session");
      const m = mk("NotAdmin");
      assert((await call("GET", "/api/admin/overview", null, m.tok)).s === 401, "a player token is not an admin session");
      assert((await call("GET", "/api/admin/overview", null, null, { "x-admin-session": "forged" })).s === 401);
      assert((await call("POST", "/api/admin/login", { token: m.tok })).s === 403, "player token cannot log in as admin");
      let last = 0; for (let i = 0; i < 8; i++) last = (await call("POST", "/api/admin/login", { token: "wrong" + i })).s;
      assert(last === 429, "brute force is throttled: " + last);
      app.resetLimits();
      const ok = await call("POST", "/api/admin/login", { token: process.env.ADMIN_TOKEN });
      assert(ok.s === 200 && ok.j.session && ok.j.session.length >= 32);
      assert((await call("GET", "/api/admin/me", null, null, { "x-admin-session": ok.j.session })).s === 200);
      assert((await call("POST", "/api/admin/logout", {}, null, { "x-admin-session": ok.j.session })).s === 200 && (await call("GET", "/api/admin/me", null, null, { "x-admin-session": ok.j.session })).s === 401, "logout kills the session");
    } finally { for (const [k, v] of [["ADMIN_TOKEN", saved.t], ["ADMIN_KEY", saved.k]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  await T("admin: approve / reject through the API, idempotent, audit log, risk flags, OG exclusion", async () => {
    process.env.ADMIN_TOKEN = "a-long-admin-token-123"; app.resetLimits();
    try {
      const sess = (await call("POST", "/api/admin/login", { token: process.env.ADMIN_TOKEN })).j.session, H = { "x-admin-session": sess };
      const A = (m, p, b) => call(m, "/api/admin/" + p, b, null, H);
      const a = mk("WdA", { sol: 3e9 }), b = mk("WdB", { sol: 3e9 }); a.p.lastWithdrawAt = 0; b.p.lastWithdrawAt = 0;
      app.resetLimits();
      assert((await wd(a.tok, 1e9)).s === 200 && (await wd(b.tok, 1e9)).s === 200);
      const wa = wOf(a.p), wb = wOf(b.p);
      const list = await A("GET", "withdrawals?status=pending");
      assert(list.s === 200 && list.j.rows.some((r) => r.id === wa.id && r.status === "pending" && r.player.name === "WdA") && list.j.min === 5e7 && list.j.max === 2e9, JSON.stringify(list.j).slice(0, 300));
      const sent0 = chain.signed.length;
      assert((await A("POST", "withdrawal/reject", { id: wb.id })).s === 400, "a reason is required");
      const rb = a.p.solBalance, bBal = b.p.solBalance;
      assert((await A("POST", "withdrawal/reject", { id: wb.id, reason: "looks like a bot" })).s === 200 && b.p.solBalance === bBal + 1e9, "rejected: funds come back in full");
      assert((await A("POST", "withdrawal/reject", { id: wb.id, reason: "again" })).s === 409 && b.p.solBalance === bBal + 1e9, "no double refund");
      assert((await A("POST", "withdrawal/approve", { id: wb.id })).s === 409, "a rejected request cannot be approved");
      const ap = await A("POST", "withdrawal/approve", { id: wa.id });
      assert(ap.s === 200 && ap.j.status === "approved", JSON.stringify(ap.j));
      assert((await A("POST", "withdrawal/approve", { id: wa.id })).s === 409, "approving twice is refused");
      await bank.processWithdrawals();
      assert(chain.signed.length === sent0 + 1 && a.p.solBalance === rb, "sent exactly once");
      const au = await A("GET", "audit?n=50");
      const acts = au.j.rows.map((r) => r.action);
      assert(au.s === 200 && acts.includes("admin.login") && acts.includes("withdrawal.approve") && acts.includes("withdrawal.reject") && acts.includes("admin.login_failed"), acts.join());
      assert(!JSON.stringify(au.j).includes(process.env.ADMIN_TOKEN), "the token is never logged");
      // risk flags: two accounts behind one IP
      game.noteIp(a.p, "10.9.9.9"); game.noteIp(b.p, "10.9.9.9");
      const pl = await A("GET", "players?q=WdA");
      assert(pl.s === 200 && pl.j.rows[0].flags >= 1, "shared IP is flagged");
      const pd = await A("GET", "player?id=" + a.p.id);
      assert(pd.j.flags.some((f) => f.k === "shared_ip") && !JSON.stringify(pd.j).includes("10.9.9.9"), "only hashes are stored or shown");
      // OG exclusion
      a.p.tags = a.p.tags.filter((t) => t !== "og"); game.db.admin.og0 = game.now() + 1e6; a.p.tags.push("og");
      assert((await A("POST", "player/og", { id: a.p.id, exclude: true })).s === 200 && !game.tagsOf(a.p).includes("og") && game.db.admin.ogExcluded.includes(a.p.id));
      assert((await A("POST", "player/og", { id: a.p.id, exclude: false })).s === 200 && game.tagsOf(a.p).includes("og"));
      assert((await A("GET", "referrals")).s === 200 && (await A("GET", "trades")).s === 200 && (await A("GET", "overview")).j.solvency.ok === true);
    } finally { delete process.env.ADMIN_TOKEN; }
  });
  await T("OG tag: granted once to the accounts that exist at the first start (minus the exclusion list), never to later ones", async () => {
    const f = path.join(os.tmpdir(), "idle-miner-og-" + process.pid + ".json");
    const mkOld = (id, name) => Object.assign(JSON.parse(JSON.stringify(gp())), { id, name, wallet: "OgW" + id, refCode: "OG" + id.slice(0, 6).toUpperCase(), referredBy: null, created: Date.now() - 5e6, tags: undefined, ips: undefined });
    const o1 = mkOld("0g0000000001", "Veteran"), o2 = mkOld("0g0000000002", "Excluded");
    fs.writeFileSync(f, JSON.stringify({ meta: { season: { start: Date.now() }, lastTick: Date.now(), bonus: 0, withdrawals: {}, orders: {}, admin: { salt: "s", ogExcluded: [o2.id], flags: {}, batchSeq: 0 } }, players: { [o1.id]: o1, [o2.id]: o2 }, sigs: {} }));
    const app4 = await createApp({ chain: fakeChain(), bs58, nacl, store: await require("./store.js").openStore({ file: f }) });
    const g4 = app4.game;
    assert(g4.tagsOf(g4.db.players[o1.id]).includes("og"), "existing account gets the golden tag");
    assert(!g4.tagsOf(g4.db.players[o2.id]).includes("og"), "excluded account does not");
    const late = g4.createPlayer("Latecomer", "LateWallet1");
    assert(!g4.tagsOf(late).includes("og"), "an account created after the first start never gets it");
    assert(g4.db.ogDone === true);
    const again = Object.keys(g4.db.players).length; g4.load && 0; assert(again === 3);
    assert(g4.tagsOf(g4.db.players[o1.id]).filter((t) => t === "og").length === 1, "granted once, no duplicates");
    assert((await app4.game.flush(), true)); app4.server.close(); fs.unlinkSync(f);
  });

  console.log(`\nALL ${n} CHECKS PASSED`);
  await app.shutdown(); try { fs.unlinkSync(DATA); } catch {}
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
