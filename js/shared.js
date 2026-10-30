"use strict";
// Shared game math. The SERVER is the authority and uses this file to decide everything;
// the browser loads the same file only to display costs/rates. Pure functions, no DOM, no globals.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.Shared = api;
})(typeof self !== "undefined" ? self : this, function () {
  const S = {};

  S.TOTAL_FLOORS = 30;
  S.PAGE_SIZE = 48; S.MAX_PAGES = 5; S.PAGE_COST = [0, 300, 800, 2000, 5000]; // $AFKMINE price of backpack page n+1
  S.ITEM_LVL_SPREAD = 10;
  S.DROP_P0 = 0.0002;
  S.HERO_MAX = 100;                 // the "Manager" (internal name: hero)
  S.XP_PER_SEC = 0.2; // manager XP per second of play (before boosts / gear)

  // ---- Mine Shards: a very rare stackable item. Miners on floor SHARD_FROM and deeper find them (per finished ore trip). ----
  S.SHARD_FROM = 15;
  S.SHARD_P = 0.00005;              // chance per finished miner trip on floor 15 (+8 % per floor deeper)
  S.SHARD_DEPTH_BONUS = 0.08;

  // ---- price of unlocking floor n (1-based). Floors 1-10: coins. 11-20: coins + $AFKMINE. 21-30: coins + $AFKMINE + Mine Shards. ----
  S.UNLOCK_MINE = [40, 60, 80, 110, 150, 200, 260, 340, 440, 560,            // floors 11-20
                   450, 550, 650, 800, 950, 1100, 1300, 1500, 1750, 2000];   // floors 21-30
  S.UNLOCK_SHARDS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20];                       // floors 21-30
  // i = index (0-based) of the floor being unlocked. Floors you already owned before a Prestige only cost coins again.
  S.shaftUnlockCost = (i, mine) => {
    const floor = i + 1, cash = Math.floor(60 * Math.pow(2.8, i));
    if (mine && i < (mine.maxUnlocked || 0)) return { cash, mine: 0, shards: 0 };
    return { cash, mine: floor > 10 ? S.UNLOCK_MINE[floor - 11] : 0, shards: floor > 20 ? S.UNLOCK_SHARDS[floor - 21] : 0 };
  };

  // ---- the bag: stackable items (boosts you bought or won, Mine Shards) ----
  S.BAG_ITEMS = {
    shards: { icon: "💠", name: "Mine Shards", desc: "Very rare crystals found by miners from floor 15 down. Needed to unlock floors 21-30." },
    boost_xp: { icon: "📖", name: "XP Boost", boost: "xp", desc: "Use it: +100% manager XP for 2 hours." },
    boost_earn: { icon: "💰", name: "Earnings Boost", boost: "earn", desc: "Use it: +50% earnings (cash and your $AFKMINE share) for 2 hours." },
    boost_power: { icon: "⚡", name: "Power Boost", boost: "power", desc: "Use it: +100% power for your $AFKMINE share for 2 hours." },
  };
  S.BAG_KEYS = Object.keys(S.BAG_ITEMS);
  S.BAG_MAX = 999;

  // ---- rewards (daily calendar, quests). cash = minutes of your current income (at least cashMin), crates, bag items, $AFKMINE ----
  S.rewardCash = (r, perSec) => (r && r.cash ? Math.max(r.cashMin || 0, Math.floor((perSec || 0) * 60 * r.cash)) : 0);
  S.DAILY_REWARDS = [                                                  // day 1..7 of the login streak; day 7 pays $AFKMINE
    { cash: 15, cashMin: 750 },
    { crates: 1 },
    { cash: 30, cashMin: 1500 },
    { bag: { boost_xp: 1 } },
    { cash: 60, cashMin: 4000 },
    { crates: 2, cash: 30, cashMin: 2000 },
    { mine: 5000 },
  ];
  S.DAILY_QUESTS = [                                                   // reset every day at 00:00 UTC
    { id: "d_play", icon: "⏱️", name: "Play for 15 minutes", metric: "play", target: 900, reward: { cash: 15, cashMin: 750 } },
    { id: "d_lvls", icon: "⬆️", name: "Buy 10 upgrade levels", desc: "Floors, elevator or warehouse.", metric: "levels", target: 10, reward: { cash: 20, cashMin: 1000 } },
    { id: "d_item", icon: "🔨", name: "Try 2 item upgrades", desc: "Success or fail, each attempt counts.", metric: "itemUp", target: 2, reward: { crates: 1 } },
    { id: "d_repair", icon: "🔧", name: "Repair a piece of gear", metric: "repair", target: 1, reward: { cash: 10, cashMin: 500 } },
  ];
  S.DAILY_BONUS = { crates: 1, bag: { boost_xp: 1 } };                 // finish all daily quests
  S.SEASON_QUESTS = [                                                  // last the whole 30-day season
    { id: "s_play", icon: "🕓", name: "Play for 10 hours", metric: "play", target: 36000, reward: { crates: 3 } },
    { id: "s_lvls", icon: "📈", name: "Buy 1,500 upgrade levels", metric: "levels", target: 1500, reward: { cash: 480, cashMin: 50000, bag: { boost_earn: 1 } } },
    { id: "s_drops", icon: "✨", name: "Find 30 mining drops", desc: "Items and crates found by your miners.", metric: "drops", target: 30, reward: { crates: 4 } },
    { id: "s_item", icon: "🔨", name: "Try 60 item upgrades", metric: "itemUp", target: 60, reward: { cash: 120, cashMin: 20000, bag: { boost_power: 1 } } },
    { id: "s_floors", icon: "⛏️", name: "Unlock 20 floors", metric: "floors", state: true, target: 20, reward: { mine: 100 } },
    { id: "s_level", icon: "🎓", name: "Manager level 40", metric: "level", state: true, target: 40, reward: { crates: 3, bag: { boost_xp: 2 } } },
    { id: "s_shards", icon: "💠", name: "Find 5 Mine Shards", metric: "shards", target: 5, reward: { mine: 150 } },
    { id: "s_daily", icon: "📅", name: "Claim 14 daily rewards", metric: "dailyClaims", target: 14, reward: { mine: 100 } },
  ];
  // progress of one daily / seasonal quest: counters (prog) or live state (floors, manager level)
  S.questMetric = (st, def, prog) => {
    if (def.state) return def.metric === "floors" ? Math.max(st.mines.start.maxUnlocked || 0, st.mines.start.unlockedShaftCount) : st.hero.lvl;
    return (prog && prog[def.metric]) || 0;
  };

  // timings of the animated miners (also define how many ore trips happen per second)
  S.WALK = 1.5; S.SWING_N = 4; S.SWING_T = 0.35; S.DROP = 0.2;
  S.T_MINER = 2 * S.WALK + S.SWING_N * S.SWING_T + S.DROP;
  S.WALK_W = 2.2; S.T_WORKER = 2 * S.WALK_W + 0.3;

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
  const FX0 = () => ({ yield: 0, speed: 0, cap: 0, aura: 0, disc: 0, guard: 0, fort: 0, haste: 0, drop: 0, xp: 0, repair: 0, lucky: 0 });
  S.FX0 = FX0;

  // ---- item upgrades (+1 ... +10) ---------------------------------------------------------
  // Attempt number n (going from +n to +n+1) succeeds with UP_CHANCE[n]. A failed attempt keeps the item as it is but the
  // price is gone. The first UP_COIN_ONLY attempts cost coins only, every later one costs coins + $AFKMINE.
  S.UP_MAX = 10;
  S.UP_BONUS = 0.10;                                                    // every + adds 10 % of the item's base stats (+100 % at +10)
  S.UP_CHANCE = [0.95, 0.90, 0.80, 0.65, 0.50, 0.40, 0.30, 0.20, 0.12, 0.07];
  S.UP_COIN_ONLY = 3;
  S.UP_MINE = [0, 0, 0, 5, 10, 20, 40, 80, 150, 300];                   // $AFKMINE for a Common item; multiplied by UP_MINE_RARITY
  S.UP_MINE_RARITY = [1, 1.5, 2, 3, 4, 6];
  S.upMult = (it) => 1 + S.UP_BONUS * (it.up || 0);
  S.itemName = (it) => S.RARITIES[it.r].n + " " + it.slot + (it.up ? " +" + it.up : "");
  S.upgradeInfo = (it, mine) => {
    const n = it.up || 0;
    if (n >= S.UP_MAX) return { n, maxed: true };
    const cash = Math.ceil(40 * Math.pow(2.4, n) * Math.pow(2.5, it.r) * (1 + 0.25 * (it.il - 1)) * S.infraScale(mine));
    const m = n >= S.UP_COIN_ONLY ? Math.ceil(S.UP_MINE[n] * S.UP_MINE_RARITY[it.r]) : 0;
    return { n, next: n + 1, chance: S.UP_CHANCE[n], cash, mine: m, maxed: false };
  };

  // ---- timed boosts (bought with $AFKMINE in the shop) ---------------------------------------
  S.BOOST_MINUTES = 120;
  S.BOOST_MAX_MS = 12 * 3600e3;                                         // boosts can be stacked up to 12 h
  S.BOOST_KEYS = ["xp", "earn", "power"];
  S.BOOST_FX = { xp: 1, earn: 0.5, power: 1 };                          // +100 % XP, +50 % earnings, +100 % power
  const boostOn = (st, k, t) => t < ((st.boosts && st.boosts[k]) || 0);
  S.xpMult = (st, t) => 1 + (boostOn(st, "xp", t) ? S.BOOST_FX.xp : 0);
  S.powerMult = (st, t) => 1 + (boostOn(st, "power", t) ? S.BOOST_FX.power : 0);

  // ---- quests: Earnings Boost (+10 % each, max +50 %) and Offline Earnings (all five) ------
  S.QUEST_BOOST = 0.10;
  S.QUESTS = [
    { id: "hold", icon: "💎", name: "Hold 50,000 $AFKMINE", desc: "Have at least 50,000 $AFKMINE in your game balance. Dropping below it pauses the reward.", target: 50000 },
    { id: "deposit", icon: "⬇️", name: "Deposit 0.5 SOL", desc: "Deposit 0.5 SOL in total from your wallet (Bank → Deposit).", target: 500000000 },   // target in lamports
    { id: "spend", icon: "🔥", name: "Spend 25,000 $AFKMINE", desc: "Spend 25,000 $AFKMINE in total inside the game: packs, boosts, item upgrades, backpack pages.", target: 25000 },
    { id: "streak", icon: "⏳", name: "24h without withdrawing", desc: "Done from the start for new players. Each withdrawal restarts a 24-hour clock; the quest is complete again once it runs out.", target: 24 * 3600e3 },
    { id: "social", icon: "🔗", name: "Link X and Discord", desc: "Link your X account and your Discord account.", target: 2 },
  ];
  S.questValue = (st, t, id) => {
    const q = st.q || {};
    switch (id) {
      case "hold": return st.balance || 0;
      case "deposit": return q.depDone ? 500000000 : ((st.tradeStats && st.tradeStats.depositedLamports) || 0);   // lamports; depDone = old $AFKMINE deposit quest was already finished
      case "spend": return q.spent || 0;
      // never withdrawn = already done; after a withdrawal the 24 h clock starts from that moment
      case "streak": return st.lastWithdrawAt ? Math.max(0, t - st.lastWithdrawAt) : 24 * 3600e3;
      case "social": return (q.x ? 1 : 0) + (q.discord ? 1 : 0);
    }
    return 0;
  };
  S.questStates = (st, t) => S.QUESTS.map((d) => { const v = S.questValue(st, t, d.id); return { id: d.id, value: Math.min(v, d.target), done: v >= d.target }; });
  S.questsDone = (st, t) => S.questStates(st, t).filter((q) => q.done).length;
  S.questBoost = (st, t) => Math.round(S.questsDone(st, t) * S.QUEST_BOOST * 100) / 100;
  S.offlineUnlocked = (st, t) => S.questsDone(st, t) === S.QUESTS.length;
  // total earnings multiplier (cash and the player's share of the $AFKMINE pool): quests + the shop boost
  S.earnBoost = (st, t) => S.questBoost(st, t) + (boostOn(st, "earn", t) ? S.BOOST_FX.earn : 0);
  S.earnMult = (st, t) => 1 + S.earnBoost(st, t);

  // ---- infrastructure maths ---------------------------------------------------------
  S.minersFor = (lvl) => Math.min(4, 1 + Math.floor(lvl / 5));
  S.unitValue = (i, mine) => 1.5 * Math.pow(2.3, i) * mine.prestigeMult;
  S.infraScale = (mine) => Math.pow(1.9, mine.unlockedShaftCount - 1);
  S.upgradeCost = (base, level, n, costMult) => {
    let total = 0;
    for (let i = 0; i < n; i++) total += Math.floor(base * Math.pow(1.12, level + i) * costMult);
    return total;
  };
  // Hero level N needs xpNeed(N) XP. All 99 levels together are ~129k XP = ~180 h of play at 0.2 XP/s, i.e. about 15 days at
  // ~12 h/day with the tab open. XP boosts, gear with Hero XP and packs shorten that a little.
  S.xpNeed = (lvl) => 55 + 25 * lvl;

  // ---- hero / gear ----------------------------------------------------------------
  S.itemById = (st, id) => st.inv.find((i) => i.id === id);
  // 0 durability = broken = unusable (no stats, no power, can't be equipped). Anything above 0 works at full strength.
  S.usable = (it) => it.dur > 0;
  S.itemPower = (it) => Math.round((it.v + it.aff.reduce((s, a) => s + a.v, 0)) * S.upMult(it) * 1000 * (S.usable(it) ? 1 : 0));
  S.sellValue = (it) => Math.ceil(35 * Math.pow(3.2, it.r) * (1 + 0.4 * (it.il - 1)) * (0.5 + (0.5 * it.dur) / it.max) * (1 + 0.15 * (it.up || 0)));
  S.repairCost = (it, mine, fx) => Math.ceil((it.max - it.dur) * 0.8 * Math.pow(3, it.r) * S.infraScale(mine) * (1 - fx.repair));
  S.canEquip = (st, it) => it.il <= st.hero.lvl;
  S.invCap = (st) => st.invPages * S.PAGE_SIZE;
  S.spareItems = (st) => st.inv.filter((i) => st.eq[i.slot] !== i.id);

  S.computeFx = (st) => {
    const f = FX0();
    for (const s of S.SLOTS) {
      const it = S.itemById(st, st.eq[s]);
      if (!it) continue;
      if (!S.usable(it)) continue;                      // broken gear (0 durability) gives nothing until repaired
      const q = S.upMult(it);
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

  // One bundle with everything derived from a state at time t (ms).
  S.ctx = (st) => {
    const fx = S.computeFx(st), hm = S.heroMult(st, fx);
    return { st, mine: st.mines.start, fx, hm, costMult: 1 - fx.disc };
  };
  S.floorUnitRate = (i, c) => c.mine.shafts[i].level * 12 * c.hm.y;
  S.elevatorCapacity = (c) => (c.mine.elevator.level * 100 + 50) * c.hm.c;
  S.elevatorBuff = (c) => c.hm.s;
  S.elevatorTravel = (c) => (1.4 + 0.15 * c.mine.elevator.level) * S.elevatorBuff(c); // floors / s
  S.elevatorStop = (c) => 0.45 / (S.elevatorBuff(c) * (1 + 0.02 * c.mine.elevator.level));
  S.warehouseSellRate = (c) => c.mine.warehouse.level * 10 * (1 + c.fx.haste);

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

  // Cash income per second of the whole mine (miners -> floor boxes -> elevator -> drop pile -> warehouse workers),
  // times the earnings boost (quests + shop boost).
  // scripts/calibrate.js checks the base model against the original animated simulation.
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
    const base = value * flow * (1 + c.fx.fort) * S.EFFICIENCY;
    const perSec = base * S.earnMult(st, t);
    return { c, perSec, base, mineV, units, eff, elevV: value, whV: eff * (units ? value / units : 0) };
  };
  // finished miner trips per second on each unlocked floor (each trip can drop an item)
  S.tripsPerSec = (st, t) => {
    const c = S.ctx(st, t), out = [];
    for (let i = 0; i < c.mine.unlockedShaftCount; i++) out.push((S.minersFor(c.mine.shafts[i].level) * c.hm.s) / S.T_MINER);
    return { c, trips: out };
  };

  // ---- upgrade info shared by UI and server ------------------------------------------
  S.upInfo = (st, target, idx, t) => {
    const c = S.ctx(st, t), mine = c.mine, infra = c.costMult * S.infraScale(mine);
    if (target === "warehouse") return { name: "Warehouse", level: mine.warehouse.level, base: 25, cm: infra };
    if (target === "elevator") return { name: "Elevator", level: mine.elevator.level, base: 40, cm: infra };
    return { name: "Floor " + (idx + 1), level: mine.shafts[idx].level, base: 18 * Math.pow(2.3, idx), cm: c.costMult };
  };
  S.maxLevels = (info, cash) => {
    let n = 0, lv = info.level;
    while (n < 500) { const c = S.upgradeCost(info.base, lv, 1, info.cm); if (cash < c) break; cash -= c; lv++; n++; }
    return n;
  };

  // ---- $AFKMINE <-> SOL market: constant-product (x*y = k) VIRTUAL pool --------------------------------------------
  // Used by the server to settle every trade AND by the browser to preview it, so the numbers always match.
  // Units are integers only: SOL in lamports (1e9 per SOL), $AFKMINE in micro-tokens (1e6 per token).
  // The reserves multiply to ~1e24, so the math is done in BigInt (exact). Rounding ALWAYS favours the pool:
  // the fee is rounded up, the payout is rounded down. The fee stays in the pool (k grows a little with every trade).
  S.LAMPORTS = 1e9; S.MICRO = 1e6; S.FEE_DEN = 10000;
  const MAX_AMOUNT = (1n << 62n);
  const toBig = (x) => {                            // positive/zero whole numbers only; floats, NaN, text, negatives -> null
    if (typeof x === "bigint") return x >= 0n && x < MAX_AMOUNT ? x : null;
    if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : null;
    if (typeof x === "string" && /^\d{1,19}$/.test(x)) { const b = BigInt(x); return b < MAX_AMOUNT ? b : null; }
    return null;
  };
  S.toBig = toBig;
  // side "buy": amountIn = lamports of SOL paid, out = micro-$AFKMINE received.   side "sell": amountIn = micro-$AFKMINE, out = lamports.
  S.quote = (side, solRes, tokRes, amountIn, feeBps) => {
    const fail = (error) => ({ ok: false, error });
    if (side !== "buy" && side !== "sell") return fail("Unknown trade side");
    const sol = toBig(solRes), tok = toBig(tokRes), a = toBig(amountIn), bps = toBig(feeBps);
    if (sol === null || tok === null || sol <= 0n || tok <= 0n || bps === null || bps >= 10000n) return fail("The market is not available");
    if (a === null) return fail("Enter a whole amount");
    if (a <= 0n) return fail("Enter an amount");
    const fee = (a * bps + 9999n) / 10000n, net = a - fee;                       // fee rounded UP
    if (net <= 0n) return fail("Amount is too small");
    let out, newSol, newTok, ideal;
    if (side === "buy") { out = (tok * net) / (sol + net); newSol = sol + a; newTok = tok - out; ideal = (a * tok) / sol; }
    else { out = (sol * net) / (tok + net); newSol = sol - out; newTok = tok + a; ideal = (a * sol) / tok; }   // payout rounded DOWN
    if (out <= 0n) return fail("Amount is too small");
    const impactBps = ideal > out ? Number(((ideal - out) * 10000n) / ideal) : 0;   // total cost vs the spot price, fee included
    return { ok: true, side, amountIn: a, fee, net, out, newSol, newTok, impactBps,
      priceBefore: S.spotPrice(sol, tok), priceAfter: S.spotPrice(newSol, newTok) };
  };
  S.spotPrice = (solRes, tokRes) => Number(solRes) / Number(tokRes) / 1e3;          // SOL per 1 $AFKMINE
  // price of a pack in micro-$AFKMINE at the pool's spot price, with the $AFKMINE discount, rounded UP to a whole token
  S.packMicroPrice = (lamports, discount, solRes, tokRes) => {
    const d = BigInt(Math.round(discount * 10000)), sol = toBig(solRes), tok = toBig(tokRes);
    const raw = (BigInt(lamports) * (10000n - d) * tok + (sol * 10000n - 1n)) / (sol * 10000n);
    const whole = 1000000n;
    return Number(((raw + whole - 1n) / whole) * whole);
  };
  // "1.25" -> 1250000000 (decimals = 9 for SOL, 6 for $AFKMINE). Returns null for anything that is not a plain decimal number.
  S.parseUnits = (str, decimals) => {
    const m = /^(\d{0,12})(?:\.(\d{0,9}))?$/.exec(String(str == null ? "" : str).trim());
    if (!m || (!m[1] && !m[2]) || (m[2] || "").length > decimals) return null;
    const v = Number(m[1]) * 10 ** decimals + Number((m[2] || "").padEnd(decimals, "0") || 0);
    return Number.isSafeInteger(v) ? v : null;
  };

  return S;
});
