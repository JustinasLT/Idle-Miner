"use strict";
// Hero / gear — DISPLAY side. Items, drops, fusing, selling and levelling all happen on the server; this file only
// derives the numbers shown in the UI (and used by the animated mine) from the server's copy of your gear.
let fx = Shared.FX0(), hmult = { y: 1, s: 1, c: 1 };
const itemById = (id) => Shared.itemById(state, id);
const spareItems = () => Shared.spareItems(state);
const itemPower = Shared.itemPower;
const sellValue = Shared.sellValue;
const repairCost = (it, mine) => Shared.repairCost(it, mine, fx);
const fuseCost = (r, mine) => Shared.fuseCost(r, mine);
const canEquip = (it) => Shared.canEquip(state, it);
const invCap = () => Shared.invCap(state);
function computeFx() { fx = Shared.computeFx(state); hmult = Shared.heroMult(state, fx); }
const pageCost = () => PAGE_COST[state.invPages] || 0;
async function buyPage() {
  if (state.invPages >= MAX_PAGES) return toast("Backpack is fully expanded");
  const r = await netAct({ type: "buy", item: "page" });
  if (!r.ok) return toast(r.error);
  INV.page = state.invPages - 1;
  toast("Backpack page " + state.invPages + " unlocked 🎒");
  renderHero();
}
