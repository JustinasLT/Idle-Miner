"use strict";
const bnText = $("bn-text"), elCable = $("elevator-cable"), hfWheel = $("hf-wheel");
let slowN = 0;
const BOOST_LABEL = { elev: "⚡ Elevator ×3", mine: "⛏️ Mining ×2", sell: "💰 Market ×2" };

function renderHUD() {
  setText($("cash-display"), formatMoney(state.cash));
  setText($("cash-rate"), "+" + formatMoney(rateMin) + "/min");
  setText($("token-display"), formatToken(state.token));
  const mi = miningInfo();
  setText($("token-rate"), !net.online ? "⚠ offline" : seasonOver() ? "$MINE" : mi.free ? "🔒 free cap · get a pack" : mi.onboarding ? "🚀 +" + formatToken(mi.perSec * 3600) + "/hr" : "+" + formatToken(mi.perDay) + "/day");
  const mine = activeMine();
  setText($("wh-lvl"), mine.warehouse.level);
  setText($("el-lvl"), mine.elevator.level);
  const badge = $("prestige-badge");
  badge.hidden = mine.prestigeMult <= 1;
  setText($("prestige-mult"), mine.prestigeMult);
  const chips = Object.keys(BOOST_LABEL).filter(boostOn).map((k) => {
    const s = Math.ceil((state.boosts[k] - Date.now()) / 1000);
    return `<span class="boost-chip">${BOOST_LABEL[k]} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</span>`;
  }).join("");
  const bc = $("boost-chips");
  if (bc._h !== chips) { bc.innerHTML = chips; bc._h = chips; }
  updateUpgradeCosts();
}
function updateUpgradeCosts() {
  [["warehouse", "wh-cost-1"], ["elevator", "el-cost-1"]].forEach(([t, id]) => {
    const info = upInfo(t), c = upgradeCost(info.base, info.level, 1, info.cm);
    setText($(id), formatMoney(c));
    $(id).closest(".btn-upgrade").classList.toggle("poor", state.cash < c);
  });
}
function renderGameVisuals(mine, rm) {
  const e = elevatorSim, top = stopY(e.pos);
  elCar.style.top = top + "px";
  elCable.style.top = WHEEL_Y + "px";
  elCable.style.height = Math.max(0, top - WHEEL_Y) + "px";
  hfWheel.classList.toggle("spin", e.state === "move");
  elLoad.style.height = Math.min(100, (e.u / elevatorCapacity(mine.elevator.level, rm.elevatorCapMult)) * 100) + "%";
  setText(pileVal, formatMoney(mine.pile.v));
  for (let i = 0; i < mine.unlockedShaftCount; i++) {
    const f = floorUI[i];
    if (f) setText(f.boxVal, formatMoney(mine.shafts[i].stock * unitValue(i, mine)));
  }
  bnEl.hidden = !bottleneck;
  if (bottleneck) setText(bnText, bottleneck === "elevator" ? "⚠️ Elevator bottleneck — upgrade it!" : "⚠️ Warehouse bottleneck — upgrade it!");
  elCar.classList.toggle("super-active", boostOn("elev"));
}
// slow refresh (4x/sec): labels, costs, miner counts
function refreshFloors(mine, rm) {
  for (let i = 0; i < mine.unlockedShaftCount; i++) {
    const f = floorUI[i], sh = mine.shafts[i];
    if (!f) continue;
    syncMiners(i, mine);
    setText(f.lv, "Lv " + sh.level);
    setText(f.inc, formatMoney(floorUnitRate(i, mine, rm) * unitValue(i, mine) * 60) + "/min");
    const c1 = upgradeCost(18 * Math.pow(2.3, i), sh.level, 1, rm.upgradeCostMult);
    setText(f.cost, formatMoney(c1));
    f.btn.classList.toggle("poor", state.cash < c1);
  }
  if (floorUI.unlockBtn) floorUI.unlockBtn.classList.toggle("poor", state.cash < shaftUnlockCost(mine.unlockedShaftCount));
}
// throughput bars (cash/min) make the bottleneck visible at a glance
function updateHeroVisuals(mine, rm) {
  let U = 0, V = 0;
  const n = mine.unlockedShaftCount;
  for (let i = 0; i < n; i++) { const u = floorUnitRate(i, mine, rm); U += u; V += u * unitValue(i, mine); }
  const avg = U ? V / U : 0;
  const cycle = (2 * n) / ((1.4 + 0.15 * mine.elevator.level) * elevatorBuff(mine)) + n * elevatorStop(mine);
  const vals = [V * 60, (elevatorCapacity(mine.elevator.level, rm.elevatorCapMult) / cycle) * avg * 60,
    warehouseSellRate(mine.warehouse.level, rm.sellMult) * hmult.c * avg * 60];
  const mx = Math.max(...vals, 1), lo = Math.min(...vals);
  ["mine", "elev", "wh"].forEach((id, k) => {
    const row = $("tp-" + id);
    row.firstChild.style.width = Math.min(100, (vals[k] / mx) * 100) + "%";
    row.classList.toggle("low", vals[k] === lo && vals[k] < mx * 0.98);
    setText(row.lastChild, formatMoney(vals[k]) + "/min");
  });
  if (typeof upSel !== "undefined" && upSel) fillUpPopup();
  if (++slowN % 4 === 0 && INV.tab === "hero" && !$("panel-hero").classList.contains("hidden")) renderHero();
}
