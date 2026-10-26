"use strict";
// All tunable numbers and environment settings live here.
const env = process.env;
const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(+v) ? +v : d);

// ---- $MINE emission (same as before, see README) --------------------------------------
const C = {
  TOTAL_POOL: 100e6, LB_POOL: 10e6, MINING_POOL: 5e6, SEASON_DAYS: 30, FULL_PLAYERS: 100,
  PLAYER_DAILY_CAP: 0.025, LB_SIZE: 100, LB_PRIZE_EXP: 0.85, MAX_PAGES: 5,
  // --- offline / activity ---
  // Players who finished all quests have "Offline Earnings": up to 8 h away, cash paid at 50 %.
  // Everybody else stops earning cash AND $MINE 15 minutes after closing the game tab.
  OFFLINE_MAX_MS: 8 * 3600e3,        // with Offline Earnings: nobody earns more than 8 h while away (cash and $MINE)
  ACTIVE_MS: 8 * 3600e3,             // with Offline Earnings: a player stops getting mined $MINE 8 h after the last request
  OFFLINE_FREE_MS: 15 * 60e3,        // without Offline Earnings: earning stops this long after the last request
  ONLINE_GRACE_MS: 120e3,            // a gap shorter than this counts as "playing", longer = "offline"
  OFFLINE_CASH_RATE: 0.5,            // offline cash is paid at 50 % when Offline Earnings are unlocked
  PENDING_MAX: 100,                  // unclaimed mining rewards: more items than this are auto-sold
  // --- free tier & onboarding ---
  FREE_EARN_CAP: 20000,              // a player without a pack can mine at most this much $MINE in total
  ONBOARD_CAP: 20000,                // the first 20 000 $MINE of every player are paid at the fast rate...
  ONBOARD_MINUTES: 90,               // ...which finishes in about 90 minutes of active play
  DEV_MINE_AMOUNT: 10000,            // $MINE given by the test faucet in the shop (see DEV_FAUCET below)
};
C.SEASON_MS = C.SEASON_DAYS * 864e5;
C.DAILY = C.MINING_POOL / C.SEASON_DAYS;
C.ONBOARD_RATE = C.ONBOARD_CAP / (C.ONBOARD_MINUTES * 60); // $MINE per second while onboarding

// $MINE shop prices (the server decides the price). Each boost lasts S.BOOST_MINUTES (2 h).
const PRICES = { boost_xp: 500, boost_earn: 400, boost_power: 600 };

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
  minePerSol: num(env.MINE_PER_SOL, 1000000),       // used only to derive the $MINE price of packs from their SOL price
  mineDiscount: 0.10,                               // paying in $MINE is 10 % cheaper than SOL
  minDeposit: 1, maxDeposit: 1e8,
  minWithdraw: num(env.MIN_WITHDRAW, 100),
  maxWithdraw: num(env.MAX_WITHDRAW, 250000),        // per withdrawal (the amount taken from the game balance, fee included)
  withdrawFee: num(env.WITHDRAW_FEE, 0.2),           // 20 % stays in the treasury, the player receives the rest
  withdrawCooldownMs: 24 * 3600e3,                   // one withdrawal per account every 24 h
};

// Test faucet ("Free money" / "Free $MINE" in the shop, no cooldown). ON by default everywhere except Solana mainnet-beta,
// where free in-game $MINE would be withdrawable real tokens. Force it with DEV_FAUCET=on / off.
C.DEV_FAUCET = env.DEV_FAUCET ? env.DEV_FAUCET === "on" : cluster !== "mainnet-beta";

// ---- Packs (each can be bought once, with SOL or $MINE) ----------------------------------------
// Prices are set in SOL; paying in $MINE is 10 % cheaper (price = sol * MINE_PER_SOL * 0.9, rounded to 500 $MINE).
// gear: `pieces` slots (in the order of `slots`) get an item of rarity `gearRarity` (2 Rare, 3 Epic, 4 Legendary),
// item level = hero level after the XP. The packs are a head start, not a shortcut: a full hero (Lv 100) still takes ~15 days.
const SLOTS_ALL = ["Pickaxe", "Helmet", "Shoes", "Gloves", "Shirt", "Pants", "Amulet", "Ring"];
const PACKS = [
  { id: 1, name: "Prospector", sol: 0.05, cash: 25e3, xp: 500, crates: 1, gearRarity: 2, slots: SLOTS_ALL.slice(0, 4), blurb: "4 Rare gear pieces, $25K cash, +500 hero XP, 1 crate" },
  { id: 2, name: "Foreman", sol: 0.15, cash: 1.5e6, xp: 2000, crates: 3, gearRarity: 3, slots: SLOTS_ALL.slice(0, 6), blurb: "6 Epic gear pieces, $1.5M cash, +2,000 hero XP, 3 crates" },
  { id: 3, name: "Tycoon", sol: 0.4, cash: 75e6, xp: 6000, crates: 6, gearRarity: 4, slots: SLOTS_ALL, blurb: "8 Legendary gear pieces, $75M cash, +6,000 hero XP, 6 crates" },
];
for (const p of PACKS) {
  p.lamports = Math.round(p.sol * 1e9);
  p.mine = Math.round((p.sol * SOL.minePerSol * (1 - SOL.mineDiscount)) / 500) * 500;
}

module.exports = { C, PRICES, SOL, PACKS, env, num };
