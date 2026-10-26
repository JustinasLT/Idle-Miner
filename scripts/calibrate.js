"use strict";
// Dev tool: runs the ORIGINAL animated simulation (miners walk, elevator travels, workers carry) headless and
// compares the cash it makes with the closed-form income used by the server (js/shared.js S.income).
//   node scripts/calibrate.js
const S = require("../js/shared.js");
function mkState(n, lvl, elev, wh, extra = {}) {
  const shafts = Array.from({ length: 30 }, () => ({ level: 1 }));
  for (let i = 0; i < n; i++) shafts[i].level = lvl;
  return { mines: { start: { prestigeMult: 1, warehouse: { level: wh }, elevator: { level: elev }, shafts, unlockedShaftCount: n } },
    boosts: { xp: 0, earn: 0, power: 0 }, hero: { lvl: 1 }, inv: [], eq: {}, ...extra };
}
function simulate(st, seconds) {
  const c = S.ctx(st, 0), mine = c.mine, n = mine.unlockedShaftCount, dt = 0.02;
  const stock = Array(n).fill(0), miners = [];
  for (let i = 0; i < n; i++) { const k = S.minersFor(mine.shafts[i].level); miners[i] = Array.from({ length: k }, (_, j) => ({ s: "wait", t: j * 0.9, p: 0, load: 0 })); }
  const e = { pos: 0, state: "idle", t: 0.6, target: 0, u: 0, v: 0, plan: 0, planV: 0, dur: 0.4 };
  const pile = { u: 0, v: 0 }, nw = Math.min(4, 1 + Math.floor(mine.warehouse.level / 5));
  const workers = Array.from({ length: nw }, (_, j) => ({ s: "wait", t: j * 0.8, p: 0, v: 0 }));
  const speed = c.hm.s, cap = S.elevatorCapacity(c); let cash = 0;
  for (let time = 0; time < seconds; time += dt) {
    for (let i = 0; i < n; i++) {
      const sims = miners[i], trip = (S.floorUnitRate(i, c) * S.T_MINER) / sims.length;
      for (const m of sims) {
        if (m.s === "wait") { m.t -= dt; if (m.t <= 0) m.s = "out"; }
        else if (m.s === "out") { m.p += (dt * speed) / S.WALK; if (m.p >= 1) { m.p = 1; m.s = "swing"; m.t = (S.SWING_N * S.SWING_T) / speed; } }
        else if (m.s === "swing") { m.t -= dt; if (m.t <= 0) { m.s = "back"; m.load = trip; } }
        else if (m.s === "back") { m.p -= (dt * speed) / S.WALK; if (m.p <= 0) { m.p = 0; m.s = "drop"; m.t = S.DROP / speed; stock[i] += m.load; m.load = 0; } }
        else { m.t -= dt; if (m.t <= 0) m.s = "out"; }
      }
    }
    // elevator
    const next = () => { if (e.u >= cap * 0.999 || e.target >= n) e.target = 0; else e.target += 1; e.state = "move"; };
    const travel = S.elevatorTravel(c), stopT = S.elevatorStop(c);
    if (e.state === "idle") { e.t -= dt; if (e.t <= 0) { if (stock.some((s) => s > 0.5)) { e.state = "move"; e.target = 1; } else e.t = 0.25; } }
    else if (e.state === "move") {
      const step = travel * dt, d = e.target - e.pos;
      if (Math.abs(d) > step) e.pos += Math.sign(d) * step;
      else { e.pos = e.target;
        if (e.target === 0) { e.state = "unload"; e.dur = stopT; e.t = e.dur; e.plan = e.u; e.planV = e.v; }
        else { e.plan = Math.min(stock[e.target - 1], cap - e.u); if (e.plan > 0.01) { e.state = "load"; e.dur = stopT; e.t = e.dur; } else next(); } }
    } else if (e.state === "load") {
      const k = e.target - 1, du = Math.min((e.plan * Math.min(dt, e.t)) / e.dur, stock[k]);
      stock[k] -= du; e.u += du; e.v += du * S.unitValue(k, mine); e.t -= dt; if (e.t <= 0) next();
    } else {
      const f = Math.min(dt, e.t) / e.dur, du = Math.min(e.plan * f, e.u), dv = Math.min(e.planV * f, e.v);
      e.u -= du; e.v -= dv; pile.u += du; pile.v += dv; e.t -= dt;
      if (e.t <= 0) { pile.u += e.u; pile.v += e.v; e.u = e.v = 0; e.state = "idle"; e.t = 0.2; }
    }
    // workers
    const carry = (S.warehouseSellRate(c) * S.T_WORKER * c.hm.c) / nw;
    for (const w of workers) {
      if (w.s === "wait") { w.t -= dt; if (w.t <= 0 && pile.u > 0.5) { const take = Math.min(pile.u, carry), v = (pile.v * take) / pile.u; pile.u -= take; pile.v -= v; w.v = v; w.s = "out"; } }
      else if (w.s === "out") { w.p += (dt * c.hm.s) / S.WALK_W; if (w.p >= 1) { w.p = 1; w.s = "drop"; w.t = 0.3; cash += w.v * (1 + c.fx.fort); w.v = 0; } }
      else if (w.s === "drop") { w.t -= dt; if (w.t <= 0) w.s = "back"; }
      else { w.p -= (dt * c.hm.s) / S.WALK_W; if (w.p <= 0) { w.p = 0; w.s = "wait"; w.t = 0; } }
    }
  }
  return cash / seconds;
}
const cases = [[1, 1, 1, 1], [1, 10, 5, 5], [3, 5, 5, 5], [5, 20, 15, 15], [8, 30, 20, 20], [12, 40, 30, 30], [20, 60, 40, 40], [30, 100, 80, 80], [5, 5, 1, 1], [5, 50, 1, 50], [5, 50, 50, 1]];
let sum = 0;
for (const [n, lvl, el, wh] of cases) {
  const st = mkState(n, lvl, el, wh), a = S.income(st, 0).perSec, sim = simulate(st, 900), r = sim / a;
  sum += r; console.log(`floors ${n} lvl ${lvl} elev ${el} wh ${wh}:  formula ${a.toFixed(1)}/s   simulation ${sim.toFixed(1)}/s   sim/formula ${r.toFixed(3)}`);
}
console.log("mean ratio", (sum / cases.length).toFixed(3));
