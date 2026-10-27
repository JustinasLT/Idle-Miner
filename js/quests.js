"use strict";
// Daily reward calendar, daily + seasonal quests, and the small controls on the mine screen (income panel, bottleneck close).
// Everything shown comes from the server (state.daily / state.dailyQuests / state.seasonQuests); buttons only send intents.

// ---------------------------------------------------------------- reward display helpers
function rewardChips(r) {
  const out = [], perSec = net.info ? net.info.cashPerSec : 0;
  if (r.cash) out.push(`<span class="rw">🪙 ${formatMoney(Shared.rewardCash(r, perSec))}</span>`);
  if (r.crates) out.push(`<span class="rw">📦 ×${r.crates}</span>`);
  for (const [k, n] of Object.entries(r.bag || {})) out.push(`<span class="rw${k === "shards" ? " shard" : ""}">${Shared.BAG_ITEMS[k].icon} ×${n}</span>`);
  if (r.mine) out.push(`<span class="rw mine">◈ ${nf(r.mine)} $MINE</span>`);
  return `<div class="rw-row">${out.join("")}</div>`;
}
function rewardText(g) { // what the server actually handed out
  const p = [];
  if (g.cash) p.push("+" + formatMoney(g.cash));
  if (g.crates) p.push(g.crates + " crate" + (g.crates === 1 ? "" : "s"));
  for (const [k, n] of Object.entries(g.bag || {})) p.push(n + "× " + Shared.BAG_ITEMS[k].name);
  if (g.mine) p.push("◈ " + nf(g.mine) + " $MINE");
  return p.join(" · ");
}
const sinceView = () => performance.now() - (net.viewAt || performance.now());
const fmtHMS = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 3600)).padStart(2, "0") + ":" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
const dayIcon = (r) => (r.mine ? "◈" : r.bag ? Shared.BAG_ITEMS[Object.keys(r.bag)[0]].icon : r.crates && !r.cash ? "📦" : r.crates ? "🎁" : "🪙");

// ---------------------------------------------------------------- Daily reward
const DAILY = { open: false };
function openDaily() {
  if (!state.daily) return;
  DAILY.open = true;
  openModal("", "wide daily-modal");
  $("dyn-box").onclick = dailyClick;
  modalHook = () => { DAILY.open = false; $("dyn-box").onclick = null; };
  drawDaily();
}
function drawDaily() {
  const d = state.daily;
  if (!DAILY.open || !d) return;
  const cards = Shared.DAILY_REWARDS.map((r, i) => {
    const n = i + 1, done = d.claimedToday ? n <= d.day : n < d.day, today = !d.claimedToday && n === d.day;
    return `<div class="daily-day${done ? " done" : ""}${today ? " today" : ""}${n === 7 ? " big" : ""}"><small>DAY ${n}</small><span class="d-ico">${dayIcon(r)}</span>${rewardChips(r)}</div>`;
  }).join("");
  $("dyn-box").innerHTML = `<h2>📅 Daily reward</h2>
    <p class="small" style="text-align:center">Log in every day: days 1-6 give coins or items, <b>day 7 gives $MINE</b>. Miss a day and the week starts again.</p>
    <div class="daily-grid">${cards}</div>
    ${d.claimable ? `<button type="button" class="btn-primary wide-btn" data-daily="claim">🎁 Claim day ${d.day}</button>`
      : `<p class="daily-foot">✅ Day ${d.day} claimed. Next reward in <b id="daily-timer">${fmtHMS(d.resetsIn - sinceView())}</b> (00:00 UTC)</p>`}
    <div class="modal-actions"><button type="button" class="btn-secondary" data-daily="close">Close</button></div>`;
}
async function dailyClick(e) {
  const b = e.target.closest("[data-daily]");
  if (!b) return;
  if (b.dataset.daily === "close") return closeModal();
  b.disabled = true;
  const r = await netAct({ type: "claimDaily" });
  if (!r.ok) { Sound.play("error"); toast(r.error); return drawDaily(); }
  Sound.play("claim"); toast("📅 Day " + r.rewarded.day + ": " + rewardText(r.rewarded)); renderHUD(); drawDaily();
}

// ---------------------------------------------------------------- Quests (daily + seasonal)
const QST = { open: false, tab: "daily" };
const fmtQ = (def, v) => (def.metric === "play" ? (v >= 3600 ? (v / 3600).toFixed(v >= 36000 ? 0 : 1) + "h" : Math.floor(v / 60) + "m") : nf(v));
function openQuests(tab) {
  if (!state.dailyQuests) return;
  QST.open = true; if (tab) QST.tab = tab;
  openModal("", "wide quests-modal");
  $("dyn-box").onclick = questClick;
  modalHook = () => { QST.open = false; $("dyn-box").onclick = null; };
  drawQuests();
}
function questRows(kind) {
  const defs = kind === "daily" ? Shared.DAILY_QUESTS : Shared.SEASON_QUESTS, data = kind === "daily" ? state.dailyQuests : state.seasonQuests;
  return defs.map((def) => {
    const it = data.items.find((x) => x.id === def.id) || { value: 0, claimed: false }, v = Math.min(it.value, def.target), done = it.value >= def.target;
    return { def, it, v, done, ready: done && !it.claimed };
  });
}
function drawQuests() {
  if (!QST.open || !state.dailyQuests) return;
  const kind = QST.tab, data = kind === "daily" ? state.dailyQuests : state.seasonQuests, rows = questRows(kind);
  const tabs = [["daily", "📅 Daily"], ["season", "🏆 Season"]].map(([k, n]) => `<button type="button" class="q-tab${kind === k ? " on" : ""}" data-qtab="${k}">${n}${questRows(k).some((r) => r.ready) ? " ●" : ""}</button>`).join("");
  const list = rows.map(({ def, it, v, done, ready }) => `<div class="dq${ready ? " ready" : ""}${it.claimed ? " claimed" : ""}"><div class="q-ico">${def.icon}</div>
      <div><b>${def.name}</b>${def.desc ? `<small>${def.desc}</small>` : ""}<i class="dur"><u style="width:${Math.min(100, (v / def.target) * 100)}%"></u></i>
        <span class="q-val">${fmtQ(def, v)} / ${fmtQ(def, def.target)}</span>${rewardChips(def.reward)}</div>
      ${it.claimed ? `<span class="dim">✅</span>` : `<button type="button" class="inv-btn gold" data-qclaim="${def.id}" ${ready ? "" : "disabled"}>Claim</button>`}</div>`).join("");
  let bonus = "";
  if (kind === "daily") {
    const all = rows.every((r) => r.it.claimed);
    bonus = `<div class="dq bonus${all && !data.bonusClaimed ? " ready" : ""}${data.bonusClaimed ? " claimed" : ""}"><div class="q-ico">🌟</div><div><b>Finish all ${rows.length} daily quests</b><small>Bonus reward for a perfect day.</small>${rewardChips(Shared.DAILY_BONUS)}</div>
      ${data.bonusClaimed ? `<span class="dim">✅</span>` : `<button type="button" class="inv-btn gold" data-qclaim="bonus" ${all ? "" : "disabled"}>Claim</button>`}</div>`;
  }
  $("dyn-box").innerHTML = `<h2>📜 Quests</h2><div class="q-tabs">${tabs}</div>
    <p class="q-reset" id="q-reset">${kind === "daily" ? "Resets in " : "Season ends in "}<b>${fmtHMS(data.resetsIn - sinceView())}</b>${kind === "daily" ? " (00:00 UTC)" : ""}</p>
    ${list}${bonus}
    <p class="dim small">${kind === "daily" ? "Daily quests restart every day at 00:00 UTC." : "Season quests last the whole 30-day season. Progress is counted from the season start."}</p>
    <div class="modal-actions"><button type="button" class="btn-secondary" data-qclose="1">Close</button></div>`;
}
async function questClick(e) {
  const t = e.target.closest("[data-qtab]"), c = e.target.closest("[data-qclaim]"), x = e.target.closest("[data-qclose]");
  if (x) return closeModal();
  if (t) { QST.tab = t.dataset.qtab; return drawQuests(); }
  if (!c || c.disabled) return;
  c.disabled = true;
  const id = c.dataset.qclaim;
  const r = await netAct(id === "bonus" ? { type: "claimDailyBonus" } : { type: "claimQuest", kind: QST.tab, id });
  if (!r.ok) { Sound.play("error"); toast(r.error); return drawQuests(); }
  Sound.play("claim"); toast("🎉 " + rewardText(r.rewarded)); renderHUD(); drawQuests();
}

// ---------------------------------------------------------------- buttons on the mine screen
function refreshQuestUI() {
  const d = state.daily, dq = state.dailyQuests, sq = state.seasonQuests;
  if (d && $("btn-daily")) {
    $("btn-daily").classList.toggle("has", d.claimable);
    setText($("daily-sub"), d.claimable ? "Day " + d.day + " ready!" : "Day " + d.day + " ✓");
    $("daily-badge").hidden = !d.claimable;
  }
  if (dq && sq && $("btn-quests")) {
    const ready = questRows("daily").filter((r) => r.ready).length + questRows("season").filter((r) => r.ready).length
      + (questRows("daily").every((r) => r.it.claimed) && !dq.bonusClaimed ? 1 : 0);
    const done = dq.items.filter((i) => i.claimed || i.value >= Shared.DAILY_QUESTS.find((q) => q.id === i.id).target).length;
    $("btn-quests").classList.toggle("has", ready > 0);
    setText($("quests-sub"), ready ? ready + " to claim!" : done + "/" + dq.items.length + " today");
    $("quests-badge").hidden = ready === 0;
    setText($("quests-badge"), String(ready));
  }
  if (DAILY.open) drawDaily();
  if (QST.open) drawQuests();
}
setInterval(() => { // live countdowns while a popup is open
  if (DAILY.open && state.daily && !state.daily.claimable) setText($("daily-timer"), fmtHMS(state.daily.resetsIn - sinceView()));
  if (QST.open && state.dailyQuests && $("q-reset")) { const data = QST.tab === "daily" ? state.dailyQuests : state.seasonQuests; const b = $("q-reset").querySelector("b"); if (b) setText(b, fmtHMS(data.resetsIn - sinceView())); }
}, 1000);

// income-per-minute panel: opens with its button, remembers the choice on this device
const TPUT_KEY = "idleMiner_tput_open";
function setTput(open) {
  $("tput").classList.toggle("hidden", !open);
  $("tput-btn").classList.toggle("on", open);
  try { localStorage.setItem(TPUT_KEY, open ? "1" : "0"); } catch { /* storage blocked */ }
}
function setupQuests() {
  $("btn-daily").onclick = openDaily;
  $("btn-quests").onclick = () => openQuests();
  $("tput-btn").onclick = () => setTput($("tput").classList.contains("hidden"));
  $("tput-x").onclick = () => setTput(false);
  $("bn-x").onclick = () => { bnDismissed.kind = bottleneck; bnDismissed.until = Date.now() + 10 * 60e3; $("bottleneck").hidden = true; };
  $("shard-chip").onclick = () => { INV.tab = "bag"; document.querySelector('.nav-btn[data-panel="hero"]').click(); };
  let open = false; try { open = localStorage.getItem(TPUT_KEY) === "1"; } catch { /* */ }
  setTput(open);
  refreshQuestUI();
}
