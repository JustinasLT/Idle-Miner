# Idle Mountain Miner — online edition

A server-authoritative idle game. The browser only sends *intents* ("upgrade floor 3"); the server owns every
number (cash, XP, gear, drops, $MINE) and computes it from **its own clock**. Changing your PC clock or
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
| `SOLANA_CLUSTER` | `testnet` (default) or `devnet`. |
| `SOLANA_RPC_URL` | Optional custom RPC (public testnet RPC is rate limited). |
| `MINE_MINT` | Token mint address (from `npm run setup:token`). |
| `MINE_DECIMALS` | Token decimals (default 6). |
| `TREASURY_SECRET_KEY` | Treasury wallet secret (base58). Holds the $MINE players deposit and pays withdrawals. **Keep it secret, only in host env vars.** |
| `MERCHANT_WALLET` | Public address that receives SOL from pack sales (straight to you, not the treasury). |
| `MINE_PER_SOL` | Price conversion for SOL packs (default 1,000,000 $MINE = 1 SOL; $MINE price = 90% of the SOL value). |
| `DEV_FAUCET` | `on`/`off`. The "Test money" shop tab (free cash + free $MINE, no cooldown). Default: on, except on `mainnet-beta`. **Turn it off before real money is involved** — it mints withdrawable $MINE. |
| `KEEPALIVE_URL` | Optional; defaults to `RENDER_EXTERNAL_URL`. The server pings its own `/api/health` every 10 min. |
| `TRUST_PROXY` | Auto-on on Render (`RENDER=true`); set `0` to disable. |

## Testnet setup
1. `npm install`
2. `npm run setup:token` — creates a treasury wallet, the $MINE token (fixed supply, mint authority removed) and prints the env vars. It needs a little test SOL (https://faucet.solana.com, pick *testnet*).
3. Put the printed values + `MERCHANT_WALLET` into Render → Environment, and add a Render Postgres → `DATABASE_URL`.
4. In Phantom switch to *Developer Settings → Testnet Mode*, add the token by its mint, send yourself some $MINE from the treasury.

## Fixing "server sleeps when nobody plays"
Render free web services sleep after ~15 min without traffic. The built-in self-ping cannot wake a sleeping
server, so also add a free external pinger (UptimeRobot / cron-job.org) hitting
`https://idle-miner-tu85.onrender.com/api/health` every 5 minutes. Combined with Postgres, nothing is lost on restarts.

## Game rules implemented
- Login: Solana wallet (signed one-time message) or guest. Guests can't withdraw; linking a wallet later keeps the progress (if that wallet already has an account you switch to it).
- Free tier: everything except withdrawals, earns up to **20,000 $MINE** (about 1–2 h of play), then $MINE earning stops until any pack is bought. Paid tiers are uncapped (original earn rates).
- Packs (one-time each): Prospector 0.05 SOL (45k $MINE), Foreman 0.15 SOL (135k), Tycoon 0.4 SOL (360k). Smaller loot than before (Prospector = 4 Rare, Foreman = 6 Epic, Tycoon = 8 Legendary).
- Pacing: max manager level (the "Manager", formerly Hero) takes about 15 days at ~12 h/day of play.
- Mining loot lands in a pending list; the **Claim mining rewards** button on the mine screen moves it to the backpack (cap 100 pending, extra is auto-sold).
- Item upgrades: +1 to +10 (+10% stats each), success chance falls from 95% to 7%. First 3 cost coins only, +4..+10 cost coins + $MINE. A failed upgrade keeps the level but spends the price.
- Quests (+10% earnings each, max +50%): hold 50k $MINE, deposit 50k, spend 25k, 24 h without withdrawing, link X and Discord (handles are **not verified**). All five unlock Offline Earnings (up to 8 h at 50% cash). Without it, earning stops 15 min after you close the tab.
- Shop boosts (paid in $MINE, 2 h each, stackable to 12 h): +100% XP, +50% earnings, +100% power ($MINE share). Prices in `server/config.js` (`PRICES`). A bought boost goes into the **bag** (Manager → BAG) and only starts when you press **Use**.
- Floor (mine) prices: floors 1-10 cost coins; 11-20 cost coins + $MINE; 21-30 cost coins + $MINE + **Mine Shards**. Upgrades cost coins only. Floors you owned before a prestige/older version only cost coins (`maxUnlocked`). Tables: `S.UNLOCK_MINE`, `S.UNLOCK_SHARDS` in `js/shared.js`.
- **Mine Shards**: very rare stackable item; miners on floor 15 and deeper find them (`S.SHARD_FROM`, `S.SHARD_P`). They wait in "Claim mining rewards", then live in the bag.
- **Offline earnings** now include $MINE, items, crates and shards (cash/loot at 50%); the Welcome-back popup lists everything.
- **Daily reward**: 7-day streak calendar, days 1-6 give coins/items/crates, day 7 gives $MINE. Missing a day restarts the week. Reset at 00:00 UTC.
- **Quests**: 4 daily quests (+ perfect-day bonus) and 8 seasonal quests (30 days). Rewards are coins, crates, boosts or $MINE.
- **Referrals**: `?ref=CODE` link; the referrer gets 25% (`REF_RATE`) of every pack the referred player buys, paid as $MINE. Referral leaderboard in Ranks → Referrals.
- **Durability**: gear at 0% is unusable (no stats, can't be equipped); anything above 0% works at full strength.
- The "24 h without withdrawing" quest is already complete for new players until their first withdrawal.
- Events tab: placeholder ("coming soon").
- See `GAME_DESIGN.md` for the full description meant to be given to an AI assistant.
- Withdrawals: 20% fee, max 250k per withdrawal (gross), 24 h cooldown.
- Settings: sound/music, change username, log out, reset progress, delete account (wallet accounts holding $MINE can't be deleted).
- Bank: deposit/withdraw $MINE. SOL pack purchases go directly to `MERCHANT_WALLET`.

## Security notes
- Web3 code uses only the official `@solana/web3.js`, `@solana/spl-token`, `tweetnacl`, `bs58`.
- Deposits are credited only after the server reads the confirmed transaction: treasury balance delta **and** the player's own balance loss; each signature can be claimed once (atomic).
- Withdrawals are signed server-side, recorded before broadcast, refunded exactly once only after the blockhash has expired.
- Tokens are stored hashed, rate limits per IP/account, strict CSP, 10 KB body limit, static-file whitelist.

## Honest limits
- Real Solana RPC paths, Postgres and a real wallet on testnet were **not** exercised in the automated tests (a fake chain was used). Test with small amounts on testnet first.
- Before going to mainnet: independent security audit, rotate the treasury key, keep only a small hot balance in the treasury.
