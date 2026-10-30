"use strict";
// Admin area: its own login (ADMIN_TOKEN, never a player token), short-lived sessions, its own rate limits, and an append-only audit log.
// Everything here is read-mostly; the money decisions (withdrawals, referral payouts) are made by the functions in bank.js / game.js, which are
// idempotent. Routes live under /api/admin/*; the page itself is /admin (admin.html + js/admin.js + css/admin.css, no inline scripts).
//
// PRIVACY: the risk flags use salted hashes of IP addresses (HMAC-SHA256 with a random per-installation salt, 16 hex chars), the last 5 per player,
// kept 30 days and deleted with the account. No raw IP addresses and no browser fingerprints are stored.
const crypto = require("crypto");

function createAdmin({ game, bank, store, chain, env, SOL, limit, ApiError, C }) {
  const { db, bad } = game;
  const token = () => String(env.ADMIN_TOKEN || env.ADMIN_KEY || "");
  const enabled = () => token().length >= 16;
  const sha = (x) => crypto.createHash("sha256").update(String(x || "")).digest();
  const sessions = new Map();                                   // session id -> { exp, hardExp, ip }
  const IDLE = 30 * 60e3, HARD = 8 * 3600e3;
  setInterval(() => { const t = Date.now(); for (const [k, s] of sessions) if (t > s.exp || t > s.hardExp) sessions.delete(k); }, 60e3).unref();
  const ipHash = (ip) => crypto.createHmac("sha256", db.admin.salt).update(String(ip)).digest("hex").slice(0, 16);

  function needAdmin(ctx) {
    if (!enabled()) throw new ApiError(404, "Unknown endpoint");
    const sid = String(ctx.req.headers["x-admin-session"] || "");
    const s = sessions.get(sid), t = Date.now();
    if (!s || t > s.exp || t > s.hardExp) { sessions.delete(sid); throw new ApiError(401, "Admin sign-in required"); }
    s.exp = Math.min(s.hardExp, t + IDLE);
    limit("adminapi:" + sid.slice(0, 16), 240, 60e3);
    return "admin";
  }
  const stampOf = (x) => (x == null ? null : x);
  const short = (id) => (id ? String(id).slice(0, 6) : "");
  const pubPlayer = (p) => ({ id: p.id, name: p.name, wallet: p.wallet || null, guest: !p.wallet, created: p.created, lastSeen: p.lastSeen, pack: game.isPaid(p), tags: game.tagsOf(p), solBalance: p.solBalance, balance: p.balance, referredBy: p.referredBy, tier: p.tierMax });

  // ---- risk flags ---------------------------------------------------------------------------------------------------
  async function riskContext() {
    const players = Object.values(db.players), byId = db.players;
    const ipMap = new Map();
    for (const p of players) for (const x of p.ips || []) { if (!ipMap.has(x.h)) ipMap.set(x.h, new Set()); ipMap.get(x.h).add(p.id); }
    const wdWallet = new Map();
    for (const w of Object.values(db.withdrawals)) if (w.unit === "lamports" && w.wallet) { if (!wdWallet.has(w.wallet)) wdWallet.set(w.wallet, new Set()); wdWallet.get(w.wallet).add(w.pid); }
    const trades = await store.trades(5000), byPid = new Map();
    for (const tr of trades) { if (!byPid.has(tr.pid)) byPid.set(tr.pid, []); byPid.get(tr.pid).push(tr); }
    for (const a of byPid.values()) a.sort((x, y) => x.t - y.t);
    return { players, byId, ipMap, wdWallet, byPid, trades };
  }
  function flagsFor(p, R) {
    const out = [], name = (id) => (R.byId[id] ? R.byId[id].name : short(id));
    const sharedWith = new Set();
    for (const x of p.ips || []) for (const id of R.ipMap.get(x.h) || []) if (id !== p.id) sharedWith.add(id);
    if (sharedWith.size) out.push({ k: "shared_ip", sev: sharedWith.size >= 3 ? 3 : 2, text: "Shares an IP address with " + [...sharedWith].slice(0, 5).map(name).join(", ") + (sharedWith.size > 5 ? " …" : "") });
    for (const [wal, ids] of R.wdWallet) if (ids.has(p.id) && ids.size > 1) out.push({ k: "shared_withdraw_wallet", sev: 3, text: "Withdraws to a wallet also used by " + [...ids].filter((i) => i !== p.id).map(name).join(", ") });
    // rapid buy/sell loop: 4+ side changes within 10 minutes in the last 24 h
    const tr = (R.byPid.get(p.id) || []).filter((x) => x.t > game.now() - 864e5);
    let best = 0; for (let i = 0; i < tr.length; i++) { let sw = 0; for (let j = i + 1; j < tr.length && tr[j].t - tr[i].t <= 600e3; j++) if (tr[j].side !== tr[j - 1].side) sw++; best = Math.max(best, sw); }
    if (best >= 4) out.push({ k: "rapid_loop", sev: 2, text: "Rapid buy/sell loop: " + best + " side changes within 10 minutes" });
    // referral rewards sold right after receipt
    for (const e of (game.db.refEntries ? Object.values(db.refEntries) : [])) {
      if (e.rid !== p.id || e.status !== "paid" || game.now() - e.paidAt > 7 * 864e5) continue;
      const sold = (R.byPid.get(p.id) || []).filter((x) => x.side === "sell" && x.t >= e.paidAt && x.t <= e.paidAt + 6 * 3600e3).reduce((a, x) => a + x.lamports, 0);
      if (sold >= e.amount * 0.5) { out.push({ k: "ref_sold_fast", sev: 2, text: "Sold referral rewards within 6 h of payout (batch " + e.batch + ")" }); break; }
    }
    // many referred accounts from one cluster
    const kids = R.players.filter((o) => o.referredBy === p.id);
    if (kids.length >= 3) {
      const seen = new Map(); for (const k of kids) for (const x of k.ips || []) seen.set(x.h, (seen.get(x.h) || 0) + 1);
      const mine = new Set((p.ips || []).map((x) => x.h)), cluster = kids.filter((k) => (k.ips || []).some((x) => seen.get(x.h) > 1 || mine.has(x.h))).length;
      if (cluster >= 2) out.push({ k: "ref_cluster", sev: 3, text: cluster + " of " + kids.length + " referred accounts share an IP with each other or with the referrer" });
    }
    const m = db.admin.flags[p.id]; if (m) out.push({ k: "manual", sev: 2, text: "Admin note: " + m.note });
    return out;
  }
  const worst = (f) => f.reduce((a, x) => Math.max(a, x.sev), 0);

  // ---- views --------------------------------------------------------------------------------------------------------
  async function overview() {
    const sv = game.solvency(), pv = game.poolView("24h"), t = game.now(), rows = await store.ledger(100000);
    const sum = (kind, since, f = (r) => r.lamports) => rows.filter((r) => r.kind === kind && r.t >= t - since).reduce((a, r) => a + (Number(f(r)) || 0), 0);
    const flows = {};
    for (const [label, since] of [["24h", 864e5], ["7d", 7 * 864e5]]) flows[label] = { inflow: sum("deposit", since), outflow: sum("withdraw", since, (r) => r.net), packRevenue: sum("pack", since), referralPaid: sum("referral", since), referralAccrued: sum("referral_accrued", since) };
    const wd = Object.values(db.withdrawals).filter((w) => w.unit === "lamports"), pend = wd.filter((w) => w.state === "pending"), failed = wd.filter((w) => w.state === "failed");
    const ref = Object.values(db.refEntries), accrued = ref.filter((e) => e.status === "accrued");
    let onchain = null; if (chain.treasuryBalance) { try { onchain = String(await chain.treasuryBalance()); } catch (e) { onchain = "error: " + e.message; } }
    return {
      now: t, cluster: SOL.cluster, treasuryAddress: chain.treasury || null, onchainLamports: onchain, solvency: sv,
      pending: { count: pend.length, lamports: pend.reduce((a, w) => a + w.amount, 0), failed: failed.length, failedLamports: failed.reduce((a, w) => a + w.amount, 0) },
      pool: { price: pv.price, change24h: pv.change24h, solReserve: pv.solReserve, tokenReserve: pv.tokenReserve, circulating: pv.circulating, feeSol: db.pool.feeSol, feeTok: db.pool.feeTok },
      flows, referral: { paidTotal: db.treasury.referralPaid, packRevenue: db.treasury.packRevenue, costPct: db.treasury.packRevenue ? (db.treasury.referralPaid / db.treasury.packRevenue) * 100 : 0, accruedCount: accrued.length, accruedLamports: accrued.reduce((a, e) => a + e.amount, 0), accruedUnbacked: accrued.filter((e) => !e.real).reduce((a, e) => a + e.amount, 0) },
      players: Object.keys(db.players).length, admin: { sessions: sessions.size },
    };
  }
  async function withdrawals(status) {
    const R = await riskContext();
    let list = Object.values(db.withdrawals).filter((w) => w.unit === "lamports");
    if (status && status !== "all") list = list.filter((w) => bank.statusOf(w) === status);
    list.sort((a, b) => (a.state === "pending" ? 0 : 1) - (b.state === "pending" ? 0 : 1) || b.created - a.created);
    return list.slice(0, 200).map((w) => {
      const p = db.players[w.pid], hist = Object.values(db.withdrawals).filter((x) => x.pid === w.pid && x.unit === "lamports" && x.id !== w.id).sort((a, b) => b.created - a.created).slice(0, 8)
        .map((x) => ({ id: x.id, amount: x.amount, status: bank.statusOf(x), created: x.created, reason: x.reason || null }));
      const flags = p ? flagsFor(p, R) : [];
      return { id: w.id, status: bank.statusOf(w), state: w.state, amount: w.amount, fee: w.fee, net: w.net, wallet: w.wallet, created: w.created, sig: w.sig || null, reason: w.reason || null, error: w.error || null,
        player: p ? { ...pubPlayer(p), deposited: p.tradeStats.depositedLamports, sold: p.tradeStats.sold, bought: p.tradeStats.bought } : null, history: hist, flags, risk: worst(flags) };
    });
  }
  async function referralBatch() {
    const R = await riskContext(), cur = game.weekKey(game.now()), by = new Map();
    for (const e of Object.values(db.refEntries)) {
      if (e.status !== "accrued") continue;
      if (!by.has(e.rid)) by.set(e.rid, []); by.get(e.rid).push(e);
    }
    const groups = [...by.entries()].map(([rid, es]) => {
      const p = db.players[rid], flags = p ? flagsFor(p, R) : [];
      const kids = Object.values(db.players).filter((o) => o.referredBy === rid).map((o) => ({ name: o.name, pack: game.isPaid(o), flags: flagsFor(o, R).length }));
      return { referrer: p ? pubPlayer(p) : { id: rid, name: "(deleted)" }, tier: p ? game.tierFor(p.refQual.length).tier : 1, qualifying: p ? p.refQual.length : 0, referred: kids.length, referredList: kids.slice(0, 12),
        total: es.reduce((a, e) => a + e.amount, 0), backed: es.filter((e) => e.real).reduce((a, e) => a + e.amount, 0), unbacked: es.filter((e) => !e.real).reduce((a, e) => a + e.amount, 0),
        entries: es.sort((a, b) => a.t - b.t).map((e) => ({ id: e.id, t: e.t, week: e.week, kind: e.kind, cur: e.cur, spend: e.spend, tier: e.tier, bps: e.bps, amount: e.amount, real: e.real, buyer: db.players[e.bid] ? db.players[e.bid].name : "(deleted)" })),
        flags, risk: worst(flags) };
    }).sort((a, b) => b.risk - a.risk || b.total - a.total);
    const paid = Object.values(db.refEntries).filter((e) => e.status === "paid").sort((a, b) => b.paidAt - a.paidAt).slice(0, 30).map((e) => ({ id: e.id, batch: e.batch, amount: e.amount, as: e.paidAs, paidAt: e.paidAt, referrer: db.players[e.rid] ? db.players[e.rid].name : "(deleted)" }));
    return { currentWeek: cur, nextPayoutAt: game.nextPayoutAt(game.now()), available: db.treasury.packRevenue - db.treasury.referralPaid, groups, recentPaid: paid };
  }
  async function players(q) {
    const R = await riskContext(), s = String(q || "").trim().toLowerCase();
    let list = R.players;
    if (s) list = list.filter((p) => p.name.toLowerCase().includes(s) || p.id.startsWith(s) || (p.wallet || "").toLowerCase().includes(s) || (p.refCode || "").toLowerCase() === s);
    return list.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 60).map((p) => { const f = flagsFor(p, R); return { ...pubPlayer(p), flags: f.length, risk: worst(f) }; });
  }
  async function player(id) {
    const p = db.players[String(id)]; if (!p) bad("Unknown player", 404);
    const R = await riskContext(), trades = (R.byPid.get(p.id) || []).slice(-60).reverse();
    const entries = (Object.values(db.refEntries)).filter((e) => e.rid === p.id || e.bid === p.id).sort((a, b) => b.t - a.t).slice(0, 40);
    return { player: pubPlayer(p), stats: { ...p.tradeStats, earned: p.earned, hero: p.hero.lvl, power: p.power, packs: p.packs, items: p.items, refQualifying: p.refQual.length, referred: Object.values(db.players).filter((o) => o.referredBy === p.id).map((o) => o.name).slice(0, 30), ogExcluded: db.admin.ogExcluded.includes(p.id) },
      flags: flagsFor(p, R), trades, entries, withdrawals: Object.values(db.withdrawals).filter((w) => w.pid === p.id).sort((a, b) => b.created - a.created).slice(0, 15).map((w) => ({ id: w.id, unit: w.unit, amount: w.amount, status: w.unit === "lamports" ? bank.statusOf(w) : w.state, created: w.created, reason: w.reason || null })) };
  }
  async function tradesView() {
    const R = await riskContext(), t = game.now(), all = R.trades.slice().sort((a, b) => b.t - a.t);
    const top = (since) => { const m = new Map(); for (const x of all) if (x.side === "sell" && x.t >= t - since) m.set(x.pid, (m.get(x.pid) || 0) + x.lamports); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pid, lam]) => ({ id: pid, name: db.players[pid] ? db.players[pid].name : short(pid), lamports: lam })); };
    const suspicious = []; for (const p of R.players) { const f = flagsFor(p, R).filter((x) => x.k === "rapid_loop" || x.k === "ref_sold_fast"); if (f.length) suspicious.push({ id: p.id, name: p.name, flags: f }); }
    return { recent: all.slice(0, 100).map((x) => ({ t: x.t, name: x.name, pid: x.pid, side: x.side, lamports: x.lamports, micro: x.micro, price: x.price })), topSellers24h: top(864e5), topSellers7d: top(7 * 864e5), suspicious };
  }
  async function auditView(n) { return { rows: (await store.ledger(Math.min(5000, n * 20 || 2000))).filter((r) => r.kind === "audit").slice(0, n || 200) }; }

  const idOf = (b) => String((b && b.id) || "");
  const ids = (b) => { const a = Array.isArray(b && b.ids) ? b.ids.map(String).slice(0, 5000) : null; if (!a) bad("ids required"); return a; };
  const flush = (ps) => game.saveNow((ps || []).filter(Boolean));

  const routes = {
    "POST /api/admin/login": async (ctx) => {
      if (!enabled()) throw new ApiError(404, "Unknown endpoint");
      limit("adminlogin:" + ctx.ip, 6, 600e3); limit("adminlogin:all", 40, 600e3);
      const ok = crypto.timingSafeEqual(sha(ctx.body.token), sha(token()));
      if (!ok) { game.audit("anonymous", "admin.login_failed", { ip: ipHash(ctx.ip) }); await flush([]); throw new ApiError(403, "Wrong token"); }
      const sid = crypto.randomBytes(32).toString("hex"), t = Date.now();
      sessions.set(sid, { exp: t + IDLE, hardExp: t + HARD, ip: ctx.ip });
      game.audit("admin", "admin.login", { ip: ipHash(ctx.ip) }); await flush([]);
      return { session: sid, idleMs: IDLE };
    },
    "POST /api/admin/logout": async (ctx) => { needAdmin(ctx); sessions.delete(String(ctx.req.headers["x-admin-session"])); game.audit("admin", "admin.logout", {}); await flush([]); return { ok: true }; },
    "GET /api/admin/me": (ctx) => { needAdmin(ctx); return { ok: true, cluster: SOL.cluster }; },
    "GET /api/admin/overview": async (ctx) => { needAdmin(ctx); return overview(); },
    "GET /api/admin/withdrawals": async (ctx) => { needAdmin(ctx); return { rows: await withdrawals(ctx.q.get("status") || "pending"), min: SOL.minWithdrawLamports, max: SOL.maxWithdrawLamports }; },
    "POST /api/admin/withdrawal/approve": async (ctx) => { const a = needAdmin(ctx); return bank.adminApprove(idOf(ctx.body), a); },
    "POST /api/admin/withdrawal/reject": async (ctx) => { const a = needAdmin(ctx); return bank.adminReject(idOf(ctx.body), ctx.body.reason, a); },
    "POST /api/admin/withdrawal/retry": async (ctx) => { const a = needAdmin(ctx); return bank.adminRetry(idOf(ctx.body), a); },
    "POST /api/admin/withdrawal/refund": async (ctx) => { const a = needAdmin(ctx); return bank.adminRefund(idOf(ctx.body), ctx.body.reason, a); },
    "GET /api/admin/referrals": async (ctx) => { needAdmin(ctx); return referralBatch(); },
    "POST /api/admin/referrals/payout": async (ctx) => {
      const a = needAdmin(ctx), r = game.refPayout(ids(ctx.body), a);
      await flush(r.players); return { batch: r.batch, paid: r.paid, realLamports: r.realLamports };
    },
    "POST /api/admin/referrals/reject": async (ctx) => { const a = needAdmin(ctx), r = game.refReject(ids(ctx.body), ctx.body.reason, a); await flush([]); return r; },
    "GET /api/admin/players": async (ctx) => { needAdmin(ctx); return { rows: await players(ctx.q.get("q")) }; },
    "GET /api/admin/player": async (ctx) => { needAdmin(ctx); return player(ctx.q.get("id")); },
    "POST /api/admin/player/flag": async (ctx) => {
      const a = needAdmin(ctx), p = db.players[idOf(ctx.body)]; if (!p) bad("Unknown player", 404);
      const note = String(ctx.body.note || "").trim().slice(0, 200);
      if (note) db.admin.flags[p.id] = { note, t: game.now() }; else delete db.admin.flags[p.id];
      game.audit(a, note ? "player.flag" : "player.unflag", { player: p.id, note }); await flush([]); return { ok: true };
    },
    "POST /api/admin/player/og": async (ctx) => { const a = needAdmin(ctx), r = game.setOGExcluded(idOf(ctx.body), !!ctx.body.exclude, a); await flush([db.players[idOf(ctx.body)]]); return r; },
    "GET /api/admin/trades": async (ctx) => { needAdmin(ctx); return tradesView(); },
    "GET /api/admin/audit": async (ctx) => { needAdmin(ctx); return auditView(Math.min(500, +ctx.q.get("n") || 200)); },
  };
  const publicKeys = Object.keys(routes);
  return { routes, publicKeys, enabled, ipHash, sessions };
}

module.exports = { createAdmin };
