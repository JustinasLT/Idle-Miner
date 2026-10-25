"use strict";
// The browser keeps only a MIRROR of what the server says (see net.js applyView). Nothing is saved locally and
// nothing the player edits here is ever trusted: every change is a request to the server.
function blankMine() {
  return { prestigeMult: 1, warehouse: { level: 1 }, elevator: { level: 1 }, shafts: Array.from({ length: 30 }, () => ({ level: 1, stock: 0 })), unlockedShaftCount: 1, pile: { u: 0, v: 0 } };
}
let state = {
  cash: 0, token: 0, activeContinent: "start", mines: { start: blankMine() }, researchUnlocked: [], boosts: { elev: 0, mine: 0, sell: 0 },
  stats: { totalEarned: 0 }, name: "", hero: { lvl: 1, xp: 0, pE: 0, pL: 0, n: 0, day: "", crates: 0 }, inv: [], eq: {}, invPages: 1,
  season: { items: 0 }, packs: {}, paid: false, guest: true, wallet: null, pendingOffline: 0, freeMoneyIn: 0, power: 0,
};
function activeMine() { return state.mines.start; }
const saveState = () => {}; // kept so older code paths stay harmless: the server is the only save
