"use strict";
// Season 0 — display helpers. Power, ranks, prizes and every $AFKMINE payout come from the server.
const seasonOver = () => !!(net.info && net.info.season.over && Date.now() + net.offset >= net.info.season.end);
const seasonLeftMs = () => (net.info ? Math.max(0, net.info.season.end - (Date.now() + net.offset)) : SEASON_MS);
const dailyEmission = () => (net.info ? net.info.season.miningPool / SEASON_DAYS : 0);   // $AFKMINE the whole game mines per day at full activity
const heroPower = () => (net.info ? net.info.power : Shared.heroPower(state));
// numbers for the "mining stake" card (all computed by the server)
function miningInfo() {
  const i = net.info;
  if (!i) return { my: 0, global: 0, share: 0, players: 0, pool: 0, cap: 0, perDay: 0, perSec: 0, capped: false, factor: 0, pending: true, free: false, onboarding: false };
  const m = i.mining, factor = Math.min(1, m.players / FULL_PLAYERS), pool = dailyEmission() * factor, cap = dailyEmission() * PLAYER_DAILY_CAP;
  return { my: i.power, global: m.global, share: m.share, players: m.players, pool, cap, perDay: m.perDay, perSec: m.perSec, capped: !m.capped && pool * m.share > cap, factor, free: m.capped, onboarding: m.onboarding };
}
// between syncs the balance ticks up smoothly; every sync replaces it with the server's exact value
function mineTick(dt) { if (net.online && net.info && !seasonOver()) state.token += net.info.mining.perSec * dt; }
