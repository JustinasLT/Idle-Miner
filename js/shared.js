"use strict";
// Shared game math. The SERVER is the authority and uses this file to decide everything;
// the browser loads the same file only to display costs/rates. Pure functions, no DOM, no globals.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.Shared = api;
})(typeof self !== "undefined" ? self : this, function () {
  const S = {};

  S.TOTAL_FLOORS = 30;
  S.PAGE_SIZE = 48; S.MAX_PAGES = 5; S.PAGE_COST = [0, 300, 800, 2000, 5000]; // $MINE price of backpack page n+1
  S.ITEM_LVL_SPREAD = 10;
  S.DROP_P0 = 0.0002;
  S.BOOST_MULT = { elev: 3, mine: 2, sell: 2 };

  // timings of the animated miners (also define how many ore trips happen per second)
  S.WALK = 1.5; S.SWING_N = 4; S.SWING_T = 0.35; S.DROP = 0.2;
  S.T_MINER = 2 * S.WALK + S.SWING_N * S.SWING_T + S.DROP;
  S.WALK_W = 2.2; S.T_WORKER = 2 * S.WALK_W + 0.3;

  S.RESEARCH_NODES = [
    { id: "cost10", name: "Efficient Plans", desc: "All upgrade costs −10%", cost: 25e3, effect: { upgradeCostMult: 0.9 } },
    { id: "elevCap", name: "Heavy Cables", desc: "Elevator capacity +25%", cost: 80e3, effect: { elevatorCapMult: 1.25 } },
    { id: "idle20", name: "Night Shift", desc: "Offline earnings +20%", cost: 200e3, effect: { offlineMult: 1.2 } },
    { id: "sell10", name: "Market Access", desc: "Warehouse sell speed +10%", cost: 450e3, effect: { sellMult: 1.1 } },
    { id: "mine10", name: "Sharper Picks", desc: "Shaft production +10%", cost: 1e6, effect: { mineMult: 1.1 } },
    { id: "mine20", name: "Power Drills", desc: "Shaft production +20%", cost: 4e6, effect: { mineMult: 1.2 } },
    { id: "sell20", name: "Express Shipping", desc: "Warehouse sell speed +20%", cost: 12e6, effect: { sellMult: 1.2 } },
    { id: "cost20", name: "Bulk Discounts", desc: "All upgrade costs −15%", cost: 40e6, effect: { upgradeCostMult: 0.85 } },
  ];
  S.SLOTS = ["Pickaxe", "Shoes", "Helmet", "Shirt", "Gloves", "Pants", "Amulet", "Ring"];
  S.SLOT_STAT = {
    Pickaxe: ["yield", "Ore Yield", 6], Shoes: ["speed", "Transit Speed", 5], Helmet: ["cap", "Capacity", 5],
    Shirt: ["aura", "Aura Strength", 4], Gloves: ["disc", "Upgrade Discount", 1.5], Pants: ["guard", "Durability Guard", 4],
    Amulet: ["fort", "Fortune (cash)", 2], Ring: ["haste", "Warehouse Haste", 3],
  };
  S.STAT_CAP = { disc: 0.4, guard: 0.75, fort: 1, haste: 0.5, drop: 1 };
  S.RARITIES = [
    { n: "Common", m: 1, aff: 0, dur: 100, c: "#b0bec5", w0: 70, k: -1 },
    { n: "Uncommon", m: 1.35, aff: 1, dur: 120, c: "#66bb6a", w0: 22, k: 0 },
    { n: "Rare", m: 1.9, aff: 2, dur: 150, c: "#42a5f5", w0: 6.5, k: 0.7 },
    { n: "Epic", m: 2.8, aff: 2, dur: 200, c: "#ab47bc", w0: 1.3, k: 1.4 },
    { n: "Legendary", m: 4.2, aff: 3, dur: 300, c: "#ffa726", w0: 0.2, k: 2.2 },
    { n: "Mythic", m: 6.5, aff: 4, dur: 500, c: "#ef5350", w0: 0.02, k: 3 },
  ];
  S.AFFIXES = { drop: ["Drop Rate", 4], xp: ["Hero XP", 8], repair: ["Repair Discount", 5], lucky: ["Lucky Haul (chance x3)", 1] };
  S.FUSE = [[5, 1], [5, 0.8], [4, 0.6], [4, 0.4], [3, 0.25]];
  const FX0 = () => ({ yield: 0, speed: 0, cap: 0, aura: 0, disc: 0, guard: 0, fort: 0, haste: 0, drop: 0, xp: 0, repair: 0, lucky: 0 });
  S.FX0 = FX0;

  // ---- infrastructure maths ---------------------------------------------------------
  S.minersFor = (lvl) => Math.min(4, 1 + Math.floor(lvl / 5));
  S.unitValue = (i, mine) => 1.5 * Math.pow(2.3, i) * mine.prestigeMult;
  S.infraScale = (mine) => Math.pow(1.9, mine.unlockedShaftCount - 1);
  S.shaftUnlockCost = (floorIndex) => Math.floor(60 * Math.pow(2.8, floorIndex));
  S.upgradeCost = (base, level, n, costMult) => {
    let total = 0;
    for (let i = 0; i < n; i++) total += Math.floor(base * Math.pow(1.12, level + i) * costMult);
    return total;
  };
  S.shopScale = (mine) => Math.ceil(S.infraScale(mine));
  S.xpNeed = (lvl) => 60 + 30 * lvl;

  // ---- hero / gear ----------------------------------------------------------------
  S.itemById = (st, id) => st.inv.find((i) => i.id === id);
  S.itemPower = (it) => Math.round((it.v + it.aff.reduce((s, a) => s + a.v, 0)) * 1000 * (it.dur ? 1 : 0.25));
  S.sellValue = (it) => Math.ceil(35 * Math.pow(3.2, it.r) * (1 + 0.4 * (it.il - 1)) * (0.5 + (0.5 * it.dur) / it.max));
  S.repairCost = (it, mine, fx) => Math.ceil((it.max - it.dur) * 0.8 * Math.pow(3, it.r) * S.infraScale(mine) * (1 - fx.repair));
  S.fuseCost = (r, mine) => Math.ceil(150 * Math.pow(6, r) * S.infraScale(mine));
  S.canEquip = (st, it) => it.il <= st.hero.lvl;
  S.invCap = (st) => st.invPages * S.PAGE_SIZE;
  S.spareItems = (st) => st.inv.filter((i) => st.eq[i.slot] !== i.id);

  S.computeFx = (st) => {
    const f = FX0();
    for (const s of S.SLOTS) {
      const it = S.itemById(st, st.eq[s]);
      if (!it) continue;
      const q = it.dur > 0 ? 1 : 0.25; // broken gear works at 25%
      f[S.SLOT_STAT[s][0]] += it.v * q;
      it.aff.forEach((a) => (f[a.k] += a.v * q));
    }
    for (const k in S.STAT_CAP) f[k] = Math.min(f[k], S.STAT_CAP[k]);
    return f;
  };
  S.heroMult = (st, fx) => {
    const a = Math.min(0.15, 0.05 + 0.0015 * st.hero.lvl) * (1 + fx.aura);
    return { y: 1 + a + fx.yield, s: 1 + a + fx.speed, c: 1 + a + fx.cap };
  };
  S.heroPower = (st) => {
    let p = st.hero.lvl * 50;
    for (const s of S.SLOTS) { const it = S.itemById(st, st.eq[s]); if (it) p += S.itemPower(it); }
    return Math.round(p);
  };
  S.researchMult = (st, fx) => {
    const r = { upgradeCostMult: 1, elevatorCapMult: 1, offlineMult: 1, sellMult: 1, mineMult: 1 };
    for (const node of S.RESEARCH_NODES) {
      if (!st.researchUnlocked.includes(node.id)) continue;
      const e = node.effect;
      for (const k in e) r[k] *= e[k];
    }
    r.upgradeCostMult *= 1 - fx.disc;
    return r;
  };
  S.boostMult = (st, k, t) => (t < (st.boosts[k] || 0) ? S.BOOST_MULT[k] : 1);

  // One bundle with everything derived from a state at time t (ms).
  S.ctx = (st, t) => {
    const fx = S.computeFx(st), hm = S.heroMult(st, fx), rm = S.researchMult(st, fx);
    const bm = { mine: S.boostMult(st, "mine", t), elev: S.boostMult(st, "elev", t), sell: S.boostMult(st, "sell", t) };
    return { st, mine: st.mines.start, fx, hm, rm, bm };
  };
  S.floorUnitRate = (i, c) => c.mine.shafts[i].level * 12 * c.rm.mineMult * c.hm.y * c.bm.mine;
  S.elevatorCapacity = (c) => (c.mine.elevator.level * 100 + 50) * c.rm.elevatorCapMult * c.hm.c;
  S.elevatorBuff = (c) => c.bm.elev * c.hm.s;
  S.elevatorTravel = (c) => (1.4 + 0.15 * c.mine.elevator.level) * S.elevatorBuff(c); // floors / s
  S.elevatorStop = (c) => 0.45 / (S.elevatorBuff(c) * (1 + 0.02 * c.mine.elevator.level));
  S.warehouseSellRate = (c) => c.mine.warehouse.level * 10 * c.rm.sellMult * (1 + c.fx.haste) * c.bm.sell;

  // Elevator simulated cycle by cycle with exactly the rules of the animation (visits floors top-down, loads until full,
  // skips empty boxes, returns when full or at the deepest floor). Returns units/s brought up from each floor.
  S.elevatorFlow = (P, n, travel, stop, cap) => {
    const stock = new Array(n).fill(0), got = new Array(n).fill(0);
    const WARM = 20, MEAS = 120;
    let t = 0, tStart = -1;
    const adv = (dt) => { for (let i = 0; i < n; i++) stock[i] += P[i] * dt; t += dt; };
    for (let guard = 0; guard < 4000 && t < WARM + MEAS; guard++) {
      adv(0.2);                                                    // idle at the surface after unloading
      let any = false; for (let i = 0; i < n; i++) if (stock[i] > 0.5) { any = true; break; }
      if (!any) { adv(0.25); continue; }
      let u = 0, pos = 0, target = 1;
      const loaded = [];
      for (;;) {
        adv(Math.abs(target - pos) / travel); pos = target;
        const plan = Math.min(stock[target - 1], cap - u);
        if (plan > 0.01) { stock[target - 1] -= plan; u += plan; loaded.push([target - 1, plan]); adv(stop); }
        if (u >= cap * 0.999 || target >= n) break;
        target++;
      }
      adv(pos / travel + stop);                                    // drive up, unload
      if (tStart < 0 && t >= WARM) tStart = t;
      else if (tStart >= 0) for (const [i, q] of loaded) got[i] += q;
    }
    const span = t - tStart;
    return tStart < 0 || span <= 0 ? P.slice() : got.map((g) => g / span);
  };

  // Cash income per second of the whole mine (miners -> floor boxes -> elevator -> drop pile -> warehouse workers).
  // scripts/calibrate.js checks this model against the original animated simulation.
  S.EFFICIENCY = 0.97; // measured: the animation averages ~3% below the model
  S.income = (st, t) => {
    const c = S.ctx(st, t), mine = c.mine, n = mine.unlockedShaftCount, lk = 1 + 2 * c.fx.lucky;
    const P = []; // ore units per second each floor puts into its box (miners also walk faster with Transit Speed)
    for (let i = 0; i < n; i++) P.push(S.floorUnitRate(i, c) * c.hm.s * lk);
    const travel = S.elevatorTravel(c), stop = S.elevatorStop(c), cap = S.elevatorCapacity(c);
    const E = S.elevatorFlow(P, n, travel, stop, cap);              // units/s the elevator really brings up per floor
    let units = 0, value = 0, mineV = 0;
    for (let i = 0; i < n; i++) { units += E[i]; value += E[i] * S.unitValue(i, mine); mineV += P[i] * S.unitValue(i, mine); }
    const eff = (S.warehouseSellRate(c) * c.hm.c * S.T_WORKER) / ((2 * S.WALK_W) / c.hm.s + 0.3); // units/s the workers can sell
    const flow = units > eff ? eff / units : 1;
    const perSec = value * flow * (1 + c.fx.fort) * S.EFFICIENCY;
    return { c, perSec, mineV, units, eff, elevV: value, whV: eff * (units ? value / units : 0) };
  };
  // finished miner trips per second on each unlocked floor (each trip can drop an item)
  S.tripsPerSec = (st, t) => {
    const c = S.ctx(st, t), out = [];
    for (let i = 0; i < c.mine.unlockedShaftCount; i++) out.push((S.minersFor(c.mine.shafts[i].level) * c.hm.s) / S.T_MINER);
    return { c, trips: out };
  };

  // ---- upgrade info shared by UI and server ------------------------------------------
  S.upInfo = (st, target, idx, t) => {
    const c = S.ctx(st, t), mine = c.mine, infra = c.rm.upgradeCostMult * S.infraScale(mine);
    if (target === "warehouse") return { name: "Warehouse", level: mine.warehouse.level, base: 25, cm: infra };
    if (target === "elevator") return { name: "Elevator", level: mine.elevator.level, base: 40, cm: infra };
    return { name: "Floor " + (idx + 1), level: mine.shafts[idx].level, base: 18 * Math.pow(2.3, idx), cm: c.rm.upgradeCostMult };
  };
  S.maxLevels = (info, cash) => {
    let n = 0, lv = info.level;
    while (n < 500) { const c = S.upgradeCost(info.base, lv, 1, info.cm); if (cash < c) break; cash -= c; lv++; n++; }
    return n;
  };

  return S;
});
