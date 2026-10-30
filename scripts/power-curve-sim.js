"use strict";
// Proposal only (nothing in the game uses it yet): typical player power at hour 1/10/50/200 vs a floor requirement curve.
// Assumptions (edit them): manager XP 0.2/s * 3600 * (1 + xp boosts), gear = pieces equipped * average piece power at that stage.
const S = require("../js/shared.js");
const xpAt = (h, boost) => 0.2 * 3600 * h * (1 + boost);
const levelAt = (xp) => { let l = 1, need = 0; while (l < 99 && xp >= need + S.xpNeed(l)) { need += S.xpNeed(l); l++; } return l; };
const R = S.RARITIES;
// typical equipped gear per stage: [pieces, rarity index, item level, avg upgrade]
const STAGES = [
  // floors = floors a player owns by then, from scripts/economy-sim.js (coin curve): ~14 at 1 h, ~22 at 10 h, ~27 at 50 h, all 30 by ~4 days
  { h: 1, boost: 0, pieces: 2, r: 0, il: 2, up: 0, floors: 14 },
  { h: 10, boost: 0.3, pieces: 5, r: 1, il: 12, up: 1, floors: 22 },
  { h: 50, boost: 0.6, pieces: 8, r: 2, il: 35, up: 4, floors: 27 },
  { h: 200, boost: 1.0, pieces: 8, r: 3, il: 70, up: 7, floors: 30 },
];
const piece = (s) => { const f = 1 + 0.03 * (s.il - 1), base = 0.035 * R[s.r].m * f, aff = R[s.r].aff * 0.05 * Math.sqrt(R[s.r].m) * f; return Math.round((base + aff) * (1 + S.UP_BONUS * s.up) * 1000); };
// requirement curve candidate: floors 1-3 free, then geometric
const REQ = (n) => S.floorReq(n);
console.log("floor:", Array.from({ length: 30 }, (_, i) => i + 1).map((n) => n + "=" + REQ(n)).join("  "));
for (const s of STAGES) {
  const lvl = levelAt(xpAt(s.h, s.boost)), gear = s.pieces * piece(s), power = lvl * 50 + gear;
  let active = 0; for (let n = 1; n <= s.floors; n++) if (power >= REQ(n)) active++;
  let nextN = 1; while (nextN <= 30 && power >= REQ(nextN)) nextN++;
  console.log(`hour ${String(s.h).padStart(3)}: manager lvl ${lvl} (${lvl * 50}) + gear ${gear} = power ${power}; owns ~${s.floors} floors -> ${active} active; first gated floor ${nextN <= 30 ? nextN + " (needs " + REQ(nextN) + ")" : "none"}`);
}
