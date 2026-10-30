"use strict";
// Mine-screen buttons: "Claim mining rewards" and "Earnings Boost" (quests, Offline Earnings, live pool numbers).
// Everything shown here comes from the server; the buttons only send intents.
const nf = (n) => Math.floor(n || 0).toLocaleString("en-US");
const fmtDur = (ms) => { const m = Math.floor(ms / 60000); return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m"; };
const fmtAgo = (ms) => (ms < 90e3 ? "just now" : ms < 3600e3 ? Math.round(ms / 60e3) + " min ago" : ms < 86400e3 ? fmtDur(ms) + " ago" : Math.floor(ms / 86400e3) + " d ago");

// ---------------------------------------------------------------- the two buttons on the mine screen
function renderMineButtons() {
  const claim = $("btn-claim");
  if (!claim) return;
  const p = state.pending, n = p.n + p.crates + (p.shards || 0);
  claim.classList.toggle("has", n > 0);
  $("claim-badge").hidden = n === 0;
  setText($("claim-badge"), n > 99 ? "99+" : String(n));
  setText($("claim-sub"), n > 0 ? p.n + " item" + (p.n === 1 ? "" : "s") + (p.crates ? " · " + p.crates + " crate" + (p.crates === 1 ? "" : "s") : "") + (p.shards ? " · " + p.shards + " 💠" : "") : "nothing new yet");
  setText($("earn-pct"), "+" + Math.round(state.earnBoost.total * 100) + "%");
  setText($("earn-sub"), state.offline.unlocked ? "Offline Earnings on" : state.quests.filter((q) => q.done).length + "/" + Shared.QUESTS.length + " quests");
  $("btn-earn").classList.toggle("perk", state.offline.unlocked);
}

// ---------------------------------------------------------------- Claim mining rewards
function openClaim() {
  const p = state.pending, spare = spareItems().length, cap = invCap();
  const items = p.items.slice().sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  const counts = RARITIES.map((R, r) => [R, items.filter((i) => i[1] === r).length]).filter(([, c]) => c).reverse();
  const shown = items.slice(0, 40);
  const tiles = shown.map(([slot, r, il]) => `<span class="claim-tile" style="--rc:${RARITIES[r].c}" title="${RARITIES[r].n} ${slot} · Lv ${il}"><i>${SLOT_ICON[slot]}</i><b>${il}</b></span>`).join("");
  const empty = !p.n && !p.crates && !p.shards;
  openModal(`<h2>🎁 Mining rewards</h2>
    <p class="small">Found since your last claim · ${p.since ? fmtAgo(serverNow() - p.since) : "—"}</p>
    <div class="claim-stats">
      <div><b>${p.n}</b><small>items</small></div><div><b>${p.crates}</b><small>crates</small></div><div><b class="shc">💠 ${p.shards || 0}</b><small>shards</small></div>
      <div><b>${formatMoney(p.cash)}</b><small>cash mined</small></div><div><b class="tokc">◈ ${formatToken(p.mine)}</b><small>$AFKMINE mined</small></div>
    </div>
    ${empty ? `<p class="dim">Nothing found yet. Items and crates drop while your miners work — deeper floors give better rarities, and from floor ${Shared.SHARD_FROM} down they can also find very rare Mine Shards.</p>`
      : `<div class="claim-chips">${counts.map(([R, c]) => `<span style="--rc:${R.c}">${c}× ${R.n}</span>`).join("")}${p.crates ? `<span style="--rc:#ffb74d">${p.crates}× Crate</span>` : ""}${p.shards ? `<span style="--rc:#4dd0e1">${p.shards}× Mine Shard</span>` : ""}</div>
         <div class="claim-grid">${tiles}${items.length > shown.length ? `<span class="claim-more">+${items.length - shown.length} more</span>` : ""}</div>`}
    ${p.n && spare + p.n > cap ? `<p class="warn">🎒 Backpack ${spare}/${cap}: only ${Math.max(0, cap - spare)} item(s) fit — the rest stay here until you make room (sell items or unlock a page).</p>` : ""}
    <p class="dim small">Cash and $AFKMINE are already in your balance — this is the loot you still have to pick up. Up to ${p.max} items are kept; more are auto-sold.</p>
    <div class="modal-actions"><button type="button" class="btn-primary" id="claim-go" ${empty ? "disabled" : ""}>Claim all</button><button type="button" class="btn-secondary" id="claim-no">Close</button></div>`, "wide");
  $("claim-no").onclick = closeModal;
  $("claim-go").onclick = doClaim;
}
async function doClaim() {
  $("claim-go").disabled = true;
  const r = await netAct({ type: "claimRewards" });
  if (!r.ok) { toast(r.error); Sound.play("error"); return openClaim(); }
  const c = r.claimed;
  Sound.play("claim");
  toast("🎁 Claimed " + c.items + " item" + (c.items === 1 ? "" : "s") + (c.crates ? " + " + c.crates + " crate" + (c.crates === 1 ? "" : "s") : "") + (c.shards ? " + " + c.shards + " 💠 shard" + (c.shards === 1 ? "" : "s") : "") + (c.left ? " · backpack full, " + c.left + " still waiting" : ""));
  if (c.left) openClaim(); else closeModal();
  renderHUD();
}

// ---------------------------------------------------------------- Earnings Boost menu
const EARN = { open: false, stats: null, at: 0, timer: 0, poll: 0, linking: null };
const QUEST_BAR = { hold: (v) => nf(v) + " / 50,000 $AFKMINE", deposit: (v) => fmtLam(v) + " / 0.5 SOL", spend: (v) => nf(v) + " / 25,000 $AFKMINE", streak: (v) => fmtDur(v) + " / 24h 00m", social: (v) => v + " / 2 linked" };

function openEarn() {
  EARN.open = true; EARN.linking = null; EARN.stats = null;
  openModal(`<h2>🚀 Earnings Boost</h2>
    <div class="pool-card">
      <small>LIVE REWARD POOL</small><b id="ep-pool" class="tokc">◈ …</b><small id="ep-pool-sub">$AFKMINE left to be mined this season</small>
      <div class="pool-grid">
        <div><small>All players earn / day</small><b id="ep-daily" class="tokc">◈ …</b></div>
        <div><small>Total players</small><b id="ep-players">…</b></div>
        <div><small>Online now</small><b id="ep-online">…</b></div>
      </div>
      <small class="dim" id="ep-note"></small>
    </div>
    <div id="earn-sum"></div><div id="earn-quests"></div>
    <p class="dim small">Every finished quest adds <b>+10%</b> to your earnings (cash and your share of the $AFKMINE pool), up to <b>+50%</b>. Finish <b>all five</b> to unlock <b>Offline Earnings</b>. Without them you stop earning cash and $AFKMINE <b>${state.offline.freeMin} minutes</b> after closing the game tab.</p>
    <div class="modal-actions"><button type="button" class="btn-secondary" id="earn-close">Close</button></div>`, "wide earn-modal");
  $("earn-close").onclick = closeModal;
  $("earn-quests").onclick = earnClick;
  modalHook = () => { EARN.open = false; clearInterval(EARN.timer); clearInterval(EARN.poll); };
  fillEarn(); loadStats();
  EARN.timer = setInterval(earnTick, 1000);
  EARN.poll = setInterval(loadStats, 5000);
}
async function loadStats() {
  try { EARN.stats = await api("GET", "stats"); EARN.at = performance.now(); } catch { return; }
  if (!EARN.open) return;
  const s = EARN.stats;
  setText($("ep-daily"), "◈ " + formatToken(s.daily));
  setText($("ep-players"), nf(s.players));
  setText($("ep-online"), nf(s.online));
  setText($("ep-pool-sub"), "of " + nf(s.poolTotal) + " $AFKMINE left to be mined" + (s.over ? " — season over" : ""));
  setText($("ep-note"), s.active < FULL_PLAYERS ? "Only " + s.active + " active miners — the daily emission scales up until " + FULL_PLAYERS + " play." : "Full daily emission is active (" + nf(s.active) + " active miners).");
  earnTick();
}
function earnTick() { // the pool drains smoothly between the 5-second refreshes
  const s = EARN.stats;
  if (!s || !EARN.open) return;
  setText($("ep-pool"), "◈ " + nf(Math.max(0, s.poolLeft - (s.over ? 0 : s.perSec) * ((performance.now() - EARN.at) / 1000))));
}
function refreshEarnMenu() {
  if (!EARN.open) return;
  const i = $("lk-in");
  if (i && document.activeElement === i) return; // don't steal focus while typing a handle
  fillEarn();
}
function fillEarn() {
  if (!EARN.open || !$("earn-sum")) return;
  const eb = state.earnBoost, off = state.offline, shop = Math.max(0, Math.round((eb.total - eb.quest) * 100));
  $("earn-sum").innerHTML = `<div class="earn-sum">
      <div><small>YOUR EARNINGS BOOST</small><b>+${Math.round(eb.total * 100)}%</b><span>quests +${Math.round(eb.quest * 100)}%${shop ? " · shop +" + shop + "%" : ""} <em>(max +50% from quests)</em></span></div>
      <div class="${off.unlocked ? "ok" : "lock"}"><small>OFFLINE EARNINGS</small><b>${off.unlocked ? "✅ Unlocked" : "🔒 Locked"}</b><span>${off.unlocked ? "earn up to " + off.maxHours + "h after you leave" : "stops " + off.freeMin + " min after you leave"}</span></div>
    </div><i class="dur earn-bar"><u style="width:${Math.min(100, (eb.quest / 0.5) * 100)}%"></u></i>`;
  const keep = $("lk-in") ? $("lk-in").value : "";
  $("earn-quests").innerHTML = Shared.QUESTS.map((d) => {
    const q = state.quests.find((x) => x.id === d.id) || { value: 0, done: false };
    let extra = "";
    if (d.id === "social") {
      extra = `<div class="q-link">${["x", "discord"].map((k) => {
        const label = k === "x" ? "X" : "Discord", h = state.social[k];
        if (h) return `<span class="linked">✓ ${label}: ${esc(h)}</span>`;
        if (EARN.linking === k) return `<span class="link-edit"><input id="lk-in" class="name-in" maxlength="33" placeholder="${k === "x" ? "@yourhandle" : "yourname"}" /><button type="button" class="inv-btn gold" data-lksave="${k}">Save</button><button type="button" class="inv-btn" data-lkno="1">✕</button></span>`;
        return `<button type="button" class="inv-btn" data-link="${k}">Link ${label}</button>`;
      }).join("")}</div><small class="dim">Handles are not verified, but each handle can only be linked to one player and can't be changed later.</small>`;
    }
    return `<div class="quest${q.done ? " done" : ""}"><div class="q-ico">${d.icon}</div>
      <div class="q-main"><b>${d.name}</b><small>${d.desc}</small>
        <i class="dur"><u style="width:${Math.min(100, (q.value / d.target) * 100)}%"></u></i><span class="q-val">${QUEST_BAR[d.id](q.value)}</span>${extra}</div>
      <div class="q-reward"><span>${q.done ? "✅" : "🔒"}</span><em>+${Math.round(Shared.QUEST_BOOST * 100)}%</em></div></div>`;
  }).join("") + `<div class="quest final${off.unlocked ? " done" : ""}"><div class="q-ico">🌙</div><div class="q-main"><b>All 5 quests → Offline Earnings</b>
      <small>Keep earning cash and $AFKMINE for up to ${off.maxHours} hours after you close the game (cash at 50%). Needs all five quests at the same time.</small></div><div class="q-reward"><span>${off.unlocked ? "✅" : "🔒"}</span></div></div>`;
  if ($("lk-in")) { $("lk-in").value = keep; }
}
async function earnClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.link) { EARN.linking = b.dataset.link; fillEarn(); if ($("lk-in")) $("lk-in").focus(); return; }
  if (b.dataset.lkno) { EARN.linking = null; return fillEarn(); }
  if (b.dataset.lksave) {
    const r = await netAct({ type: "linkSocial", kind: b.dataset.lksave, handle: $("lk-in").value });
    if (!r.ok) { Sound.play("error"); return toast(r.error); }
    EARN.linking = null; Sound.play("coin"); toast("🔗 Linked!"); fillEarn();
  }
}
function setupEarn() {
  $("btn-claim").onclick = openClaim;
  $("btn-earn").onclick = openEarn;
  renderMineButtons();
}
