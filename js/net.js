"use strict";
// Talks to the game server. The server is the ONLY authority: this file sends intents ("upgrade floor 3")
// and mirrors the answer into `state`. Same origin only (no ?api= override: that would let a crafted link
// send your session to someone else's server).
const AUTH_KEY = "idleMiner_auth_v2";
const net = { info: null, online: false, error: "", offset: 0, token: null, busy: false, config: null, cashBase: 0, cashRate: 0, cashAt: 0, queue: Promise.resolve(), accountId: null };
try { net.token = localStorage.getItem(AUTH_KEY); } catch { /* storage blocked */ }
const setToken = (t) => { net.token = t || null; try { t ? localStorage.setItem(AUTH_KEY, t) : localStorage.removeItem(AUTH_KEY); } catch { /* */ } };

async function api(method, path, body) {
  const h = { "Content-Type": "application/json" };
  if (net.token) h.Authorization = "Bearer " + net.token;
  const r = await fetch("/api/" + path, { method, headers: h, body: method === "POST" ? JSON.stringify(body || {}) : undefined, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && net.token && !/^auth\//.test(path)) { setToken(null); net.info = null; showLogin("Your session ended — please sign in again."); }
  if (!r.ok) { const e = new Error(j.error || "HTTP " + r.status); e.status = r.status; throw e; }
  return j;
}

// ---- mirror the server's answer into the local state ----------------------------------------------------
function applyView(j) {
  if (!j || j.cash == null) return;
  const firstOfAccount = net.accountId !== j.id, prevLvl = state.hero.lvl;
  net.accountId = j.id;
  net.info = j; net.online = true; net.error = "";
  net.offset = j.serverNow - Date.now();
  state.cash = j.cash; net.cashBase = j.cash; net.cashRate = j.cashPerSec; net.cashAt = performance.now();
  state.token = j.balance;
  state.name = j.name; state.stats.totalEarned = j.totalEarned;
  const old = state.mines.start, m = j.mine;
  state.mines.start = {
    prestigeMult: m.prestigeMult, warehouse: m.warehouse, elevator: m.elevator, unlockedShaftCount: m.unlockedShaftCount, pile: old.pile || { u: 0, v: 0 },
    shafts: m.shafts.map((s, i) => ({ level: s.level, stock: (old.shafts[i] && old.shafts[i].stock) || 0 })),
  };
  state.boosts = j.boosts; state.hero = j.hero; state.inv = j.inv; state.eq = j.eq; state.invPages = j.invPages;
  state.season = { items: j.items }; state.packs = j.packs; state.paid = j.paid; state.guest = j.guest; state.wallet = j.wallet;
  state.pendingOffline = j.pendingOffline; state.power = j.power;
  state.pending = j.pending; state.quests = j.quests; state.social = j.social; state.earnBoost = j.earnBoost; state.offline = j.offline; state.devFaucet = j.devFaucet;
  computeFx();
  if (firstOfAccount) { resetSims(); buildShafts(); }
  else if (old.unlockedShaftCount !== m.unlockedShaftCount) buildShafts();
  if (j.events && j.events.length) toast(j.events.slice(-2).join("  ·  "));
  if (!firstOfAccount && state.hero.lvl > prevLvl) Sound.play("levelUp");
  invChanged();
  maybeOfflineModal();
  renderAccountChip();
  renderMineButtons();
  refreshEarnMenu();
}
// cash ticks up smoothly between syncs at the rate the server told us; every answer replaces it with the exact value
function cashTick() { if (net.online) state.cash = net.cashBase + (net.cashRate * (performance.now() - net.cashAt)) / 1000; }

async function netSync() {
  if (net.busy || !net.token) return;
  net.busy = true;
  try {
    const first = !net.info;
    const j = await api("POST", "sync", {});
    applyView(j);
    if (first) awayToast(j);
  } catch (e) { if (e.status !== 401) { net.online = false; net.error = e.message; } }
  net.busy = false;
}
// "while you were away" for $MINE (cosmetic): compare with the balance we saw last time on this device
function awayToast(j) {
  try {
    const k = "idleMiner_bal_" + j.id, was = parseFloat(localStorage.getItem(k));
    if (isFinite(was) && j.balance - was > 0.01) {
      const m = j.balance - was; toast("⛏️ Mined " + formatToken(m) + " $MINE while you were away");
      const el = $("offline-mine"); if (el) { el.hidden = false; el.textContent = "+" + formatToken(m) + " $MINE mined"; }
    }
  } catch { /* */ }
}
const rememberBalance = () => { try { if (net.accountId) localStorage.setItem("idleMiner_bal_" + net.accountId, String(state.token)); } catch { /* */ } };

// one request at a time, in order (so fast tapping can never race itself): resolves {ok, error?, ...view}
function netAct(body) {
  const run = async () => {
    try { const j = await api("POST", "act", body); applyView(j); return j; }
    catch (e) { return { ok: false, error: e.status ? e.message : "Server unreachable — try again" }; }
  };
  net.queue = net.queue.then(run, run);
  return net.queue;
}
async function netPost(path, body) { // bank / pack calls: throws on error
  const j = await api("POST", path, body);
  if (j && j.cash != null) applyView(j);
  return j;
}
const netBoard = () => api("GET", "leaderboard");
const netRename = (name) => netAct({ type: "rename", name });
const netClaim = () => netAct({ type: "claimPrize" });
async function netBuy(item) { return netAct({ type: "buy", item }); }

function startNet() {
  netSync();
  setInterval(netSync, 15000);
  setInterval(rememberBalance, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) netSync(); });
}
