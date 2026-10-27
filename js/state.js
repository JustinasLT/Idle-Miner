"use strict";
// The browser keeps only a MIRROR of what the server says (see net.js applyView). Nothing is saved locally and
// nothing the player edits here is ever trusted: every change is a request to the server.
function blankMine() {
  return { prestigeMult: 1, warehouse: { level: 1 }, elevator: { level: 1 }, shafts: Array.from({ length: 30 }, () => ({ level: 1, stock: 0 })), unlockedShaftCount: 1, maxUnlocked: 1, pile: { u: 0, v: 0 } };
}
let state = {
  cash: 0, token: 0, activeContinent: "start", mines: { start: blankMine() }, boosts: { xp: 0, earn: 0, power: 0 },
  stats: { totalEarned: 0 }, name: "", hero: { lvl: 1, xp: 0, pE: 0, pL: 0, n: 0, day: "", crates: 0 }, inv: [], eq: {}, invPages: 1,
  season: { items: 0 }, packs: {}, paid: false, guest: true, wallet: null, pendingOffline: 0, power: 0,
  pending: { n: 0, crates: 0, shards: 0, items: [], cash: 0, mine: 0, since: 0, max: 100 }, quests: [], social: { x: null, discord: null }, earnBoost: { quest: 0, total: 0 },
  offline: { unlocked: false, freeMin: 15, maxHours: 8, away: { cash: 0, mine: 0, items: 0, crates: 0, shards: 0 } }, devFaucet: false,
  bag: { shards: 0, boost_xp: 0, boost_earn: 0, boost_power: 0 }, daily: null, dailyQuests: null, seasonQuests: null, ref: null,
};
function activeMine() { return state.mines.start; }
const saveState = () => {}; // kept so older code paths stay harmless: the server is the only save
