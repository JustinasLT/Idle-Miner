"use strict";
// Idle Miner server.   node server/server.js   ->  game + API on http://localhost:3000
// See README.md for the environment variables.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto"), zlib = require("zlib");
const { C, SOL, env, num } = require("./config.js");
const { openStore } = require("./store.js");
const { createChain } = require("./chain.js");
const { createGame, ApiError } = require("./game.js");
const { createBank } = require("./bank.js");

const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
// the page may only load its own files + Google Fonts; no inline scripts; API calls only to itself
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const SEC = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cross-Origin-Opener-Policy": "same-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=()" };

async function createApp(opts = {}) {
  const store = opts.store || await openStore({ file: env.DATA_FILE || path.join(__dirname, "data.json"), databaseUrl: env.DATABASE_URL, ssl: env.DATABASE_SSL === "false" ? false : undefined });
  const game = createGame({ store, now: opts.now });
  await game.load();
  const chain = opts.chain || createChain(SOL);
  const bank = createBank(game, chain);
  const { db, bad } = game;

  // ---- rate limiting (in memory) ------------------------------------------------------------------------
  const buckets = new Map();
  function limit(key, max, windowMs) {
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || t > b.reset) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
    if (++b.n > max) throw new ApiError(429, "Too many requests — slow down");
  }
  const sweep = setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60000); sweep.unref();
  const RATE = num(env.RATE_LIMIT, 300);
  const TRUST_PROXY = env.TRUST_PROXY ? env.TRUST_PROXY !== "0" : !!env.RENDER; // Render sets RENDER=true
  const clientIp = (req) => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";

  // ---- sign in with a Solana wallet: a one-time message that the wallet signs (no transaction, no cost) ------
  const nonces = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of nonces) if (t > v.exp) nonces.delete(k); }, 60000).unref();
  const nacl = opts.nacl || require("tweetnacl"), bs58 = opts.bs58 || require("bs58");
  function walletBytes(w) {
    let b; try { b = bs58.decode(String(w)); } catch { bad("Invalid wallet address"); }
    if (b.length !== 32 || bs58.encode(b) !== w) bad("Invalid wallet address");
    return b;
  }

  const sessionReply = (p, token, extra) => ({ token, ...game.view(p), ...extra });
  const auth = (req) => game.authToken(req.headers.authorization);

  // ---- routes ---------------------------------------------------------------------------------------------------------
  // each handler: (ctx) => object ; ctx = { req, body, p (player or null), ip, host }
  const routes = {
    "GET /api/health": () => ({ ok: true, now: game.now(), store: store.kind }),
    "GET /api/config": () => ({ ...bank.publicConfig(), nonceTtl: 300 }),
    "GET /api/leaderboard": ({ p }) => game.leaderboard(p),

    "POST /api/guest": ({ ip, body }) => {
      limit("guest:" + ip, 20, 3600e3); limit("guest:all", 600, 3600e3);
      const p = game.createPlayer(body.name);
      return sessionReply(p, game.newSession(p), {});
    },
    "POST /api/auth/nonce": ({ ip, body, host }) => {
      limit("nonce:" + ip, 40, 600e3);
      walletBytes(body.wallet);
      const nonce = crypto.randomBytes(16).toString("hex"), t = Date.now();
      const message = `${host} wants you to sign in with your Solana account:\n${body.wallet}\n\nSign in to Idle Miner. This costs nothing and does not give access to your funds.\n\nNonce: ${nonce}\nIssued At: ${new Date(t).toISOString()}`;
      nonces.set(nonce, { wallet: body.wallet, message, exp: t + 300e3 });
      return { nonce, message };
    },
    "POST /api/auth/wallet": async ({ ip, req, body, p: caller }) => {
      limit("wallet:" + ip, 30, 600e3);
      const entry = nonces.get(String(body.nonce));
      nonces.delete(String(body.nonce));                     // one use only
      if (!entry || Date.now() > entry.exp) bad("Sign-in request expired — try again", 401);
      const pub = walletBytes(body.wallet);
      if (entry.wallet !== body.wallet) bad("Wallet mismatch", 401);
      const sig = Buffer.from(String(body.signature || ""), "base64");
      if (sig.length !== 64 || !nacl.sign.detached.verify(Buffer.from(entry.message, "utf8"), new Uint8Array(sig), pub)) bad("Signature check failed", 401);
      const existing = game.findByWallet(body.wallet);
      let p, linked = false, switched = false;
      if (existing) { p = existing; switched = !!caller && caller.id !== existing.id; }
      else if (caller && !caller.wallet) { p = caller; game.linkWallet(p, body.wallet); linked = true; }
      else p = game.createPlayer(body.name, body.wallet);
      game.touchPlayer(p);
      const token = game.newSession(p);
      await game.saveNow([p]);
      return sessionReply(p, token, { linked, switched });
    },
    "POST /api/logout": ({ p, req }) => { game.dropSession(p, req.headers.authorization); return { ok: true }; },

    "POST /api/sync": ({ p }) => { game.touchPlayer(p); return game.view(p); },
    "GET /api/me": ({ p }) => { game.touchPlayer(p); return game.view(p); },
    "POST /api/act": ({ p, body }) => {
      limit("act:" + p.id, 240, 60e3);
      const res = game.act(p, body);
      return { ok: true, ...res, ...game.view(p) };
    },

    "GET /api/bank": ({ p }) => { game.touchPlayer(p); return { ...bank.bankView(p), ...bank.publicConfig() }; },
    "POST /api/bank/deposit/prepare": ({ p, body }) => { limit("bank:" + p.id, 30, 60e3); return bank.prepareDeposit(p, body.amount); },
    "POST /api/bank/deposit/confirm": ({ p, body }) => { limit("bank:" + p.id, 60, 60e3); return bank.confirmDeposit(p, body.signature).then(async (r) => ({ ...r, ...game.view(p) })); },
    "POST /api/bank/withdraw": ({ p, body }) => { limit("bank:" + p.id, 30, 60e3); return bank.requestWithdraw(p, body.amount).then((r) => ({ ...r, ...game.view(p) })); },
    "POST /api/pack/mine": ({ p, body }) => { limit("bank:" + p.id, 30, 60e3); return bank.buyPackWithMine(p, body.pack).then((r) => ({ ...r, ...game.view(p) })); },
    "POST /api/pack/order": ({ p, body }) => { limit("bank:" + p.id, 30, 60e3); return bank.createPackOrder(p, body.pack); },
    "POST /api/pack/confirm": ({ p, body }) => { limit("bank:" + p.id, 60, 60e3); return bank.confirmPackOrder(p, body.order, body.signature).then((r) => ({ ...r, ...game.view(p) })); },
  };
  const PUBLIC = new Set(["GET /api/health", "GET /api/config", "GET /api/leaderboard", "POST /api/guest", "POST /api/auth/nonce", "POST /api/auth/wallet"]);

  // ---- static files (whitelist only: never serve /server, .git, data files...) ------------------------------------
  const VENDOR = [["node_modules", "@solana", "web3.js", "lib", "index.iife.min.js"], ["node_modules", "@solana", "web3.js", "lib", "index.iife.js"]].map((a) => path.join(ROOT, ...a));
  const STATIC_RE = /^\/(index\.html|(css|js)\/[\w.\-]+\.(css|js)|vendor\/solana-web3\.js)$/;
  function serveStatic(req, res) {
    let u; try { u = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400, SEC); return res.end("Bad request"); }
    if (u === "/") u = "/index.html";
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, SEC); return res.end(); }
    if (!STATIC_RE.test(u)) { res.writeHead(404, SEC); return res.end("Not found"); }
    const file = u === "/vendor/solana-web3.js" ? VENDOR.find((f) => fs.existsSync(f)) : path.join(ROOT, u);
    if (!file) { res.writeHead(404, SEC); return res.end("Wallet library not installed — run npm install"); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, SEC); return res.end("Not found"); }
      res.writeHead(200, { ...SEC, "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  }

  function send(req, res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const h = { ...SEC, "Content-Type": "application/json", "Cache-Control": "no-store" };
    if (body.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      zlib.gzip(body, (e, z) => { if (e) { res.writeHead(code, h); res.end(body); } else { res.writeHead(code, { ...h, "Content-Encoding": "gzip" }); res.end(z); } });
    } else { res.writeHead(code, h); res.end(body); }
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (!pathname.startsWith("/api/")) return serveStatic(req, res);
    // no CORS headers on purpose: the API is only for the game page served from this very origin
    const ip = clientIp(req);
    try { limit("ip:" + ip, RATE, 60e3); } catch (e) { return send(req, res, 429, { error: e.message }); }
    const key = req.method + " " + pathname, handler = routes[key];
    if (!handler) return send(req, res, 404, { error: "Unknown endpoint" });
    let raw = "", tooBig = false;
    req.on("data", (c) => { raw += c; if (raw.length > 10000) { tooBig = true; req.destroy(); } });
    req.on("end", async () => {
      if (tooBig) return;
      try {
        let body = {};
        if (raw) { try { body = JSON.parse(raw); } catch { bad("Bad JSON"); } if (body === null || typeof body !== "object" || Array.isArray(body)) bad("Bad JSON"); }
        const p = auth(req);
        if (!p && !PUBLIC.has(key)) bad("Not signed in", 401);
        const host = String(req.headers.host || "localhost").replace(/[^A-Za-z0-9.\-:]/g, "").slice(0, 80);
        send(req, res, 200, await handler({ req, body, p, ip, host }));
      } catch (e) {
        if (e instanceof ApiError) return send(req, res, e.status, { error: e.message, ...(e.extra || {}) });
        console.error(e); send(req, res, 500, { error: "Server error" });
      }
    });
  });

  // ---- background jobs ---------------------------------------------------------------------------------------------
  const timers = [];
  const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => console.error("job failed:", e.message)); }, ms); t.unref(); timers.push(t); };
  async function shutdown() { timers.forEach(clearInterval); try { await game.flush(); await store.close(); } catch (e) { console.error(e); } }
  function start(port) {
    every(5000, () => game.tick());
    every(8000, () => game.flush());
    every(10000, () => bank.processWithdrawals());
    every(3600e3, () => game.prune());
    bank.kick();
    // Render's free plan puts the service to sleep after ~15 min without visitors: ping our own public URL.
    // (An external pinger like UptimeRobot on /api/health works too and can also wake it up after a restart.)
    const selfUrl = env.KEEPALIVE_URL || env.RENDER_EXTERNAL_URL;
    if (selfUrl && env.KEEPALIVE !== "off") every(10 * 60e3, () => fetch(selfUrl.replace(/\/$/, "") + "/api/health").then(() => {}, () => {}));
    return new Promise((r) => server.listen(port, r));
  }
  return { server, game, bank, chain, store, start, shutdown, routes, resetLimits: () => buckets.clear() };
}

if (require.main === module) {
  (async () => {
    const app = await createApp();
    const port = num(env.PORT, 3000);
    await app.start(port);
    const { game, chain } = app;
    console.log(`Idle Miner on http://localhost:${port}  | store: ${app.store.kind} | solana: ${SOL.cluster} | $MINE ${chain.tokenEnabled ? "on" : "OFF (" + chain.missing.join(", ") + ")"} | SOL packs ${chain.payEnabled ? "on" : "OFF"}`);
    if (app.store.kind === "file" && env.RENDER) console.warn("WARNING: running on Render without DATABASE_URL — player data is stored on an ephemeral disk and WILL be lost on restart. Set DATABASE_URL.");
    let closing = false;
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { if (closing) return; closing = true; await app.shutdown(); process.exit(0); });
  })().catch((e) => { console.error("Failed to start:", e); process.exit(1); });
}
module.exports = { createApp };
