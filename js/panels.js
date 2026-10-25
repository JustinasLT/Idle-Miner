"use strict";
function renderContinents() {
  $("continent-list").innerHTML = `<div class="continent-card active"><div class="cont-art"></div><strong>Grasslands</strong>
    <small>30 floors · 5 each of ${ORES.map((o) => o.name).join(", ")}</small><button type="button" disabled>✓ Active</button></div>
    <div class="coming-soon"><span>🌍</span><b>More continents</b><small>Coming soon</small></div>`;
}
function renderEvents() {
  $("events-content").innerHTML = `<div class="coming-soon big"><span>🎉</span><b>Events &amp; Expeditions</b><small>Coming soon</small></div>`;
}
// ---------- shop ----------
let shopCat = "boosts";
const sc = () => Math.ceil(activeMine() && infraScale(activeMine()));
const boostFn = (k, mins, label) => () => { state.boosts[k] = Math.max(Date.now(), state.boosts[k]) + mins * 60000; toast(label + " for " + mins + " min!"); };
const SHOP = [
  { id: "boosts", name: "Boosts", icon: "⚡", items: [
    { name: "⛏️ Mining Frenzy", desc: "2× shaft production for 3 minutes.", cost: () => 1500 * sc(), fn: boostFn("mine", 3, "Mining ×2") },
    { name: "💰 Market Rush", key: "boost_sell", desc: "2× warehouse sell speed for 5 minutes.", token: 25, fn: boostFn("sell", 5, "Market ×2") },
    { name: "⚡ Turbo Elevator", key: "boost_elev", desc: "3× elevator speed for 5 minutes.", token: 25, fn: boostFn("elev", 5, "Turbo elevator") },
  ] },
  { id: "gear", name: "Gear", icon: "🛡️", items: [
    { name: "📦 Equipment Crate", desc: "Open it in Inventory → Craft and pick a slot.", cost: () => 3000 * sc(), fn: () => { state.hero.crates++; toast("Crate added — open it in Inventory 📦"); } },
  ] },
  { id: "upgrades", name: "Upgrades", icon: "🏗️", items: [
    { name: "🏗️ Shaft Boost", desc: "All unlocked floors +5 levels.", cost: () => 5000 * sc(), fn: () => { const m = activeMine(); for (let i = 0; i < m.unlockedShaftCount; i++) m.shafts[i].level += 5; refreshFloors(m, researchMult()); toast("All floors +5 levels!"); } },
    { name: "🛗 Infrastructure Boost", desc: "Elevator and warehouse +5 levels.", cost: () => 8000 * sc(), fn: () => { const m = activeMine(); m.elevator.level += 5; m.warehouse.level += 5; toast("Elevator & warehouse +5!"); } },
  ] },
  { id: "cash", name: "Cash", icon: "💰", items: [
    { name: "💰 Free Money", desc: "A big pile of free cash.", free: true, fn: () => { const b = Math.max(10000, state.stats.totalEarned * 0.5 + 5000); state.cash += b; state.stats.totalEarned += b; toast("Free money! +" + formatMoney(b)); } },
  ] },
  { id: "mine", name: "$MINE", icon: "◈", items: [
    { name: "⚡ Turbo Elevator", key: "boost_elev", desc: "3× elevator speed, 5 minutes.", token: 25, fn: boostFn("elev", 5, "Turbo elevator") },
    { name: "💰 Market Rush", key: "boost_sell", desc: "2× sell speed, 5 minutes.", token: 25, fn: boostFn("sell", 5, "Market ×2") },
    { name: "📖 Hero Tome", key: "tome", desc: "+500 hero XP.", token: 15, fn: () => addXp(500) },
  ] },
];
function renderShop() {
  const cat = SHOP.find((c) => c.id === shopCat) || SHOP[0];
  $("shop-list").innerHTML = `<div class="shop-tabs">${SHOP.map((c) => `<button type="button" class="shop-tab${c.id === cat.id ? " on" : ""}" data-cat="${c.id}">${c.icon} ${c.name}</button>`).join("")}</div>` +
    cat.items.map((it, i) => `<div class="shop-item"><div class="shop-item-info"><strong>${it.name}</strong><small>${it.desc}</small></div>
      <button type="button" class="${it.free ? "btn-free" : it.token ? "btn-token" : ""}" data-i="${i}">${it.free ? "🎁 CLAIM" : it.token ? "◈ " + formatToken(it.token) : formatMoney(it.cost())}</button></div>`).join("");
  $("shop-list").onclick = async (e) => {
    const t = e.target.closest(".shop-tab"), b = e.target.closest("button[data-i]");
    if (t) { shopCat = t.dataset.cat; return renderShop(); }
    if (!b) return;
    const it = cat.items[+b.dataset.i];
    if (it.token) { const r = await netBuy(it.key); if (!r.ok) return toast(r.error); } // server charges $MINE
    else if (!it.free) { const c = it.cost(); if (state.cash < c) return toast("Not enough cash"); state.cash -= c; }
    it.fn(); saveState(); renderHUD(); renderShop();
  };
}
function renderResearch() {
  $("research-tree").innerHTML = "";
  RESEARCH_NODES.forEach((n) => {
    const done = state.researchUnlocked.includes(n.id), el = document.createElement("div");
    el.className = "research-node " + (done ? "unlocked" : "locked");
    el.innerHTML = `<strong>${n.name}</strong><br><small>${n.desc}</small><br><small>${done ? "✅ Researched" : formatMoney(n.cost)}</small>`;
    if (!done) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = "Research"; b.disabled = state.cash < n.cost;
      b.onclick = () => { if (state.cash < n.cost) return; state.cash -= n.cost; state.researchUnlocked.push(n.id); saveState(); renderResearch(); renderHUD(); toast(n.name + " researched! 🔬"); };
      el.appendChild(b);
    }
    $("research-tree").appendChild(el);
  });
}
