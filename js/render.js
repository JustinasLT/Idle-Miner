"use strict";
const bnText = $("bn-text"), elCable = $("elevator-cable"), hfWheel = $("hf-wheel");
let slowN = 0;
const bnDismissed = { kind: null, until: 0 };
const BOOST_LABEL = { xp: "📖 XP +100%", earn: "💰 Earnings +50%", power: "⚡ Power +100%" };

function renderHUD() {
  setText($("cash-display"), formatMoney(state.cash));
  setText($("cash-rate"), "+" + formatMoney(rateMin) + "/min");
  setText($("token-display"), formatToken(state.token));
  setText($("sol-display"), fmtLam(state.sol));
  const mi = miningInfo();
  setText($("token-rate"), !net.online ? "⚠ offline" : seasonOver() ? "$AFKMINE" : mi.free ? "🔒 free cap · get a pack" : mi.onboarding ? "🚀 +" + formatToken(mi.perSec * 3600) + "/hr" : "+" + formatToken(mi.perDay) + "/day");
  const mine = activeMine();
  setText($("wh-lvl"), mine.warehouse.level);
  setText($("el-lvl"), mine.elevator.level);
  const badge = $("prestige-badge");
  badge.hidden = mine.prestigeMult <= 1;
  setText($("prestige-mult"), mine.prestigeMult);
  const chips = Object.keys(BOOST_LABEL).filter(boostOn).map((k) => {
    const s = Math.ceil((state.boosts[k] - serverNow()) / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return `<span class="boost-chip">${BOOST_LABEL[k]} ${h ? h + ":" + String(m).padStart(2, "0") : m}:${String(x).padStart(2, "0")}</span>`;
  }).join("");
  const bc = $("boost-chips");
  if (bc._h !== chips) { bc.innerHTML = chips; bc._h = chips; }
  const sh = (state.bag && state.bag.shards) || 0;
  $("shard-chip").hidden = sh < 1 && !(state.pending && state.pending.shards);
  setText($("shard-count"), String(sh));
  updateUpgradeCosts();
}
function updateUpgradeCosts() {
  [["warehouse", "wh-cost-1"], ["elevator", "el-cost-1"]].forEach(([t, id]) => {
    const info = upInfo(t), c = upgradeCost(info.base, info.level, 1, info.cm);
    setText($(id), formatMoney(c));
    $(id).closest(".btn-upgrade").classList.toggle("poor", state.cash < c);
  });
}
function renderGameVisuals(mine) {
  const e = elevatorSim, top = stopY(e.pos);
  elCar.style.top = top + "px";
  elCable.style.top = WHEEL_Y + "px";
  elCable.style.height = Math.max(0, top - WHEEL_Y) + "px";
  hfWheel.classList.toggle("spin", e.state === "move");
  elLoad.style.height = Math.min(100, (e.u / elevatorCapacity(mine.elevator.level)) * 100) + "%";
  setText(pileVal, formatMoney(mine.pile.v));
  for (let i = 0; i < mine.unlockedShaftCount; i++) {
    const f = floorUI[i];
    if (f) setText(f.boxVal, formatMoney(mine.shafts[i].stock * unitValue(i, mine)));
  }
  // the warning is a small pill; ✕ hides that kind of warning for 10 minutes
  const hidden = !bottleneck || (bnDismissed.kind === bottleneck && Date.now() < bnDismissed.until);
  bnEl.hidden = hidden;
  if (bottleneck) setText(bnText, bottleneck === "elevator" ? "⚠️ Elevator bottleneck" : "⚠️ Warehouse bottleneck");
  $("tput-btn").classList.toggle("warn", !!bottleneck && hidden);
}
// slow refresh (4x/sec): labels, costs, miner counts
function refreshFloors(mine) {
  GATE = Shared.gateInfo(state, Date.now());                             // which floors reach their Power requirement
  renderGate();
  for (let i = 0; i < mine.unlockedShaftCount; i++) {
    const f = floorUI[i], sh = mine.shafts[i];
    if (!f) continue;
    syncMiners(i, mine);
    setText(f.lv, "Lv " + sh.level);
    const on = !GATE || GATE.active[i] !== false;
    f.row.classList.toggle("gated", !on);
    setText(f.inc, on ? formatMoney(floorUnitRate(i, mine) * unitValue(i, mine) * 60) + "/min" : "💤 idle");
    setText(f.need, on ? "" : "Needs " + fmtN(Shared.floorReq(i + 1)) + " Power, you have " + fmtN(GATE.power));
    const c1 = upgradeCost(18 * Math.pow(2.3, i), sh.level, 1, costMult());
    setText(f.cost, formatMoney(c1));
    f.btn.classList.toggle("poor", state.cash < c1);
  }
  if (floorUI.unlockBtn) {
    const c = nextFloorCost(mine), b = floorUI.unlockBtn, no = [state.cash < c.cash, c.mine && state.token < c.mine, c.shards && (state.bag.shards || 0) < c.shards];
    b.classList.toggle("poor", no.some(Boolean));
    ["ca", "mi", "sh"].forEach((k, n) => { const el = b.querySelector("." + k); if (el) el.classList.toggle("bad", !!no[n]); });
  }
}
// throughput bars (cash/min) make the bottleneck visible at a glance
function updateHeroVisuals(mine) {
  let U = 0, V = 0;
  const n = mine.unlockedShaftCount;
  for (let i = 0; i < n; i++) { if (GATE && GATE.active[i] === false) continue; const u = floorUnitRate(i, mine); U += u; V += u * unitValue(i, mine); }
  const avg = U ? V / U : 0;
  const cycle = (2 * n) / ((1.4 + 0.15 * mine.elevator.level) * elevatorBuff()) + n * elevatorStop(mine);
  const vals = [V * 60, (elevatorCapacity(mine.elevator.level) / cycle) * avg * 60,
    warehouseSellRate(mine.warehouse.level) * hmult.c * avg * 60];
  const mx = Math.max(...vals, 1), lo = Math.min(...vals), limiting = vals[1] === lo ? 1 : vals[2] === lo ? 2 : 0;
  if (!$("tput").classList.contains("hidden")) { // only worth drawing while the panel is open
    ["mine", "elev", "wh"].forEach((id, k) => {
      const row = $("tp-" + id), bar = row.querySelector("u");
      bar.style.width = Math.min(100, (vals[k] / mx) * 100) + "%";
      row.classList.toggle("low", vals[k] === lo && vals[k] < mx * 0.98);
      setText(row.querySelector("em"), formatMoney(vals[k]));
    });
    const weak = lo < mx * 0.98;
    setText($("tput-gate"), gateText());
    setText($("tput-note"), weak ? "Limited by the " + ["mines", "elevator", "warehouse"][limiting] + " — upgrade it to earn more." : "Everything keeps up with the mines. Nice!");
  }
  if (typeof upSel !== "undefined" && upSel) fillUpPopup();
  if (++slowN % 4 === 0 && INV.tab === "hero" && !$("panel-hero").classList.contains("hidden")) renderHero();
}
