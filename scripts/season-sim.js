#!/usr/bin/env node
// 30-day $AFKMINE simulation: a free player and a pack buyer, plus the prize tiers and pack affordability.
// Usage: node scripts/season-sim.js [activeHoursPerDay=3]        (SEASON_BUDGET=15000000 node ... = the old, un-scaled economy)
// Assumes a full lobby (>= FULL_PLAYERS active players) and equal weights, so a player earns DAILY / (FULL_PLAYERS * 24) per active hour,
// bounded by the per-player daily cap. Coins are not modelled: floors 1-10 cost coins only (scripts/economy-sim.js), floors 11+ also $AFKMINE.
const { C, SOL, PACKS } = require("../server/config.js");
const S = require("../js/shared.js");
const H = Number(process.argv[2]) || 3;
const ratePerHour = C.DAILY / (C.FULL_PLAYERS * 24), dayCap = C.PLAYER_DAILY_CAP * C.DAILY;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
console.log(`budget ${fmt(C.SEASON_BUDGET)} = prizes ${fmt(C.LB_POOL)} + mining ${fmt(C.MINING_POOL)}   (scale ${C.MINE_SCALE})`);
console.log(`daily mining pool ${fmt(C.DAILY)}   per player: ${ratePerHour.toFixed(2)}/active hour, cap ${fmt(dayCap)}/day   free cap ${fmt(C.FREE_EARN_CAP)}   active ${H} h/day\n`);

function sim(paid) {
  let earned = 0, capDay = null, rows = [];
  for (let d = 1; d <= C.SEASON_DAYS; d++) {
    let gain = 0, h = H;
    if (earned < C.ONBOARD_CAP) { const m = Math.min(h * 60, C.ONBOARD_MINUTES - earned / C.ONBOARD_RATE / 60); const g = Math.min(m * 60 * C.ONBOARD_RATE, C.ONBOARD_CAP - earned); gain += g; h -= g / C.ONBOARD_RATE / 3600; }
    gain += h * ratePerHour; gain = Math.min(gain, dayCap + (earned < C.ONBOARD_CAP ? C.ONBOARD_CAP : 0));
    if (!paid) gain = Math.min(gain, C.FREE_EARN_CAP - earned);
    earned += gain; if (!paid && capDay === null && earned >= C.FREE_EARN_CAP - 1e-9) capDay = d;
    let fl = 10; while (fl < 30 && S.UNLOCK_MINE.slice(0, fl - 9).reduce((a, b) => a + b, 0) <= earned) fl++;
    rows.push({ d, earned, fl });
  }
  return { rows, capDay };
}
for (const [name, paid] of [["FREE player", false], ["PACK buyer", true]]) {
  const r = sim(paid);
  console.log(`${name}: $AFKMINE earned after day 1/3/7/14/30 = ${[1, 3, 7, 14, 30].map((d) => fmt(r.rows[d - 1].earned)).join(" / ")}`);
  console.log(`   floors reachable with mined $AFKMINE (coins assumed enough) day 1/7/14/30 = ${[1, 7, 14, 30].map((d) => r.rows[d - 1].fl).join(" / ")}` + (paid ? "" : `   days to reach the free cap: ${r.capDay === null ? "never" : r.capDay}`));
}
const total = S.UNLOCK_MINE.reduce((a, b) => a + b, 0), totalSh = S.UNLOCK_MINE.slice(0, 10).reduce((a, b) => a + b, 0);
console.log(`\nfloors 11-20 cost ${fmt(totalSh)} $AFKMINE, 11-30 cost ${fmt(total)} (free cap ${fmt(C.FREE_EARN_CAP)}: a free player ${C.FREE_EARN_CAP >= totalSh ? "can" : "cannot"} buy floors 11-20)`);

const spot = S.spotPrice(BigInt(C.POOL_INIT_LAMPORTS), BigInt(C.POOL_INIT_MICRO));
console.log(`\nPack price in $AFKMINE at the start (spot ${spot.toExponential(3)} SOL, discount ${SOL.mineDiscount}):`);
for (const p of PACKS) {
  const tok = S.packMicroPrice(p.lamports, SOL.mineDiscount, BigInt(C.POOL_INIT_LAMPORTS), BigInt(C.POOL_INIT_MICRO)) / 1e6;
  const days = Math.ceil(tok / Math.min(dayCap, H * ratePerHour));
  console.log(`  ${(p.name || "pack").padEnd(12)} ${fmt(tok).padStart(9)} $AFKMINE  = ${(tok / C.FREE_EARN_CAP * 100).toFixed(0)}% of the free cap, ${days} days of mining at ${H} h/day` + (tok <= C.FREE_EARN_CAP ? "  (reachable by a free player)" : ""));
}
console.log(`\nPrize tiers (pool ${fmt(C.LB_POOL)}); sell cap ${(C.DAILY_SELL_CAP_LAMPORTS_PER_PLAYER / 1e9)} SOL/day:`);
let lo = 1;
for (const t of C.LB_TIERS) {
  const each = C.LB_POOL * t.share / (t.to - lo + 1), sol = each * spot;
  console.log(`  ranks ${lo}-${t.to}: ${fmt(each)} each = ${sol.toFixed(2)} SOL at the start price -> ${Math.ceil(sol / (C.DAILY_SELL_CAP_LAMPORTS_PER_PLAYER / 1e9))} day(s) to sell`);
  lo = t.to + 1;
}
