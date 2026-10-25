"use strict";
// Talks to the multiplayer server. The server owns accounts, the $MINE balance, mining payouts and the leaderboard.
// Open the game through the server (http://localhost:3000) or add ?api=https://your-server to the URL.
const API_BASE = (new URLSearchParams(location.search).get("api") || window.IDLE_API || (location.protocol === "file:" ? "http://localhost:3000" : "")).replace(/\/$/, "");
const AUTH_KEY = "idleMiner_auth_v1";
const net = { info: null, online: false, error: "", offset: 0, token: null, busy: false };
try { net.token = localStorage.getItem(AUTH_KEY); } catch { /* storage blocked */ }

async function api(method, path, body) {
  const h = { "Content-Type": "application/json" };
  if (net.token) h.Authorization = "Bearer " + net.token;
  const r = await fetch(API_BASE + "/api/" + path, { method, headers: h, body: method === "POST" ? JSON.stringify(body || {}) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { net.token = null; try { localStorage.removeItem(AUTH_KEY); } catch { /* */ } }
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}
function applyInfo(j) {
  if (!j || j.balance == null) return;
  net.info = j; net.online = true; net.error = "";
  net.offset = j.season.now - Date.now();
  state.token = j.balance;
  state.name = j.name;
  if (j.pages > state.invPages) state.invPages = Math.min(MAX_PAGES, j.pages);
}
async function netSync() {
  if (net.busy) return;
  net.busy = true;
  try {
    if (!net.token) {
      const j = await api("POST", "register", { name: state.name });
      net.token = j.token; try { localStorage.setItem(AUTH_KEY, j.token); } catch { /* */ }
    }
    const first = !net.info;
    const j = await api("POST", "sync", { level: state.hero.lvl, power: heroPower(), items: state.season.items });
    if (first && state.lastBalance != null && j.balance - state.lastBalance > 0.01 && (Date.now() - state.lastSave) > 60000) {
      const m = j.balance - state.lastBalance;
      toast("⛏️ Mined " + formatToken(m) + " $MINE while you were away");
      const el = $("offline-mine"); if (el) { el.hidden = false; el.textContent = "+" + formatToken(m) + " $MINE mined"; }
    }
    applyInfo(j);
    state.lastBalance = j.balance;
  } catch (e) { net.online = false; net.error = e.message; }
  net.busy = false;
}
// server-priced $MINE purchases: resolves {ok, error?}
async function netBuy(item, extra) {
  try { const j = await api("POST", "buy", { item, ...extra }); applyInfo(j); state.lastBalance = state.token; return j; }
  catch (e) { return { ok: false, error: net.online ? e.message : "Server offline — can't spend $MINE right now" }; }
}
async function netRename(name) { const j = await api("POST", "rename", { name }); applyInfo(j); return j; }
async function netClaim() { const j = await api("POST", "claim", {}); applyInfo(j); return j; }
const netBoard = () => api("GET", "leaderboard");
function startNet() { netSync(); setInterval(netSync, 15000); }
