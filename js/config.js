"use strict";
// Display-only configuration. The server owns every real number (prices, rates, drops); the shared maths
// live in js/shared.js and are used by the server as the authority.
const ORES = [
  { name: "Coal", color: "#616161" }, { name: "Copper", color: "#d4873f" }, { name: "Iron", color: "#90a4ae" },
  { name: "Gold", color: "#ffd54f" }, { name: "Ruby", color: "#e53935" }, { name: "Diamond", color: "#80deea" },
];
const FLOORS_PER_ORE = 5;
const SHAFT_DEFS = ORES.flatMap((o) => Array.from({ length: FLOORS_PER_ORE }, () => o));
// layout in px (pushed to CSS variables in init)
const L = { surface: 216, grass: 14, floor: 124, head: 22, tunnel: 70, car: 44, headframe: 120 };
const WHEEL_Y = L.surface - L.grass - L.headframe + 15;
const { WALK, SWING_N, SWING_T, DROP, T_MINER, WALK_W, T_WORKER, SLOTS, SLOT_STAT, STAT_CAP, RARITIES, AFFIXES,
  PAGE_SIZE, MAX_PAGES, PAGE_COST, ITEM_LVL_SPREAD } = Shared;
const CONTINENTS = [{ id: "start", name: "Grasslands", shaftCount: 30 }];
const SLOT_ICON = { Pickaxe: "⛏️", Shoes: "👟", Helmet: "⛑️", Shirt: "👕", Gloves: "🧤", Pants: "👖", Amulet: "📿", Ring: "💍" };
// ---- $AFKMINE economy: texts only (the server decides)
// (season budget, prize pool, mining pool and the $AFKMINE price scale come from the server: net.info.season / Shared.MINE_SCALE)
const SEASON_DAYS = 30, SEASON_MS = SEASON_DAYS * 864e5;
const FULL_PLAYERS = 100, PLAYER_DAILY_CAP = 0.025, LB_SIZE = 100;
