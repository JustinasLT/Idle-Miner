"use strict";
function defaultMine(continentId) {
  const cont = CONTINENTS.find((c) => c.id === continentId) || CONTINENTS[0];
  return {
    continentId, prestigeMult: 1, warehouse: { level: 1 }, elevator: { level: 1 },
    shafts: SHAFT_DEFS.slice(0, cont.shaftCount).map(() => ({ level: 1, stock: 0 })),
    unlockedShaftCount: 1, pile: { u: 0, v: 0 },
  };
}
function ensureMineShape(mine) {
  delete mine.managers;
  if (!mine.pile) mine.pile = { u: 0, v: 0 };
  if (typeof mine.unlockedShaftCount !== "number") mine.unlockedShaftCount = 1;
  while (mine.shafts.length < 30) mine.shafts.push({ level: 1, stock: 0 });
  mine.unlockedShaftCount = Math.max(1, Math.min(mine.unlockedShaftCount, mine.shafts.length));
}
const shaftUnlockCost = (floorIndex) => Math.floor(60 * Math.pow(2.8, floorIndex));

function defaultState() {
  return {
    cash: 50, token: 0, activeContinent: "start", mines: { start: defaultMine("start") },
    researchUnlocked: [], boosts: { elev: 0, mine: 0, sell: 0 },
    lastSave: Date.now(), stats: { totalEarned: 0 },
    name: "Miner" + Math.floor(1000 + Math.random() * 9000),
    season: { start: Date.now(), earned: 0, items: 0, claimed: false },
  };
}
function loadState() {
  try {
    let raw = localStorage.getItem(SAVE_KEY), old = false;
    if (!raw) { raw = localStorage.getItem(OLD_SAVE_KEY); old = true; }
    if (!raw) return defaultState();
    const p = JSON.parse(raw), s = { ...defaultState(), ...p };
    if (old) { // migrate: drop cogs/diamonds/loadouts/other continents, keep progress + gear
      s.boosts = { elev: p.superBoostUntil || 0, mine: 0, sell: 0 };
      s.token = 0; s.activeContinent = "start";
      s.mines = { start: p.mines && p.mines.start ? p.mines.start : defaultMine("start") };
    }
    ["cogs", "superCash", "loadouts", "superBoostUntil", "continentUnlocked", "eventProgress", "managersOwned"].forEach((k) => delete s[k]);
    s.boosts = { elev: 0, mine: 0, sell: 0, ...s.boosts };
    Object.values(s.mines).forEach(ensureMineShape);
    s.season = { ...defaultState().season, ...s.season };
    if (typeof s.token !== "number" || !isFinite(s.token)) s.token = 0;
    return s;
  } catch { return defaultState(); }
}
function saveState() {
  state.lastSave = Date.now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
}
function activeMine() {
  const id = state.activeContinent;
  if (!state.mines[id]) state.mines[id] = defaultMine(id);
  ensureMineShape(state.mines[id]);
  return state.mines[id];
}
let state = loadState();
