# Idle Mountain Miner — online edition

A server-authoritative idle game. The browser only sends *intents* ("upgrade floor 3"); the server owns every
number (cash, XP, gear, drops, $AFKMINE) and computes it from **its own clock**. Changing your PC clock or
sending crafted requests cannot give you anything.

## Run locally
```
npm install
npm test            # 37 server checks (cheats, rate limits, chain analysis, withdrawals...)
npm start           # http://localhost:3000
```

## Environment variables
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | **Postgres connection string. Strongly recommended on Render** (free web-service disks are wiped on every deploy/restart). Without it, a file (`server/data.json`) is used. |
| `SOLANA_CLUSTER` | `devnet` (default) or `testnet`. `mainnet-beta` is blocked (see `ALLOW_MAINNET`). |
| `SOLANA_RPC_URL` | Optional custom RPC (public testnet RPC is rate limited). |
| `TREASURY_SECRET_KEY` | Treasury wallet secret (base58). Receives SOL deposits and pays SOL withdrawals. **Keep it secret, only in host env vars.** |
| `MERCHANT_WALLET` | Only used to confirm *legacy* pack orders paid before the switch to the SOL balance. Optional. |
| `POOL_INIT_SOL` / `POOL_INIT_TOKENS` | Virtual pool start reserves (default 100 SOL / 10,000,000 $AFKMINE = 0.00001 SOL each). **Virtual: no real SOL backs the first 100.** |
| `TRADE_FEE_BPS` | Trade fee in basis points (default 100 = 1%), stays in the pool. |
| `MAX_TRADE_POOL_PCT` | Max size of one trade as % of the reserve it pays into (default 2). |
| `TRADE_COOLDOWN_MS` | Per-player gap between trades (default 10000). |
| `DAILY_SELL_CAP_LAMPORTS_PER_PLAYER` | SOL a player may receive from selling per UTC day (default 1e9 = 1 SOL). |
| `TRADE_NEED_WALLET`, `SELL_NEED_PACK` | `0` disables: guests may trade / selling needs no pack. Default on (both required). |
| `SELL_KEEP_LAMPORTS` | Treasury SOL that sells may never touch (default 0). There is **no price floor**: a sell is limited only by what the treasury can really pay (assets - balances - pending withdrawals - this value). |
| `ECONOMY_SINK_MODE` | `burn` (default) or `recycle`: what happens to $AFKMINE spent in the game. |
| `EMISSION_MODE`, `EMISSION_RESERVE_TOKENS` | `mint` (default): rewards are minted into balances, `circulating` rises. `reserve`: paid from a finite stock. |
| `MIN_/MAX_DEPOSIT_SOL`, `WITHDRAW_FEE` | Deposit limits; withdraw fee (0.2 = 20%). |
| `WITHDRAW_MIN_LAMPORTS`, `WITHDRAW_MAX_LAMPORTS` | Per-withdrawal limits (default 0.05 and 2 SOL). 24 h cooldown. Every withdrawal needs **manual admin approval**. |
| `REF_T1_BPS`, `REF_T2_MIN`, `REF_T2_BPS`, `REF_T3_MIN`, `REF_T3_BPS`, `REF_T3_SHOP_BPS`, `REF_PAYOUT_DOW` | Referral tiers (defaults 20% / 3+ refs 25% / 10+ refs 30% + 5% of shop spend) and the weekly payout day shown to players (1 = Monday). |
| `SEASON0_CUTOFF` | ISO date: accounts created before it get the golden OG tag at first start (empty = everyone who exists then). |
| `TREASURY_RESERVE_LAMPORTS` | Safety margin kept on-chain for tx fees. |
| `ADMIN_TOKEN` | Enables the admin dashboard at `/admin` (min. 16 characters, long and random). Unset = the page and `/api/admin/*` answer 404. `ADMIN_KEY` still works for `GET /api/admin/solvency`. Never reuse a player token. |
| `ALLOW_MAINNET` | Mainnet is refused unless this is `yes-i-have-tested-on-devnet`. |
| `DEV_FAUCET` | `on`/`off`. The "Test money" shop tab (free cash + free $AFKMINE, no cooldown). Default: on, except on `mainnet-beta`. **Turn it off before real money is involved** — it mints sellable $AFKMINE. |
| `KEEPALIVE_URL` | Optional; defaults to `RENDER_EXTERNAL_URL`. The server pings its own `/api/health` every 10 min. |
| `TRUST_PROXY` | Auto-on on Render (`RENDER=true`); set `0` to disable. |

## Devnet setup
1. `npm install` (also regenerates `package-lock.json`)
2. Create a treasury wallet (`solana-keygen new`) and fund it with devnet SOL (https://faucet.solana.com, pick *devnet*). **There is no token to create: $AFKMINE exists only in the database.**
3. Put `TREASURY_SECRET_KEY` (and `ADMIN_TOKEN`) into Render → Environment, plus a Render Postgres → `DATABASE_URL`.
4. In Phantom switch to *Developer Settings → Testnet Mode → Solana Devnet* and use a wallet with devnet SOL.

## Fixing "server sleeps when nobody plays"
Render free web services sleep after ~15 min without traffic. The built-in self-ping cannot wake a sleeping
server, so also add a free external pinger (UptimeRobot / cron-job.org) hitting
`https://idle-miner-tu85.onrender.com/api/health` every 5 minutes. Combined with Postgres, nothing is lost on restarts.

## Game rules implemented
- Login: Solana wallet (signed one-time message) or guest. Guests can't withdraw; linking a wallet later keeps the progress (if that wallet already has an account you switch to it).
- Free tier: everything except withdrawals, earns up to **20,000 $AFKMINE** (about 1–2 h of play), then $AFKMINE earning stops until any pack is bought. Paid tiers are uncapped (original earn rates).
- Packs (one-time each): Prospector 0.05 SOL (45k $AFKMINE), Foreman 0.15 SOL (135k), Tycoon 0.4 SOL (360k). Smaller loot than before (Prospector = 4 Rare, Foreman = 6 Epic, Tycoon = 8 Legendary).
- Pacing: max manager level (the "Manager", formerly Hero) takes about 15 days at ~12 h/day of play.
- Mining loot lands in a pending list; the **Claim mining rewards** button on the mine screen moves it to the backpack (cap 100 pending, extra is auto-sold).
- Item upgrades: +1 to +10 (+10% stats each), success chance falls from 95% to 7%. First 3 cost coins only, +4..+10 cost coins + $AFKMINE. A failed upgrade keeps the level but spends the price.
- Quests (+10% earnings each, max +50%): hold 50k $AFKMINE, deposit 50k, spend 25k, 24 h without withdrawing, link X and Discord (handles are **not verified**). All five unlock Offline Earnings (up to 8 h at 50% cash). Without it, earning stops 15 min after you close the tab.
- Shop boosts (paid in $AFKMINE, 2 h each, stackable to 12 h): +100% XP, +50% earnings, +100% power ($AFKMINE share). Prices in `server/config.js` (`PRICES`). A bought boost goes into the **bag** (Manager → BAG) and only starts when you press **Use**.
- Floor (mine) prices: floors 1-10 cost coins; 11-20 cost coins + $AFKMINE; 21-30 cost coins + $AFKMINE + **Mine Shards**. Upgrades cost coins only. Floors you owned before a prestige/older version only cost coins (`maxUnlocked`). Tables: `S.UNLOCK_MINE`, `S.UNLOCK_SHARDS` in `js/shared.js`.
- **Mine Shards**: very rare stackable item; miners on floor 15 and deeper find them (`S.SHARD_FROM`, `S.SHARD_P`). They wait in "Claim mining rewards", then live in the bag.
- **Offline earnings** now include $AFKMINE, items, crates and shards (cash/loot at 50%); the Welcome-back popup lists everything.
- **Daily reward**: 7-day streak calendar, days 1-6 give coins/items/crates, day 7 gives $AFKMINE. Missing a day restarts the week. Reset at 00:00 UTC.
- **Quests**: 4 daily quests (+ perfect-day bonus) and 8 seasonal quests (30 days). Rewards are coins, crates, boosts or $AFKMINE.
- **Referrals**: `?ref=CODE` link. Tiers by *qualifying* referrals (distinct friends who bought at least one pack): T1 20%, T2 25% (3+), T3 30% + 5% of shop spending (10+). Rewards are recorded in lamports at purchase time as **pending** and paid **by hand once a week** in the admin dashboard. Nothing is credited automatically.
- **Nametags** (cosmetic): golden **OG** (Season 0 accounts), silver T2 and premium T3 on both leaderboards.
- **Power gating**: floor 4+ only work when the Manager's total Power reaches the floor's requirement (floors 1-3 are free). Gated floors show what they need.
- **Trade chart**: 5-minute candles with 24H / 3D / 7D / 30D / ALL ranges.
- **Durability**: gear at 0% is unusable (no stats, can't be equipped); anything above 0% works at full strength.
- The "24 h without withdrawing" quest is already complete for new players until their first withdrawal.
- Events tab: placeholder ("coming soon").
- See `GAME_DESIGN.md` for the full description meant to be given to an AI assistant.
- Withdrawals (SOL): 0.05-2 SOL (gross), 20% fee, 24 h cooldown, guests cannot withdraw. A request locks the funds as **pending**; nothing is sent until an admin approves it in `/admin`.
- Settings: sound/music, change username, log out, reset progress, delete account (accounts holding SOL or $AFKMINE can't be deleted).
- Bank: Deposit / Withdraw (SOL only) / Trade ($AFKMINE <-> SOL in a virtual x*y=k pool) / History. Packs are paid from the in-game SOL balance or with $AFKMINE.

## Security notes
- Web3 code uses only the official `@solana/web3.js`, `tweetnacl`, `bs58`.
- Deposits are credited only after the server reads the confirmed transaction: treasury balance delta **and** the player's own balance loss; each signature can be claimed once (atomic).
- Withdrawals are signed server-side, recorded before broadcast, refunded exactly once only after the blockhash has expired.
- Tokens are stored hashed, rate limits per IP/account, strict CSP, 10 KB body limit, static-file whitelist.

## Honest limits
- Real Solana RPC paths, Postgres and a real wallet on testnet were **not** exercised in the automated tests (a fake chain was used). Test with small amounts on testnet first.
- Before going to mainnet: independent security audit, rotate the treasury key, keep only a small hot balance in the treasury.

## Admin dashboard (`/admin`)
Set `ADMIN_TOKEN` (16+ random characters) and open `/admin`. Pages: Overview (solvency, flows, referral cost), Withdrawals (approve / reject with reason / retry / refund), Referrals (weekly batch), Players (search, flags, OG exclusion), Trades, Audit log. Sign-in is rate limited, sessions expire after 30 min idle (8 h max) and are lost on restart. Every decision is written to an append-only audit log.

**Privacy**: the risk flags use salted HMAC hashes of IP addresses (16 hex chars, last 5 per player, deleted after 30 days and with the account). Raw IPs and browser fingerprints are never stored. Mention this in your privacy policy.
