# Idle Mountain Miner — online edition

A server-authoritative idle game. The browser only sends *intents* ("upgrade floor 3"); the server owns every
number (cash, XP, gear, drops, $MINE) and computes it from **its own clock**. Changing your PC clock or
sending crafted requests cannot give you anything.

## Run locally
```
npm install
npm test            # 27 server checks (cheats, rate limits, chain analysis, withdrawals...)
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
| `MINE_PER_SOL` | Price conversion for SOL packs (default 100000 $MINE = 1 SOL). |
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
- Packs (one-time each): Prospector 40k, Foreman 100k, Tycoon 250k $MINE; paying in SOL costs 10% more than $MINE. Free earnings count toward the first pack (e.g. 20k earned + 20k extra).
- Offline earnings are capped at 8 hours.
- Bank: deposit/withdraw $MINE. SOL pack purchases go directly to `MERCHANT_WALLET`.

## Security notes
- Web3 code uses only the official `@solana/web3.js`, `@solana/spl-token`, `tweetnacl`, `bs58`.
- Deposits are credited only after the server reads the confirmed transaction: treasury balance delta **and** the player's own balance loss; each signature can be claimed once (atomic).
- Withdrawals are signed server-side, recorded before broadcast, refunded exactly once only after the blockhash has expired.
- Tokens are stored hashed, rate limits per IP/account, strict CSP, 10 KB body limit, static-file whitelist.

## Honest limits
- Real Solana RPC paths, Postgres and a real wallet on testnet were **not** exercised in the automated tests (a fake chain was used). Test with small amounts on testnet first.
- Before going to mainnet: independent security audit, rotate the treasury key, keep only a small hot balance in the treasury.
