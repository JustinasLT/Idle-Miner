"use strict";
// One big Upgrade button everywhere -> popup with +1 / +10 / +50 / MAX
let upSel = null;
function upInfo(target, idx = 0) {
  const mine = activeMine(), infra = costMult() * infraScale(mine);
  if (target === "warehouse") return { name: "Warehouse", level: mine.warehouse.level, base: 25, cm: infra };
  if (target === "elevator") return { name: "Elevator", level: mine.elevator.level, base: 40, cm: infra };
  return { name: "Floor " + (idx + 1) + " · " + SHAFT_DEFS[idx].name, level: mine.shafts[idx].level, base: 18 * Math.pow(2.3, idx), cm: costMult() };
}
function maxLevels(info, cash) {
  let n = 0, lv = info.level;
  while (n < 500) { const c = upgradeCost(info.base, lv, 1, info.cm); if (cash < c) break; cash -= c; lv++; n++; }
  return n;
}
function upOption(info, o) {
  const n = o === "max" ? maxLevels(info, state.cash) : o;
  const shown = n || 1, cost = upgradeCost(info.base, info.level, shown, info.cm);
  return { n, shown, cost, ok: n > 0 && state.cash >= cost };
}
function openUpgrade(target, idx = 0) {
  upSel = { target, idx };
  const info = upInfo(target, idx);
  openModal(`<h2>⬆ Upgrade</h2><p class="up-name">${info.name}</p><p class="up-cur"></p>
    <div class="up-opts">${[1, 10, 50, "max"].map((o) => `<button type="button" class="up-opt" data-o="${o}"><b></b><span></span><em></em></button>`).join("")}</div>
    <button type="button" class="btn-secondary" id="up-close">Close</button>`);
  $("up-close").onclick = closeModal;
  document.querySelectorAll(".up-opt").forEach((b) => (b.onclick = () => buyLevels(b.dataset.o)));
  modalHook = () => (upSel = null);
  fillUpPopup();
}
function fillUpPopup() {
  const info = upInfo(upSel.target, upSel.idx);
  setText(document.querySelector(".up-cur"), "Level " + info.level + " · You have " + formatMoney(state.cash));
  document.querySelectorAll(".up-opt").forEach((b) => {
    const o = b.dataset.o === "max" ? "max" : +b.dataset.o, r = upOption(info, o);
    setText(b.children[0], o === "max" ? "MAX" : "+" + o);
    setText(b.children[1], r.n ? "Lv " + info.level + " → " + (info.level + r.n) + (o === "max" ? " (+" + r.n + ")" : "") : "Can't afford yet");
    setText(b.children[2], formatMoney(r.cost));
    b.classList.toggle("poor", !r.ok);
  });
}
async function buyLevels(o) {
  const { target, idx } = upSel, info = upInfo(target, idx), r = upOption(info, o === "max" ? "max" : +o);
  if (!r.ok) return toast("Not enough cash");
  const j = await netAct({ type: "upgrade", target, idx, n: o === "max" ? "max" : +o }); // the server prices and applies it
  if (!j.ok) return toast(j.error);
  renderHUD(); refreshFloors(activeMine());
  if (upSel) fillUpPopup();
}
