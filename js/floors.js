"use strict";
let shaftsBuilt = false;

  function buildShafts() {
    const mine = activeMine();
    const wrap = document.getElementById("shafts-container");
    const sc = document.getElementById("world-scroll");
    const keep = sc.scrollTop;
    const un = mine.unlockedShaftCount, total = mine.shafts.length;
    const frag = document.createDocumentFragment();
    floorUI.length = 0;
    floorUI.unlockBtn = null;
    for (let i = 0; i < un; i++) frag.appendChild(floorRow(i));
    if (un < total) frag.appendChild(unlockRow(un));
    if (total - un > 1) {
      const more = document.createElement("div");
      more.className = "floor more";
      more.textContent = total - un - 1 + " more floors below";
      frag.appendChild(more);
    }
    wrap.replaceChildren(frag);
    sc.scrollTop = keep;
    document.getElementById("shaft-core").style.height = un * L.floor + "px";
    for (let i = 0; i < un; i++) syncMiners(i, mine);
    refreshFloors(mine);
    shaftsBuilt = true;
  }

  function unlockRow(i) {
    const def = SHAFT_DEFS[i];
    const row = document.createElement("div");
    row.className = "floor locked";
    row.style.setProperty("--ore", def.color);
    const c = Shared.shaftUnlockCost(i, activeMine());
    row.innerHTML = `<button type="button" class="btn-unlock-shaft">🔒 Unlock floor ${i + 1} · ${def.name}<br><small class="uc"><span class="ca">${formatMoney(c.cash)}</span>${c.mine ? `<span class="mi">◈ ${nf(c.mine)}</span>` : ""}${c.shards ? `<span class="sh">💠 ${c.shards}</span>` : ""}</small></button>`;
    const b = row.querySelector("button");
    b.addEventListener("click", () => buyShaftUnlock(i));
    floorUI.unlockBtn = b;
    floorUI.unlockCost = c;
    return row;
  }

  async function buyShaftUnlock(floorIndex) {
    const mine = activeMine();
    if (floorIndex !== mine.unlockedShaftCount) return;
    const c = Shared.shaftUnlockCost(floorIndex, mine);
    if (state.cash < c.cash) return toast("Not enough cash");
    if (c.mine && state.token < c.mine) return toast("Not enough $MINE (" + nf(c.mine) + " needed)");
    if (c.shards && (state.bag.shards || 0) < c.shards) return toast("Not enough Mine Shards (" + c.shards + " needed) — miners find them from floor " + Shared.SHARD_FROM + " down");
    const j = await netAct({ type: "unlockFloor" });
    if (!j.ok) return toast(j.error);
    renderHUD();
    toast("Floor " + (floorIndex + 1) + " unlocked! ⛏️");
  }

function floorRow(i) {
  const def = SHAFT_DEFS[i];
  const row = document.createElement("div");
  row.className = "floor";
  row.style.setProperty("--ore", def.color);
  row.innerHTML = `
    <div class="floor-head">
      <span class="floor-no">${i + 1}</span><span class="floor-name">${def.name}</span>
      <span class="floor-lv"></span><span class="floor-inc"></span>
    </div>
    <div class="tunnel">
      <div class="t-beams"></div><div class="t-rails"></div><i class="t-lamp"></i><i class="t-lamp l2"></i>
      <div class="crate dbox" title="Mined ore waiting for the elevator"><b>$0</b></div>
      <div class="lane"></div>
      <div class="rock"><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="floor-actions">
      <button type="button" class="btn-upgrade big"><span>⬆ Upgrade</span><small class="up-cost"></small></button>
    </div>`;
  const q = (s) => row.querySelector(s), btn = q(".btn-upgrade");
  btn.addEventListener("click", () => openUpgrade("shaft", i));
  floorUI[i] = { lane: q(".lane"), boxEl: q(".dbox"), boxVal: q(".dbox b"), lv: q(".floor-lv"), inc: q(".floor-inc"), cost: q(".up-cost"), btn };
  return row;
}
