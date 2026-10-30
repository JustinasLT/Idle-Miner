"use strict";
// Persistence. Two interchangeable backends:
//   * file     – one JSON file (local development)
//   * postgres – DATABASE_URL (use this on Render: its free disk is wiped on every restart/deploy!)
// save() resolves only once the data is durable. save(..., claim) additionally records a blockchain
// signature as "used" in the SAME atomic write and returns false (writing nothing) if it was already used.
// save(players, meta, claim, extra): `extra` = { trades: [...], ledger: [...] } are append-only rows (trade history, treasury ledger) written in the
// SAME atomic step. The pool state itself lives in meta.pool with a version number `v` that only ever goes up: a write carrying an OLDER pool
// version than the stored one (a stale process) is refused with an error, so two writers can never both build on stale reserves.
const fs = require("fs");

async function openStore({ file, databaseUrl, ssl }) {
  return databaseUrl ? openPg(databaseUrl, ssl) : openFile(file);
}

const CANDLES_KEEP = 105000;   // 5-minute candles: about a year
// ---------------------------------------------------------------------------------------------
async function openFile(file) {
  let data = { meta: {}, players: {}, sigs: {}, trades: [], ledger: [], candles: {} };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { /* first run */ }
  let chain = Promise.resolve();
  const write = () => {
    const run = () => {
      const tmp = file + ".tmp";
      return fs.promises.writeFile(tmp, JSON.stringify(data)).then(() => fs.promises.rename(tmp, file));
    };
    chain = chain.then(run, run);
    return chain;
  };
  return {
    kind: "file",
    load: async () => ({ meta: data.meta, players: data.players }),
    save: async (players, meta, claim, extra) => {
      const stored = data.meta && data.meta.pool ? data.meta.pool.v : -1;
      if (meta && meta.pool && meta.pool.v < stored) throw new Error("stale pool state: refusing to overwrite pool v" + stored + " with v" + meta.pool.v);
      if (claim) { if (data.sigs[claim.sig]) return false; data.sigs[claim.sig] = claim.info || { at: Date.now() }; }
      for (const p of players) data.players[p.id] = p;
      if (meta) data.meta = meta;
      if (extra && extra.trades && extra.trades.length) data.trades = data.trades.concat(extra.trades).slice(-20000);
      if (extra && extra.ledger && extra.ledger.length) data.ledger = data.ledger.concat(extra.ledger).slice(-50000);
      if (extra && extra.candles && extra.candles.length) {
        for (const c of extra.candles) data.candles[c.t] = c;
        const ks = Object.keys(data.candles); if (ks.length > CANDLES_KEEP) ks.map(Number).sort((a, b) => a - b).slice(0, ks.length - CANDLES_KEEP).forEach((k) => delete data.candles[k]);
      }
      await write();
      return true;
    },
    trades: async (n = 50) => data.trades.slice(-n).reverse(),
    ledger: async (n = 100) => data.ledger.slice(-n).reverse(),
    candles: async () => Object.values(data.candles).sort((a, b) => a.t - b.t),
    allLedger: async () => data.ledger.slice(),
    removePlayers: async (ids) => { ids.forEach((id) => delete data.players[id]); return write(); },
    hasSig: async (sig) => !!data.sigs[sig],
    close: async () => { await chain; },
  };
}

// ---------------------------------------------------------------------------------------------
async function openPg(url, ssl) {
  const { Pool } = require("pg");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, max: 5, ssl: ssl === false || local ? false : { rejectUnauthorized: false } });
  await pool.query(`CREATE TABLE IF NOT EXISTS players (id text PRIMARY KEY, data jsonb NOT NULL, updated timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS meta (k text PRIMARY KEY, v jsonb NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sigs (sig text PRIMARY KEY, data jsonb, at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS trades (id bigserial PRIMARY KEY, pid text, data jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS candles (t bigint PRIMARY KEY, data jsonb NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ledger (id bigserial PRIMARY KEY, kind text, data jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now())`);
  return {
    kind: "postgres",
    load: async () => {
      const players = {};
      for (const r of (await pool.query("SELECT id, data FROM players")).rows) players[r.id] = r.data;
      const m = await pool.query("SELECT v FROM meta WHERE k = 'main'");
      return { meta: m.rows[0] ? m.rows[0].v : {}, players };
    },
    save: async (players, meta, claim, extra) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        if (meta && meta.pool) {  // row lock: concurrent writers queue here, and a stale pool version is refused
          const cur = await c.query("SELECT v FROM meta WHERE k = 'main' FOR UPDATE");
          const stored = cur.rows[0] && cur.rows[0].v && cur.rows[0].v.pool ? cur.rows[0].v.pool.v : -1;
          if (meta.pool.v < stored) throw new Error("stale pool state: refusing to overwrite pool v" + stored + " with v" + meta.pool.v);
        }
        if (claim) {
          const r = await c.query("INSERT INTO sigs (sig, data) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING RETURNING sig", [claim.sig, JSON.stringify(claim.info || {})]);
          if (r.rowCount !== 1) { await c.query("ROLLBACK"); return false; }
        }
        if (players.length) {
          await c.query(
            "INSERT INTO players (id, data) SELECT * FROM unnest($1::text[], $2::jsonb[]) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated = now()",
            [players.map((p) => p.id), players.map((p) => JSON.stringify(p))]);
        }
        if (meta) await c.query("INSERT INTO meta (k, v) VALUES ('main', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(meta)]);
        if (extra && extra.trades && extra.trades.length) await c.query("INSERT INTO trades (pid, data) SELECT * FROM unnest($1::text[], $2::jsonb[])", [extra.trades.map((t) => t.pid), extra.trades.map((t) => JSON.stringify(t))]);
        if (extra && extra.ledger && extra.ledger.length) await c.query("INSERT INTO ledger (kind, data) SELECT * FROM unnest($1::text[], $2::jsonb[])", [extra.ledger.map((t) => t.kind), extra.ledger.map((t) => JSON.stringify(t))]);
        if (extra && extra.candles && extra.candles.length) await c.query("INSERT INTO candles (t, data) SELECT * FROM unnest($1::bigint[], $2::jsonb[]) ON CONFLICT (t) DO UPDATE SET data = EXCLUDED.data", [extra.candles.map((x) => x.t), extra.candles.map((x) => JSON.stringify(x))]);
        await c.query("COMMIT");
        return true;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    },
    trades: async (n = 50) => (await pool.query("SELECT data FROM trades ORDER BY id DESC LIMIT $1", [n])).rows.map((r) => r.data),
    ledger: async (n = 100) => (await pool.query("SELECT data FROM ledger ORDER BY id DESC LIMIT $1", [n])).rows.map((r) => r.data),
    candles: async () => (await pool.query("SELECT data FROM candles ORDER BY t ASC LIMIT $1", [CANDLES_KEEP])).rows.map((r) => r.data),
    allLedger: async () => (await pool.query("SELECT data FROM ledger ORDER BY id ASC")).rows.map((r) => r.data),
    removePlayers: async (ids) => { if (ids.length) await pool.query("DELETE FROM players WHERE id = ANY($1::text[])", [ids]); },
    hasSig: async (sig) => (await pool.query("SELECT 1 FROM sigs WHERE sig = $1", [sig])).rowCount === 1,
    close: async () => { await pool.end(); },
  };
}

module.exports = { openStore };
