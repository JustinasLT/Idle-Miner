# Idle Mountain Miner — Game Design & Technical Guide

> Give this file to an AI assistant (or a new developer) before asking "what should I change to do X?".
> It describes what the game is, how it is built, where every rule lives and how to request changes.
> Numbers marked **[tunable]** are first-pass values you can change in one place (file given).

## 1. What the game is
An idle/tycoon mining game in the browser with a real-money-adjacent twist: the in-game currency **$AFKMINE** is **not** a blockchain token (there is no mint anywhere). It lives only in the database and is traded against **SOL** in a **virtual constant-product pool** (x*y=k, also only in the database). The only real on-chain operations are **SOL deposits and SOL withdrawals**. Players:
1. Build a mine of up to **30 floors** (from floor 4 on a floor only works while the Manager's **Power** reaches its requirement, see 3.11) (a "floor" is what a player calls a "mine" in chat), plus one **elevator** and one **warehouse**. Miners dig ore, the elevator lifts it, the warehouse carries it to the surface and turns it into **coins** (cash).
2. Level up the **Manager** (internal name `hero`; renamed from "Hero", display-only) and equip **gear items** (rarity, level, +upgrades, durability).
3. Earn **$AFKMINE** from a daily emission pool shared by active players (30-day **season**, leaderboard prizes).
4. Buy **packs** (from the in-game SOL balance, or with $AFKMINE at 10% off) that remove the free-tier cap, unlock selling $AFKMINE for SOL and give loot.

Currencies / resources: **Coins** (cash), **$AFKMINE** (in-game currency; code keys `token`/`balance`/`mine` keep their old names), **SOL balance** (`solBalance`, integer lamports), **Mine Shards** (very rare, stackable), **crates** (open for gear), **bag items** (Shards + 3 boosts).

## 2. Architecture
- **Server-authoritative.** The browser never decides outcomes. It sends an intent (`POST /api/act {type, ...}`) and receives the full player *view*. All math is in `js/shared.js`, which is loaded by BOTH server and browser (UMD) so costs shown always match costs charged.
- Plain Node `http`, no framework. Storage: JSON file or Postgres (`server/store.js`).
- Client: vanilla JS, global scripts loaded in order from `index.html`; CSS in `css/`. Strict CSP: **no inline scripts/handlers**.
- Server ticks every few seconds (`tick()` in game.js) to settle income, $AFKMINE and offline loot for players who are away.

### File map
| File | Purpose |
|---|---|
| `server/server.js` | HTTP routes, auth (guest / Solana wallet signature), rate limits, static files (whitelist `css/*.css`, `js/*.js`) |
| `server/game.js` | **All game rules**: settle/tick, drops, quests, daily, referrals, shop, actions (`ACTIONS` table), view builder |
| `server/config.js` | Env + tunables: pools, caps, offline rules, referral rate, shop `PRICES`, packs |
| `server/bank.js`, `chain.js` | Deposits, withdrawal requests + admin approval, pack payments on Solana |
| `server/admin.js`, `admin.html`, `js/admin.js`, `css/admin.css` | Admin dashboard `/admin` (own login, audit log, risk flags) |
| `server/store.js` | Persistence (file/Postgres) |
| `server/test.js` | 69 automated checks: `node server/test.js` |
| `js/shared.js` | **Shared math & content tables** (floor prices, shards, daily rewards, quests, durability, income) |
| `js/net.js` | API calls, `applyView` (server view → `state`), `?ref=` capture |
| `js/main.js` | init, nav panels (`PANELS`) |
| `js/render.js`, `floors.js`, `sim.js` | Mine screen drawing, floor rows, miner animation |
| `js/quests.js` | Daily calendar modal, Quests modal (Daily/Season), mine-screen buttons, 📊 income panel |
| `js/inventory.js` | Manager screen: Items / Manager / BAG / Workshop tabs |
| `js/panels.js` | Shop (boosts → bag) |
| `js/ranks.js` | Season leaderboard + Referral tab/leaderboard |
| `js/offline.js` | "Welcome back" popup |
| `js/packs.js`, `bank.js`, `earn.js`, `login.js`, `settings.js` | Packs, bank, claim popup, login, settings |
| `css/extras.css` | Styles for the newest features (shards, daily, quests, referrals, bag, income panel) |
| `index.html` | All markup & script order |

## 3. Systems and rules

### 3.1 Mine floors (unlock prices)
- Coins for floor *n* (1-based): `60 × 2.8^(n-1)`. (`S.shaftUnlockCost` in shared.js)
- Floors **1-10**: coins only. Floors **11-20**: coins + **$AFKMINE** (`S.UNLOCK_MINE` **[tunable]**: 40 … 560). Floors **21-30**: coins + $AFKMINE (450 … 2000) + **Mine Shards** (`S.UNLOCK_SHARDS` **[tunable]**: 2,3,4,5,6,8,10,12,15,20).
- **Upgrades** (floor, elevator, warehouse levels) cost **coins only**.
- Floors already owned before (older save / prestige) are remembered in `mines.start.maxUnlocked` and only cost coins to re-unlock.
- The unlock is atomic on the server: coins, $AFKMINE and shards are all checked and deducted together.

### 3.2 Mine Shards
- Found by miners on floor **15 and deeper** (`S.SHARD_FROM`). Chance per finished ore trip `S.SHARD_P = 0.00005` on floor 15, +8% per deeper floor (`S.SHARD_DEPTH_BONUS`) **[tunable]**. Rolled with a Poisson draw so it also works offline.
- Stack in the **bag** (cap `S.BAG_MAX` 999). First they appear in "Claim mining rewards" (`pending.shards`), then the claim moves them to the bag.
- Used for unlocking floors 21-30 and the seasonal quest "Find 5 Mine Shards".

### 3.3 Bag and boosts
- Bag items (`S.BAG_ITEMS`): `shards`, `boost_xp`, `boost_earn`, `boost_power`.
- **Shop boosts are items.** Buying (`buy` action) charges $AFKMINE and adds 1 to the bag; nothing starts. The player presses **Use** (Shop or Manager → BAG → `useItem` action) to start a 2-hour boost (`S.BOOST_MINUTES`); using again adds 2 h, max 12 h stacked.
- Boosts: XP +100% manager XP, Earnings +50% (cash and $AFKMINE share, adds to quest boost), Power +100% manager power for the $AFKMINE share. Prices: `PRICES` in config.js **[tunable]** (500 / 400 / 600 $AFKMINE).
- Boosts can also be won as quest / daily rewards.

### 3.4 Durability
- Gear has `dur` 0-100%. **At 0% the item is unusable**: gives no stats, cannot be equipped, auto-equip skips it. **Any value above 0% works at full strength.** Repair (single or all) costs coins. (`S.usable`)

### 3.5 Offline earnings
- Players without the *Offline Earnings* perk earn only for **15 minutes** after closing the game (`OFFLINE_FREE_MS`); with the perk (all five Earnings Boost quests done) up to **8 hours** (`OFFLINE_MAX_MS`), cash and loot at **50%** (`OFFLINE_CASH_RATE`).
- Offline now includes **$AFKMINE, items, crates and Mine Shards**, not just coins. The server accumulates them in `offAcc`; the "Welcome back" popup shows them (`view.offline.away`). Coins are paid on Collect, $AFKMINE goes straight to the balance, loot waits in "Claim mining rewards".

### 3.6 Daily reward
- 7-day streak calendar (`S.DAILY_REWARDS` **[tunable]**): day 1 coins, 2 crate, 3 coins, 4 XP Boost, 5 coins, 6 coins + 2 crates, **day 7 = 250 $AFKMINE**. Coin rewards scale with the player's income (minutes of income, with a minimum).
- Claim once per UTC day. Missing a day resets to day 1. State: `p.daily`.

### 3.7 Quests
- **Daily quests** (reset 00:00 UTC, `S.DAILY_QUESTS`): play 30 min, buy 10 upgrade levels, try 2 item upgrades, repair gear. Finishing all four unlocks a **bonus** (`S.DAILY_BONUS`).
- **Seasonal quests** (30 days, `S.SEASON_QUESTS`): play 10 h, 1,500 levels, 30 drops, 60 item upgrades, unlock 20 floors, manager level 40, 5 shards, 14 daily claims. Rewards include $AFKMINE.
- Progress counters are updated by the server in `bumpQ`; rewards are granted in `grant`. UI: `js/quests.js`.
- **Boost quests** (the older "Earnings Boost" set, +10% each, max +50%): hold 50k $AFKMINE, deposit 50k, spend 25k, 24 h without withdrawing, link X/Discord. The **"24 h without withdrawals"** quest is **already complete** for new players: it counts from the last withdrawal, and if the player never withdrew it is done (`questMetric` "streak").

### 3.8 Referrals (tiers, manual weekly payout)
- Each player has a `refCode`; link `https://<site>/?ref=CODE`, stored by the browser and sent on first login (`createPlayer` links `referredBy`).
- **Qualifying referral** = a distinct referred player who bought at least one pack (`p.refQual`). Tier is recomputed at every purchase, so the purchase that makes the 3rd / 10th qualifying referral already earns the higher rate. A tier only applies to its own purchase.
- Tiers **[tunable]** `C.REF_TIERS`: T1 20% of pack spend; T2 (3+) 25%; T3 (10+) 30% plus 5% of the referred player's shop spend.
- A purchase **accrues a ledger entry** (`db.refEntries`: `{id,t,rid,bid,kind pack|shop,cur,spend,tier,bps,amount,real,status,week,batch,paidAs}`), amount fixed in lamports at purchase time. Nothing is credited automatically (the old instant `payReferral` is gone). `real` = the SOL pack was covered by the buyer's real deposits.
- Status: `accrued -> approved/paid` or `rejected`. An admin pays a weekly batch in `/admin` -> Referrals: backed entries become SOL balance (`treasury.referralPaid`), unbacked ones (paid with $AFKMINE or not covered by real deposits) are minted as $AFKMINE at spot price. Atomic and idempotent; refused (503) when pack revenue does not cover it.
- Player UI (Ranks -> Referrals): tier, progress to the next tier, pending vs paid, next payout date. The referral leaderboard shows the tier.

### 3.8b Nametags (cosmetic only)
- `p.tags`: **og** (golden, Season 0; granted once at the first start of this version to accounts created before `SEASON0_CUTOFF`, minus `db.admin.ogExcluded`), **ref2** (silver), **ref3** (premium), permanent once reached (`tierMax`). Shown on the season AND referral leaderboards: OG first, then the highest referral tag. Styles in `css/extras.css` (`.tag.og/.ref2/.ref3`).

### 3.9 Income panel and bottleneck
- 📊 button on the mine screen opens the **income per minute** panel (mines / elevator / warehouse bars, closeable, remembered). The **bottleneck** warning is a small pill with an ✕ (hidden for 10 min when closed).

### 3.10 Economy: $AFKMINE, SOL, pool, treasury
- **Units**: SOL in integer lamports, $AFKMINE in micro-units (1e6) inside the pool; BigInt maths only. `S.quote(side, solRes, tokRes, amountIn, feeBps)` in `js/shared.js` is used by the client preview AND the server; the server recomputes and ignores client prices. Fee is taken from the input (rounded up) and stays in the pool; payout rounds down (pool-favoring).
- **Pool** (`db.pool`): start 100 SOL / 10,000,000 $AFKMINE (price 0.00001 SOL) - **virtual**. Single atomic record with a monotonic version `v` (stores refuse a stale write). Trades: `tradeBuy {lamports, minOut}`, `tradeSell {tokens, minOut}`; result key `traded`. `GET /api/pool?range=24h|3d|7d|30d|all` is public: reserves, price, change, circulating supply, last ~50 trades and **OHLC candles** (5-minute candles persisted in the store, downsampled to at most 300 points `[t,o,h,l,c,volLamports]`; bad ranges fall back to 24h).
- **Limits**: fee `TRADE_FEE_BPS` (1%), max trade `MAX_TRADE_POOL_PCT` (2% of the reserve paid into), cooldown `TRADE_COOLDOWN_MS` (10 s), `DAILY_SELL_CAP_LAMPORTS_PER_PLAYER` (1 SOL/day). Guests cannot trade; selling needs a pack (`SELL_NEED_PACK`). **No price floor**: a sell is capped by treasury headroom `sellRoom = depositsIn - withdrawnNet - (all SOL balances + locked withdrawals) - SELL_KEEP_LAMPORTS`; the quote shows `maxSellMicro` and the UI MAX button uses it.
- **Treasury ledger** (`db.treasury`): `depositsIn, withdrawnNet, withdrawFees, packRevenue, referralPaid, legacyPacks`. assets = depositsIn - withdrawnNet; liabilities = sum of player SOL balances. **Invariant: assets >= liabilities** (liabilities include SOL locked in pending/failed withdrawals). Admin: `GET /api/admin/solvency` (needs `ADMIN_KEY`), plus a log line at start and every 10 min.
- **Emission**: `EMISSION_MODE=mint` (rewards minted into balances, `circulating` tracked and shown) or `reserve` (finite stock). **Sinks** (`ECONOMY_SINK_MODE`): `burn` or `recycle` into the pool. All go through `mint()`/`sink()`/`debitMine()`.
- **Packs**: SOL price fixed (`PACKS`), $AFKMINE price dynamic = SOL price -10% at the market price (`S.packMicroPrice`), buyer may pass `maxMine` (409 if the price moved).
- **Free tier**: earns up to 20,000 $AFKMINE (`FREE_EARN_CAP`), then earning stops until any pack is bought.
- **Withdrawals** (SOL only, **manual approval**): 0.05-2 SOL, 20% fee, 24 h cooldown, no guests. A request locks the funds (`pending`, still a liability); an admin approves (checks the on-chain balance, books the ledger, queues the send) or rejects with a reason (full refund, cooldown restored). States shown to players: pending / approved / sent / rejected / failed. A failed send stays locked until the admin chooses retry or refund. Approve is idempotent (second call = 409). Old token withdrawals: queued ones were refunded as $AFKMINE; sent ones are polled and refunded only on failure/expiry.
- **Season**: 30 days, leaderboard prizes from a $AFKMINE pool.
- **Item upgrades** +1..+10, success 95% -> 7%, failure keeps the level but spends the price.
- **Events tab**: placeholder "coming soon" (`#panel-events` in index.html).

### 3.11 Power-gated floors
- Total power = Manager power (level x 50 + usable gear) x the Power Boost (`S.GATE_COUNTS_BOOST`). Floor *n* works only if total power >= `S.FLOOR_POWER_REQ[n]`. Floors 1-3 are free; later `round(120 x 1.2^(n-4) / 10) x 10` (floor 4 = 120, 10 = 360, 20 = 2,220, 30 = 13,740) **[tunable]** `S.GATE_FREE_FLOORS, GATE_BASE, GATE_GROWTH`.
- A gated floor produces no coins, drops or shards, online or offline (server `S.floorActive`, `S.income`, `S.gateInfo`); the client greys it out ("Needs X Power, you have Y"). Gear can switch floors on; broken gear counts as nothing. `scripts/power-curve-sim.js` prints the curve.
- The elevator drives to the deepest floor with ore, so extra shallow ore (or equipping gear) can never lower income.

### 3.12 Admin dashboard
- `/admin` (needs `ADMIN_TOKEN`, 404 otherwise). Own login (never a player token), 30 min idle / 8 h sessions, brute-force limit, API limit. Pages: Overview, Withdrawals, Referrals (weekly batch), Players, Trades, Audit.
- Every decision (login, failed login, approve/reject/retry/refund, referral payout/reject, OG exclusion) is an append-only ledger row of kind `audit`.
- **Risk flags** (informational, never automatic bans): shared IP hash, shared withdrawal wallet, rapid buy/sell loops, referral rewards sold within 6 h, referral clusters on one IP, manual note. IPs are stored only as salted HMAC hashes (5 per player, 30 days).

## 4. Data model (per player, in the store)
`id, name, wallet, token (hashed), cash, mine/token balance, hero {lvl, xp, items...}, mines.start {shafts[], unlockedShaftCount, maxUnlocked, elevator, warehouse}, inventory/equipment (items with rarity, lvl, up, dur), pending {items, crates, shards, cash}, bag {shards, boost_xp, boost_earn, boost_power}, boosts {xp, earn, power} (end timestamps), daily {day, lastClaim,...}, dq (daily quests), sq (season quests), offAcc (offline tally), solBalance (lamports), tradeStats {lastAt, day, soldToday, depositedLamports,...}, refCode, referredBy, refQual[], tierMax, tags[], ips[] (hashed), refEarned, refPaid, refEarnedSol, refPaidSol, lastWithdrawAt, quests (boost quests), history/events`.
`migrate()` in game.js upgrades old saves automatically (adds any missing field) — **always add new fields there**. Global (not per player): `db.pool`, `db.treasury`, `db.refEntries`, `db.admin {salt, ogExcluded, flags, batchSeq, og0}`, `db.ogDone`, plus `trades`, `candles` and `ledger` rows in the store.

## 5. API summary
- Public: `GET /api/health, /api/config, /api/leaderboard, /api/stats, /api/referrals/leaderboard`
- Auth: `POST /api/guest`, `/api/auth/nonce`, `/api/auth/wallet`, `/api/logout`, `/api/account/delete`
- Player: `GET /api/referrals`, `POST /api/act` with `type` = `upgrade, unlockFloor, prestige, buy, claimOffline, useItem, claimDaily, claimQuest, claimDailyBonus, claimRewards, upgradeItem, linkSocial, reset, equip, unequip, lock, sell, sellAll, sort, autoEquip, repair, repairAll, crate, …` (see `ACTIONS` in game.js)
- Trade: `POST /api/act` `tradeBuy` / `tradeSell`; public `GET /api/pool?range=`; `GET /api/admin/solvency` (`x-admin-key`).
- Bank: `POST /api/bank/deposit/prepare {lamports}`, `/api/bank/deposit/confirm`, `/api/bank/withdraw {lamports}` (creates a pending request), `/api/pack/sol {pack}`, `/api/pack/mine {pack, maxMine}` (see `server/bank.js`).

- Admin (header `x-admin-session` from `POST /api/admin/login {token}`): `GET /api/admin/me, overview, withdrawals?status=, referrals, players?q=, player?id=, trades, audit`; `POST /api/admin/withdrawal/approve|reject|retry|refund`, `referrals/payout|reject`, `player/flag`, `player/og`, `logout`.

## 6. Config knobs (where to change what)
| Want to change | Edit |
|---|---|
| Floor prices ($AFKMINE / shards) | `S.UNLOCK_MINE`, `S.UNLOCK_SHARDS` in `js/shared.js` |
| Shard drop rate / starting floor | `S.SHARD_P`, `S.SHARD_FROM`, `S.SHARD_DEPTH_BONUS` |
| Daily rewards / quest lists & rewards | `S.DAILY_REWARDS`, `S.DAILY_QUESTS`, `S.DAILY_BONUS`, `S.SEASON_QUESTS` |
| Shop boost prices | `PRICES` in `server/config.js` |
| Boost length / max stack | `S.BOOST_MINUTES`, `S.BOOST_MAX_MS` |
| Pool start / fee / limits | `POOL_INIT_SOL`, `POOL_INIT_TOKENS`, `TRADE_FEE_BPS`, `MAX_TRADE_POOL_PCT`, `TRADE_COOLDOWN_MS`, `DAILY_SELL_CAP_LAMPORTS_PER_PLAYER` (env or `server/config.js`) |
| Who may trade / sell, price floor | `TRADE_NEED_WALLET`, `SELL_NEED_PACK`, `SELL_KEEP_LAMPORTS` (no price floor any more) |
| Emission and sinks | `EMISSION_MODE`, `EMISSION_RESERVE_TOKENS`, `ECONOMY_SINK_MODE` |
| SOL deposit / withdraw limits | `MIN_/MAX_DEPOSIT_SOL`, `WITHDRAW_MIN_LAMPORTS` (0.05 SOL), `WITHDRAW_MAX_LAMPORTS` (2 SOL), `WITHDRAW_FEE`, `TREASURY_RESERVE_LAMPORTS` |
| Admin dashboard, solvency endpoint, mainnet guard | `ADMIN_TOKEN`, `ADMIN_KEY`, `ALLOW_MAINNET` |
| Referral tiers and payout day | `REF_T1_BPS, REF_T2_MIN/BPS, REF_T3_MIN/BPS, REF_T3_SHOP_BPS, REF_PAYOUT_DOW` (`C.REF_TIERS`) |
| Floor Power requirements | `S.GATE_FREE_FLOORS, GATE_BASE, GATE_GROWTH, GATE_COUNTS_BOOST` in `js/shared.js` |
| Chart candles | `CANDLE_MS, CANDLES_MAX, CHART_MAX_POINTS` |
| OG tag cutoff | `SEASON0_CUTOFF` |
| Offline rules | `OFFLINE_*`, `ACTIVE_MS` in config.js |
| Free-tier cap, onboarding | `FREE_EARN_CAP`, `ONBOARD_*` |
| Texts / labels | `index.html`, `js/*.js` strings |
| Styles of new screens, nametags | `css/extras.css` (admin: `css/admin.css`) |

## 7. Glossary
- **Mine / floor / shaft** — one level of the mine (code says `shaft`/`floor`).
- **Manager** — the player's character (code `hero`). **Gear / items** — equipment. **Crate** — opens into gear.
- **Bag** — stackable items (shards + boosts). **Pending** — unclaimed mining loot.
- **Season** — 30-day competition with $AFKMINE prizes. **Pack** — one-time paid bundle.

## 8. How to ask an AI for a change (template)
1. Paste this file.
2. Say what you want in plain words, e.g. "Make floors 25+ need 2× shards" or "Add a weekly quest".
3. Ask it to name the files it will touch, keep the server authoritative (add a field → `migrate`, add an action → `ACTIONS` + view + UI + a test in `server/test.js`), and to run `node server/test.js`.
4. Rules to remember: never trust the client; no inline scripts (CSP); new static files must live in `css/` or `js/`; shared math belongs in `js/shared.js`.

## 9. Known limits / assumptions
- Shard rates and floor prices are first-pass tuning; play-test and adjust.
- **The initial 100 SOL pool reserve is virtual.** Only SOL buyers deposit is real; Without a price floor, sells are limited by treasury headroom (`sellRoom`). Pack revenue and fees count as headroom too, so sellers can drain them unless `SELL_KEEP_LAMPORTS` is set.
- Free-tier mined $AFKMINE can be sold once the player owns a pack (mitigation: pack requirement, daily cap, trade size limit, cooldown).
- Old on-chain $AFKMINE holders are stranded: in-game balances carried over 1:1, but nothing exists on-chain any more.
- Possible regulatory exposure: a currency that is tradable for SOL and withdrawable can be treated as a financial product in some jurisdictions - get advice before real money.
- Internal keys (`token`, `balance`, `mine`, `MINE_*` helpers) keep their old names; only text and docs say $AFKMINE. "Hero -> Manager" is likewise a display rename.
- Postgres paths (row lock, trades/ledger tables) and real Solana RPC were not exercised by automated tests (fake chain / file store). Test on devnet; mainnet is blocked unless `ALLOW_MAINNET=yes-i-have-tested-on-devnet`.
- Referral entries paid with $AFKMINE (or not covered by real deposits) are unbacked: they are paid as $AFKMINE, never as SOL.
- Admin: only the `ADMIN_TOKEN` login exists (no wallet-signature login); sessions live in memory and reset on restart. Risk flags have no fingerprint and no "same funding wallet" check (wallet = account); only salted IP hashes are used.
- No migration/grace period was built for the Power gate (only the author had played).
- `scripts/calibrate.js` is an old dev tool with its own copy of the elevator logic and is out of date.
