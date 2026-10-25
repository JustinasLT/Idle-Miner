"use strict";
let lastTick = performance.now();
const PANELS = { hero: () => renderHero(), ranks: () => renderRanks(), packs: () => renderPacks(), bank: () => renderBank(), shop: () => renderShop(), research: () => renderResearch() };
function setupNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const p = btn.dataset.panel;
    document.querySelectorAll(".side-panel").forEach((x) => x.classList.add("hidden"));
    $("app").classList.toggle("panel-open", p !== "mine"); // game view stays in layout, so the nav never jumps
    if (p === "mine") return;
    $("panel-" + p).classList.remove("hidden");
    PANELS[p]();
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
  $("btn-prestige-confirm").onclick = async () => {
    $("prestige-modal").classList.add("hidden");
    const r = await netAct({ type: "prestige" });
    if (!r.ok) return toast(r.error);
    resetSims(); buildShafts(); renderHUD(); toast("Prestiged! Earnings ×" + activeMine().prestigeMult + " 🌟");
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
  computeFx();
  $("hero-content").addEventListener("click", heroClick);
  $("dyn-modal").addEventListener("click", (e) => { if (e.target.id === "dyn-modal") closeModal(); });
  buildShafts();
  setupNav(); setupPrestige(); setupRanks(); setupLogin(); setupPacks(); setupBank();
  document.querySelectorAll("[data-upgrade]").forEach((b) => (b.onclick = () => openUpgrade(b.dataset.upgrade)));
  $("scroll-up").onclick = () => $("world-scroll").scrollBy({ top: -240, behavior: "smooth" });
  $("scroll-down").onclick = () => $("world-scroll").scrollBy({ top: 240, behavior: "smooth" });
  $("btn-claim-offline").onclick = () => claimOffline(false);
  $("btn-double-offline").onclick = () => claimOffline(true);
  renderHUD();
  requestAnimationFrame(loop);
  bootSession();   // sign in with a saved session, or show the login screen
}
init();
