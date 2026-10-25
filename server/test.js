"use strict";
// Self-test: node server/test.js   (starts its own server on a temp data file)
process.env.DATA_FILE = require("path").join(require("os").tmpdir(), "idle-miner-test-" + Date.now() + ".json");
process.env.PORT = 3999; process.env.RATE_LIMIT = 1e6;
const { server, tick, db, C } = require("./server.js");
const assert = require("assert");
const B = "http://localhost:3999/api/";
const call = async (m, p, body, tok) => { const r = await fetch(B + p, { method: m, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: m === "POST" ? JSON.stringify(body || {}) : undefined }); return { s: r.status, j: await r.json() }; };
(async () => {
  await new Promise((r) => server.listen(3999, r));
  // 1) a lone player: tiny emission (only 1/100 of the daily pool), never above the cap
  const a = (await call("POST", "register", { name: "Alice" })).j;
  await call("POST", "sync", { level: 1, power: 300, items: 0 }, a.token);
  db.lastTick = Date.now() - 60000; tick();
  const lone = db.players[a.id].earned;
  console.log("lone player, 60s:", lone.toFixed(5), "$MINE ->", ((lone / 60) * 86400).toFixed(1), "/day");
  assert(lone > 0 && (lone / 60) * 86400 <= C.DAILY * 0.0101, "lone player must get <= 1% of daily emission");
  // 2) cheating attempts are clamped
  let r = (await call("POST", "sync", { level: 100, power: 9e9, items: 1e9 }, a.token)).j;
  console.log("cheat sync ->", { power: r.myPower, level: db.players[a.id].level, items: db.players[a.id].items });
  assert(r.myPower < 20000 && db.players[a.id].level < 5 && db.players[a.id].items < 30);
  await call("POST", "sync", { level: 1, power: 300, items: 0 }, a.token);
  // 3) 150 players: full emission, shares proportional, total never exceeds daily*dt
  const toks = [];
  for (let i = 0; i < 150; i++) { const x = (await call("POST", "register", { name: "P" + i })).j; toks.push(x.token); await call("POST", "sync", { level: 1, power: 200 + i * 10, items: i }, x.token); }
  const before = Object.values(db.players).reduce((s, p) => s + p.earned, 0);
  db.lastTick = Date.now() - 60000; tick();
  const paid = Object.values(db.players).reduce((s, p) => s + p.earned, 0) - before;
  console.log("151 players, 60s paid:", paid.toFixed(3), "expected <=", ((C.DAILY * 60) / 86400).toFixed(3));
  assert(paid <= (C.DAILY * 60) / 86400 + 1e-9 && paid > 0.9 * (C.DAILY * 60) / 86400);
  // 4) names unique, spending is server priced
  assert((await call("POST", "register", { name: "alice" })).j.name !== "alice");
  db.players[a.id].balance = 1000;
  let b = (await call("POST", "buy", { item: "page" }, a.token)).j; assert(b.ok && b.pages === 2 && Math.round(b.balance) === 700, "page 2 costs 300");
  b = (await call("POST", "buy", { item: "tome" }, a.token)).j; assert(b.ok && Math.round(b.balance) === 685);
  b = (await call("POST", "buy", { item: "page" }, a.token)).j; assert(!b.ok && b.error === "Not enough $MINE", "page 3 costs 800, only 685 left");
  assert((await call("POST", "buy", { item: "free_money" }, a.token)).j.ok === false);
  assert((await call("POST", "sync", {}, "bad.token")).s === 401);
  // 5) leaderboard + season end + claim
  const lb = (await call("GET", "leaderboard", null, a.token)).j;
  console.log("leaderboard rows:", lb.rows.length, "top:", lb.rows[0].name, lb.rows[0].pts, "prize", Math.round(lb.rows[0].prize), "| me rank", lb.me.rank);
  assert(lb.rows.length === 100 && Math.abs(lb.rows.reduce((s, r) => s + r.prize, 0) - C.LB_POOL) < 1);
  assert((await call("POST", "claim", {}, a.token)).j.ok === false, "can't claim during season");
  db.season.start -= 31 * 864e5; db.lastTick = Date.now() - 1000; tick();
  const top = lb.rows[0].name, topTok = toks[Number(top.slice(1))];
  const c = (await call("POST", "claim", {}, topTok)).j;
  console.log("after season end:", top, "claimed", Math.round(c.paid || 0), "$MINE; second claim:", (await call("POST", "claim", {}, topTok)).j.error);
  assert(c.ok && c.paid > 1e6 && (await call("POST", "claim", {}, topTok)).j.ok === false);
  const mined = Object.values(db.players).reduce((s, p) => s + p.earned, 0);
  assert(mined <= C.MINING_POOL, "mining never exceeds the 5M pool");
  console.log("ALL OK");
  server.close(); process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
