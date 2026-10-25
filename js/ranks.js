"use strict";
// Leaderboard panel (all data comes from the server).
let ranksTimer = 0, ranksData = null;
const ranksOpen = () => !$("panel-ranks").classList.contains("hidden");
function fmtLeft(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(x).padStart(2, "0")}s`;
}
async function renderRanks() {
  if (!ranksData) $("ranks-content").innerHTML = `<p class="dim small" style="padding:20px;text-align:center">Loading leaderboard…</p>`;
  try { ranksData = await netBoard(); } catch (e) {
    $("ranks-content").innerHTML = `<div class="coming-soon"><span>📡</span><b>Can't reach the game server</b><small>${e.message}</small><button type="button" class="inv-btn" data-r="retry">Retry</button></div>`;
    return;
  }
  if (!ranksOpen()) return;
  const D = ranksData, over = D.season.over, mine = D.me || { rank: 0, pts: 0, prize: 0 }, m = miningInfo();
  const info = net.info, claimed = info && info.claimed;
  const medal = (r) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : r);
  const tr = (r, me) => `<tr class="${me ? "me" : ""}"><td class="rk">${medal(r.rank)}</td><td class="nmc">${me ? "⭐ " : ""}${esc(r.name)}</td><td>${r.level}</td><td>${fmtN(r.power)}</td><td>${r.items}</td><td class="tokc">${formatToken(r.earned)}</td><td class="tokc">${r.prize ? formatToken(r.prize) : "–"}</td><td class="pts">${fmtN(r.pts)}</td></tr>`;
  const myName = info ? info.name : "";
  const inTop = D.me && D.me.rank <= LB_SIZE;
  const claim = over && info && !claimed ? `<button type="button" class="btn-primary claim" data-r="claim">🏆 Claim ${mine.prize ? formatToken(mine.prize) + " $MINE" : "(no prize this season)"}</button>` : over ? `<p class="dim small">Prize claimed ✓</p>` : "";
  const dayNo = Math.min(SEASON_DAYS, Math.floor((D.season.now - D.season.start) / 864e5) + 1);
  $("ranks-content").innerHTML = `
    <div class="season-hero"><small>SEASON 0 PRIZE POOL</small><b class="prize-big">◈ ${formatToken(LB_POOL + MINING_POOL)} $MINE</b>
      <div class="season-split"><span>🏆 ${formatToken(LB_POOL)} top ${LB_SIZE} prizes</span><span>⛏️ ${formatToken(MINING_POOL)} mining</span></div>
      <div class="season-timer"><small>${over ? "SEASON ENDED" : "TIME REMAINING"}</small><b id="season-left">${fmtLeft(seasonLeftMs())}</b></div>
      <i class="dur"><u style="width:${Math.min(100, ((D.season.now - D.season.start) / SEASON_MS) * 100)}%"></u></i>
      <small class="dim">Day ${dayNo} of ${SEASON_DAYS} · ${D.players} active players · ${formatToken(D.minedAll)} / ${formatToken(MINING_POOL)} mined · part of ${formatToken(TOTAL_POOL)} total $MINE</small></div>
    <div class="rank-me"><div><small>YOUR RANK</small><b>${mine.rank ? "#" + mine.rank : "–"}</b></div><div><small>POINTS</small><b>${fmtN(mine.pts)}</b></div><div><small>${over ? "PRIZE" : "PROJECTED PRIZE"}</small><b class="tokc">${mine.prize ? formatToken(mine.prize) : "–"}</b></div>
      <div><small>STAKE</small><b>${m.share * 100 < 0.01 ? "<0.01" : (m.share * 100).toFixed(2)}%</b></div></div>
    ${claim}
    <div class="rank-name"><span class="dim">Username:</span> <b>${esc(myName)}</b> <button type="button" class="inv-btn" data-r="rename">✎ Rename</button></div>
    <div class="rank-wrap"><table class="rank-t"><thead><tr><th>#</th><th>Player</th><th>Lvl</th><th>Power</th><th>Items</th><th>$Mine</th><th>Prize</th><th>Pts</th></tr></thead><tbody>
      ${D.rows.map((r) => tr(r, D.me && r.rank === D.me.rank && r.name === myName)).join("")}${D.me && !inTop ? `<tr class="gap"><td colspan="8">⋯</td></tr>${tr(D.me, true)}` : ""}
    </tbody></table></div>
    <p class="dim small rank-note">Points = Power + Level×20 + Items×5 + $Mine earned×0.1. Prizes shown are projected from the current rank and can be claimed when the season ends.</p>`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function renameUser() {
  openModal(`<h2>Username</h2><p>Shown on the leaderboard (2–16 letters, numbers, space . _ -).</p><input id="name-in" class="name-in" maxlength="16" value="${esc(state.name)}" />
    <div class="modal-actions"><button type="button" class="btn-primary" id="name-ok">Save</button><button type="button" class="btn-secondary" id="name-no">Cancel</button></div>`);
  $("name-ok").onclick = async () => {
    try { const r = await netRename($("name-in").value); if (!r.ok) return toast(r.error); saveState(); closeModal(); renderRanks(); }
    catch (e) { toast(e.message); }
  };
  $("name-no").onclick = closeModal;
}
function setupRanks() {
  $("ranks-content").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-r]");
    if (!b) return;
    if (b.dataset.r === "rename") renameUser();
    else if (b.dataset.r === "retry") { await netSync(); renderRanks(); }
    else if (b.dataset.r === "claim") {
      try { const r = await netClaim(); if (!r.ok) toast(r.error); else toast(r.paid ? "🏆 Prize claimed: " + formatToken(r.paid) + " $MINE!" : "Season 0 is over — thanks for playing!"); } catch (er) { toast(er.message); }
      renderHUD(); renderRanks();
    }
  });
  setInterval(() => {
    if (!ranksOpen()) return;
    setText($("season-left"), fmtLeft(seasonLeftMs()));
    if (++ranksTimer % 15 === 0) renderRanks();
  }, 1000);
}
