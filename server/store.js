"use strict";
// Persistence. Two interchangeable backends:
//   * file     – one JSON file (local development)
//   * postgres – DATABASE_URL (use this on Render: its free disk is wiped on every restart/deploy!)
// save() resolves only once the data is durable. save(..., claim) additionally records a blockchain
// signature as "used" in the SAME atomic write and returns false (writing nothing) if it was already used.
const fs = require("fs");

async function openStore({ file, databaseUrl, ssl }) {
  return databaseUrl ? openPg(databaseUrl, ssl) : openFile(file);
}

// ---------------------------------------------------------------------------------------------
async function openFile(file) {
  let data = { meta: {}, players: {}, sigs: {} };
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
    save: async (players, meta, claim) => {
      if (claim) { if (data.sigs[claim.sig]) return false; data.sigs[claim.sig] = claim.info || { at: Date.now() }; }
      for (const p of players) data.players[p.id] = p;
      if (meta) data.meta = meta;
      await write();
      return true;
    },
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
  return {
    kind: "postgres",
    load: async () => {
      const players = {};
      for (const r of (await pool.query("SELECT id, data FROM players")).rows) players[r.id] = r.data;
      const m = await pool.query("SELECT v FROM meta WHERE k = 'main'");
      return { meta: m.rows[0] ? m.rows[0].v : {}, players };
    },
    save: async (players, meta, claim) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
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
        await c.query("COMMIT");
        return true;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    },
    removePlayers: async (ids) => { if (ids.length) await pool.query("DELETE FROM players WHERE id = ANY($1::text[])", [ids]); },
    hasSig: async (sig) => (await pool.query("SELECT 1 FROM sigs WHERE sig = $1", [sig])).rowCount === 1,
    close: async () => { await pool.end(); },
  };
}

module.exports = { openStore };
