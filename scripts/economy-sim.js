"use strict";
// Coin-economy simulation for a NEW player (uses the real js/shared.js, so it always matches the game).
//   node scripts/economy-sim.js            -> full report
//   node scripts/economy-sim.js --quiet    -> only the milestone table
// Bot: an attentive player who buys the next floor as soon as it is affordable and otherwise spends on the best-payback upgrade (cost / income gained;
// level purchases come in chunks of ~10 % of the current level count). Floors 11+ also need $AFKMINE and 21+ Mine Shards in the
// real game; here they are treated as available so the COIN curve can be read on its own (see the power section for the other gate).
const S = require("../js/shared.js");
{ const i = process.argv.indexOf("--set"); if (i > 0) for (const kv of process.argv[i + 1].split(",")) { const [k, v] = kv.split("="); S[k] = +v; } }   // e.g. --set UNLOCK_STEEP_JUMP=8,LEVEL_GROWTH=1.14
const T_SNAP = [60, 600, 3600, 12 * 3600];                    // minute 1, minute 10, minute 60, "day 1" = 12 h of active play
const SNAP_NAME = ["minute 1", "minute 10", "minute 60", "day 1 (12 h)"];

function newState() {
  const it = (id, slot) => ({ id, slot, r: 0, il: 1, v: S.SLOT_STAT[slot][2] / 100, dur: 100, max: 100, aff: [], lock: false, up: 0 });
  const inv = [it(1, "Pickaxe"), it(2, "Shoes"), it(3, "Helmet")];
  return { cash: 50, hero: { lvl: 1, xp: 0 }, inv, eq: { Pickaxe: 1, Shoes: 2, Helmet: 3 }, boosts: { xp: 0, earn: 0, power: 0 }, q: {}, balance: 0, tradeStats: {}, lastWithdrawAt: 0,
    mines: { start: { prestigeMult: 1, warehouse: { level: 1 }, elevator: { level: 1 }, shafts: Array.from({ length: 30 }, () => ({ level: 1 })), unlockedShaftCount: 1, maxUnlocked: 1 } } };
}
const levelAt = (xp) => { let l = 1, need = 0; while (l < 99 && xp >= need + S.xpNeed(l)) { need += S.xpNeed(l); l++; } return l; };

function run(horizon) {
  const saved = S.FLOOR_POWER_REQ.slice();
  try { return run1(horizon); } finally { saved.forEach((v, i) => (S.FLOOR_POWER_REQ[i] = v)); }
}
function run1(horizon) {
  const END = Math.max(horizon || 0, T_SNAP[T_SNAP.length - 1]);
  S.FLOOR_POWER_REQ.fill(0);                                  // coin curve only; the power curve is reported separately
  const st = newState(), m = st.mines.start;
  const levelsOf = (k) => (k === "e" ? m.elevator : k === "w" ? m.warehouse : m.shafts[k]);
  const inc = (t) => S.income(st, t * 1000).perSec;
  let t = 0, bought = 0, firstBuy = null;
  const floorAt = { 1: 0 }, lvlAt = {}, snaps = [];
  let si = 0;
  const record = () => { while (si < T_SNAP.length && t >= T_SNAP[si]) { snaps.push({ name: SNAP_NAME[si], t: T_SNAP[si], floors: m.unlockedShaftCount, levels: bought, perMin: r * 60 * 1, cash: st.cash }); si++; } };
  let r = inc(0);
  const LV = [10, 50, 100, 250, 500, 1000, 1500, 2500, 5000]; let li = 0;
  const addLevels = (n) => { bought += n; while (li < LV.length && bought >= LV[li]) { lvlAt[LV[li]] = t; li++; } };
  for (let guard = 0; guard < 400000 && t < END; guard++) {
    st.hero.lvl = levelAt(t * S.XP_PER_SEC);
    r = Math.max(1e-9, inc(t));
    const n = m.unlockedShaftCount;
    // options: +k levels on a floor / elevator / warehouse, with the income gained (payback = cost / gain, in seconds)
    const keys = [...Array(n).keys(), "e", "w"], opts = [];
    for (const key of keys) {
      const target = key === "e" ? "elevator" : key === "w" ? "warehouse" : "shaft", idx = typeof key === "number" ? key : 0;
      const o = levelsOf(key), k = Math.max(1, Math.floor(o.level * 0.1));
      const info = S.upInfo(st, target, idx, t * 1000), cost = S.upgradeCost(info.base, info.level, k, info.cm);
      o.level += k; const g = inc(t) - r; o.level -= k;
      if (g > 1e-12) opts.push({ key, k, cost, pb: cost / g });
    }
    // Policy: buy the next floor as soon as it is affordable (a new floor only pays once elevator/warehouse keep up, so it is not judged by
    // payback). Until then spend on any upgrade that pays itself back before the floor would have been affordable anyway.
    const uc = n < S.TOTAL_FLOORS ? S.shaftUnlockCost(n, m).cash : Infinity;
    const wU = (uc - st.cash) / r;
    let wait, act = "u", best = null;
    if (wU <= 0) wait = 0;
    else {
      const aff = opts.filter((o) => o.cost <= st.cash && o.pb <= wU).sort((x, y) => x.pb - y.pb)[0];
      if (aff) { best = aff; act = "b"; wait = 0; }
      else {
        const soon = opts.filter((o) => (o.cost - st.cash) / r + o.pb <= wU).sort((x, y) => x.pb - y.pb)[0];
        if (soon) { best = soon; act = "b"; wait = Math.max(0, (soon.cost - st.cash) / r); } else wait = wU;
      }
    }
    // never jump over a snapshot: advance in pieces so the report is exact
    const tNext = t + wait;
    if (si < T_SNAP.length && tNext > T_SNAP[si]) { const dt = T_SNAP[si] - t; st.cash += r * dt; t = T_SNAP[si]; record(); continue; }
    st.cash += r * wait; t = tNext;
    if (act === "u") { st.cash -= uc; m.unlockedShaftCount++; m.maxUnlocked = m.unlockedShaftCount; floorAt[m.unlockedShaftCount] = t; }
    else { st.cash -= best.cost; levelsOf(best.key).level += best.k; addLevels(best.k); if (firstBuy == null) firstBuy = t; }
    if (act === "u" && firstBuy == null) firstBuy = t;
    if (t >= T_SNAP[si]) record();
  }
  return { floorAt, lvlAt, snaps, firstBuy };
}

// ---- power curve (same assumptions as scripts/power-curve-sim.js): when does the Manager's power reach each floor's requirement? ----
function powerTimes() {
  const REQ_REAL = S.computeFloorReq();
  const R = S.RARITIES;
  const piece = (s) => { const f = 1 + 0.03 * (s.il - 1), base = 0.035 * R[s.r].m * f, aff = R[s.r].aff * 0.05 * Math.sqrt(R[s.r].m) * f; return Math.round((base + aff) * (1 + S.UP_BONUS * s.up) * 1000); };
  const STG = [{ h: 0.02, boost: 0, pieces: 3, r: 0, il: 1, up: 0 }, { h: 1, boost: 0, pieces: 2, r: 0, il: 2, up: 0 }, { h: 10, boost: 0.3, pieces: 5, r: 1, il: 12, up: 1 },
    { h: 50, boost: 0.6, pieces: 8, r: 2, il: 35, up: 4 }, { h: 200, boost: 1, pieces: 8, r: 3, il: 70, up: 7 }];
  const gearAt = (h) => { let i = 0; while (i < STG.length - 2 && h > STG[i + 1].h) i++; const a = STG[i], b = STG[i + 1], x = Math.min(1, Math.max(0, Math.log(h / a.h) / Math.log(b.h / a.h))); const ga = a.pieces * piece(a), gb = b.pieces * piece(b); return ga + (gb - ga) * x; };
  const out = {};
  for (let h = 0.02; h < 400; h *= 1.01) {
    const lvl = levelAt(0.2 * 3600 * h * (1 + Math.min(1, 0.3 * Math.log10(h + 1) * 1.6))), p = lvl * 50 + gearAt(h);
    for (let n = 1; n <= 30; n++) if (out[n] == null && p >= REQ_REAL[n - 1]) out[n] = h * 3600;
  }
  return out;
}

module.exports = { run, powerTimes };
if (require.main !== module) return;
const fmt = (s) => s == null ? "—" : s < 90 ? s.toFixed(0) + " s" : s < 5400 ? (s / 60).toFixed(1) + " min" : s < 172800 ? (s / 3600).toFixed(1) + " h" : (s / 86400).toFixed(1) + " d";
if (process.argv.includes("--floors")) { global.__floorsOnly = true; }
const res = run(200 * 3600), quiet = process.argv.includes("--quiet");
console.log("== NEW PLAYER, coins only (gates off), attentive bot ==");
console.log("first purchase after:", fmt(res.firstBuy));
console.log("time to floor N:   " + [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30].map((n) => n + ":" + fmt(res.floorAt[n])).join("  "));
console.log("time to N levels:  " + Object.keys(res.lvlAt).map((n) => n + ":" + fmt(res.lvlAt[n])).join("  "));
console.log("snapshots:");
for (const s of res.snaps) console.log(`  ${s.name.padEnd(14)} floors ${String(s.floors).padStart(2)}  levels bought ${String(s.levels).padStart(5)}  income ${S.formatMoney ? "" : ""}${Math.round(s.perMin).toLocaleString("en-US")} coins/min`);
if (!quiet) {
  const pt = powerTimes();
  console.log("== line-up with the Power gate (power curve assumptions of scripts/power-curve-sim.js) ==");
  console.log("floor  coin-time   power-gate-time   verdict");
  for (const n of [3, 4, 5, 6, 8, 10, 12, 15, 20, 25]) {
    const c = res.floorAt[n], g = pt[n] != null ? pt[n] : null, ratio = c && g ? g / c : null;
    console.log(`${String(n).padStart(4)}   ${fmt(c).padStart(9)}   ${fmt(g).padStart(14)}   ${ratio == null ? "" : ratio > 4 ? "POWER wall (" + ratio.toFixed(1) + "x the coin time)" : ratio < 0.25 ? "COIN wall (power " + (1 / ratio).toFixed(1) + "x sooner)" : "balanced"}`);
  }
}
