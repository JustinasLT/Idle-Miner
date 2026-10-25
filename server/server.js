"use strict";
// Idle Miner multiplayer server — zero dependencies, Node 18+.
//   node server/server.js            -> game + API on http://localhost:3000
// Env: PORT, RATE_LIMIT, TRUST_PROXY, DATA_FILE, SEASON_START (ISO date, first run only), DEV_DAY_OFFSET (days, testing)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const ROOT = path.join(__dirname, "..");
const DEV_OFFSET = (+process.env.DEV_DAY_OFFSET || 0) * 864e5;

// ---- economy (keep in sync with js/config.js) ----------------------------------------
const C = {
  TOTAL_POOL: 100e6, LB_POOL: 10e6, MINING_POOL: 5e6, SEASON_DAYS: 30, FULL_PLAYERS: 100,
  PLAYER_DAILY_CAP: 0.025, LB_SIZE: 100, LB_PRIZE_EXP: 0.85, ACTIVE_DAYS: 3, MAX_PAGES: 5,
};
C.SEASON_MS = C.SEASON_DAYS * 864e5;
C.DAILY = C.MINING_POOL / C.SEASON_DAYS;
const PAGE_COST = [0, 300, 800, 2000, 5000];
const PRICES = { boost_sell: 25, boost_elev: 25, tome: 15, offline2: 5 }; // $MINE shop prices (server decides the price)

const now = () => Date.now() + DEV_OFFSET;

// ---- persistence -------------------------------------------------------------------
let db = { season: null, players: {}, lastTick: 0, nextSeq: 1 }, dirty = false;
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) }; } catch { /* first run */ }
if (!db.season) { db.season = { start: process.env.SEASON_START ? Date.parse(process.env.SEASON_START) : now() }; db.lastTick = now(); dirty = true; }
const seasonEnd = () => db.season.start + C.SEASON_MS;
const over = () => now() >= seasonEnd();
function save() {
  if (!dirty) return;
  dirty = false;
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA_FILE);
}
setInterval(save, 10000).unref();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { save(); process.exit(0); });

// ---- helpers -------------------------------------------------------------------------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (x) => (Number.isFinite(+x) ? +x : 0);
const isActive = (p, t) => p.power > 0 && t - p.lastSeen < C.ACTIVE_DAYS * 864e5;
const cleanName = (s) => String(s || "").replace(/[^A-Za-z0-9 _.\-]/g, "").trim().replace(/\s+/g, " ").slice(0, 16);
function uniqueName(want, selfId) {
  let n = cleanName(want); if (n.length < 2) n = "Miner";
  const taken = (x) => Object.values(db.players).some((p) => p.id !== selfId && p.name.toLowerCase() === x.toLowerCase());
  let out = n, k = 1;
  while (taken(out)) out = n.slice(0, 12) + (++k > 9 ? Math.floor(Math.random() * 9000 + 1000) : k);
  return out;
}
const pointsOf = (p) => Math.floor(p.power + p.level * 20 + p.items * 5 + p.earned * 0.1);
let prizeW = null;
function prizeFor(rank) {
  if (rank < 1 || rank > C.LB_SIZE) return 0;
  if (!prizeW) { prizeW = Array.from({ length: C.LB_SIZE }, (_, i) => 1 / Math.pow(i + 1, C.LB_PRIZE_EXP)); prizeW.sum = prizeW.reduce((a, b) => a + b, 0); }
  return (C.LB_POOL * prizeW[rank - 1]) / prizeW.sum;
}

// ---- anti-cheat: plausibility limits (the game itself still runs in the browser) -----------
// Level can only grow as fast as hero XP can be earned (+ bought tomes); power/items are bounded by level & time.
const xpForLevel = (L) => 60 * (L - 1) + 15 * L * (L - 1);
function maxLevel(p, t) {
  const budget = ((t - p.created) / 1000) * 1.0 + 500 * p.tomes + 300;
  let L = 1; while (L < 100 && xpForLevel(L + 1) <= budget) L++;
  return L;
}
// you start with 3 items and can only equip what you have found: at most (3 + items found) slots of perfect Mythic gear
const maxPower = (L, items) => 50 * L + Math.min(8, 3 + items) * 934 * (1 + 0.03 * (L - 1));
const maxItems = (p, t) => 10 + ((t - p.created) / 36e5) * 150;

// ---- mining emission: every 5s the season's daily pool is split by power share -----------
function tick() {
  const t = now(), upto = Math.min(t, seasonEnd());
  const dt = clamp((upto - db.lastTick) / 1000, 0, 60); // downtime is not paid out
  if (upto > db.lastTick) db.lastTick = upto;
  if (dt <= 0) return;
  const act = Object.values(db.players).filter((p) => isActive(p, upto));
  if (!act.length) return;
  const G = act.reduce((s, p) => s + p.power, 0);
  const pool = (C.DAILY * Math.min(1, act.length / C.FULL_PLAYERS) * dt) / 86400, cap = (C.DAILY * C.PLAYER_DAILY_CAP * dt) / 86400;
  for (const p of act) { const g = Math.min((pool * p.power) / G, cap); p.balance += g; p.earned += g; }
  dirty = true;
}
setInterval(tick, 5000).unref();

// ---- leaderboard (cached 3s) --------------------------------------------------------------
let boardCache = { t: 0, v: null };
function board() {
  if (boardCache.v && Date.now() - boardCache.t < 3000) return boardCache.v;
  const t = now();
  const ranked = Object.values(db.players).filter((p) => p.power > 0).map((p) => ({ p, pts: pointsOf(p) }))
    .sort((a, b) => b.pts - a.pts || a.p.created - b.p.created);
  const rank = new Map(); ranked.forEach((r, i) => rank.set(r.p.id, i + 1));
  const act = ranked.filter((r) => isActive(r.p, Math.min(t, seasonEnd())));
  const v = { ranked, rank, players: act.length, global: act.reduce((s, r) => s + r.p.power, 0), minedAll: Object.values(db.players).reduce((s, p) => s + p.earned, 0) };
  boardCache = { t: Date.now(), v };
  return v;
}
const row = (r, i) => ({ rank: i + 1, name: r.p.name, level: r.p.level, power: Math.round(r.p.power), items: r.p.items, earned: r.p.earned, prize: prizeFor(i + 1), pts: r.pts });
function seasonInfo() { return { start: db.season.start, end: seasonEnd(), now: now(), over: over(), days: C.SEASON_DAYS }; }
function meInfo(p) {
  const b = board(), rank = b.rank.get(p.id) || 0;
  const t = Math.min(now(), seasonEnd());
  const act = isActive(p, t), others = b.global - (act ? p.power : 0), players = b.players + (act ? 0 : 1);
  const global = others + p.power, share = global ? p.power / global : 0;
  const perDay = over() ? 0 : Math.min(C.DAILY * Math.min(1, players / C.FULL_PLAYERS) * share, C.DAILY * C.PLAYER_DAILY_CAP);
  return { id: p.id, name: p.name, balance: p.balance, earned: p.earned, pages: p.pages, claimed: !!p.claimed, rank, prize: rank ? prizeFor(rank) : 0,
    pts: pointsOf(p), myPower: p.power, global, players, perDay, season: seasonInfo(), minedAll: b.minedAll };
}

// ---- API ----------------------------------------------------------------------------------------
const RATE_LIMIT = +process.env.RATE_LIMIT || 240; // requests per minute per IP (set TRUST_PROXY=1 behind a reverse proxy)
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
function auth(req) {
  const m = /^Bearer ([0-9a-f]{12})\.([0-9a-f]{48})$/.exec(req.headers.authorization || "");
  const p = m && db.players[m[1]];
  return p && p.key === sha(m[2]) ? p : null;
}
const routes = {
  "POST /api/register": (req, body) => {
    const id = crypto.randomBytes(6).toString("hex"), secret = crypto.randomBytes(24).toString("hex"), t = now();
    db.players[id] = { id, key: sha(secret), name: uniqueName(body.name), created: t, lastSeen: t, level: 1, power: 0, items: 0, tomes: 0, pages: 1, balance: 0, earned: 0, claimed: false };
    dirty = true; boardCache.v = null;
    return { token: id + "." + secret, ...meInfo(db.players[id]) };
  },
  "POST /api/sync": (req, body, p) => {
    const t = now();
    p.lastSeen = t;
    if (!over()) {
      p.level = clamp(Math.floor(num(body.level)), p.level, maxLevel(p, t)); // level never goes down
      p.items = clamp(Math.floor(num(body.items)), p.items, maxItems(p, t));
      p.power = clamp(Math.round(num(body.power)), 1, maxPower(p.level, p.items));
    }
    dirty = true; boardCache.v = null;
    return meInfo(p);
  },
  "POST /api/buy": (req, body, p) => {
    let cost;
    if (body.item === "page") {
      if (p.pages >= C.MAX_PAGES) return { ok: false, error: "All pages unlocked", ...meInfo(p) };
      cost = PAGE_COST[p.pages];
    } else cost = PRICES[body.item];
    if (cost == null) return { ok: false, error: "Unknown item", ...meInfo(p) };
    if (p.balance < cost) return { ok: false, error: "Not enough $MINE", ...meInfo(p) };
    p.balance -= cost;
    if (body.item === "page") p.pages++;
    if (body.item === "tome") p.tomes++;
    dirty = true;
    return { ok: true, ...meInfo(p) };
  },
  "POST /api/rename": (req, body, p) => {
    const n = cleanName(body.name);
    if (n.length < 2) return { ok: false, error: "Name must be 2-16 letters/numbers", ...meInfo(p) };
    p.name = uniqueName(n, p.id); dirty = true; boardCache.v = null;
    return { ok: true, ...meInfo(p) };
  },
  "POST /api/claim": (req, body, p) => {
    if (!over()) return { ok: false, error: "Season is still running", ...meInfo(p) };
    if (p.claimed) return { ok: false, error: "Already claimed", ...meInfo(p) };
    const rank = board().rank.get(p.id) || 0, prize = prizeFor(rank);
    p.claimed = true; p.balance += prize; p.earned += 0; dirty = true;
    return { ok: true, paid: prize, ...meInfo(p) };
  },
  "GET /api/leaderboard": (req, body, p) => {
    const b = board();
    return { season: seasonInfo(), players: b.players, global: b.global, minedAll: b.minedAll, total: b.ranked.length,
      rows: b.ranked.slice(0, C.LB_SIZE).map(row), me: p ? { ...row({ p, pts: pointsOf(p) }, (b.rank.get(p.id) || b.ranked.length + 1) - 1), name: p.name } : null };
  },
  "GET /api/health": () => ({ ok: true, now: now() }),
};

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(req, res) {
  let u = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (u === "/") u = "/index.html";
  if (!/^\/(index\.html|(css|js)\/[\w.\-]+\.(css|js))$/.test(u)) { res.writeHead(404); return res.end("Not found"); } // never serve /server
  fs.readFile(path.join(ROOT, u), (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(u)] || "application/octet-stream", "Cache-Control": "no-cache" }); res.end(buf);
  });
}
const server = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const path_ = new URL(req.url, "http://x").pathname;
  if (!path_.startsWith("/api/")) return serveStatic(req, res);
  const send = (code, obj) => { res.writeHead(code, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const ip = (process.env.TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress, n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
  if (n > RATE_LIMIT) return send(429, { error: "Too many requests" });
  const handler = routes[req.method + " " + path_];
  if (!handler) return send(404, { error: "Unknown endpoint" });
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 10000) req.destroy(); });
  req.on("end", () => {
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "Bad JSON" }); }
    const p = auth(req);
    if (!p && !["POST /api/register", "GET /api/leaderboard", "GET /api/health"].includes(req.method + " " + path_)) return send(401, { error: "Not signed in" });
    try { send(200, handler(req, body, p)); } catch (e) { console.error(e); send(500, { error: "Server error" }); }
  });
});
if (require.main === module) {
  server.listen(PORT, () => console.log(`Idle Miner server on http://localhost:${PORT}  (season ends ${new Date(seasonEnd()).toISOString()})`));
}
module.exports = { server, tick, db, C };
