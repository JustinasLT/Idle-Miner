"use strict";
// Season 0 client logic. Power is computed here; everything money-related ($MINE balance, payouts,
// ranks, prizes) comes from the server (see net.js).
const seasonOver = () => !!(net.info && net.info.season.over && Date.now() + net.offset >= net.info.season.end);
const seasonLeftMs = () => (net.info ? Math.max(0, net.info.season.end - (Date.now() + net.offset)) : SEASON_MS);
const seasonDay = () => (net.info ? Math.min(SEASON_DAYS, (Date.now() + net.offset - net.info.season.start) / 864e5) : 0);

// hero power: level + everything equipped (broken gear counts 25%)
function heroPower() {
  let p = state.hero.lvl * 50;
  for (const s of SLOTS) { const it = itemById(state.eq[s]); if (it) p += itemPower(it); }
  return Math.round(p);
}
// live projection of your share, using the server's last global numbers + your current power
function miningInfo() {
  const my = heroPower(), i = net.info;
  if (!i) return { my, global: my, share: 0, players: 0, pool: 0, cap: DAILY_EMISSION * PLAYER_DAILY_CAP, perDay: 0, capped: false, factor: 0, pending: true };
  const global = Math.max(0, i.global - i.myPower) + my, share = global ? my / global : 0;
  const factor = Math.min(1, i.players / FULL_PLAYERS), pool = DAILY_EMISSION * factor, cap = DAILY_EMISSION * PLAYER_DAILY_CAP;
  const raw = pool * share;
  return { my, global, share, players: i.players, pool, cap, perDay: seasonOver() ? 0 : Math.min(raw, cap), capped: raw > cap, factor };
}
// between syncs the balance ticks up smoothly; every sync replaces it with the server's exact value
function mineTick(dt) { if (net.online && !seasonOver()) state.token += (miningInfo().perDay / 86400) * dt; }
