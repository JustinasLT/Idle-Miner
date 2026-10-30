"use strict";
// All tunable numbers and environment settings live here.
const env = process.env;
const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(+v) ? +v : d);

// NOTE ($AFKMINE): the in-game currency is called $AFKMINE in all texts. Internal keys keep their old names (like hero/Manager):
// the player's $AFKMINE balance is still `p.balance`, the season pool constants below still say MINE, and PRICES / S.UNLOCK_MINE are $AFKMINE prices.
// ---- $AFKMINE emission (same as before, see README) --------------------------------------
const C = {
  TOTAL_POOL: 100e6, LB_POOL: 10e6, MINING_POOL: 5e6, SEASON_DAYS: 30, FULL_PLAYERS: 100,
  PLAYER_DAILY_CAP: 0.025, LB_SIZE: 100, LB_PRIZE_EXP: 0.85, MAX_PAGES: 5,
  // --- offline / activity ---
  // Players who finished all quests have "Offline Earnings": up to 8 h away, cash paid at 50 %.
  // Everybody else stops earning cash AND $AFKMINE 15 minutes after closing the game tab.
  OFFLINE_MAX_MS: 8 * 3600e3,        // with Offline Earnings: nobody earns more than 8 h while away (cash and $AFKMINE)
  ACTIVE_MS: 8 * 3600e3,             // with Offline Earnings: a player stops getting mined $AFKMINE 8 h after the last request
  OFFLINE_FREE_MS: 15 * 60e3,        // without Offline Earnings: earning stops this long after the last request
  ONLINE_GRACE_MS: 120e3,            // a gap shorter than this counts as "playing", longer = "offline"
  OFFLINE_CASH_RATE: 0.5,            // offline cash is paid at 50 % when Offline Earnings are unlocked
  PENDING_MAX: 100,                  // unclaimed mining rewards: more items than this are auto-sold
  // --- free tier & onboarding ---
  FREE_EARN_CAP: 20000,              // a player without a pack can mine at most this much $AFKMINE in total
  ONBOARD_CAP: 20000,                // the first 20 000 $AFKMINE of every player are paid at the fast rate...
  ONBOARD_MINUTES: 90,               // ...which finishes in about 90 minutes of active play
  DEV_MINE_AMOUNT: 10000,            // $AFKMINE given by the test faucet in the shop (see DEV_FAUCET below)
  // --- referrals ---
  // A referrer gets REF_RATE of what a referred player spends on packs.
  //   * pack paid from the SOL balance  -> the referrer gets REF_RATE of the price as SOL balance (paid out of that real pack revenue, never minted),
  //     but only if the buyer's lifetime REAL deposits cover the pack price (stops free-account / alt-account loops).
  //   * pack paid in $AFKMINE           -> the referrer gets REF_RATE of the tokens spent (taken from what the buyer paid, nothing is minted).
  REF_RATE: num(env.REF_RATE, 0.25),
  REF_BOARD_SIZE: 100,               // rows on the referral leaderboard
  // --- $AFKMINE <-> SOL market (VIRTUAL constant-product pool x*y=k that lives only in our database) ---
  POOL_INIT_SOL: num(env.POOL_INIT_SOL, 100),                 // starting SOL reserve (virtual!)
  POOL_INIT_TOKENS: num(env.POOL_INIT_TOKENS, 10000000),      // starting $AFKMINE reserve -> starting price 100 / 10,000,000 = 0.00001 SOL
  TRADE_FEE_BPS: num(env.TRADE_FEE_BPS, 100),                 // 100 = 1 %, charged on the input, stays in the pool
  MAX_TRADE_POOL_PCT: num(env.MAX_TRADE_POOL_PCT, 2),         // one trade may move at most this % of the reserve it pays into (SOL in for buys, $AFKMINE in for sells)
  TRADE_COOLDOWN_MS: num(env.TRADE_COOLDOWN_MS, 10e3),        // minimum time between two trades of the same player
  DAILY_SELL_CAP_LAMPORTS_PER_PLAYER: num(env.DAILY_SELL_CAP_LAMPORTS_PER_PLAYER, 1e9), // SOL one player can receive from selling per UTC day (1 SOL)
  TRADE_NEED_WALLET: env.TRADE_NEED_WALLET !== "0",           // guests cannot trade
  SELL_NEED_PACK: env.SELL_NEED_PACK !== "0",                 // only players who bought a pack can sell $AFKMINE for SOL (blocks free-account farming)
  // "backed": a sell may only be paid with SOL that buyers put into the pool, so the price can never fall below the starting price and
  //           trading alone can never create more SOL liabilities than real deposits. "off": the curve may pay out the virtual starting SOL too
  //           (still limited by the treasury solvency check).
  POOL_SELL_FLOOR: env.POOL_SELL_FLOOR === "off" ? "off" : "backed",
  // What happens to $AFKMINE spent on sinks (packs, boosts, floors, item upgrades...):
  //   "burn": it disappears (circulating supply shrinks).   "recycle": it flows back into the pool's token reserve (pushes the price down).
  // (the shop boosts / floor unlocks themselves always debit the player; this only decides where the tokens go)
  ECONOMY_SINK_MODE: env.ECONOMY_SINK_MODE === "recycle" ? "recycle" : "burn",
  // Where game rewards (mining, quests, daily, season prizes, offline) come from:
  //   "mint": created out of thin air into the player's balance (circulating supply grows).
  //   "reserve": paid from a finite stock of EMISSION_RESERVE_TOKENS; when it is empty rewards stop.
  EMISSION_MODE: env.EMISSION_MODE === "reserve" ? "reserve" : "mint",
  EMISSION_RESERVE_TOKENS: num(env.EMISSION_RESERVE_TOKENS, 20e6),
  PRICE_HISTORY_MAX: 600, TRADES_RECENT: 50,
  // Safety margin kept on-chain in the treasury wallet on top of pending withdrawals (tx fees, rent), in lamports
  TREASURY_RESERVE_LAMPORTS: num(env.TREASURY_RESERVE_LAMPORTS, 5e6),
};
C.SEASON_MS = C.SEASON_DAYS * 864e5;
C.DAILY = C.MINING_POOL / C.SEASON_DAYS;
C.ONBOARD_RATE = C.ONBOARD_CAP / (C.ONBOARD_MINUTES * 60); // $AFKMINE per second while onboarding
C.POOL_INIT_LAMPORTS = Math.round(C.POOL_INIT_SOL * 1e9);         // exact integers: lamports and micro-$AFKMINE (6 decimals)
C.POOL_INIT_MICRO = Math.round(C.POOL_INIT_TOKENS * 1e6);

// $AFKMINE shop prices (the server decides the price). Each boost lasts S.BOOST_MINUTES (2 h).
const PRICES = { boost_xp: 500, boost_earn: 400, boost_power: 600 };

// ---- Solana (only SOL deposits and SOL withdrawals touch the chain; there is NO token mint) ----------------------
const cluster = env.SOLANA_CLUSTER || "devnet"; // devnet | testnet. mainnet-beta is refused unless you explicitly confirm it (see below)
if (cluster === "mainnet-beta" && env.ALLOW_MAINNET !== "yes-i-have-tested-on-devnet") {
  throw new Error("SOLANA_CLUSTER=mainnet-beta is blocked. This build has only been tested with a fake chain; test on devnet first. (Override: ALLOW_MAINNET=yes-i-have-tested-on-devnet)");
}
const solToLamports = (x) => Math.round(x * 1e9);
const SOL = {
  cluster,
  rpc: env.SOLANA_RPC_URL || ({ testnet: "https://api.testnet.solana.com", devnet: "https://api.devnet.solana.com", "mainnet-beta": "https://api.mainnet-beta.solana.com" }[cluster]),
  commitment: env.SOLANA_COMMITMENT || "confirmed",
  treasurySecret: env.TREASURY_SECRET_KEY || "",   // hot wallet: receives deposits AND pays withdrawals (base58 or JSON array)
  merchant: env.MERCHANT_WALLET || "",              // LEGACY: only used to confirm pack orders that were created before the switch to the SOL balance
  mineDiscount: 0.10,                               // paying a pack in $AFKMINE is 10 % cheaper than SOL (priced at the pool's spot price)
  minDepositLamports: solToLamports(num(env.MIN_DEPOSIT_SOL, 0.01)), maxDepositLamports: solToLamports(num(env.MAX_DEPOSIT_SOL, 100)),
  minWithdrawLamports: solToLamports(num(env.MIN_WITHDRAW_SOL, 0.01)),
  maxWithdrawLamports: solToLamports(num(env.MAX_WITHDRAW_SOL, 5)),   // per withdrawal (taken from the SOL balance, fee included)
  withdrawFeeBps: Math.round(num(env.WITHDRAW_FEE, 0.2) * 10000),     // 20 % stays in the treasury, the player receives the rest
  withdrawCooldownMs: 24 * 3600e3,                                    // one withdrawal per account every 24 h
};

// Test faucet ("Free money" / "Free $AFKMINE" in the shop, no cooldown). ON by default everywhere except Solana mainnet-beta,
// where free in-game $AFKMINE could be sold for real SOL. Force it with DEV_FAUCET=on / off.
C.DEV_FAUCET = env.DEV_FAUCET ? env.DEV_FAUCET === "on" : cluster !== "mainnet-beta";

// ---- Packs (each can be bought once, with the SOL balance or with $AFKMINE) ----------------------------------------
// Prices are set in SOL. Paying in $AFKMINE is 10 % cheaper and is priced at the pool's CURRENT price (S.packMicroPrice), so it always matches the SOL price.
// gear: `pieces` slots (in the order of `slots`) get an item of rarity `gearRarity` (2 Rare, 3 Epic, 4 Legendary),
// item level = hero level after the XP. The packs are a head start, not a shortcut: a full manager (Lv 100) still takes ~15 days.
const SLOTS_ALL = ["Pickaxe", "Helmet", "Shoes", "Gloves", "Shirt", "Pants", "Amulet", "Ring"];
const PACKS = [
  { id: 1, name: "Prospector", sol: 0.05, cash: 25e3, xp: 500, crates: 1, gearRarity: 2, slots: SLOTS_ALL.slice(0, 4), blurb: "4 Rare gear pieces, $25K cash, +500 manager XP, 1 crate" },
  { id: 2, name: "Foreman", sol: 0.15, cash: 1.5e6, xp: 2000, crates: 3, gearRarity: 3, slots: SLOTS_ALL.slice(0, 6), blurb: "6 Epic gear pieces, $1.5M cash, +2,000 manager XP, 3 crates" },
  { id: 3, name: "Tycoon", sol: 0.4, cash: 75e6, xp: 6000, crates: 6, gearRarity: 4, slots: SLOTS_ALL, blurb: "8 Legendary gear pieces, $75M cash, +6,000 manager XP, 6 crates" },
];
for (const p of PACKS) {
  p.lamports = Math.round(p.sol * 1e9);
}

module.exports = { C, PRICES, SOL, PACKS, env, num };
