"use strict";
// All tunable numbers and environment settings live here.
const env = process.env;
const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(+v) ? +v : d);

// ---- $MINE emission (same as before, see README) --------------------------------------
const C = {
  TOTAL_POOL: 100e6, LB_POOL: 10e6, MINING_POOL: 5e6, SEASON_DAYS: 30, FULL_PLAYERS: 100,
  PLAYER_DAILY_CAP: 0.025, LB_SIZE: 100, LB_PRIZE_EXP: 0.85, MAX_PAGES: 5,
  // --- offline / activity ---
  OFFLINE_MAX_MS: 8 * 3600e3,        // nobody earns more than 8 h while away (cash and $MINE)
  ACTIVE_MS: 8 * 3600e3,             // a player stops getting mined $MINE 8 h after the last request
  ONLINE_GRACE_MS: 120e3,            // a gap shorter than this counts as "playing", longer = "offline"
  OFFLINE_CASH_RATE: 0.5,            // offline cash is paid at 50 % (as in the original game)
  // --- free tier & onboarding ---
  FREE_EARN_CAP: 20000,              // a player without a pack can mine at most this much $MINE in total
  ONBOARD_CAP: 20000,                // the first 20 000 $MINE of every player are paid at the fast rate...
  ONBOARD_MINUTES: 90,               // ...which finishes in about 90 minutes of active play
  FREE_MONEY_COOLDOWN_MS: 12 * 3600e3,
  TOME_XP: 500,
};
C.SEASON_MS = C.SEASON_DAYS * 864e5;
C.DAILY = C.MINING_POOL / C.SEASON_DAYS;
C.ONBOARD_RATE = C.ONBOARD_CAP / (C.ONBOARD_MINUTES * 60); // $MINE per second while onboarding

const PRICES = { boost_sell: 25, boost_elev: 25, tome: 15, offline2: 5 }; // $MINE shop prices (server decides the price)

// ---- Solana ------------------------------------------------------------------------------
const cluster = env.SOLANA_CLUSTER || "testnet"; // testnet | devnet | mainnet-beta
const SOL = {
  cluster,
  rpc: env.SOLANA_RPC_URL || ({ testnet: "https://api.testnet.solana.com", devnet: "https://api.devnet.solana.com", "mainnet-beta": "https://api.mainnet-beta.solana.com" }[cluster]),
  commitment: env.SOLANA_COMMITMENT || "confirmed",
  mint: env.MINE_MINT || "",
  decimals: num(env.MINE_DECIMALS, 6),
  treasurySecret: env.TREASURY_SECRET_KEY || "",   // hot wallet that pays withdrawals (base58 or JSON array)
  merchant: env.MERCHANT_WALLET || "",              // receives SOL pack payments directly (public address only)
  minePerSol: num(env.MINE_PER_SOL, 100000),        // used only to derive the SOL price of packs
  mineDiscount: 0.10,                               // paying in $MINE is 10 % cheaper than SOL
  minDeposit: 1, maxDeposit: 1e8,
  minWithdraw: num(env.MIN_WITHDRAW, 100),
  maxWithdrawDay: num(env.MAX_WITHDRAW_DAY, 250000), // per account, rolling 24 h
  withdrawCooldownMs: 30e3,
};

// ---- Packs (each can be bought once, with SOL or $MINE) ----------------------------------------
// gear: one item for every slot at this rarity index (3 Epic, 4 Legendary, 5 Mythic), item level = hero level after the XP.
const PACKS = [
  { id: 1, name: "Prospector", mine: 40000, cash: 250e3, xp: 2000, crates: 3, gearRarity: 3, blurb: "8 Epic gear pieces, $250K cash, hero to ~Lv 10" },
  { id: 2, name: "Foreman", mine: 100000, cash: 15e6, xp: 10000, crates: 10, gearRarity: 4, blurb: "8 Legendary gear pieces, $15M cash, hero to ~Lv 24" },
  { id: 3, name: "Tycoon", mine: 250000, cash: 750e6, xp: 30000, crates: 25, gearRarity: 5, blurb: "8 Mythic gear pieces, $750M cash, hero to ~Lv 43" },
];
// SOL price = (mine price / (1 - discount)) / MINE_PER_SOL, rounded up to 0.0001 SOL
for (const p of PACKS) {
  p.lamports = Math.ceil((p.mine / (1 - SOL.mineDiscount) / SOL.minePerSol) * 1e4) * 1e5;
}

module.exports = { C, PRICES, SOL, PACKS, env, num };
