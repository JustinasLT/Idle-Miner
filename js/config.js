"use strict";
const ORES = [
  { name: "Coal", color: "#616161" }, { name: "Copper", color: "#d4873f" }, { name: "Iron", color: "#90a4ae" },
  { name: "Gold", color: "#ffd54f" }, { name: "Ruby", color: "#e53935" }, { name: "Diamond", color: "#80deea" },
];
const FLOORS_PER_ORE = 5;
const SHAFT_DEFS = ORES.flatMap((o) => Array.from({ length: FLOORS_PER_ORE }, () => o));
// layout in px (pushed to CSS variables in init)
const L = { surface: 208, grass: 14, floor: 124, head: 22, tunnel: 70, car: 44, headframe: 120 };
const WHEEL_Y = L.surface - L.grass - L.headframe + 15;
const WALK = 1.5, SWING_N = 4, SWING_T = 0.35, DROP = 0.2;
const T_MINER = 2 * WALK + SWING_N * SWING_T + DROP;
const WALK_W = 2.2, T_WORKER = 2 * WALK_W + 0.3;
const SAVE_KEY = "idleMountainMiner_v5", OLD_SAVE_KEY = "idleMountainMiner_v4";

const CONTINENTS = [{ id: "start", name: "Grasslands", shaftCount: 30 }];
const BOOST_MULT = { elev: 3, mine: 2, sell: 2 };
// ---- $MINE token economy (Season 0)
const OFFLINE_DOUBLE_COST = 5;
const TOTAL_POOL = 100e6;            // total $MINE supply reserved for the game
const LB_POOL = 10e6;                // paid to the top 100 leaderboard places at the end of the season
const MINING_POOL = 5e6;             // given away through mining during the season
const SEASON_DAYS = 30, SEASON_MS = SEASON_DAYS * 864e5;
const DAILY_EMISSION = MINING_POOL / SEASON_DAYS; // max $MINE mined by everyone together per day
const FULL_PLAYERS = 100;            // below this many players the daily emission is scaled down
const PLAYER_DAILY_CAP = 0.025;      // one player can never take more than 2.5% of the daily emission
const LB_SIZE = 100;
const LB_PRIZE_EXP = 0.85;           // prize weight of rank r = 1 / r^0.85
// ---- backpack pages (bought with $MINE)
const PAGE_SIZE = 48, MAX_PAGES = 5, PAGE_COST = [0, 300, 800, 2000, 5000];
// ---- item level rules
const ITEM_LVL_SPREAD = 10;          // items drop at hero level +/- 10

const RESEARCH_NODES = [
  { id: "cost10", name: "Efficient Plans", desc: "All upgrade costs −10%", cost: 25e3, effect: { upgradeCostMult: 0.9 } },
  { id: "elevCap", name: "Heavy Cables", desc: "Elevator capacity +25%", cost: 80e3, effect: { elevatorCapMult: 1.25 } },
  { id: "idle20", name: "Night Shift", desc: "Offline earnings +20%", cost: 200e3, effect: { offlineMult: 1.2 } },
  { id: "sell10", name: "Market Access", desc: "Warehouse sell speed +10%", cost: 450e3, effect: { sellMult: 1.1 } },
  { id: "mine10", name: "Sharper Picks", desc: "Shaft production +10%", cost: 1e6, effect: { mineMult: 1.1 } },
  { id: "mine20", name: "Power Drills", desc: "Shaft production +20%", cost: 4e6, effect: { mineMult: 1.2 } },
  { id: "sell20", name: "Express Shipping", desc: "Warehouse sell speed +20%", cost: 12e6, effect: { sellMult: 1.2 } },
  { id: "cost20", name: "Bulk Discounts", desc: "All upgrade costs −15%", cost: 40e6, effect: { upgradeCostMult: 0.85 } },
];

// ---- hero gear (the hero now boosts the WHOLE mine, no travelling)
const SLOTS = ["Pickaxe", "Shoes", "Helmet", "Shirt", "Gloves", "Pants", "Amulet", "Ring"];
const SLOT_ICON = { Pickaxe: "⛏️", Shoes: "👟", Helmet: "⛑️", Shirt: "👕", Gloves: "🧤", Pants: "👖", Amulet: "📿", Ring: "💍" };
const SLOT_STAT = {
  Pickaxe: ["yield", "Ore Yield", 6], Shoes: ["speed", "Transit Speed", 5], Helmet: ["cap", "Capacity", 5],
  Shirt: ["aura", "Aura Strength", 4], Gloves: ["disc", "Upgrade Discount", 1.5], Pants: ["guard", "Durability Guard", 4],
  Amulet: ["fort", "Fortune (cash)", 2], Ring: ["haste", "Warehouse Haste", 3],
};
const STAT_CAP = { disc: 0.4, guard: 0.75, fort: 1, haste: 0.5, drop: 1 };
const RARITIES = [
  { n: "Common", m: 1, aff: 0, dur: 100, c: "#b0bec5", w0: 70, k: -1 },
  { n: "Uncommon", m: 1.35, aff: 1, dur: 120, c: "#66bb6a", w0: 22, k: 0 },
  { n: "Rare", m: 1.9, aff: 2, dur: 150, c: "#42a5f5", w0: 6.5, k: 0.7 },
  { n: "Epic", m: 2.8, aff: 2, dur: 200, c: "#ab47bc", w0: 1.3, k: 1.4 },
  { n: "Legendary", m: 4.2, aff: 3, dur: 300, c: "#ffa726", w0: 0.2, k: 2.2 },
  { n: "Mythic", m: 6.5, aff: 4, dur: 500, c: "#ef5350", w0: 0.02, k: 3 },
];
const AFFIXES = { drop: ["Drop Rate", 4], xp: ["Hero XP", 8], repair: ["Repair Discount", 5], lucky: ["Lucky Haul (chance x3)", 1] };
const FUSE = [[5, 1], [5, 0.8], [4, 0.6], [4, 0.4], [3, 0.25]];
const DROP_P0 = 0.0002;
const DROP_MULT = +new URLSearchParams(location.search).get("drops") || 1; // ?drops=50 for testing
