"use strict";
// The authoritative game engine. The browser only sends *intents* ("upgrade floor 3 once");
// every number — cash, items, hero level, $MINE — is computed here from the SERVER clock.
const crypto = require("crypto");
const S = require("../js/shared.js");
const { C, PRICES, SOL, PACKS, env, num } = require("./config.js");

class ApiError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (msg, status = 400) => { throw new ApiError(status, msg); };

const DAY = 864e5;
const DROP_MULT = num(env.DROP_MULT, 1); // testing only
const rng = () => crypto.randomInt(0, 2 ** 47) / 2 ** 47;
const rnd = (a, b) => a + rng() * (b - a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const intIn = (x, a, b, what = "value") => { if (!Number.isInteger(x) || x < a || x > b) bad("Invalid " + what); return x; };
const cleanName = (s) => String(s || "").replace(/[^A-Za-z0-9 _.\-]/g, "").trim().replace(/\s+/g, " ").slice(0, 16);

function createGame({ store, now: nowFn, rng: rngOpt }) {
  const upRoll = rngOpt || rng; // randomness of item upgrades (tests can inject their own)
  let clockOffset = 0;
  const now = nowFn || (() => Date.now() + clockOffset + (num(env.DEV_DAY_OFFSET, 0)) * DAY);
  const db = { season: null, players: {}, lastTick: 0, bonus: 0, withdrawals: {}, orders: {} };
  let statsCache = { t: 0, v: null };
  const byWallet = new Map(), byRef = new Map(), dirty = new Set();
  let metaDirty = false, boardCache = { t: 0, v: null }, refCache = { t: 0, v: null };
  const touch = (p) => { if (p) dirty.add(p.id); boardCache.v = null; };
  const refCounts = new Map();                                     // referrer id -> how many accounts they referred
  const refCount = (p) => refCounts.get(p.id) || 0;
  const refAdd = (id, d) => { if (id) refCounts.set(id, Math.max(0, (refCounts.get(id) || 0) + d)); };
  const BOOST_ITEMS = { boost_xp: "xp", boost_earn: "earn", boost_power: "power" };
  const touchMeta = () => { metaDirty = true; };
  const dayStr = (t) => new Date(t).toISOString().slice(0, 10);   // UTC day, used by the daily reward and daily quests
  const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function newRefCode() {
    for (;;) {
      const b = crypto.randomBytes(8); let c = "";
      for (let i = 0; i < 8; i++) c += REF_ALPHABET[b[i] % REF_ALPHABET.length];
      if (!byRef.has(c)) return c;
    }
  }
  function poisson(l) { // number of events when `l` are expected on average
    if (!(l > 0)) return 0;
    if (l > 30) { const g = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng()); return Math.max(0, Math.round(l + Math.sqrt(l) * g)); }
    const L = Math.exp(-l); let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }

  // ---- persistence ------------------------------------------------------------------------------
  const meta = () => ({ season: db.season, lastTick: db.lastTick, bonus: db.bonus, withdrawals: db.withdrawals, orders: db.orders });
  async function load() {
    const d = await store.load();
    db.players = d.players || {};
    Object.assign(db, { season: null, lastTick: 0, bonus: 0, withdrawals: {}, orders: {} }, d.meta || {});
    // players saved by the old browser-trusting version have no server-side game state: forget them
    const legacy = Object.keys(db.players).filter((id) => !db.players[id].mines || !db.players[id].sessions);
    legacy.forEach((id) => delete db.players[id]);
    if (legacy.length) await store.removePlayers(legacy);
    for (const p of Object.values(db.players)) { if (p.refCode) byRef.set(p.refCode, p); }
    for (const p of Object.values(db.players)) { migrate(p); if (p.wallet) byWallet.set(p.wallet, p); }
    for (const p of Object.values(db.players)) { if (p.referredBy && !db.players[p.referredBy]) p.referredBy = null; refAdd(p.referredBy, 1); }
    if (!db.season) { db.season = { start: env.SEASON_START ? Date.parse(env.SEASON_START) : now() }; db.lastTick = now(); touchMeta(); }
  }
  // bring players saved by an older version up to date (research/forge/old boosts are gone, rewards are claimed, quests exist)
  function migrate(p) {
    const old = p.boosts || {};
    p.boosts = { xp: old.xp || 0, earn: old.earn || 0, power: old.power || 0 };
    delete p.researchUnlocked; delete p.freeMoneyAt; delete p.withdrawLog;
    p.pending = p.pending || { items: [], crates: 0 };
    p.pending.shards = p.pending.shards || 0;
    p.claimMark = p.claimMark || { cash: p.stats.totalEarned, mine: p.earned, t: now() };
    p.q = Object.assign({ deposited: 0, spent: 0, x: null, discord: null }, p.q);
    p.lastWithdrawAt = p.lastWithdrawAt || 0;
    p.inv.forEach((i) => { if (i.up == null) i.up = 0; });
    // v3 additions: bag, daily reward, daily/seasonal quests, offline tally, referrals
    p.bag = Object.assign({ shards: 0, boost_xp: 0, boost_earn: 0, boost_power: 0 }, p.bag);
    p.daily = Object.assign({ last: "", streak: 0 }, p.daily);
    p.dq = p.dq || { day: "", prog: {}, claimed: {}, bonus: false };
    p.sq = p.sq || { start: 0, prog: {}, claimed: {} };
    p.offAcc = Object.assign({ mine: 0, items: 0, crates: 0, shards: 0 }, p.offAcc);
    p.refEarned = p.refEarned || 0; p.refPaid = p.refPaid || 0; p.referredBy = p.referredBy || null;
    if (!p.refCode) { p.refCode = newRefCode(); byRef.set(p.refCode, p); dirty.add(p.id); }
    const m = p.mines && p.mines.start;
    if (m) m.maxUnlocked = Math.max(m.maxUnlocked || 0, m.unlockedShaftCount || 1);
  }
  async function flush() {
    if (!dirty.size && !metaDirty) return;
    const list = [...dirty].map((id) => db.players[id]).filter(Boolean), m = metaDirty ? meta() : null;
    dirty.clear(); metaDirty = false;
    try { await store.save(list, m); } catch (e) { list.forEach((p) => dirty.add(p.id)); if (m) metaDirty = true; throw e; }
  }

  // durable write of some players + all shared data (optionally claiming a used blockchain signature in the same atomic step)
  async function saveNow(players, claim) {
    const m = meta(); metaDirty = false;
    players.forEach((p) => dirty.delete(p.id));
    try { return await store.save(players, m, claim); }
    catch (e) { players.forEach((p) => dirty.add(p.id)); metaDirty = true; throw e; }
  }

  // ---- players ------------------------------------------------------------------------------------
  const seasonEnd = () => db.season.start + C.SEASON_MS;
  const over = () => now() >= seasonEnd();
  // Offline Earnings (all quests done): still earning up to 8 h after closing the game. Everybody else: 15 minutes.
  const activeWindow = (p, t) => (S.offlineUnlocked(p, t) ? C.ACTIVE_MS : C.OFFLINE_FREE_MS);
  const isActive = (p, t) => p.power > 0 && t - p.lastSeen < activeWindow(p, t);
  // a player's weight in the split of the $MINE pool: hero power (x power boost) x earnings boost. The pool itself never grows.
  const weight = (p, t) => p.power * S.powerMult(p, t) * S.earnMult(p, t);
  const isPaid = (p) => !!(p.packs && (p.packs[1] || p.packs[2] || p.packs[3]));
  const defaultMine = () => ({ prestigeMult: 1, warehouse: { level: 1 }, elevator: { level: 1 }, shafts: Array.from({ length: S.TOTAL_FLOORS }, () => ({ level: 1 })), unlockedShaftCount: 1, maxUnlocked: 1 });

  function uniqueName(want, selfId) {
    let n = cleanName(want); if (n.length < 2) n = "Miner";
    const taken = (x) => Object.values(db.players).some((p) => p.id !== selfId && p.name.toLowerCase() === x.toLowerCase());
    let out = n, k = 1;
    while (taken(out)) out = n.slice(0, 12) + (++k > 9 ? Math.floor(Math.random() * 9000 + 1000) : k);
    return out;
  }
  // everything that belongs to "the game progress" (what Reset progress wipes). Wallet, name, packs, $MINE balance,
  // quest counters, boosts and the leaderboard history are NOT touched.
  function freshProgress(p, t) {
    Object.assign(p, {
      cash: 50, mines: { start: defaultMine() }, stats: { totalEarned: 0 }, hero: { lvl: 1, xp: 0, pE: 0, pL: 0, n: 0, day: "", crates: 0 },
      inv: [], eq: {}, nextId: 1, invPages: 1, pendingOffline: 0, wear: 0, items: 0, events: [], settledAt: t,
      pending: { items: [], crates: 0, shards: 0 }, claimMark: { cash: 0, mine: p.earned || 0, t },
    });
    if (p.bag) p.bag.shards = 0;   // Mine Shards belong to the mine you just wiped; boost items in the bag are kept
    ["Pickaxe", "Shoes", "Helmet"].forEach((s) => { const it = genItem(p, 1, s, 0); p.inv.push(it); p.eq[s] = it.id; });
    p.power = S.heroPower(p);
  }
  function createPlayer(name, wallet, ref) {
    const t = now(), id = crypto.randomBytes(6).toString("hex");
    const p = {
      id, sessions: [], wallet: wallet || null, name: uniqueName(name || "Miner" + Math.floor(1000 + Math.random() * 9000)),
      created: t, lastSeen: t, packs: {}, boosts: { xp: 0, earn: 0, power: 0 }, q: { deposited: 0, spent: 0, x: null, discord: null },
      balance: 0, earned: 0, claimed: false, history: [], lastWithdrawAt: 0,
      bag: { shards: 0, boost_xp: 0, boost_earn: 0, boost_power: 0 }, daily: { last: "", streak: 0 }, dq: { day: "", prog: {}, claimed: {}, bonus: false },
      sq: { start: 0, prog: {}, claimed: {} }, offAcc: { mine: 0, items: 0, crates: 0, shards: 0 },
      refCode: newRefCode(), referredBy: null, refEarned: 0, refPaid: 0,
    };
    // referral link (?ref=CODE): only a brand-new account can be referred, never by itself or by an account with the same wallet
    const r = ref ? byRef.get(String(ref).toUpperCase().slice(0, 12)) : null;
    if (r && !(wallet && r.wallet === wallet)) { p.referredBy = r.id; refAdd(r.id, 1); }
    byRef.set(p.refCode, p);
    freshProgress(p, t);
    db.players[id] = p; if (wallet) byWallet.set(wallet, p);
    touch(p);
    return p;
  }
  const findByWallet = (w) => byWallet.get(w) || null;
  function linkWallet(p, wallet) { p.wallet = wallet; byWallet.set(wallet, p); touch(p); }

  // sessions: random 192-bit secret, only its hash is stored
  function newSession(p) {
    const secret = crypto.randomBytes(24).toString("hex"), t = now();
    p.sessions = p.sessions.filter((s) => t - s.last < 60 * DAY).slice(-4);
    p.sessions.push({ h: sha(secret), last: t });
    touch(p);
    return p.id + "." + secret;
  }
  function authToken(header) {
    const m = /^Bearer ([0-9a-f]{12})\.([0-9a-f]{48})$/.exec(header || "");
    const p = m && db.players[m[1]];
    if (!p) return null;
    const h = Buffer.from(sha(m[2]), "hex");
    const s = p.sessions.find((x) => crypto.timingSafeEqual(Buffer.from(x.h, "hex"), h));
    if (!s) return null;
    s.last = now();
    return p;
  }
  function dropSession(p, header) {
    const m = /^Bearer ([0-9a-f]{12})\.([0-9a-f]{48})$/.exec(header || "");
    if (m) { const h = sha(m[2]); p.sessions = p.sessions.filter((s) => s.h !== h); touch(p); }
  }

  // ---- hero / items ---------------------------------------------------------------------------------
  function addXp(p, x) {
    const h = p.hero;
    h.xp += x;
    while (h.lvl < S.HERO_MAX && h.xp >= S.xpNeed(h.lvl)) { h.xp -= S.xpNeed(h.lvl); h.lvl++; evt(p, "Manager reached level " + h.lvl + "!"); }
    if (h.lvl >= S.HERO_MAX) h.xp = Math.min(h.xp, S.xpNeed(S.HERO_MAX));
  }
  function evt(p, text) { p.events.push(text); if (p.events.length > 20) p.events.shift(); }

  function rollRarity(p, d) { // d = floor depth: deeper floors favour better rarities
    const h = p.hero;
    h.pE++; h.pL++;
    const minR = h.pL >= 500 || rng() < Math.max(0, (h.pL - 300) * 0.005) ? 4 : h.pE >= 50 ? 3 : 0;
    const w = S.RARITIES.map((x, i) => (i < minR ? 0 : x.w0 * Math.exp((x.k * d) / 30)));
    let u = rng() * w.reduce((a, b) => a + b), r = 0;
    for (; r < 5; r++) { if (u <= w[r]) break; u -= w[r]; }
    if (r >= 3) h.pE = 0;
    if (r >= 4) h.pL = 0;
    return r;
  }
  const rollItemLevel = (p) => Math.max(1, p.hero.lvl + Math.floor(rnd(-S.ITEM_LVL_SPREAD, S.ITEM_LVL_SPREAD + 1)));
  function genItem(p, lvl, slot, r, depth) {
    slot = slot || S.SLOTS[Math.floor(rng() * 8)];
    if (r == null) r = rollRarity(p, depth || 1);
    const R = S.RARITIES[r], f = 1 + 0.03 * (lvl - 1);
    const it = { id: p.nextId++, slot, r, il: lvl, v: (S.SLOT_STAT[slot][2] / 100) * R.m * f * rnd(0.9, 1.1), dur: R.dur, max: R.dur, aff: [], lock: false, up: 0 };
    const mk = (k) => it.aff.push({ k, v: (S.AFFIXES[k][1] / 100) * Math.sqrt(R.m) * f * rnd(0.9, 1.1) });
    if (slot === "Amulet") mk("drop");
    const pool = Object.keys(S.AFFIXES).filter((k) => k !== "drop" || slot !== "Amulet");
    const want = Math.min(R.aff, pool.length);
    while (it.aff.length - (slot === "Amulet" ? 1 : 0) < want) {
      const k = pool[Math.floor(rng() * pool.length)];
      if (!it.aff.some((a) => a.k === k)) mk(k);
    }
    return it;
  }
  // Items found while mining wait in p.pending until the player presses "Claim mining rewards".
  function dropItem(p, it, where) {
    p.items++; // counts towards the leaderboard
    if (p.pending.items.length >= C.PENDING_MAX) {
      const v = S.sellValue(it); p.cash += v;
      evt(p, "Rewards full — auto-sold " + S.itemName(it) + " for $" + Math.floor(v) + ". Claim your rewards!");
      return;
    }
    p.pending.items.push(it);
    evt(p, "✨ " + S.itemName(it) + " " + where);
  }
  // items that go straight into the backpack (opened crates)
  function addToBackpack(p, it, where) {
    p.items++;
    if (S.spareItems(p).length >= S.invCap(p)) {
      const v = S.sellValue(it); p.cash += v;
      evt(p, "Backpack full — auto-sold " + S.itemName(it) + " for $" + Math.floor(v));
      return;
    }
    p.inv.push(it);
    evt(p, "✨ " + S.itemName(it) + " " + where);
  }
  function autoEquip(p) {
    S.SLOTS.forEach((s) => {
      const q = (i) => i.v * S.upMult(i);
      const best = p.inv.filter((i) => i.slot === s && S.canEquip(p, i) && S.usable(i)).sort((x, y) => q(y) - q(x))[0];
      if (best) p.eq[s] = best.id;
    });
  }

  // ---- time: income, xp, wear and drops are all paid from SERVER time ------------------------------------
  function settle(p, t = now()) {
    const gap = t - p.settledAt;
    if (!(gap > 0)) return;
    p.settledAt = t;
    const online = gap <= C.ONLINE_GRACE_MS;
    const unlocked = S.offlineUnlocked(p, t); // Offline Earnings: all quests finished
    const span = online ? gap : Math.min(gap, unlocked ? C.OFFLINE_MAX_MS : C.OFFLINE_FREE_MS); // 8 h with the perk, else 15 min
    const t0 = t - gap, t1 = t0 + span;
    const cuts = [t0, t1];
    for (const k of S.BOOST_KEYS) { const e = p.boosts[k]; if (e > t0 && e < t1) cuts.push(e); }
    cuts.sort((a, b) => a - b);
    const c0 = S.ctx(p, t0);
    let cash = 0, xp = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const sec = (cuts[i + 1] - cuts[i]) / 1000;
      cash += S.income(p, cuts[i]).perSec * sec;
      xp += sec * S.XP_PER_SEC * (1 + c0.fx.xp) * S.xpMult(p, cuts[i]);
    }
    if (!(cash >= 0) || !isFinite(cash)) cash = 0;
    if (!online) {
      // Away: cash is held for the "Welcome back" collect; items, crates and Mine Shards found meanwhile go to the
      // normal reward stash (Claim mining rewards); $MINE is mined by tick() into the balance and tallied there.
      const rate = unlocked ? C.OFFLINE_CASH_RATE : 1;
      p.pendingOffline += cash * rate;
      const found = rollDrops(p, t0, (span / 1000) * rate);
      p.offAcc.items += found.items; p.offAcc.crates += found.crates; p.offAcc.shards += found.shards;
      return;
    }
    p.cash += cash; p.stats.totalEarned += cash;
    addXp(p, xp);
    const dt = span / 1000;
    bumpQ(p, "play", dt, t);
    p.wear += (dt * (1 - c0.fx.guard)) / 360; // 1 durability per 6 min
    if (p.wear >= 1) {
      const w = Math.floor(p.wear); p.wear -= w;
      for (const s of S.SLOTS) {
        const it = S.itemById(p, p.eq[s]);
        if (it && it.dur > 0) { it.dur = Math.max(0, it.dur - w); if (it.dur === 0) evt(p, "💥 " + S.itemName(it) + " broke!"); }
      }
    }
    rollDrops(p, t0, dt);
    p.power = S.heroPower(p);
  }
  // Rolls everything the miners find during `dt` seconds of work: gear, crates and (from floor 15) Mine Shards.
  // Finds wait in p.pending until "Claim mining rewards". Returns how many of each were found.
  function rollDrops(p, t0, dt) {
    const found = { items: 0, crates: 0, shards: 0 };
    const h = p.hero, today = new Date(t0).toISOString().slice(0, 10);
    if (h.day !== today) { h.day = today; h.n = 0; }
    const { c, trips } = S.tripsPerSec(p, t0);
    const w = trips.map((tr, i) => tr * (1 + 0.025 * (i + 1))), W = w.reduce((a, b) => a + b, 0), T = trips.reduce((a, b) => a + b, 0);
    if (!(T > 0)) return found;
    let remaining = T * dt, guard = 0;
    while (guard++ < 2000) {
      const pAvg = (S.DROP_P0 * DROP_MULT * (W / T) * (1 + c.fx.drop)) / (1 + h.n / 40);
      if (!(pAvg > 0)) break;
      const k = pAvg >= 1 ? 0 : Math.floor(Math.log(1 - rng()) / Math.log(1 - pAvg)); // trips until the next drop
      if (k + 1 > remaining) break;
      remaining -= k + 1;
      let u = rng() * W, i = 0;
      for (; i < w.length - 1; i++) { if (u <= w[i]) break; u -= w[i]; }
      h.n++;
      if (rng() < 0.25) { p.pending.crates++; found.crates++; evt(p, "📦 Equipment crate found on floor " + (i + 1) + "!"); }
      else { dropItem(p, genItem(p, rollItemLevel(p), null, null, i + 1), "found on floor " + (i + 1) + "!"); found.items++; }
      bumpQ(p, "drops", 1);
    }
    // Mine Shards: independent, very rare roll per finished trip on floors SHARD_FROM and deeper
    let lam = 0;
    for (let i = S.SHARD_FROM - 1; i < trips.length; i++) lam += trips[i] * dt * S.SHARD_P * DROP_MULT * (1 + S.SHARD_DEPTH_BONUS * (i - (S.SHARD_FROM - 1)));
    const n = poisson(lam * (1 + c.fx.drop));
    if (n > 0) {
      p.pending.shards += n; found.shards += n; bumpQ(p, "shards", n);
      evt(p, "💠 " + n + " Mine Shard" + (n === 1 ? "" : "s") + " found!");
    }
    return found;
  }

  // ---- daily / seasonal quest counters -------------------------------------------------------------------
  // Daily counters reset at 00:00 UTC, seasonal ones with the season. bumpQ() is called wherever the player does something countable.
  function rollQ(p, t) {
    const today = dayStr(t);
    if (p.dq.day !== today) p.dq = { day: today, prog: {}, claimed: {}, bonus: false };
    if (p.sq.start !== db.season.start) p.sq = { start: db.season.start, prog: {}, claimed: {} };
  }
  function bumpQ(p, metric, n = 1, t = now()) {
    if (!(n > 0)) return;
    rollQ(p, t);
    p.dq.prog[metric] = (p.dq.prog[metric] || 0) + n;
    p.sq.prog[metric] = (p.sq.prog[metric] || 0) + n;
  }
  // hands out a reward (see S.DAILY_REWARDS) and returns what was given, for the "you got ..." message
  function grant(p, r, t) {
    const got = { cash: 0, crates: 0, mine: 0, bag: {} };
    got.cash = S.rewardCash(r, S.income(p, t).perSec);
    if (got.cash) p.cash += got.cash;
    if (r.crates) { p.hero.crates += r.crates; got.crates = r.crates; }
    if (r.mine) { p.balance += r.mine; p.earned += r.mine; got.mine = r.mine; } // counts as mined $MINE (same pool, same leaderboard)
    for (const [k, n] of Object.entries(r.bag || {})) { p.bag[k] = Math.min(S.BAG_MAX, (p.bag[k] || 0) + n); got.bag[k] = n; }
    return got;
  }

  // ---- $MINE emission: every 5s the season's daily pool is split by power share ------------------
  const room = (p) => (isPaid(p) ? Infinity : Math.max(0, C.FREE_EARN_CAP - p.earned)); // free players stop at 20 000
  function tick() {
    const t = now(), upto = Math.min(t, seasonEnd());
    const dt = clamp((upto - db.lastTick) / 1000, 0, 60); // downtime is not paid out
    if (upto > db.lastTick) { db.lastTick = upto; touchMeta(); }
    if (dt <= 0) return;
    const act = Object.values(db.players).filter((p) => isActive(p, upto));
    if (!act.length) return;
    const wt = new Map(); let G = 0;
    for (const p of act) { const x = weight(p, upto); wt.set(p.id, x); G += x; }
    if (!(G > 0)) return;
    const pool = (C.DAILY * Math.min(1, act.length / C.FULL_PLAYERS) * dt) / 86400, cap = (C.DAILY * C.PLAYER_DAILY_CAP * dt) / 86400;
    for (const p of act) {
      let g = Math.min((pool * wt.get(p.id)) / G, cap);
      if (upto - p.lastSeen <= C.ONLINE_GRACE_MS && p.earned < C.ONBOARD_CAP) { // fast start: the first 20 000 $MINE of an active player
        const fast = Math.min(C.ONBOARD_RATE * dt, C.ONBOARD_CAP - p.earned);
        if (fast > g) { db.bonus += fast - g; g = fast; }
      }
      g = Math.min(g, room(p));
      if (g > 0) {
        p.balance += g; p.earned += g; touch(p);
        if (upto - p.lastSeen > C.ONLINE_GRACE_MS) p.offAcc.mine += g;   // mined while away: shown in "Welcome back"
      }
    }
  }

  // ---- leaderboard ---------------------------------------------------------------------------------------
  const pointsOf = (p) => Math.floor(p.power + p.hero.lvl * 20 + p.items * 5 + p.earned * 0.1);
  let prizeW = null;
  function prizeFor(rank) {
    if (rank < 1 || rank > C.LB_SIZE) return 0;
    if (!prizeW) { prizeW = Array.from({ length: C.LB_SIZE }, (_, i) => 1 / Math.pow(i + 1, C.LB_PRIZE_EXP)); prizeW.sum = prizeW.reduce((a, b) => a + b, 0); }
    return (C.LB_POOL * prizeW[rank - 1]) / prizeW.sum;
  }
  function board() {
    if (boardCache.v && Date.now() - boardCache.t < 3000) return boardCache.v;
    const t = Math.min(now(), seasonEnd()), all = Object.values(db.players);
    const ranked = all.filter((p) => p.power > 0).map((p) => ({ p, pts: pointsOf(p) }))
      .sort((a, b) => b.pts - a.pts || a.p.created - b.p.created);
    const rank = new Map(); ranked.forEach((r, i) => rank.set(r.p.id, i + 1));
    const act = ranked.filter((r) => isActive(r.p, t));
    const w = new Map(); let globalW = 0;
    for (const r of act) { const x = weight(r.p, t); w.set(r.p.id, x); globalW += x; }
    const v = { ranked, rank, players: act.length, global: act.reduce((s, r) => s + r.p.power, 0), globalW, w,
      minedAll: all.reduce((s, p) => s + p.earned, 0), total: all.length, online: all.filter((p) => now() - p.lastSeen < C.ONLINE_GRACE_MS).length };
    boardCache = { t: Date.now(), v };
    return v;
  }
  const row = (r, i) => ({ rank: i + 1, name: r.p.name, level: r.p.hero.lvl, power: Math.round(r.p.power), items: r.p.items, earned: r.p.earned, prize: prizeFor(i + 1), pts: r.pts, pack: isPaid(r.p) });
  const seasonInfo = () => ({ start: db.season.start, end: seasonEnd(), now: now(), over: over(), days: C.SEASON_DAYS });
  function leaderboard(p) {
    const b = board();
    return { season: seasonInfo(), players: b.players, global: b.global, minedAll: b.minedAll, total: b.ranked.length,
      rows: b.ranked.slice(0, C.LB_SIZE).map(row), me: p ? row({ p, pts: pointsOf(p) }, (b.rank.get(p.id) || b.ranked.length + 1) - 1) : null };
  }

  // ---- referral leaderboard: who brought in the most players / earned the most from their purchases ---------------
  function refBoard(p) {
    if (!refCache.v || Date.now() - refCache.t > 3000) {
      const all = [];
      for (const q of Object.values(db.players)) {
        const n = refCount(q);
        if (n > 0 || q.refEarned > 0) all.push({ id: q.id, name: q.name, referred: n, earned: q.refEarned });
      }
      all.sort((a, b) => b.earned - a.earned || b.referred - a.referred || a.name.localeCompare(b.name));
      refCache = { t: Date.now(), v: all };
    }
    const all = refCache.v, row = (r, i) => ({ rank: i + 1, name: r.name, referred: r.referred, earned: r.earned });
    const mine = p ? all.findIndex((r) => r.id === p.id) : -1;
    return { rate: C.REF_RATE, total: all.length, rows: all.slice(0, C.REF_BOARD_SIZE).map(row),
      me: p ? (mine >= 0 ? row(all[mine], mine) : { rank: 0, name: p.name, referred: refCount(p), earned: p.refEarned }) : null };
  }
  // the player's own referral page: code and the people they brought in (with what each one has paid them so far)
  function referrals(p) {
    const list = Object.values(db.players).filter((o) => o.referredBy === p.id)
      .map((o) => ({ name: o.name, pack: isPaid(o), paid: o.refPaid || 0 })).sort((a, b) => b.paid - a.paid || a.name.localeCompare(b.name)).slice(0, 100);
    return { code: p.refCode, rate: C.REF_RATE, count: refCount(p), earned: p.refEarned, list };
  }

  // ---- what the client gets to see ------------------------------------------------------------------------------
  // $MINE per second the server expects to pay this player right now (used for the live estimates)
  function rateOf(p, t, b) {
    if (over() || !isActive(p, t) || (!isPaid(p) && p.earned >= C.FREE_EARN_CAP) || !(b.globalW > 0)) return 0;
    let r = Math.min(C.DAILY * Math.min(1, b.players / C.FULL_PLAYERS) * (weight(p, t) / b.globalW), C.DAILY * C.PLAYER_DAILY_CAP) / 86400;
    if (p.earned < C.ONBOARD_CAP && t - p.lastSeen <= C.ONLINE_GRACE_MS) r = Math.max(r, C.ONBOARD_RATE);
    return r;
  }
  // numbers for everybody: live reward pool, what all players together earn per day, player counts
  function stats() {
    if (statsCache.v && Date.now() - statsCache.t < 3000) return statsCache.v;
    const b = board(), t = Math.min(now(), seasonEnd());
    let perSec = 0;
    for (const r of b.ranked) if (b.w.has(r.p.id)) perSec += rateOf(r.p, t, b);
    const v = { poolTotal: C.MINING_POOL, poolLeft: Math.max(0, C.MINING_POOL - b.minedAll), minedAll: b.minedAll, perSec, daily: perSec * 86400,
      players: b.total, online: b.online, active: b.players, over: over(), end: seasonEnd(), now: now() };
    statsCache = { t: Date.now(), v };
    return v;
  }
  function mining(p) {
    const b = board(), rank = b.rank.get(p.id) || 0, t = Math.min(now(), seasonEnd());
    const act = isActive(p, t), myW = weight(p, t);
    const players = b.players + (act ? 0 : 1);
    const G = b.globalW - (act ? b.w.get(p.id) || 0 : 0) + myW, share = G ? myW / G : 0;
    const global = b.global - (act ? p.power : 0) + p.power;
    const perDay = over() ? 0 : Math.min(C.DAILY * Math.min(1, players / C.FULL_PLAYERS) * share, C.DAILY * C.PLAYER_DAILY_CAP);
    const capped = !isPaid(p) && p.earned >= C.FREE_EARN_CAP;
    const onboarding = p.earned < C.ONBOARD_CAP && !capped;
    let perSec = capped || over() ? 0 : perDay / 86400;
    if (onboarding && !over()) perSec = Math.max(perSec, C.ONBOARD_RATE);
    return { rank, prize: rank ? prizeFor(rank) : 0, pts: pointsOf(p), global, players, perDay, perSec, share, minedAll: b.minedAll, capped, onboarding,
      powerMult: S.powerMult(p, t), boostedPower: p.power * S.powerMult(p, t) };
  }
  // daily reward calendar: which day you would claim next, whether today's is available, when it resets (00:00 UTC)
  function dailyView(p, t) {
    const today = dayStr(t), alive = p.daily.last === today || p.daily.last === dayStr(t - DAY);
    const run = alive ? p.daily.streak : 0;                          // days claimed in the current run (7 = the whole week)
    const claimable = p.daily.last !== today;
    const next = (claimable ? (run >= 7 ? 0 : run) : run - 1) + 1;   // day number to claim now (or the one claimed today)
    return { claimable, day: next, run, claimedToday: !claimable, resetsIn: Date.parse(today) + DAY - t, claims: p.sq.prog.dailyClaims || 0 };
  }
  function questView(p, t, kind) {
    rollQ(p, t);
    const q = kind === "daily" ? p.dq : p.sq, defs = kind === "daily" ? S.DAILY_QUESTS : S.SEASON_QUESTS;
    const items = defs.map((d) => ({ id: d.id, value: S.questMetric(p, d, q.prog), claimed: !!q.claimed[d.id] }));
    const out = { items, resetsIn: kind === "daily" ? Date.parse(dayStr(t)) + DAY - t : seasonEnd() - t };
    if (kind === "daily") out.bonusClaimed = !!q.bonus;
    return out;
  }
  const pendingView = (p) => ({ n: p.pending.items.length, crates: p.pending.crates, shards: p.pending.shards, items: p.pending.items.map((i) => [i.slot, i.r, i.il]),
    cash: Math.max(0, p.stats.totalEarned - p.claimMark.cash), mine: Math.max(0, p.earned - p.claimMark.mine), since: p.claimMark.t, max: C.PENDING_MAX });
  function view(p) {
    const t = now(), inc = S.income(p, t), m = p.mines.start;
    const out = {
      serverNow: t, id: p.id, name: p.name, wallet: p.wallet, guest: !p.wallet, packs: p.packs, paid: isPaid(p),
      cash: p.cash, balance: p.balance, earned: p.earned, totalEarned: p.stats.totalEarned, claimed: !!p.claimed,
      mine: { prestigeMult: m.prestigeMult, warehouse: m.warehouse, elevator: m.elevator, shafts: m.shafts.map((s) => ({ level: s.level })), unlockedShaftCount: m.unlockedShaftCount, maxUnlocked: m.maxUnlocked },
      bag: p.bag, daily: dailyView(p, t), dailyQuests: questView(p, t, "daily"), seasonQuests: questView(p, t, "season"),
      ref: { code: p.refCode, rate: C.REF_RATE, earned: p.refEarned, count: refCount(p), by: p.referredBy && db.players[p.referredBy] ? db.players[p.referredBy].name : null },
      boosts: p.boosts, hero: p.hero, inv: p.inv, eq: p.eq, invPages: p.invPages, items: p.items,
      pendingOffline: p.pendingOffline, pending: pendingView(p), devFaucet: C.DEV_FAUCET,
      quests: S.questStates(p, t), social: { x: p.q.x, discord: p.q.discord },
      earnBoost: { quest: S.questBoost(p, t), total: S.earnBoost(p, t) },
      offline: { unlocked: S.offlineUnlocked(p, t), freeMin: C.OFFLINE_FREE_MS / 60000, maxHours: C.OFFLINE_MAX_MS / 3600e3,
        away: { cash: p.pendingOffline, mine: p.offAcc.mine, items: p.offAcc.items, crates: p.offAcc.crates, shards: p.offAcc.shards } },
      power: p.power, cashPerSec: inc.perSec, season: seasonInfo(), mining: mining(p),
      free: { cap: C.FREE_EARN_CAP, onboardCap: C.ONBOARD_CAP, earned: p.earned },
      events: p.events,
    };
    p.events = [];
    return out;
  }
  // called for every authenticated request: settle time, then show the player
  function touchPlayer(p) {
    const t = now();
    settle(p, t);
    p.lastSeen = t;
    touch(p);
  }

  // ---- player actions (every one is validated here) ------------------------------------------------------------
  function spendMine(p, amount) {
    if (p.balance < amount) bad("Not enough $MINE");
    p.balance -= amount;
    p.q.spent += amount; // counts towards the "Spend 25,000 $MINE" quest
  }
  function addHistory(p, h) { p.history.unshift({ t: now(), ...h }); if (p.history.length > 40) p.history.length = 40; }

  function grantPack(p, pack, how) {
    if (p.packs[pack.id]) bad("You already own this pack");
    p.packs[pack.id] = true;
    addXp(p, pack.xp);
    p.cash += pack.cash;
    p.hero.crates += pack.crates;
    for (const s of pack.slots) p.inv.push(genItem(p, p.hero.lvl, s, pack.gearRarity));
    autoEquip(p);
    p.power = S.heroPower(p);
    addHistory(p, { type: "pack", pack: pack.id, how });
    evt(p, "📦 " + pack.name + " pack unlocked!");
    touch(p);
    return payReferral(p, pack, how);
  }
  // The referrer of a buyer gets C.REF_RATE (25 %) of what the buyer paid, in $MINE. Returns the referrer (so the caller can save them too).
  function payReferral(p, pack, how) {
    const r = p.referredBy && db.players[p.referredBy];
    if (!r || r === p) return null;
    const spent = how === "sol" ? pack.sol * SOL.minePerSol : pack.mine;       // what the buyer spent, in $MINE terms
    const amt = Math.floor(spent * C.REF_RATE * 1e4) / 1e4;
    if (!(amt > 0)) return null;
    r.balance += amt; r.refEarned += amt; p.refPaid += amt;
    evt(r, "🤝 " + p.name + " bought a pack — you earned " + Math.floor(amt) + " $MINE!");
    touch(r);
    return r;
  }

  const boost = (p, k, mins, t) => { p.boosts[k] = Math.max(t, p.boosts[k]) + mins * 60000; };

  const ACTIONS = {
    upgrade(p, b, t) {
      const target = b.target;
      if (!["warehouse", "elevator", "shaft"].includes(target)) bad("Unknown upgrade");
      const m = p.mines.start;
      const idx = target === "shaft" ? intIn(b.idx, 0, m.unlockedShaftCount - 1, "floor") : 0;
      const info = S.upInfo(p, target, idx, t);
      const n = b.n === "max" ? S.maxLevels(info, p.cash) : [1, 10, 50].includes(b.n) ? b.n : bad("Invalid amount");
      if (n < 1) bad("Not enough cash");
      const cost = S.upgradeCost(info.base, info.level, n, info.cm);
      if (!(p.cash >= cost)) bad("Not enough cash");
      p.cash -= cost;
      if (target === "warehouse") m.warehouse.level += n; else if (target === "elevator") m.elevator.level += n; else m.shafts[idx].level += n;
      bumpQ(p, "levels", n, t);
    },
    // Floors 1-10 cost coins, 11-20 coins + $MINE, 21-30 coins + $MINE + Mine Shards (S.shaftUnlockCost). Nothing is taken unless all of it is there.
    unlockFloor(p, b) {
      const m = p.mines.start, i = m.unlockedShaftCount;
      if (i >= S.TOTAL_FLOORS) bad("All floors are unlocked");
      const cost = S.shaftUnlockCost(i, m);
      if (!(p.cash >= cost.cash)) bad("Not enough cash");
      if (cost.mine && !(p.balance >= cost.mine)) bad("Not enough $MINE (" + cost.mine + " needed)");
      if (cost.shards && !(p.bag.shards >= cost.shards)) bad("Not enough Mine Shards (" + cost.shards + " needed)");
      p.cash -= cost.cash;
      if (cost.mine) spendMine(p, cost.mine);
      p.bag.shards -= cost.shards;
      m.unlockedShaftCount++; m.maxUnlocked = Math.max(m.maxUnlocked || 0, m.unlockedShaftCount);
    },
    prestige(p) {
      const m = p.mines.start;
      if (m.shafts.reduce((s, sh) => s + sh.level, 0) + m.warehouse.level + m.elevator.level < 50) bad("Reach 50+ total levels to Prestige");
      m.prestigeMult *= 2; m.warehouse.level = 1; m.elevator.level = 1; m.unlockedShaftCount = 1;
      m.shafts.forEach((sh) => (sh.level = 1));
      p.cash = 0;
    },
    buy(p, b, t) {
      const key = String(b.item);
      if (key === "free_money" || key === "free_mine") { // test faucet, no cooldown (turn it off with DEV_FAUCET=off)
        if (!C.DEV_FAUCET) bad("The test faucet is turned off on this server");
        if (key === "free_money") p.cash += Math.max(10000, p.stats.totalEarned * 0.5 + 5000);
        else p.balance += C.DEV_MINE_AMOUNT;
      } else if (Object.prototype.hasOwnProperty.call(BOOST_ITEMS, key)) {
        // boosts are bought as ITEMS now: they land in the bag and do nothing until the player uses them (action "useItem")
        if (p.bag[key] >= S.BAG_MAX) bad("Your bag is full of that item");
        spendMine(p, PRICES[key]); p.bag[key]++;
      } else if (key === "page") {
        if (p.invPages >= C.MAX_PAGES) bad("All pages unlocked");
        spendMine(p, S.PAGE_COST[p.invPages]); p.invPages++;
      } else bad("Unknown item");
    },
    // "Welcome back": pays the cash earned while away and clears the tally of what else was found/mined meanwhile
    // ($MINE is already in the balance; items, crates and shards wait in Claim mining rewards).
    claimOffline(p) {
      const amt = p.pendingOffline, a = p.offAcc;
      if (!(amt > 0) && !(a.mine > 0 || a.items || a.crates || a.shards)) bad("Nothing to collect");
      const res = { cash: amt, mine: a.mine, items: a.items, crates: a.crates, shards: a.shards };
      p.cash += amt; p.stats.totalEarned += amt; p.pendingOffline = 0;
      p.offAcc = { mine: 0, items: 0, crates: 0, shards: 0 };
      return { offlineClaimed: res };
    },
    // use one stackable item from the bag. Boosts last 2 h and stack up to 12 h; Mine Shards are spent when unlocking floors.
    useItem(p, b, t) {
      const key = String(b.item);
      if (!Object.prototype.hasOwnProperty.call(BOOST_ITEMS, key)) bad(key === "shards" ? "Mine Shards are spent automatically when you unlock floors 21-30" : "Unknown item");
      if (!(p.bag[key] >= 1)) bad("You don't have that item");
      const k = BOOST_ITEMS[key], left = Math.max(0, p.boosts[k] - t);
      if (left + S.BOOST_MINUTES * 60000 > S.BOOST_MAX_MS) bad("That boost is already stacked to the maximum (12 h)");
      p.bag[key]--; boost(p, k, S.BOOST_MINUTES, t);
      return { used: key };
    },
    // daily login calendar: day 1-6 coins/items, day 7 $MINE. Miss a day and the week starts again.
    claimDaily(p, b, t) {
      const today = dayStr(t), d = p.daily;
      if (d.last === today) bad("Already claimed today — come back after 00:00 UTC");
      let run = d.last === dayStr(t - DAY) ? d.streak : 0;
      if (run >= 7) run = 0;
      const day = run + 1, got = grant(p, S.DAILY_REWARDS[run], t);
      d.last = today; d.streak = day;
      bumpQ(p, "dailyClaims", 1, t);
      evt(p, "📅 Daily reward day " + day + " claimed!");
      return { rewarded: { kind: "daily", day, ...got } };
    },
    claimQuest(p, b, t) {
      const kind = b.kind === "daily" ? "daily" : b.kind === "season" ? "season" : bad("Unknown quest type");
      rollQ(p, t);
      const q = kind === "daily" ? p.dq : p.sq, defs = kind === "daily" ? S.DAILY_QUESTS : S.SEASON_QUESTS;
      const def = defs.find((d) => d.id === b.id);
      if (!def) bad("Unknown quest");
      if (q.claimed[def.id]) bad("Already claimed");
      if (S.questMetric(p, def, q.prog) < def.target) bad("This quest isn't finished yet");
      q.claimed[def.id] = true;
      return { rewarded: { kind: "quest", id: def.id, ...grant(p, def.reward, t) } };
    },
    claimDailyBonus(p, b, t) {
      rollQ(p, t);
      if (p.dq.bonus) bad("Already claimed");
      if (!S.DAILY_QUESTS.every((d) => p.dq.claimed[d.id])) bad("Claim every daily quest first");
      p.dq.bonus = true;
      return { rewarded: { kind: "bonus", ...grant(p, S.DAILY_BONUS, t) } };
    },
    // everything the mine found since the last claim goes into the backpack / crate stock now
    claimRewards(p, b, t) {
      const pend = p.pending;
      if (!pend.items.length && !pend.crates && !pend.shards) bad("Nothing to claim yet");
      let free = S.invCap(p) - S.spareItems(p).length, moved = 0;
      pend.items.sort((x, y) => y.r - x.r || y.il - x.il || x.id - y.id);
      const rest = [];
      for (const it of pend.items) { if (free > 0) { p.inv.push(it); free--; moved++; } else rest.push(it); }
      const res = { items: moved, crates: pend.crates, shards: pend.shards, left: rest.length };
      p.hero.crates += pend.crates;
      p.bag.shards = Math.min(S.BAG_MAX, p.bag.shards + pend.shards);
      pend.items = rest; pend.crates = 0; pend.shards = 0;
      p.claimMark = { cash: p.stats.totalEarned, mine: p.earned, t };
      return { claimed: res };
    },
    upgradeItem(p, b) {
      const it = S.itemById(p, b.id);
      if (!it) bad("No such item");
      const info = S.upgradeInfo(it, p.mines.start);
      if (info.maxed) bad("This item is already +" + S.UP_MAX);
      if (!(p.cash >= info.cash)) bad("Not enough cash");
      if (info.mine) spendMine(p, info.mine); // throws "Not enough $MINE" before anything is taken
      p.cash -= info.cash;
      const ok = upRoll() < info.chance;
      bumpQ(p, "itemUp", 1);
      if (ok) { it.up = info.next; evt(p, "⬆ " + S.itemName(it) + " — upgrade succeeded!"); }
      else evt(p, "💥 Upgrade failed — " + S.itemName(it) + " is unchanged");
      return { upgrade: { ok, up: it.up || 0, chance: info.chance, name: S.itemName(it) } };
    },
    // X / Discord for the "Link X and Discord" quest. Unverified (no OAuth): the name only has to look valid and be unused.
    linkSocial(p, b) {
      const kind = b.kind;
      if (kind !== "x" && kind !== "discord") bad("Unknown account type");
      if (p.q[kind]) bad("Already linked");
      let h = String(b.handle || "").trim();
      if (kind === "x") { h = h.replace(/^@/, ""); if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) bad("Enter your X handle (1-15 letters, numbers or _)"); }
      else if (!/^[A-Za-z0-9_.]{2,32}(#\d{4})?$/.test(h)) bad("Enter your Discord username (2-32 letters, numbers, _ or .)");
      if (Object.values(db.players).some((o) => o.id !== p.id && o.q && String(o.q[kind] || "").toLowerCase() === h.toLowerCase())) bad("That account is already linked to another player");
      p.q[kind] = h;
    },
    // wipes the game progress only: wallet, name, packs, $MINE balance, boosts and quest progress stay
    reset(p, b, t) {
      if (b.confirm !== "RESET") bad("Confirmation missing");
      freshProgress(p, t);
    },
    equip(p, b) {
      const it = S.itemById(p, b.id);
      if (!it) bad("No such item");
      if (!S.canEquip(p, it)) bad("Manager must be level " + it.il + " to equip this");
      if (!S.usable(it)) bad("This item is broken (0% durability) — repair it first");
      p.eq[it.slot] = it.id;
    },
    unequip(p, b) { if (!S.SLOTS.includes(b.slot)) bad("Invalid slot"); delete p.eq[b.slot]; },
    lock(p, b) { const it = S.itemById(p, b.id); if (!it) bad("No such item"); it.lock = !it.lock; },
    sell(p, b) {
      const it = S.itemById(p, b.id);
      if (!it) bad("No such item");
      if (it.lock) bad("Item is locked");
      if (p.eq[it.slot] === it.id) bad("Unequip it first");
      p.cash += S.sellValue(it); p.inv = p.inv.filter((i) => i !== it);
    },
    sellAll(p) {
      const list = S.spareItems(p).filter((i) => !i.lock && !i.up && i.r <= 2);
      if (!list.length) bad("Nothing to sell — Epic+, upgraded and locked items are kept");
      for (const it of list) p.cash += S.sellValue(it);
      const gone = new Set(list);
      p.inv = p.inv.filter((i) => !gone.has(i));
    },
    sort(p) { p.inv.sort((x, y) => y.r - x.r || y.il - x.il || x.id - y.id); },
    autoEquip(p) { autoEquip(p); },
    repair(p, b) {
      const it = S.itemById(p, b.id);
      if (!it) bad("No such item");
      repairList(p, [it]);
    },
    repairAll(p) { repairList(p, p.inv.filter((i) => i.dur < i.max)); },
    crate(p, b) {
      if (!S.SLOTS.includes(b.slot)) bad("Invalid slot");
      if (p.hero.crates < 1) bad("No crates");
      p.hero.crates--;
      addToBackpack(p, genItem(p, rollItemLevel(p), b.slot, null, p.mines.start.unlockedShaftCount), "from the crate!");
    },
    rename(p, b) {
      const n = cleanName(b.name);
      if (n.length < 2) bad("Name must be 2-16 letters/numbers");
      p.name = uniqueName(n, p.id);
    },
    claimPrize(p) {
      if (!over()) bad("Season is still running");
      if (p.claimed) bad("Already claimed");
      if (!isPaid(p)) bad("Buy a pack to claim your prize");
      const rank = board().rank.get(p.id) || 0, prize = prizeFor(rank);
      p.claimed = true; p.balance += prize;
      return { paid: prize };
    },
  };
  function repairList(p, list) {
    if (!list.length) bad("Nothing to repair");
    const fx = S.computeFx(p), m = p.mines.start, cost = list.reduce((s, i) => s + S.repairCost(i, m, fx), 0);
    if (!(p.cash >= cost)) bad("Need $" + cost + " to repair");
    p.cash -= cost;
    list.forEach((i) => { i.max = Math.max(Math.ceil(S.RARITIES[i.r].dur * 0.5), Math.floor(i.max * 0.95)); i.dur = i.max; });
    bumpQ(p, "repair", list.length);
  }
  function act(p, body) {
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, body.type) ? ACTIONS[body.type] : null;
    if (!fn) bad("Unknown action");
    touchPlayer(p);                       // 1) pay everything earned up to this instant
    const res = fn(p, body, now()) || {}; // 2) validate + apply the action
    for (const s of S.SLOTS) { const it = S.itemById(p, p.eq[s]); if (it && it.il > p.hero.lvl) delete p.eq[s]; }
    p.power = S.heroPower(p);
    if (!isFinite(p.cash) || p.cash < 0) p.cash = Math.max(0, isFinite(p.cash) ? p.cash : 0);
    touch(p);
    return res;
  }

  // permanently delete an account. A wallet account that still holds $MINE must withdraw/spend it first (nothing is ever destroyed silently).
  async function deleteAccount(p) {
    if (p.wallet && p.balance >= 1) bad("You still hold " + Math.floor(p.balance) + " $MINE — withdraw or spend it first");
    if (Object.values(db.withdrawals).some((w) => w.pid === p.id && (w.state === "queued" || w.state === "signed" || w.state === "sent"))) bad("A withdrawal is still in progress — try again when it has finished");
    delete db.players[p.id];
    byRef.delete(p.refCode); refAdd(p.referredBy, -1);
    for (const o of Object.values(db.players)) if (o.referredBy === p.id) { o.referredBy = null; touch(o); } // their future purchases pay nobody
    refCounts.delete(p.id);
    if (p.wallet && byWallet.get(p.wallet) === p) byWallet.delete(p.wallet);
    dirty.delete(p.id); boardCache.v = null; statsCache = { t: 0, v: null };
    await store.removePlayers([p.id]);
  }

  // housekeeping: forget abandoned guest accounts (no wallet, no money in, 45 days idle)
  function prune() {
    const t = now(), gone = [];
    for (const p of Object.values(db.players)) {
      if (!p.wallet && !isPaid(p) && t - p.lastSeen > 45 * DAY && p.balance < 1) gone.push(p.id);
    }
    gone.forEach((id) => {
      const g = db.players[id];
      if (g) { byRef.delete(g.refCode); refAdd(g.referredBy, -1); refCounts.delete(id); }
      delete db.players[id]; dirty.delete(id);
    });
    for (const o of Object.values(db.players)) if (o.referredBy && !db.players[o.referredBy]) { o.referredBy = null; touch(o); }
    for (const [id, o] of Object.entries(db.orders)) if (t - o.created > 24 * 3600e3) { delete db.orders[id]; touchMeta(); }
    if (gone.length) { boardCache.v = null; return store.removePlayers(gone); }
  }

  return {
    db, C, S, now, saveNow, store, setClock: (ms) => { clockOffset = ms; }, load, flush, touch, touchMeta, metaDirty: () => metaDirty,
    createPlayer, findByWallet, linkWallet, newSession, authToken, dropSession, uniqueName, cleanName,
    touchPlayer, settle, tick, view, act, leaderboard, board, mining, stats, deleteAccount, grantPack, spendMine, addHistory, evt,
    refBoard, referrals, rollQ, bumpQ, dayStr,
    isPaid, isActive, over, seasonEnd, prune, ApiError, bad, intIn, rng, ACTIONS, PACKS, SOL,
  };
}

module.exports = { createGame, ApiError, bad };
