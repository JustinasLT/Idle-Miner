"use strict";
// Sign-in screen (wallet or guest) and the account menu.
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "");
const PACK_NAMES = { 1: "Prospector", 2: "Foreman", 3: "Tycoon" };
const tierName = () => (state.packs[3] ? "Tycoon" : state.packs[2] ? "Foreman" : state.packs[1] ? "Prospector" : "Free");

function showLogin(msg) {
  $("login").hidden = false;
  $("login-msg").textContent = msg || "";
  renderLoginWallets();
}
const hideLogin = () => { $("login").hidden = true; };
function setLoginBusy(text) { $("login-status").textContent = text || ""; $("login-actions").classList.toggle("busy", !!text); }

function renderLoginWallets() {
  const w = Wallet.list();
  $("login-wallets").innerHTML = w.length
    ? w.map((x) => `<button type="button" class="login-btn wallet" data-w="${x.id}">👛 Connect ${x.name}</button>`).join("")
    : `<p class="login-hint">No Solana wallet found in this browser. Install <b>Phantom</b>, <b>Solflare</b> or <b>Backpack</b> (or open this page inside the wallet's own browser on mobile), then reload — or play as a guest.</p>`;
}

// wallet sign-in: ask the server for a one-time message, the wallet signs it, the server checks the signature
async function walletLogin(entry) {
  setLoginBusy("Waiting for your wallet…");
  try {
    const addr = await Wallet.connect(entry);
    const n = await api("POST", "auth/nonce", { wallet: addr });
    const signature = await Wallet.signMessage(n.message);
    setLoginBusy("Checking…");
    const j = await api("POST", "auth/wallet", { wallet: addr, nonce: n.nonce, signature, ref: refCode() });
    setToken(j.token); forgetRef();
    applyView(j);
    enterGame();
    if (j.switched) toast("Welcome back! Loaded the progress saved on this wallet.");
    else if (j.linked) toast("Wallet connected — your progress is now saved on it ✅");
    return true;
  } catch (e) {
    const m = /reject|denied|cancel/i.test(e.message) ? "Sign-in cancelled." : e.message;
    $("login").hidden ? toast(m) : (setLoginBusy(""), ($("login-msg").textContent = m));
    return false;
  } finally { setLoginBusy(""); }
}
async function guestLogin() {
  setLoginBusy("Creating your guest miner…");
  try {
    const j = await api("POST", "guest", { ref: refCode() });
    setToken(j.token); forgetRef(); applyView(j); enterGame();
  } catch (e) { setLoginBusy(""); $("login-msg").textContent = e.message; }
  setLoginBusy("");
}
let started = false;
function enterGame() {
  hideLogin(); closeModal();
  if (!started) { started = true; startNet(); }
  renderHUD(); renderAccountChip();
}

// first thing on page load: use a saved session if there is one
async function bootSession() {
  $("login").hidden = false;
  $("boot-msg").textContent = "Connecting to the server… (the free host can need up to a minute to wake up)";
  const slow = setTimeout(() => ($("boot-msg").textContent = "Still waking the server up — hang on…"), 8000);
  let ok = false;
  for (let attempt = 0; attempt < 12 && !ok; attempt++) {
    try { net.config = await api("GET", "config"); ok = true; } catch { await new Promise((r) => setTimeout(r, 4000)); }
  }
  clearTimeout(slow);
  $("boot-msg").textContent = "";
  if (!ok) { $("boot-msg").textContent = "Can't reach the game server. Reload to try again."; return; }
  if (net.token) {
    try { const j = await api("GET", "me"); applyView(j); enterGame(); return; }
    catch (e) { if (e.status !== 401) { $("login-msg").textContent = "Server error: " + e.message; } }
  }
  showLogin();
}

// ---- settings button (the menu itself is in settings.js) -----------------------------------------------------------------------------------------
function renderAccountChip() {
  const b = $("btn-settings");
  if (!b) return;
  b.textContent = "⚙️";
  b.title = "Settings";
}
async function doLogout() {
  try { await api("POST", "logout", {}); } catch { /* */ }
  setToken(null); net.info = null; net.online = false; net.accountId = null; offlineShown = false;
  closeModal(); showLogin();
}
function setupLogin() {
  $("login-wallets").addEventListener("click", (e) => { const b = e.target.closest("[data-w]"); if (b) { const en = Wallet.list().find((x) => x.id === b.dataset.w); if (en) walletLogin(en); } });
  $("btn-guest").onclick = guestLogin;
  $("btn-settings").onclick = openSettings;
}
