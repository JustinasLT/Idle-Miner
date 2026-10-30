"use strict";
// "Welcome back": what your miners earned while you were away, all tallied by the server — coins, $AFKMINE, items, crates and
// Mine Shards. Without the Offline Earnings perk (all five boost quests) you only earn for the first 15 minutes after closing the
// game; with it, up to 8 hours (cash and loot at 50%). Here we only show it. Coins are paid when you press Collect; the $AFKMINE is
// already in your balance; items, crates and shards wait in "Claim mining rewards".
let offlineShown = false;
function maybeOfflineModal() {
  const a = state.offline.away;
  if (!a || offlineShown || !net.token) return;
  if (!(a.cash > 10 || a.mine > 0.05 || a.items > 0 || a.crates > 0 || a.shards > 0)) return;
  offlineShown = true;
  $("offline-amount").textContent = formatMoney(a.cash);
  const loot = [];
  if (a.items) loot.push(`✨ ${a.items} item${a.items === 1 ? "" : "s"}`);
  if (a.crates) loot.push(`📦 ${a.crates} crate${a.crates === 1 ? "" : "s"}`);
  const rows = [];
  if (a.mine > 0.005) rows.push(`<div><span>◈ $AFKMINE mined</span><b class="tk">+${formatToken(a.mine)}</b></div>`);
  if (loot.length) rows.push(`<div><span>Loot found</span><b>${loot.join(" · ")}</b></div>`);
  if (a.shards) rows.push(`<div><span>💠 Mine Shards</span><b class="sh">+${a.shards}</b></div>`);
  $("offline-list").innerHTML = rows.join("");
  const o = state.offline;
  $("offline-note").textContent = (rows.length && (a.items || a.crates || a.shards) ? "Loot is waiting in “Claim mining rewards”. " : "") + (o.unlocked
    ? "Offline Earnings: coins and loot at 50% for up to " + o.maxHours + " hours."
    : "Without Offline Earnings you only earn for " + o.freeMin + " minutes after closing the game. Finish the Earnings Boost quests to unlock them.");
  $("offline-modal").classList.remove("hidden");
}
async function claimOffline() {
  const j = await netAct({ type: "claimOffline" });
  if (!j.ok) toast(j.error); else Sound.play("coin");
  offlineShown = false;
  $("offline-modal").classList.add("hidden");
  renderHUD();
}
