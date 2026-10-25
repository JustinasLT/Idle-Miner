"use strict";
const INV = { tab: "items", selSlot: null, selItem: null, page: 0 };
const FLAVOR = ["Found behind a crate at the Dusty Dock.", "Still warm from the forge.", "Dropped by a miner who swears it wasn't his.", "Smells faintly of coal and old coffee.", "Someone scratched a tiny star into it."];
const panelOpen = () => !$("panel-hero").classList.contains("hidden");
const invChanged = () => { if (panelOpen()) renderHero(); };
const STAT_LABELS = [["yield", "Ore Yield"], ["speed", "Transit Speed"], ["cap", "Capacity"], ["aura", "Aura Strength"], ["disc", "Upgrade Discount"], ["guard", "Durability Guard"], ["fort", "Fortune"], ["haste", "Warehouse Haste"], ["drop", "Drop Rate"], ["xp", "Hero XP"], ["repair", "Repair Discount"], ["lucky", "Lucky Haul"]];

function rollQuality(it, k) { // how good this roll is inside its range, 0-100%
  const R = RARITIES[it.r], f = 1 + 0.03 * (it.il - 1);
  const base = k ? (AFFIXES[k][1] / 100) * Math.sqrt(R.m) * f : (SLOT_STAT[it.slot][2] / 100) * R.m * f;
  const v = k ? it.aff.find((a) => a.k === k).v : it.v;
  return Math.max(0, Math.min(100, Math.round(((v / base - 0.9) / 0.2) * 100)));
}
function statRows(it, cmp) {
  const rows = [[SLOT_STAT[it.slot][1], rollQuality(it), it.v, cmp ? cmp.v : 0]];
  it.aff.forEach((a) => rows.push([AFFIXES[a.k][0], rollQuality(it, a.k), a.v, cmp ? (cmp.aff.find((x) => x.k === a.k) || { v: 0 }).v : 0]));
  return rows.map(([n, q, v, c]) => {
    const d = cmp ? v - c : 0;
    return `<div class="st-row"><span>${n}</span><i class="chip">${q}%</i><b>+${pct(v)}${cmp && Math.abs(d) > 1e-6 ? ` <em class="${d > 0 ? "up" : "dn"}">${d > 0 ? "▲" : "▼"}${pct(Math.abs(d))}</em>` : ""}</b></div>`;
  }).join("");
}
const tile = (it, cls = "") => `<button type="button" class="bp-cell r${it.r} ${canEquip(it) ? "" : "locked-lvl"} ${cls}" style="--rc:${RARITIES[it.r].c}" data-act="pick" data-id="${it.id}"><i>${SLOT_ICON[it.slot]}</i><b>Lv${it.il}</b>${it.lock ? "<u>🔒</u>" : ""}${it.dur ? "" : "<s>!</s>"}</button>`;
const durBar = (it) => `<div class="dur-line"><i class="dur"><u style="width:${(it.dur / it.max) * 100}%"></u></i><small>${it.dur}/${it.max}${it.dur ? "" : " BROKEN"}</small></div>`;

function equippedStrip() {
  const s = INV.selSlot && state.eq[INV.selSlot] ? INV.selSlot : SLOTS.find((x) => state.eq[x]);
  const it = s && itemById(state.eq[s]);
  if (!it) return `<div class="eq-card empty">Nothing equipped yet — tap an item below and press Equip.</div>`;
  const R = RARITIES[it.r];
  return `<div class="eq-card" style="--rc:${R.c}"><div class="eq-ico"><i>${SLOT_ICON[it.slot]}</i></div>
    <div class="eq-main"><b class="nm">${R.n} ${it.slot}</b><div class="eq-st"><span>Power <b>${itemPower(it)}</b></span><span>${SLOT_STAT[it.slot][1]} <b>+${pct(it.v)}</b></span><span>Lvl <b>${it.il}</b></span></div>${durBar(it)}</div>
    <div class="eq-btns"><button type="button" class="inv-btn" data-act="unequip" data-slot="${it.slot}">Unequip</button>${it.dur < it.max ? `<button type="button" class="inv-btn" data-act="repair" data-id="${it.id}">🔧 ${formatMoney(repairCost(it, activeMine()))}</button>` : ""}</div></div>`;
}
function detailPanel() {
  const it = INV.selItem && itemById(INV.selItem);
  if (!it || state.eq[it.slot] === it.id) return `<div class="item-detail empty">Tap an item in your backpack to inspect it.</div>`;
  const R = RARITIES[it.r], cmp = itemById(state.eq[it.slot]), mine = activeMine();
  return `<div class="item-detail" style="--rc:${R.c}">
    <div class="d-head"><div class="eq-ico"><i>${SLOT_ICON[it.slot]}</i></div><div><b class="nm">${R.n} ${it.slot}</b><small>${R.n.toUpperCase()} · ${it.slot.toUpperCase()} · LVL ${it.il}${canEquip(it) ? "" : " · 🚫 TOO HIGH"}${it.lock ? " · 🔒 LOCKED" : ""}</small></div></div>
    <div class="d-power">⚔ Power ${itemPower(it)}</div>
    <div class="st-list">${statRows(it, cmp)}</div>
    ${cmp ? `<p class="cmp">Compared with equipped: <b>${RARITIES[cmp.r].n} ${cmp.slot}</b> (Power ${itemPower(cmp)})</p>` : `<p class="cmp">Slot is empty — equipping adds the full bonus.</p>`}
    <p class="flavor">"${FLAVOR[it.id % FLAVOR.length]}"</p>${durBar(it)}
    <div class="d-btns">${canEquip(it) ? `<button type="button" class="inv-btn gold" data-act="equip" data-id="${it.id}">Equip</button>` : `<button type="button" class="inv-btn gold" disabled>Requires hero Lv ${it.il}</button>`}
      <button type="button" class="inv-btn" data-act="lock" data-id="${it.id}">${it.lock ? "🔓 Unlock" : "🔒 Lock"}</button>
      ${it.dur < it.max ? `<button type="button" class="inv-btn" data-act="repair" data-id="${it.id}">🔧 ${formatMoney(repairCost(it, mine))}</button>` : ""}
      <button type="button" class="inv-btn red" data-act="sell" data-id="${it.id}" ${it.lock ? "disabled" : ""}>Sell ${formatMoney(sellValue(it))}</button></div>
    <p class="note">⚠ Broken gear still works at 25%. Repairs trim 5% off max durability.</p></div>`;
}
function pageBar() {
  const btns = Array.from({ length: MAX_PAGES }, (_, p) => {
    if (p < state.invPages) return `<button type="button" class="pg${INV.page === p ? " on" : ""}" data-act="page" data-p="${p}">${p + 1}</button>`;
    const next = p === state.invPages;
    return `<button type="button" class="pg lock${next ? " next" : ""}" data-act="buypage" title="${next ? "Unlock page " + (p + 1) + " for " + formatToken(pageCost()) + " $MINE" : "Unlock previous pages first"}">🔒</button>`;
  }).join("");
  const info = state.invPages >= MAX_PAGES ? `<small class="dim">All pages unlocked</small>`
    : `<small class="dim">Page ${state.invPages + 1}: <b class="tokc">◈ ${formatToken(pageCost())}</b> $MINE</small>`;
  return `<div class="bp-page"><span>PAGE</span>${btns}${info}</div>`;
}
function itemsTab() {
  const spare = spareItems(), cap = invCap();
  if (INV.page >= state.invPages) INV.page = state.invPages - 1;
  const eq = SLOTS.map((s) => { const it = itemById(state.eq[s]), R = it && RARITIES[it.r];
    return `<div class="eq-cell"><button type="button" class="eq-slot${it ? "" : " empty"}${INV.selSlot === s ? " sel" : ""}" data-act="slot" data-slot="${s}" style="--rc:${R ? R.c : "#3a3026"}"><i>${SLOT_ICON[s]}</i>${it && !it.dur ? "<s>!</s>" : ""}</button><small>${s}</small></div>`; }).join("");
  const base = INV.page * PAGE_SIZE;
  const cells = Array.from({ length: PAGE_SIZE }, (_, i) => (spare[base + i] ? tile(spare[base + i], INV.selItem === spare[base + i].id ? "sel" : "") : `<div class="bp-cell empty"></div>`)).join("");
  return `<div class="eq-row">${eq}</div>${equippedStrip()}
    <div class="bp-bar"><span class="dim">Backpack</span><button type="button" class="inv-btn" data-act="sort">⇅ Sort</button><button type="button" class="inv-btn big" data-act="auto">⛏ Auto-Equip</button><button type="button" class="inv-btn red" data-act="sellall">Sell All</button><span class="dim cnt">${spare.length}/${cap}</span></div>
    ${pageBar()}
    <div class="bp-grid">${cells}</div>${detailPanel()}`;
}
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "K" : Math.round(n).toLocaleString("en-US"));
function stakeCard() { // your share of the global power and the $MINE it earns per day
  const m = miningInfo(), share = m.share * 100, earned = net.info ? net.info.earned : 0;
  if (!net.info) return `<div class="inv-card stake"><h3>⚡ Mining stake · Season 0</h3><p class="dim">${net.error ? "⚠ Can't reach the game server (" + net.error + "). Mining is paused until it's back." : "Connecting to the server…"}</p></div>`;
  const note = seasonOver() ? "Season 0 has ended — mining is finished."
    : m.free ? `You have mined the free-tier limit of ${fmtN(net.info.free.cap)} $MINE. Buy any pack (Packs tab) and mining starts again.`
    : m.onboarding ? `🚀 Fast start: the first ${fmtN(net.info.free.onboardCap)} $MINE are paid at a boosted rate while you play. After that the normal rate below applies.`
    : m.capped ? `Capped at ${pct(PLAYER_DAILY_CAP)} of the daily emission.`
    : m.factor < 1 ? `Only ${m.players} players so far — daily emission is scaled to ${pct(m.factor)} until ${FULL_PLAYERS} play.` : "Full daily emission is active.";
  return `<div class="inv-card stake"><h3>⚡ Mining stake · Season 0</h3>
    <div class="stake-big"><b>${share < 0.01 ? "<0.01" : share.toFixed(share >= 10 ? 1 : 2)}%</b><span>of global power</span></div>
    <i class="dur"><u style="width:${Math.min(100, Math.max(1, share))}%"></u></i>
    <div class="st-row"><span>Your hero power</span><b>${fmtN(m.my)}</b></div>
    <div class="st-row"><span>Global power (${m.players} active players)</span><b>${fmtN(m.global)}</b></div>
    <div class="st-row"><span>Predicted $MINE / day</span><b class="tokc">◈ ${formatToken(m.free ? 0 : m.onboarding ? m.perSec * 86400 : m.perDay)}</b></div>
    <div class="st-row"><span>Predicted $MINE / hour</span><b class="tokc">◈ ${formatToken(m.free ? 0 : m.onboarding ? m.perSec * 3600 : m.perDay / 24)}</b></div>
    <div class="st-row"><span>Mined this season</span><b class="tokc">◈ ${formatToken(earned)}</b></div>
    <p class="dim small">${net.online ? "" : "⚠ Server offline — showing last known numbers. "}${note} Stronger gear and a higher level raise your share. Prediction uses today's power; others grow too.</p></div>`;
}
function heroTab() {
  const h = state.hero, need = 60 + 30 * h.lvl;
  const rows = STAT_LABELS.filter(([k]) => fx[k] > 0).map(([k, n]) => `<div class="st-row"><span>${n}</span><b>+${pct(fx[k])}</b></div>`).join("") || `<p class="dim">Equip gear to gain bonuses.</p>`;
  return `<div class="inv-card hero-card"><div class="hero-av">🤠</div><div><b class="nm">Hero · Level ${h.lvl}</b><i class="dur xp"><u style="width:${Math.min(100, (h.xp / need) * 100)}%"></u></i><small class="dim">${Math.floor(h.xp)}/${need} XP</small></div></div>
    ${stakeCard()}
    <div class="inv-card"><h3>Active everywhere</h3><p class="dim">The hero now boosts every floor, the elevator and the warehouse at once.</p>
    <div class="st-row"><span>Ore production</span><b>×${hmult.y.toFixed(2)}</b></div><div class="st-row"><span>Movement speed</span><b>×${hmult.s.toFixed(2)}</b></div><div class="st-row"><span>Carry capacity</span><b>×${hmult.c.toFixed(2)}</b></div></div>
    <div class="inv-card"><h3>Gear bonuses</h3>${rows}</div>
    <div class="inv-card"><h3>Loot luck</h3><div class="st-row"><span>Item level range</span><b>${Math.max(1, h.lvl - ITEM_LVL_SPREAD)} – ${h.lvl + ITEM_LVL_SPREAD}</b></div><div class="st-row"><span>Drops today</span><b>${h.n}</b></div><div class="st-row"><span>Epic pity</span><b>${h.pE}/50</b></div><div class="st-row"><span>Legendary pity</span><b>${h.pL}/500</b></div></div>`;
}
function craftTab() {
  const h = state.hero, mine = activeMine(), spare = spareItems(), fuses = [];
  SLOTS.forEach((s) => RARITIES.slice(0, 5).forEach((R, r) => {
    if (spare.filter((i) => i.slot === s && i.r === r && !i.lock).length >= FUSE[r][0])
      fuses.push(`<button type="button" class="inv-btn" data-act="fuse" data-slot="${s}" data-r="${r}">${SLOT_ICON[s]} ${FUSE[r][0]}× ${R.n} → ${RARITIES[r + 1].n} (${pct(FUSE[r][1])}) · ${formatMoney(fuseCost(r, mine))}</button>`);
  }));
  const dmg = state.inv.filter((i) => i.dur < i.max);
  return `<div class="inv-card"><h3>📦 Equipment crates (${h.crates})</h3>${h.crates ? `<p class="dim">Pick a slot to open one:</p><div class="btn-wrap">${SLOTS.map((s) => `<button type="button" class="inv-btn" data-act="crate" data-slot="${s}">${SLOT_ICON[s]}</button>`).join("")}</div>` : `<p class="dim">Crates drop from the shafts or can be bought in the Shop.</p>`}</div>
    <div class="inv-card"><h3>🔥 Forge</h3><div class="btn-wrap col">${fuses.join("") || `<p class="dim">Collect same-slot, same-rarity spares to fuse them up a tier.</p>`}</div></div>
    <div class="inv-card"><h3>🔧 Workshop</h3><button type="button" class="inv-btn gold" data-act="repairall" ${dmg.length ? "" : "disabled"}>Repair all${dmg.length ? " · " + formatMoney(dmg.reduce((s, i) => s + repairCost(i, mine), 0)) : ""}</button></div>`;
}
function renderHero() {
  const tabs = [["items", "ITEMS"], ["hero", "HERO"], ["craft", "CRAFT"]].map(([t, n]) => `<button type="button" class="inv-tab${INV.tab === t ? " on" : ""}" data-act="tab" data-tab="${t}">${n}</button>`).join("");
  $("hero-content").innerHTML = `<div class="inv"><div class="inv-top"><span class="inv-title">◆ INVENTORY</span><nav>${tabs}</nav></div>${INV.tab === "items" ? itemsTab() : INV.tab === "hero" ? heroTab() : craftTab()}</div>`;
}
async function heroClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const d = b.dataset, a = d.act, it = d.id ? itemById(+d.id) : null;
  // pure UI actions
  if (a === "tab") { INV.tab = d.tab; return renderHero(); }
  if (a === "slot") { INV.selSlot = d.slot; return renderHero(); }
  if (a === "pick") { INV.selItem = +d.id; return renderHero(); }
  if (a === "page") { INV.page = +d.p; return renderHero(); }
  // everything else is a request to the server, which validates it and answers with the new state
  const send = async (body, after) => { const r = await netAct(body); if (!r.ok) toast(r.error); else if (after) after(r); renderHero(); };
  if (a === "equip") { if (!canEquip(it)) return toast("Hero must be level " + it.il + " to equip this"); return send({ type: "equip", id: it.id }, () => { INV.selSlot = it.slot; INV.selItem = null; }); }
  if (a === "unequip") return send({ type: "unequip", slot: d.slot });
  if (a === "lock") return send({ type: "lock", id: it.id });
  if (a === "sell") { if (it.lock) return; return send({ type: "sell", id: it.id }, () => { INV.selItem = null; }); }
  if (a === "sellall") {
    const list = spareItems().filter((i) => !i.lock && i.r <= 2);
    if (!list.length) return toast("Nothing to sell — Epic+ and locked items are kept");
    return confirmModal("Sell all?", `Sell ${list.length} unlocked item(s) up to Rare for ${formatMoney(list.reduce((s, i) => s + sellValue(i), 0))}? Epic and better are kept.`, "Sell", () => send({ type: "sellAll" }));
  }
  if (a === "sort") return send({ type: "sort" });
  if (a === "auto") return send({ type: "autoEquip" });
  if (a === "repair") return send({ type: "repair", id: it.id });
  if (a === "repairall") return send({ type: "repairAll" });
  if (a === "fuse") return send({ type: "fuse", slot: d.slot, r: +d.r });
  if (a === "crate") return send({ type: "crate", slot: d.slot });
  if (a === "buypage") {
    if (state.invPages >= MAX_PAGES) return;
    return confirmModal("Unlock page " + (state.invPages + 1) + "?", `Spend ${formatToken(pageCost())} $MINE for 48 more backpack slots? You have ${formatToken(state.token)} $MINE.`, "Unlock", buyPage);
  }
}
