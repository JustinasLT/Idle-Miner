# Idle Mountain Miner — multiplayer

## Run it
Needs Node 18+ (no npm install).

    cd "Idle Miner\files"
    node server/server.js

Open http://localhost:3000 — the server serves the game and the API. Open it in two browsers to see two players on one leaderboard.
`node server/test.js` runs the economy self-test.

## Go public
Deploy the `files` folder to any Node host (Render, Railway, Fly.io, a VPS) with `node server/server.js` as the start command,
and keep `server/data.json` on a persistent disk (or set DATA_FILE). Behind a proxy set TRUST_PROXY=1.
If the game is hosted separately from the server, open it with `?api=https://your-server`.

Env: PORT, DATA_FILE, SEASON_START (ISO date, first run only), RATE_LIMIT, TRUST_PROXY, DEV_DAY_OFFSET (testing: skip N days).

## What the server owns
- Accounts (id + secret in the browser's localStorage — clearing site data loses the account)
- The $MINE balance. Mining is paid every 5 s to all active players (synced within 3 days), also while offline
- Prices for every $MINE purchase (pages, boosts, tome, offline x2), the leaderboard, season clock, prize claim

## Anti-cheat — honest limits
The game simulation still runs in the browser, so the server can only sanity-check what it is told: level can't
outgrow possible XP, items are rate-limited, power is capped by level/items found. A determined cheater can still
inflate stats inside those limits. Real protection needs the server to simulate the mines (a larger rewrite).
