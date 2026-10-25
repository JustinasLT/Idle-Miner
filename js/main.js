"use strict";
let lastTick = performance.now();
function setupNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const p = btn.dataset.panel;
    document.querySelectorAll(".side-panel").forEach((x) => x.classList.add("hidden"));
    $("app").classList.toggle("panel-open", p !== "mine"); // game view stays in layout, so the nav never jumps
    if (p === "mine") return;
    $("panel-" + p).classList.remove("hidden");
    ({ hero: renderHero, ranks: renderRanks, world: renderContinents, shop: renderShop, research: renderResearch, events: renderEvents })[p]();
  }));
}
function setupPrestige() {
  const open = () => {
    const m = activeMine();
    if (m.shafts.reduce((s, sh) => s + sh.level, 0) + m.warehouse.level + m.elevator.level < 50) return toast("Reach 50+ total levels to Prestige");
    $("prestige-next").textContent = "×" + m.prestigeMult * 2;
    $("prestige-modal").classList.remove("hidden");
  };
  $("btn-prestige-cancel").onclick = () => $("prestige-modal").classList.add("hidden");
  $("btn-prestige-confirm").onclick = () => {
    const m = activeMine();
    m.prestigeMult *= 2; m.warehouse.level = 1; m.elevator.level = 1; m.unlockedShaftCount = 1;
    m.shafts.forEach((sh) => { sh.level = 1; sh.stock = 0; });
    state.cash = 0; resetSims(); m.pile = { u: 0, v: 0 };
    $("prestige-modal").classList.add("hidden");
    saveState(); buildShafts(); renderHUD(); toast("Prestiged! Earnings ×" + m.prestigeMult + " 🌟");
  };
  $("prestige-badge").addEventListener("dblclick", open);
  $("cash-display").addEventListener("dblclick", open);
}
function loop(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  tick(dt);
  requestAnimationFrame(loop);
}
function init() {
  const rs = document.documentElement.style;
  rs.setProperty("--surface-h", L.surface + "px"); rs.setProperty("--grass-h", L.grass + "px");
  rs.setProperty("--floor-h", L.floor + "px"); rs.setProperty("--head-h", L.head + "px");
  rs.setProperty("--tunnel-h", L.tunnel + "px"); rs.setProperty("--headframe-h", L.headframe + "px");
  Object.values(state.mines).forEach(ensureMineShape);
  initHero();
  $("hero-content").addEventListener("click", heroClick);
  $("dyn-modal").addEventListener("click", (e) => { if (e.target.id === "dyn-modal") closeModal(); });
  applyOfflineEarnings();
  buildShafts();
  setupNav(); setupPrestige(); setupRanks();
  document.querySelectorAll("[data-upgrade]").forEach((b) => (b.onclick = () => openUpgrade(b.dataset.upgrade)));
  $("scroll-up").onclick = () => $("world-scroll").scrollBy({ top: -240, behavior: "smooth" });
  $("scroll-down").onclick = () => $("world-scroll").scrollBy({ top: 240, behavior: "smooth" });
  $("btn-claim-offline").onclick = () => claimOffline(false);
  $("btn-double-offline").onclick = () => claimOffline(true);
  setInterval(saveState, 15000);
  startNet();
  renderHUD();
  requestAnimationFrame(loop);
}
init();
