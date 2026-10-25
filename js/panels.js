"use strict";
// ---------- shop ---------- (prices shown here are for display; the server charges its own price)
let shopCat = "boosts";
const sc = () => Shared.shopScale(activeMine());
const SHOP = [
  { id: "boosts", name: "Boosts", icon: "⚡", items: [
    { name: "⛏️ Mining Frenzy", key: "boost_mine", desc: "2× shaft production for 3 minutes.", cost: () => 1500 * sc(), msg: "Mining ×2 for 3 min!" },
    { name: "💰 Market Rush", key: "boost_sell", desc: "2× warehouse sell speed for 5 minutes.", token: 25, msg: "Market ×2 for 5 min!" },
    { name: "⚡ Turbo Elevator", key: "boost_elev", desc: "3× elevator speed for 5 minutes.", token: 25, msg: "Turbo elevator for 5 min!" },
  ] },
  { id: "gear", name: "Gear", icon: "🛡️", items: [
    { name: "📦 Equipment Crate", key: "crate", desc: "Open it in Inventory → Craft and pick a slot.", cost: () => 3000 * sc(), msg: "Crate added — open it in Inventory 📦" },
  ] },
  { id: "upgrades", name: "Upgrades", icon: "🏗️", items: [
    { name: "🏗️ Shaft Boost", key: "shaft5", desc: "All unlocked floors +5 levels.", cost: () => 5000 * sc(), msg: "All floors +5 levels!" },
    { name: "🛗 Infrastructure Boost", key: "infra5", desc: "Elevator and warehouse +5 levels.", cost: () => 8000 * sc(), msg: "Elevator & warehouse +5!" },
  ] },
  { id: "cash", name: "Cash", icon: "💰", items: [
    { name: "💰 Free Money", key: "free_money", desc: "A pile of free cash. Ready again every 12 hours.", free: true, msg: "Free money collected!" },
  ] },
  { id: "mine", name: "$MINE", icon: "◈", items: [
    { name: "⚡ Turbo Elevator", key: "boost_elev", desc: "3× elevator speed, 5 minutes.", token: 25, msg: "Turbo elevator for 5 min!" },
    { name: "💰 Market Rush", key: "boost_sell", desc: "2× sell speed, 5 minutes.", token: 25, msg: "Market ×2 for 5 min!" },
    { name: "📖 Hero Tome", key: "tome", desc: "+500 hero XP.", token: 15, msg: "+500 hero XP!" },
  ] },
];
const freeMoneyLeft = () => Math.max(0, state.freeMoneyIn - (performance.now() - net.cashAt));
const fmtHm = (ms) => { const m = Math.ceil(ms / 60000); return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m"; };
function renderShop() {
  const cat = SHOP.find((c) => c.id === shopCat) || SHOP[0];
  $("shop-list").innerHTML = `<div class="shop-tabs">${SHOP.map((c) => `<button type="button" class="shop-tab${c.id === cat.id ? " on" : ""}" data-cat="${c.id}">${c.icon} ${c.name}</button>`).join("")}</div>` +
    cat.items.map((it, i) => {
      const wait = it.free ? freeMoneyLeft() : 0;
      return `<div class="shop-item"><div class="shop-item-info"><strong>${it.name}</strong><small>${it.desc}</small></div>
      <button type="button" class="${it.free ? "btn-free" : it.token ? "btn-token" : ""}" data-i="${i}" ${wait ? "disabled" : ""}>${it.free ? (wait ? "⏳ " + fmtHm(wait) : "🎁 CLAIM") : it.token ? "◈ " + formatToken(it.token) : formatMoney(it.cost())}</button></div>`;
    }).join("");
  $("shop-list").onclick = async (e) => {
    const t = e.target.closest(".shop-tab"), b = e.target.closest("button[data-i]");
    if (t) { shopCat = t.dataset.cat; return renderShop(); }
    if (!b) return;
    const it = cat.items[+b.dataset.i];
    if (!it.free && !it.token && state.cash < it.cost()) return toast("Not enough cash");
    const r = await netBuy(it.key); // the server checks and charges
    toast(r.ok ? it.msg : r.error);
    renderHUD(); renderShop();
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
      b.onclick = async () => {
        if (state.cash < n.cost) return;
        const r = await netAct({ type: "research", id: n.id });
        if (!r.ok) return toast(r.error);
        renderResearch(); renderHUD(); toast(n.name + " researched! 🔬");
      };
      el.appendChild(b);
    }
    $("research-tree").appendChild(el);
  });
}
