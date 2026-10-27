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
const { analyzeDeposit, analyzePayment } = require("./chain.js");
const S = require("../js/shared.js");
const { C, PACKS, PRICES } = require("./config.js");

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
  const finishQuests = (p) => { p.balance = Math.max(p.balance, 50000); p.q.deposited = 50000; p.q.spent = 25000; p.q.x = "x" + p.id; p.q.discord = "d" + p.id; p.created -= 2 * 864e5; };
  const totalXp = (h) => { let x = h.xp; for (let l = 1; l < h.lvl; l++) x += S.xpNeed(l); return x; };

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
    assert(dbl, "the old x2 option is gone: it neither charges $MINE nor doubles");
  });
  await T("malformed / malicious actions are refused and change nothing", async () => {
    const p = game.db.players[guest.id], snap = () => JSON.stringify([p.mines, p.inv, p.balance, p.eq, p.hero.crates, p.pending, p.boosts, p.q]), before = snap(), cash0 = p.cash;
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
  await T("test faucet: free cash and free $MINE without a cooldown, and it can be switched off", async () => {
    const p = game.db.players[guest.id], b0 = p.balance;
    const a = await act(gTok, { type: "buy", item: "free_money" }), a2 = await act(gTok, { type: "buy", item: "free_money" });
    assert(a.j.ok && a2.j.ok && a2.j.cash > a.j.cash, "no cooldown");
    const m1 = await act(gTok, { type: "buy", item: "free_mine" }), m2 = await act(gTok, { type: "buy", item: "free_mine" });
    assert(m1.j.ok && m2.j.ok && Math.abs(p.balance - b0 - 2 * C.DEV_MINE_AMOUNT) < 1e-6, "$MINE faucet");
    assert(p.earned === 0 || p.earned < C.DEV_MINE_AMOUNT, "faucet $MINE is not 'mined' $MINE");
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
  await T("$MINE stops 15 minutes after you close the game; with Offline Earnings it keeps going for up to 8 hours", async () => {
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
    const b0 = gp().balance, d0 = gp().q.deposited;
    const r = await call("POST", "/api/bank/deposit/confirm", { signature: s1 }, gTok);
    assert(r.j.status === "ok" && Math.abs(gp().balance - b0 - 25) < 1e-9, JSON.stringify(r.j));
    assert(Math.abs(gp().q.deposited - d0 - 25) < 1e-9, "deposits count for the deposit quest");
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: s1 }, gTok)).s === 400, "replay");
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: "short" }, gTok)).s === 400);
    chain.deposits[sig(2)] = { status: "error", error: "not yours" };
    assert((await call("POST", "/api/bank/deposit/confirm", { signature: sig(2) }, gTok)).s === 400);
    const pr = await call("POST", "/api/bank/deposit/prepare", { amount: 10 }, gTok);
    assert(pr.j.tx && pr.j.amount === 10);
    assert((await call("POST", "/api/bank/deposit/prepare", { amount: -5 }, gTok)).s === 400);
    assert((await call("POST", "/api/bank/deposit/prepare", { amount: "abc" }, gTok)).s === 400);
  });
  await T("buying a pack with $MINE: price enforced, once only, a modest head start (not the whole game)", async () => {
    const pk = PACKS[0], p = gp(); p.balance = pk.mine - 1;
    assert((await call("POST", "/api/pack/mine", { pack: 1 }, gTok)).s === 400, "1 short");
    p.balance = pk.mine + 20000; const cash0 = p.cash, xp0 = totalXp(p.hero), spent0 = p.q.spent, invN = p.inv.length;
    const r = await call("POST", "/api/pack/mine", { pack: 1 }, gTok);
    assert(r.j.pack === 1 && Math.abs(r.j.balance - 20000) < 1e-6 && r.j.packs[1] && r.j.paid);
    assert(near(totalXp(p.hero) - xp0, 500, 0.001) && near(r.j.cash - cash0, 25e3, 0.2), "XP and cash from the pack");
    assert(p.inv.length === invN + 4, "4 pieces, not 8");
    const rare = p.inv.filter((i) => i.r === 2 && i.il === p.hero.lvl);
    assert(rare.length === 4 && ["Pickaxe", "Helmet", "Shoes", "Gloves"].every((s) => S.itemById(p, p.eq[s]).r === 2), "4 Rare items equipped");
    assert(p.q.spent - spent0 === pk.mine, "spending $MINE counts for the spend quest");
    assert((await call("POST", "/api/pack/mine", { pack: 1 }, gTok)).s === 400, "only once");
    assert((await call("POST", "/api/pack/mine", { pack: 7 }, gTok)).s === 400);
    assert(pk.lamports === 50_000_000 && pk.mine === 45000 && PACKS[1].lamports === 150_000_000 && PACKS[2].lamports === 400_000_000, "0.05 / 0.15 / 0.4 SOL");
    assert(Math.abs(pk.lamports / 1e9 * 1e6 * 0.9 - pk.mine) < 500, "$MINE price is 10% below the SOL price");
    assert(PACKS.every((x) => x.gearRarity <= 4) && PACKS[0].slots.length < PACKS[1].slots.length && PACKS[1].slots.length < PACKS[2].slots.length, "lower tier gear, fewer pieces than before");
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
  await T("withdraw: 20 % fee, max 250k, 24 h cooldown, paid to the player's own wallet", async () => {
    app.resetLimits(); const p = gp(); p.balance = 5000; p.lastWithdrawAt = 0;
    assert((await call("POST", "/api/bank/withdraw", { amount: 50 }, gTok)).s === 400, "below minimum");
    assert((await call("POST", "/api/bank/withdraw", { amount: 99999999 }, gTok)).s === 400, "more than balance");
    assert((await call("POST", "/api/bank/withdraw", { amount: -1 }, gTok)).s === 400);
    const big = await call("POST", "/api/bank/withdraw", { amount: 250001 }, gTok);
    assert(big.s === 400 && /maximum/i.test(big.j.error), big.j.error);
    const r = await call("POST", "/api/bank/withdraw", { amount: 1000, wallet: "Attacker111", to: "Attacker111" }, gTok);
    assert(r.s === 200 && Math.abs(r.j.balance - 4000) < 1e-6 && r.j.fee === 200 && r.j.net === 800, JSON.stringify(r.j));
    await bank.processWithdrawals();
    const w = Object.values(game.db.withdrawals).find((x) => x.pid === p.id);
    assert(w.state === "done" && w.wallet === wallet() && chain.signed[0].w === wallet() && chain.signed[0].base === 800_000_000n, "the wallet receives 80 %: " + JSON.stringify(w));
    const again = await call("POST", "/api/bank/withdraw", { amount: 500 }, gTok);
    assert(again.s === 429 && /24 hour/.test(again.j.error), again.j.error);
    step(23 * 3600e3);
    assert((await call("POST", "/api/bank/withdraw", { amount: 500 }, gTok)).s === 429, "still on cooldown after 23 h");
    const bv = (await call("GET", "/api/bank", null, gTok)).j;
    assert(bv.cooldownLeft > 0 && bv.cooldownLeft <= 3600e3 && bv.withdrawFee === 0.2 && bv.maxWithdraw === 250000);
    step(61 * 60e3);
    p.balance = 1e6;
    const ok2 = await call("POST", "/api/bank/withdraw", { amount: 250000 }, gTok);
    assert(ok2.s === 200 && ok2.j.net === 200000 && ok2.j.fee === 50000, "exactly 250k is allowed, fee 50k: " + JSON.stringify(ok2.j));
    await bank.processWithdrawals();
  });
  await T("failed or expired withdrawals are refunded exactly once; crash after signing never pays twice", async () => {
    app.resetLimits(); const p = gp(); p.balance = 1000; p.lastWithdrawAt = 0;
    chain.wStatus = "pending";
    await call("POST", "/api/bank/withdraw", { amount: 300 }, gTok);
    await bank.processWithdrawals();
    let w = Object.values(game.db.withdrawals).filter((x) => x.pid === p.id).pop();
    assert(w.state === "sent" && chain.broadcasts.length >= 1 && Math.abs(p.balance - 700) < 1e-9);
    chain.wStatus = "expired"; await bank.processWithdrawals(); await bank.processWithdrawals();
    assert(w.state === "failed" && Math.abs(p.balance - 1000) < 1e-9, "refunded once: " + p.balance);
    assert(p.lastWithdrawAt === 0, "a failed withdrawal does not use up the 24 h cooldown");
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

  console.log("gear upgrades, quests, boosts, account");
  await T("item upgrades: chance curve, coins for +1..+3, coins + $MINE for +4..+10, names and stats grow", async () => {
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
    assert(it.up === 3, "three coin-only upgrades without any $MINE");
    q.balance = 0;
    const cash3 = q.cash;
    r = await act(tok, { type: "upgradeItem", id: it.id });
    assert(r.s === 400 && /\$MINE/.test(r.j.error) && it.up === 3 && q.cash >= cash3, "+4 needs $MINE and nothing is taken if it is missing");
    q.balance = 100; const inf3 = S.upgradeInfo(it, mine);
    r = await act(tok, { type: "upgradeItem", id: it.id });
    assert(r.j.upgrade.ok && it.up === 4 && near(100 - q.balance, inf3.mine, 0.001) && q.balance < 100, "+4 charged $MINE: " + inf3.mine);
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
    q.q.deposited = 50000; assert(boost() === 30, "deposit 50k");
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
  await T("shop boosts are items: bought into the bag for $MINE, used on purpose (+100 % XP, +50 % earnings, +100 % power, 2 h each)", async () => {
    const a = game.createPlayer("Plain"), b = game.createPlayer("Boosted"), c = game.createPlayer("Powered");
    for (const p of [a, b, c]) game.touchPlayer(p);
    b.balance = 5000; c.balance = 5000;
    game.act(b, { type: "buy", item: "boost_xp" }); game.act(b, { type: "buy", item: "boost_earn" });
    game.act(c, { type: "buy", item: "boost_power" });
    assert(near(5000 - b.balance, PRICES.boost_xp + PRICES.boost_earn, 0.0001) && near(5000 - c.balance, PRICES.boost_power, 0.0001), "$MINE prices");
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
    assert(near(b.cash - cash0[1], (1.6 / 1.1) * (a.cash - cash0[0]), 0.01), "earnings x1.5 on top of the quest boost");
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
  await T("reset progress keeps the wallet, packs and $MINE; delete account is guarded", async () => {
    const q = game.createPlayer("Resetter", "ResetWallet1111111111111111111111111111111"), tok = game.newSession(q);
    game.touchPlayer(q); q.cash = 123456; q.balance = 777; q.earned = 500; q.packs[1] = true; q.hero.lvl = 40; q.q.spent = 99; q.mines.start.unlockedShaftCount = 9; q.pending.crates = 3;
    assert((await act(tok, { type: "reset" })).s === 400 && q.hero.lvl === 40, "needs the confirmation word");
    const r = await act(tok, { type: "reset", confirm: "RESET" });
    assert(r.j.ok && r.j.hero.lvl === 1 && r.j.cash < 200 && r.j.mine.unlockedShaftCount === 1 && r.j.inv.length === 3 && r.j.pending.crates === 0, "game progress is wiped");
    assert(q.balance === 777 && q.packs[1] && q.wallet === "ResetWallet1111111111111111111111111111111" && q.q.spent === 99 && q.earned === 500 && q.name === "Resetter", "$MINE, packs, wallet, name and quest progress stay");
    const nope = await call("POST", "/api/account/delete", { confirm: "DELETE" }, tok);
    assert(nope.s === 400 && /777|withdraw/i.test(nope.j.error) && game.db.players[q.id], "a wallet account that still holds $MINE can't be deleted");
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
  await T("floor prices: 1-10 coins, 11-20 coins + $MINE, 21-30 coins + $MINE + Mine Shards; nothing is taken unless everything is there", async () => {
    const q = game.createPlayer("Unlocker"); game.touchPlayer(q); const m = q.mines.start;
    for (let i = 1; i < 10; i++) { const c = S.shaftUnlockCost(i, m); assert(c.cash > 0 && c.mine === 0 && c.shards === 0, "floor " + (i + 1)); }
    for (let i = 10; i < 20; i++) { const c = S.shaftUnlockCost(i, m); assert(c.mine > 0 && c.shards === 0, "floor " + (i + 1)); }
    for (let i = 20; i < 30; i++) { const c = S.shaftUnlockCost(i, m); assert(c.mine > 0 && c.shards > 0, "floor " + (i + 1)); }
    const fail = (msg) => { let st = 0; try { game.act(q, { type: "unlockFloor" }); } catch (e) { st = e.status; assert(msg.test(e.message), e.message); } assert(st === 400, "refused"); };
    m.unlockedShaftCount = m.maxUnlocked = 10; q.cash = 1e15; q.balance = 0;
    fail(/\$MINE/); assert(m.unlockedShaftCount === 10 && q.cash === 1e15, "nothing taken");
    q.balance = S.UNLOCK_MINE[0]; const sp = q.q.spent; game.act(q, { type: "unlockFloor" });
    assert(m.unlockedShaftCount === 11 && q.balance === 0 && q.q.spent - sp === S.UNLOCK_MINE[0], "floor 11 cost $MINE, counted as spent");
    m.unlockedShaftCount = m.maxUnlocked = 20; q.balance = S.UNLOCK_MINE[10] - 1; q.bag.shards = 99; fail(/\$MINE/);
    q.balance = S.UNLOCK_MINE[10]; q.bag.shards = 1; fail(/Shard/); assert(q.balance === S.UNLOCK_MINE[10] && q.bag.shards === 1, "nothing taken");
    q.bag.shards = 2; game.act(q, { type: "unlockFloor" });
    assert(m.unlockedShaftCount === 21 && q.bag.shards === 0 && q.balance === 0, "floor 21 took coins + $MINE + 2 shards");
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
  await T("daily reward: 7-day calendar (coins / items, day 7 = $MINE), once per UTC day, a missed day restarts the week", async () => {
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
    assert(r.day === 7 && r.mine === S.DAILY_REWARDS[6].mine && q.balance - b === r.mine && q.earned - e === r.mine, "day 7: $MINE");
    toNextDay(); r = claim(); assert(r.day === 1, "the week starts again");
    toNextDay(); toNextDay(); r = claim(); assert(r.day === 1, "a missed day restarts the week");
    toNextDay(); r = claim(); assert(r.day === 2, "streak continues when you come every day");
    assert(game.view(q).seasonQuests.items.find((x) => x.id === "s_daily").value === 10, "claims count for the seasonal quest");
  });
  await T("daily quests count what you do and reset every day; all four give a bonus; seasonal quests run for the whole season", async () => {
    const q = game.createPlayer("Questy"); game.touchPlayer(q); q.cash = 1e12;
    const dq = () => game.view(q).dailyQuests, val = (id) => dq().items.find((x) => x.id === id).value;
    assert(dq().items.length === 4 && dq().items.every((x) => x.value === 0 && !x.claimed));
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
    const b0 = q.balance; assert(claim("season", "s_floors").mine === 100 && q.balance - b0 === 100, "seasonal $MINE reward");
    const cr3 = q.hero.crates, xb3 = q.bag.boost_xp; claim("season", "s_level"); assert(q.hero.crates === cr3 + 3 && q.bag.boost_xp === xb3 + 2);
    toNextDay();
    assert(dq().items.every((x) => x.value === 0 && !x.claimed) && !dq().bonusClaimed, "daily quests reset at 00:00 UTC");
    assert(sv().find((x) => x.id === "s_lvls").value === 10 && sv().find((x) => x.id === "s_floors").claimed, "seasonal progress and claims stay");
  });
  await T("referrals: link -> new player; referrer gets 25 % of pack spending (SOL or $MINE); leaderboard lists referrer, referred people, earnings", async () => {
    const boss = (await call("POST", "/api/guest", { name: "Boss" })).j, bp = game.db.players[boss.id];
    assert(boss.ref.code && boss.ref.code.length === 8 && boss.ref.count === 0 && boss.ref.rate === 0.25);
    const mk = (name, wallet, code) => game.createPlayer(name, wallet, code);
    const f1 = mk("Friend1", "FriendWallet1", boss.ref.code), f2 = mk("Friend2", "FriendWallet2", boss.ref.code.toLowerCase());
    const stranger = mk("Stranger", "StrangerWallet", "NOSUCHCD");
    assert(f1.referredBy === bp.id && f2.referredBy === bp.id && stranger.referredBy === null, "valid codes work (any case), unknown codes are ignored");
    const viaApi = (await call("POST", "/api/guest", { name: "ApiFriend", ref: boss.ref.code })).j; assert(game.db.players[viaApi.id].referredBy === bp.id, "the guest endpoint takes ?ref");
    assert(game.view(bp).ref.count === 3);
    f1.balance = 50000; const b0 = bp.balance;
    await bank.buyPackWithMine(f1, 1);
    assert(near(bp.balance - b0, PACKS[0].mine * 0.25, 1e-9) && near(bp.refEarned, PACKS[0].mine * 0.25, 1e-9) && near(f1.refPaid, PACKS[0].mine * 0.25, 1e-9), "25 % of the $MINE price");
    const b1 = bp.balance; game.grantPack(f2, PACKS[1], "sol");
    assert(near(bp.balance - b1, PACKS[1].sol * 1e6 * 0.25, 1e-9), "SOL purchases pay 25 % of their value in $MINE");
    assert(stranger.balance === 0 && bp.refEarned > 0);
    const other = mk("Small", "SmallWallet", null), small = mk("SmallFriend", "SmallWallet2", other.refCode); game.grantPack(small, PACKS[0], "sol");
    const lb = (await call("GET", "/api/referrals/leaderboard")).j, tok = boss.token, mine = (await call("GET", "/api/referrals/leaderboard", null, tok)).j;
    assert(lb.rows[0].name === "Boss" && lb.rows[0].referred === 3 && near(lb.rows[0].earned, bp.refEarned, 1e-9) && lb.rows[0].rank === 1 && lb.rows[1].name === "Small" && lb.me === null, "public board, sorted by earnings");
    assert(mine.me.rank === 1 && mine.me.name === "Boss", "your own row");
    const my = (await call("GET", "/api/referrals", null, tok)).j;
    assert(my.code === boss.ref.code && my.count === 3 && my.list.length === 3 && my.list[0].name === "Friend2", "your referred players, biggest payer first");
    assert((await call("GET", "/api/referrals")).s === 401, "the personal list needs a login");
    assert(!JSON.stringify(lb).includes('"id"') && !JSON.stringify(lb).includes("wallet"), "no ids or wallets leak into the board");
    const sub = Object.keys(game.db.players).length; assert(sub > 5);
  });
  await T("while away you also earn $MINE and loot: tallied for the Welcome-back screen, loot waits in Claim mining rewards", async () => {
    const q = game.createPlayer("Away"); finishQuests(q); game.touchPlayer(q);
    maxMine(q, 30); game.touchPlayer(q);
    for (let i = 0; i < 8 * 60 + 5; i++) { step(60e3); game.tick(); }                    // 8 h away, the server keeps paying
    game.touchPlayer(q);
    const a = game.view(q).offline.away;
    assert(a.cash > 0 && a.mine > 0 && a.items > 0 && a.shards > 0, "cash, $MINE, items and shards: " + JSON.stringify(a));
    assert(q.pending.items.length >= Math.min(a.items, C.PENDING_MAX) - 0 && q.pending.shards === a.shards, "loot is in the reward stash");
    const bal = q.balance, r = game.act(q, { type: "claimOffline" }).offlineClaimed;
    assert(r.cash === a.cash && r.mine === a.mine && r.items === a.items && r.shards === a.shards, "collecting reports the same tally");
    assert(q.balance === bal && game.view(q).offline.away.mine === 0 && game.view(q).offline.away.items === 0, "$MINE was already in the balance; the tally is cleared");
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

  console.log("persistence & leaderboard & web security");
  await T("a restart keeps everything, including a withdrawal that was signed but not yet confirmed", async () => {
    app.resetLimits(); const p = gp(); p.lastWithdrawAt = 0; chain.wStatus = "pending";
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
