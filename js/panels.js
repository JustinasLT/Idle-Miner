"use strict";
// ---------- shop ---------- Boosts are bought with $MINE (the server checks and charges its own price).
// The "Test money" tab is a dev faucet (free cash / free $MINE, no cooldown); the server only offers it when DEV_FAUCET is on.
let shopCat = "boosts";
const price = (key) => (net.config && net.config.prices ? net.config.prices[key] : 0);
const SHOP = [
  { id: "boosts", name: "Boosts", icon: "⚡", items: [
    { name: "📖 XP Boost", key: "boost_xp", boost: "xp", desc: "+100% hero XP for 2 hours.", msg: "+100% hero XP for 2 hours!" },
    { name: "💰 Earnings Boost", key: "boost_earn", boost: "earn", desc: "+50% earnings (cash and your $MINE share) for 2 hours. Adds to your quest boost.", msg: "+50% earnings for 2 hours!" },
    { name: "⚡ Power Boost", key: "boost_power", boost: "power", desc: "+100% hero power for your $MINE share for 2 hours (the leaderboard shows your real power).", msg: "+100% power for 2 hours!" },
  ] },
  { id: "test", name: "Test money", icon: "🧪", dev: true, items: [
    { name: "💰 Free Cash", key: "free_money", desc: "Test faucet: a pile of free cash. No cooldown.", free: true, msg: "Free cash!" },
    { name: "◈ Free $MINE", key: "free_mine", desc: "Test faucet: free $MINE for testing (not mined, no cooldown).", free: true, mine: true, msg: "Free $MINE!" },
  ] },
];
const shopTabs = () => SHOP.filter((c) => !c.dev || state.devFaucet);
function renderShop() {
  const tabs = shopTabs(), cat = tabs.find((c) => c.id === shopCat) || tabs[0];
  const devMine = net.config ? net.config.devMine : 0;
  $("shop-list").innerHTML = (tabs.length > 1 ? `<div class="shop-tabs">${tabs.map((c) => `<button type="button" class="shop-tab${c.id === cat.id ? " on" : ""}" data-cat="${c.id}">${c.icon} ${c.name}</button>`).join("")}</div>` : "") +
    cat.items.map((it, i) => {
      const left = it.boost ? Math.max(0, (state.boosts[it.boost] || 0) - serverNow()) : 0;
      const label = it.free ? (it.mine ? "◈ +" + fmtN(devMine) : "🎁 CLAIM") : "◈ " + formatToken(price(it.key));
      return `<div class="shop-item"><div class="shop-item-info"><strong>${it.name}</strong><small>${it.desc}</small>${left ? `<small class="boost-left">Active: ${fmtDur(left)} left · buying again adds 2 h (max 12 h)</small>` : ""}</div>
      <button type="button" class="${it.free ? "btn-free" : "btn-token"}" data-i="${i}">${label}</button></div>`;
    }).join("");
  $("shop-list").onclick = async (e) => {
    const t = e.target.closest(".shop-tab"), b = e.target.closest("button[data-i]");
    if (t) { shopCat = t.dataset.cat; return renderShop(); }
    if (!b) return;
    const it = cat.items[+b.dataset.i];
    if (it.boost && state.token < price(it.key)) { Sound.play("error"); return toast("Not enough $MINE (" + formatToken(price(it.key)) + " needed)"); }
    const r = await netBuy(it.key); // the server checks and charges
    if (r.ok) Sound.play("coin"); else Sound.play("error");
    toast(r.ok ? it.msg : r.error);
    renderHUD(); renderShop();
  };
}
