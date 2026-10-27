"use strict";
// Settings menu: sounds, music, username, wallet, log out, reset progress, delete account.
function openSettings() {
  if (!net.info) return;
  const wallets = Wallet.list();
  const account = state.guest
    ? `<p class="small">You are playing as a <b>guest</b>. Connect a Solana wallet to save your progress on it, buy packs and withdraw $MINE.</p>
       ${wallets.length ? wallets.map((x) => `<button type="button" class="login-btn wallet" data-w="${x.id}">👛 Connect ${x.name}</button>`).join("") : `<p class="small dim">No wallet detected in this browser.</p>`}`
    : `<p class="small">Wallet <b class="mono">${short(state.wallet)}</b> · your progress is saved on it.</p>`;
  const tgl = (k, icon, label) => `<button type="button" class="tgl${Sound.prefs[k] ? " on" : ""}" data-snd="${k}"><span>${icon} ${label}</span><b>${Sound.prefs[k] ? "ON" : "OFF"}</b></button>`;
  openModal(`<h2>⚙️ Settings</h2>
    <div class="set-sec"><h3>Account</h3><p class="small">Pack: <b>${tierName()}</b>${state.paid ? "" : " · no withdrawals · mining stops at " + fmtN(net.info.free.cap) + " $MINE"}</p>${account}</div>
    <div class="set-sec"><h3>Audio</h3><div class="tgl-row">${tgl("sfx", "🔊", "Sounds")}${tgl("music", "🎵", "Music")}</div></div>
    <div class="set-sec"><h3>Username</h3><div class="bk-row"><input id="set-name" class="name-in" maxlength="16" value="${esc(state.name)}" /><button type="button" class="inv-btn gold" id="set-name-go">Save</button></div>
      <p class="dim small">Shown on the leaderboard · 2–16 letters, numbers, space . _ -</p></div>
    <div class="set-sec"><h3>Session</h3><button type="button" class="btn-secondary wide-btn" id="set-out">Log out</button></div>
    <div class="set-sec danger"><h3>Danger zone</h3>
      <button type="button" class="btn-secondary wide-btn" id="set-reset">↺ Reset progress</button>
      <button type="button" class="btn-secondary wide-btn" id="set-delete">🗑 Delete account</button></div>
    <div class="modal-actions"><button type="button" class="btn-secondary" id="set-close">Close</button></div>`, "wide settings");
  $("set-close").onclick = closeModal;
  document.querySelectorAll("#dyn-box [data-w]").forEach((el) => (el.onclick = () => { const e = Wallet.list().find((x) => x.id === el.dataset.w); if (e) walletLogin(e); }));
  document.querySelectorAll("#dyn-box [data-snd]").forEach((el) => (el.onclick = () => {
    const k = el.dataset.snd, on = !Sound.prefs[k];
    if (k === "sfx") Sound.setSfx(on); else Sound.setMusic(on);
    el.classList.toggle("on", on); el.lastChild.textContent = on ? "ON" : "OFF";
    if (k === "sfx" && on) Sound.play("coin");
  }));
  $("set-name-go").onclick = async () => {
    const r = await netRename($("set-name").value);
    if (!r.ok) return toast(r.error);
    $("set-name").value = state.name; toast("Username saved ✓");
    if (typeof ranksOpen === "function" && ranksOpen()) renderRanks();
  };
  $("set-out").onclick = () => {
    if (state.guest) return confirmModal("Log out of a guest account?", "A guest has no wallet to restore from. You will lose this progress forever.", "Log out", doLogout);
    doLogout();
  };
  $("set-reset").onclick = () => typedConfirm("↺ Reset progress?",
    "Cash, floors, manager level, gear, backpack, Mine Shards and unclaimed rewards go back to the start. Your wallet, username, packs, <b>$MINE balance</b>, boosts and quest progress are kept.", "RESET", "Reset progress", resetProgress);
  $("set-delete").onclick = () => typedConfirm("🗑 Delete account?",
    state.guest ? "This permanently deletes your guest account and all its progress." : "This permanently deletes your account, its progress and the packs you bought. You must withdraw or spend your $MINE first.", "DELETE", "Delete forever", deleteAccount);
}
async function resetProgress() {
  const r = await netAct({ type: "reset", confirm: "RESET" });
  if (!r.ok) { Sound.play("error"); return toast(r.error); }
  INV.selItem = null; INV.selSlot = null; INV.page = 0;
  resetSims(); buildShafts(); renderHUD();
  toast("Progress reset — good luck, miner! ⛏️");
}
async function deleteAccount() {
  try { await api("POST", "account/delete", { confirm: "DELETE" }); }
  catch (e) { Sound.play("error"); return toast(e.message); }
  setToken(null); net.info = null; net.online = false; net.accountId = null; offlineShown = false;
  closeModal(); showLogin("Your account was deleted.");
}
