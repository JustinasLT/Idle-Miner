"use strict";
// Offline earnings are calculated and held by the server (max 8 hours, paid at 50 %). Here we only show them.
let offlineShown = false;
function maybeOfflineModal() {
  if (state.pendingOffline > 10 && !offlineShown && net.token) {
    offlineShown = true;
    $("offline-amount").textContent = formatMoney(state.pendingOffline);
    $("offline-modal").classList.remove("hidden");
  }
}
async function claimOffline(double) {
  const j = await netAct({ type: "claimOffline", double: !!double });
  if (!j.ok) { toast(j.error); if (double) return; }
  offlineShown = false;
  $("offline-modal").classList.add("hidden");
  renderHUD();
}
