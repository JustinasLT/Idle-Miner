"use strict";
// Offline earnings are calculated and held by the server. Without the Offline Earnings perk (all five quests) you only
// earn for the first 15 minutes after closing the game; with it, up to 8 hours at 50 %. Here we only show them.
let offlineShown = false;
function maybeOfflineModal() {
  if (state.pendingOffline > 10 && !offlineShown && net.token) {
    offlineShown = true;
    $("offline-amount").textContent = formatMoney(state.pendingOffline);
    const o = state.offline;
    $("offline-note").textContent = o.unlocked
      ? "Offline Earnings: paid at 50% for up to " + o.maxHours + " hours."
      : "Without Offline Earnings you only earn for " + o.freeMin + " minutes after closing the game. Finish the Earnings Boost quests to unlock them.";
    $("offline-modal").classList.remove("hidden");
  }
}
async function claimOffline() {
  const j = await netAct({ type: "claimOffline" });
  if (!j.ok) toast(j.error); else Sound.play("coin");
  offlineShown = false;
  $("offline-modal").classList.add("hidden");
  renderHUD();
}
