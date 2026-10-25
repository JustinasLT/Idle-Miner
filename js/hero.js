"use strict";
// The hero boosts the entire mine at once — no stations, no walking, no rally.
let fx = { yield: 0, speed: 0, cap: 0, aura: 0, disc: 0, guard: 0, fort: 0, haste: 0, drop: 0, xp: 0, repair: 0, lucky: 0 };
let hmult = { y: 1, s: 1, c: 1 }, wearAcc = 0;
const itemById = (id) => state.inv.find((i) => i.id === id);
const spareItems = () => state.inv.filter((i) => state.eq[i.slot] !== i.id);
const itemPower = (it) => Math.round((it.v + it.aff.reduce((s, a) => s + a.v, 0)) * 1000 * (it.dur ? 1 : 0.25));
const sellValue = (it) => Math.ceil(35 * Math.pow(3.2, it.r) * (1 + 0.4 * (it.il - 1)) * (0.5 + (0.5 * it.dur) / it.max));
const repairCost = (it, mine) => Math.ceil((it.max - it.dur) * 0.8 * Math.pow(3, it.r) * infraScale(mine) * (1 - fx.repair));
const fuseCost = (r, mine) => Math.ceil(150 * Math.pow(6, r) * infraScale(mine));

function initHero() {
  state.hero = Object.assign({ lvl: 1, xp: 0, pE: 0, pL: 0, n: 0, day: "", crates: 0 }, state.hero || {});
  state.inv = state.inv || []; state.eq = state.eq || {};
  state.nextId = state.nextId || 1;
  if (!state.invPages) state.invPages = Math.min(MAX_PAGES, Math.max(1, Math.ceil((state.invCap || PAGE_SIZE) / PAGE_SIZE))); // old +12 slot saves keep their space
  delete state.invCap;
  if (!state.heroInit) {
    state.heroInit = true;
    ["Pickaxe", "Shoes", "Helmet"].forEach((s) => { const it = genItem(1, s, 0); state.inv.push(it); state.eq[s] = it.id; });
  }
  for (const s of SLOTS) { const it = itemById(state.eq[s]); if (it && it.il > state.hero.lvl) delete state.eq[s]; } // gear above hero level can't stay equipped
  computeFx();
}
function computeFx() {
  const f = { yield: 0, speed: 0, cap: 0, aura: 0, disc: 0, guard: 0, fort: 0, haste: 0, drop: 0, xp: 0, repair: 0, lucky: 0 };
  for (const s of SLOTS) {
    const it = itemById(state.eq[s]);
    if (!it) continue;
    const q = it.dur > 0 ? 1 : 0.25; // broken gear works at 25%
    f[SLOT_STAT[s][0]] += it.v * q;
    it.aff.forEach((a) => (f[a.k] += a.v * q));
  }
  for (const k in STAT_CAP) f[k] = Math.min(f[k], STAT_CAP[k]);
  fx = f;
  computeHmult();
}
function computeHmult() {
  const h = state.hero, a = Math.min(0.15, 0.05 + 0.0015 * h.lvl) * (1 + fx.aura);
  hmult = { y: 1 + a + fx.yield, s: 1 + a + fx.speed, c: 1 + a + fx.cap };
}
function addXp(x) {
  const h = state.hero;
  h.xp += x;
  while (h.lvl < 100 && h.xp >= 60 + 30 * h.lvl) { h.xp -= 60 + 30 * h.lvl; h.lvl++; toast("Hero reached level " + h.lvl + "!"); computeHmult(); }
}
function heroTick(dt) {
  addXp(dt * 0.2 * (1 + fx.xp));
  mineTick(dt);
  wearAcc += (dt * (1 - fx.guard)) / 360; // 1 durability per 6 min
  if (wearAcc >= 1) {
    wearAcc -= 1;
    for (const s of SLOTS) {
      const it = itemById(state.eq[s]);
      if (it && it.dur > 0 && --it.dur === 0) toast("💥 " + RARITIES[it.r].n + " " + it.slot + " broke!");
    }
    computeFx(); invChanged();
  }
}
function rollRarity(d) { // d = floor depth: deeper floors favour better rarities
  const h = state.hero;
  h.pE++; h.pL++;
  const minR = h.pL >= 500 || Math.random() < Math.max(0, (h.pL - 300) * 0.005) ? 4 : h.pE >= 50 ? 3 : 0;
  const w = RARITIES.map((x, i) => (i < minR ? 0 : x.w0 * Math.exp((x.k * d) / 30)));
  let u = Math.random() * w.reduce((a, b) => a + b), r = 0;
  for (; r < 5; r++) { if (u <= w[r]) break; u -= w[r]; }
  if (r >= 3) h.pE = 0;
  if (r >= 4) h.pL = 0;
  return r;
}
// item level: hero level +/- 10 (never below 1)
const rollItemLevel = () => Math.max(1, state.hero.lvl + Math.floor(rnd(-ITEM_LVL_SPREAD, ITEM_LVL_SPREAD + 1)));
const canEquip = (it) => it.il <= state.hero.lvl;
// lvl = item level, depth = floor it came from (only affects rarity odds)
function genItem(lvl, slot, r, depth) {
  slot = slot || SLOTS[Math.floor(Math.random() * 8)];
  if (r == null) r = rollRarity(depth || 1);
  const R = RARITIES[r], f = 1 + 0.03 * (lvl - 1);
  const it = { id: state.nextId++, slot, r, il: lvl, v: (SLOT_STAT[slot][2] / 100) * R.m * f * rnd(0.9, 1.1), dur: R.dur, max: R.dur, aff: [], lock: false };
  const mk = (k) => it.aff.push({ k, v: (AFFIXES[k][1] / 100) * Math.sqrt(R.m) * f * rnd(0.9, 1.1) });
  if (slot === "Amulet") mk("drop");
  const pool = Object.keys(AFFIXES).filter((k) => k !== "drop" || slot !== "Amulet");
  const want = Math.min(R.aff, pool.length);
  while (it.aff.length - (slot === "Amulet" ? 1 : 0) < want) {
    const k = pool[Math.floor(Math.random() * pool.length)];
    if (!it.aff.some((a) => a.k === k)) mk(k);
  }
  return it;
}
const invCap = () => state.invPages * PAGE_SIZE;
function giveItem(it, where) {
  state.season.items++; // counts towards the leaderboard
  if (spareItems().length >= invCap()) { const v = sellValue(it); state.cash += v; toast("Backpack full — auto-sold " + RARITIES[it.r].n + " " + it.slot + " for " + formatMoney(v)); return; }
  state.inv.push(it);
  toast("✨ " + RARITIES[it.r].n + " " + it.slot + " " + where);
  invChanged();
}
function rollDrop(i) { // once per finished miner trip
  const h = state.hero, today = new Date().toDateString();
  if (h.day !== today) { h.day = today; h.n = 0; }
  const p = (DROP_P0 * DROP_MULT * (1 + 0.025 * (i + 1)) * (1 + fx.drop)) / (1 + h.n / 40);
  if (Math.random() >= p) return;
  h.n++;
  if (Math.random() < 0.25) { h.crates++; toast("📦 Equipment crate found on floor " + (i + 1) + "!"); invChanged(); }
  else giveItem(genItem(rollItemLevel(), null, null, i + 1), "dropped on floor " + (i + 1) + "!");
}
function repairList(list) {
  const mine = activeMine(), cost = list.reduce((s, i) => s + repairCost(i, mine), 0);
  if (!list.length) return toast("Nothing to repair");
  if (state.cash < cost) return toast("Need " + formatMoney(cost) + " to repair");
  state.cash -= cost;
  list.forEach((i) => { i.max = Math.max(Math.ceil(RARITIES[i.r].dur * 0.5), Math.floor(i.max * 0.95)); i.dur = i.max; });
  toast("Repaired " + list.length + " item(s) for " + formatMoney(cost));
}
const repairAll = () => repairList(state.inv.filter((i) => i.dur < i.max));
function fuse(slot, r) {
  const mine = activeMine(), [need, ok] = FUSE[r], cost = fuseCost(r, mine);
  const pool = state.inv.filter((i) => i.slot === slot && i.r === r && !i.lock && state.eq[slot] !== i.id).slice(0, need);
  if (pool.length < need) return;
  if (state.cash < cost) return toast("Need " + formatMoney(cost) + " to fuse");
  state.cash -= cost;
  state.inv = state.inv.filter((i) => !pool.includes(i));
  if (Math.random() < ok) {
    state.inv.push(genItem(Math.round(pool.reduce((s, i) => s + i.il, 0) / need), slot, r + 1));
    toast("🔥 Fused a " + RARITIES[r + 1].n + " " + slot + "!");
  } else { state.inv.push(pool[Math.floor(Math.random() * need)]); toast("Fusion failed — one item returned"); }
}
function sellItem(it) { state.cash += sellValue(it); state.inv = state.inv.filter((i) => i !== it); }
function autoEquip() {
  SLOTS.forEach((s) => {
    const q = (i) => i.v * (i.dur ? 1 : 0.25);
    const best = state.inv.filter((i) => i.slot === s && canEquip(i)).sort((x, y) => q(y) - q(x))[0];
    if (best) state.eq[s] = best.id;
  });
}
// backpack pages are bought with $MINE, max 5 pages
const pageCost = () => PAGE_COST[state.invPages] || 0;
async function buyPage() {
  if (state.invPages >= MAX_PAGES) return toast("Backpack is fully expanded");
  const r = await netBuy("page", { n: state.invPages + 1 }); // the server charges the price and records the page
  if (!r.ok) return toast(r.error);
  state.invPages = Math.max(state.invPages, r.pages); INV.page = state.invPages - 1;
  toast("Backpack page " + state.invPages + " unlocked 🎒");
  computeFx(); renderHero(); saveState(); renderHUD();
}
function openCrate(slot) {
  if (state.hero.crates < 1) return;
  state.hero.crates--;
  giveItem(genItem(rollItemLevel(), slot, null, activeMine().unlockedShaftCount), "from the crate!");
}
