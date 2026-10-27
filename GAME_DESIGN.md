# Idle Mountain Miner — Game Design & Technical Guide

> Give this file to an AI assistant (or a new developer) before asking "what should I change to do X?".
> It describes what the game is, how it is built, where every rule lives and how to request changes.
> Numbers marked **[tunable]** are first-pass values you can change in one place (file given).

## 1. What the game is
An idle/tycoon mining game in the browser with a real-money-adjacent twist: the in-game token **$MINE** (a Solana SPL token) can be deposited and withdrawn. Players:
1. Build a mine of up to **30 floors** (a "floor" is what a player calls a "mine" in chat), plus one **elevator** and one **warehouse**. Miners dig ore, the elevator lifts it, the warehouse carries it to the surface and turns it into **coins** (cash).
2. Level up the **Manager** (internal name `hero`; renamed from "Hero", display-only) and equip **gear items** (rarity, level, +upgrades, durability).
3. Earn **$MINE** from a daily emission pool shared by active players (30-day **season**, leaderboard prizes).
4. Buy **packs** (SOL or $MINE) that remove the free-tier $MINE cap and give loot.

Currencies / resources: **Coins** (cash), **$MINE** (token), **Mine Shards** (very rare, stackable), **crates** (open for gear), **bag items** (Shards + 3 boosts).

## 2. Architecture
- **Server-authoritative.** The browser never decides outcomes. It sends an intent (`POST /api/act {type, ...}`) and receives the full player *view*. All math is in `js/shared.js`, which is loaded by BOTH server and browser (UMD) so costs shown always match costs charged.
- Plain Node `http`, no framework. Storage: JSON file or Postgres (`server/store.js`).
- Client: vanilla JS, global scripts loaded in order from `index.html`; CSS in `css/`. Strict CSP: **no inline scripts/handlers**.
- Server ticks every few seconds (`tick()` in game.js) to settle income, $MINE and offline loot for players who are away.

### File map
| File | Purpose |
|---|---|
| `server/server.js` | HTTP routes, auth (guest / Solana wallet signature), rate limits, static files (whitelist `css/*.css`, `js/*.js`) |
| `server/game.js` | **All game rules**: settle/tick, drops, quests, daily, referrals, shop, actions (`ACTIONS` table), view builder |
| `server/config.js` | Env + tunables: pools, caps, offline rules, referral rate, shop `PRICES`, packs |
| `server/bank.js`, `chain.js` | Deposits/withdrawals/pack payments on Solana |
| `server/store.js` | Persistence (file/Postgres) |
| `server/test.js` | 44 automated checks: `node server/test.js` |
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
- Floors **1-10**: coins only. Floors **11-20**: coins + **$MINE** (`S.UNLOCK_MINE` **[tunable]**: 40 … 560). Floors **21-30**: coins + $MINE (450 … 2000) + **Mine Shards** (`S.UNLOCK_SHARDS` **[tunable]**: 2,3,4,5,6,8,10,12,15,20).
- **Upgrades** (floor, elevator, warehouse levels) cost **coins only**.
- Floors already owned before (older save / prestige) are remembered in `mines.start.maxUnlocked` and only cost coins to re-unlock.
- The unlock is atomic on the server: coins, $MINE and shards are all checked and deducted together.

### 3.2 Mine Shards
- Found by miners on floor **15 and deeper** (`S.SHARD_FROM`). Chance per finished ore trip `S.SHARD_P = 0.00005` on floor 15, +8% per deeper floor (`S.SHARD_DEPTH_BONUS`) **[tunable]**. Rolled with a Poisson draw so it also works offline.
- Stack in the **bag** (cap `S.BAG_MAX` 999). First they appear in "Claim mining rewards" (`pending.shards`), then the claim moves them to the bag.
- Used for unlocking floors 21-30 and the seasonal quest "Find 5 Mine Shards".

### 3.3 Bag and boosts
- Bag items (`S.BAG_ITEMS`): `shards`, `boost_xp`, `boost_earn`, `boost_power`.
- **Shop boosts are items.** Buying (`buy` action) charges $MINE and adds 1 to the bag; nothing starts. The player presses **Use** (Shop or Manager → BAG → `useItem` action) to start a 2-hour boost (`S.BOOST_MINUTES`); using again adds 2 h, max 12 h stacked.
- Boosts: XP +100% manager XP, Earnings +50% (cash and $MINE share, adds to quest boost), Power +100% manager power for the $MINE share. Prices: `PRICES` in config.js **[tunable]** (500 / 400 / 600 $MINE).
- Boosts can also be won as quest / daily rewards.

### 3.4 Durability
- Gear has `dur` 0-100%. **At 0% the item is unusable**: gives no stats, cannot be equipped, auto-equip skips it. **Any value above 0% works at full strength.** Repair (single or all) costs coins. (`S.usable`)

### 3.5 Offline earnings
- Players without the *Offline Earnings* perk earn only for **15 minutes** after closing the game (`OFFLINE_FREE_MS`); with the perk (all five Earnings Boost quests done) up to **8 hours** (`OFFLINE_MAX_MS`), cash and loot at **50%** (`OFFLINE_CASH_RATE`).
- Offline now includes **$MINE, items, crates and Mine Shards**, not just coins. The server accumulates them in `offAcc`; the "Welcome back" popup shows them (`view.offline.away`). Coins are paid on Collect, $MINE goes straight to the balance, loot waits in "Claim mining rewards".

### 3.6 Daily reward
- 7-day streak calendar (`S.DAILY_REWARDS` **[tunable]**): day 1 coins, 2 crate, 3 coins, 4 XP Boost, 5 coins, 6 coins + 2 crates, **day 7 = 250 $MINE**. Coin rewards scale with the player's income (minutes of income, with a minimum).
- Claim once per UTC day. Missing a day resets to day 1. State: `p.daily`.

### 3.7 Quests
- **Daily quests** (reset 00:00 UTC, `S.DAILY_QUESTS`): play 30 min, buy 10 upgrade levels, try 2 item upgrades, repair gear. Finishing all four unlocks a **bonus** (`S.DAILY_BONUS`).
- **Seasonal quests** (30 days, `S.SEASON_QUESTS`): play 10 h, 1,500 levels, 30 drops, 60 item upgrades, unlock 20 floors, manager level 40, 5 shards, 14 daily claims. Rewards include $MINE.
- Progress counters are updated by the server in `bumpQ`; rewards are granted in `grant`. UI: `js/quests.js`.
- **Boost quests** (the older "Earnings Boost" set, +10% each, max +50%): hold 50k $MINE, deposit 50k, spend 25k, 24 h without withdrawing, link X/Discord. The **"24 h without withdrawals"** quest is **already complete** for new players: it counts from the last withdrawal, and if the player never withdrew it is done (`questMetric` "streak").

### 3.8 Referrals
- Each player has a `refCode`. Link format `https://<site>/?ref=CODE`; the browser stores the code (`localStorage idleMiner_ref`) and sends it on first login (guest or wallet), where `createPlayer` links `referredBy`.
- When the referred player buys a pack, the referrer gets **25%** (`C.REF_RATE`) of its value as **$MINE** to their game balance (`payReferral`, called from `grantPack`). SOL purchases are valued at `SOL price × MINE_PER_SOL`; $MINE purchases at the $MINE price. **Note:** for SOL purchases this $MINE is not backed by a treasury movement — it is an in-game credit; change if you want it backed.
- Leaderboard: Ranks → Referrals; columns user, referred people, $MINE earned. API: `GET /api/referrals/leaderboard` (public), `GET /api/referrals` (own stats).

### 3.9 Income panel and bottleneck
- 📊 button on the mine screen opens the **income per minute** panel (mines / elevator / warehouse bars, closeable, remembered). The **bottleneck** warning is a small pill with an ✕ (hidden for 10 min when closed).

### 3.10 Other (unchanged)
- **Free tier**: earns up to 20,000 $MINE (`FREE_EARN_CAP`), then $MINE earning stops until any pack is bought. First 20k are paid fast (onboarding).
- **Packs**: Prospector 0.05 SOL, Foreman 0.15, Tycoon 0.4 (`PACKS` in config.js).
- **Season**: 30 days, leaderboard prizes from a $MINE pool.
- **Withdrawals**: 20% fee, max 250k, 24 h cooldown, guests can't withdraw.
- **Item upgrades** +1..+10, success 95% → 7%, failure keeps the level but spends the price.
- **Events tab**: placeholder "coming soon" (`#panel-events` in index.html).

## 4. Data model (per player, in the store)
`id, name, wallet, token (hashed), cash, mine/token balance, hero {lvl, xp, items...}, mines.start {shafts[], unlockedShaftCount, maxUnlocked, elevator, warehouse}, inventory/equipment (items with rarity, lvl, up, dur), pending {items, crates, shards, cash}, bag {shards, boost_xp, boost_earn, boost_power}, boosts {xp, earn, power} (end timestamps), daily {day, lastClaim,...}, dq (daily quests), sq (season quests), offAcc (offline tally), refCode, referredBy, refEarned, refPaid, lastWithdrawAt, quests (boost quests), history/events`.
`migrate()` in game.js upgrades old saves automatically (adds any missing field) — **always add new fields there**.

## 5. API summary
- Public: `GET /api/health, /api/config, /api/leaderboard, /api/stats, /api/referrals/leaderboard`
- Auth: `POST /api/guest`, `/api/auth/nonce`, `/api/auth/wallet`, `/api/logout`, `/api/account/delete`
- Player: `GET /api/referrals`, `POST /api/act` with `type` = `upgrade, unlockFloor, prestige, buy, claimOffline, useItem, claimDaily, claimQuest, claimDailyBonus, claimRewards, upgradeItem, linkSocial, reset, equip, unequip, lock, sell, sellAll, sort, autoEquip, repair, repairAll, crate, …` (see `ACTIONS` in game.js)
- Bank: deposit / withdraw / pack purchase routes in `server/bank.js`.

## 6. Config knobs (where to change what)
| Want to change | Edit |
|---|---|
| Floor prices ($MINE / shards) | `S.UNLOCK_MINE`, `S.UNLOCK_SHARDS` in `js/shared.js` |
| Shard drop rate / starting floor | `S.SHARD_P`, `S.SHARD_FROM`, `S.SHARD_DEPTH_BONUS` |
| Daily rewards / quest lists & rewards | `S.DAILY_REWARDS`, `S.DAILY_QUESTS`, `S.DAILY_BONUS`, `S.SEASON_QUESTS` |
| Shop boost prices | `PRICES` in `server/config.js` |
| Boost length / max stack | `S.BOOST_MINUTES`, `S.BOOST_MAX_MS` |
| Referral percentage | `REF_RATE` (env var or config.js) |
| Offline rules | `OFFLINE_*`, `ACTIVE_MS` in config.js |
| Free-tier cap, onboarding | `FREE_EARN_CAP`, `ONBOARD_*` |
| Texts / labels | `index.html`, `js/*.js` strings |
| Styles of new screens | `css/extras.css` |

## 7. Glossary
- **Mine / floor / shaft** — one level of the mine (code says `shaft`/`floor`).
- **Manager** — the player's character (code `hero`). **Gear / items** — equipment. **Crate** — opens into gear.
- **Bag** — stackable items (shards + boosts). **Pending** — unclaimed mining loot.
- **Season** — 30-day competition with $MINE prizes. **Pack** — one-time paid bundle.

## 8. How to ask an AI for a change (template)
1. Paste this file.
2. Say what you want in plain words, e.g. "Make floors 25+ need 2× shards" or "Add a weekly quest".
3. Ask it to name the files it will touch, keep the server authoritative (add a field → `migrate`, add an action → `ACTIONS` + view + UI + a test in `server/test.js`), and to run `node server/test.js`.
4. Rules to remember: never trust the client; no inline scripts (CSP); new static files must live in `css/` or `js/`; shared math belongs in `js/shared.js`.

## 9. Known limits / assumptions
- Shard rates and floor prices are first-pass tuning; play-test and adjust.
- Referral payouts for SOL packs are unbacked in-game $MINE.
- "Hero → Manager" is a display rename only (code/save keys still say `hero`).
- Real Solana/Postgres paths were not exercised by automated tests (fake chain used). Test on testnet before mainnet.
