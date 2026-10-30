"use strict";
// Leaderboard panel (all data comes from the server).
let ranksTimer = 0, ranksData = null;
const RANKS = { tab: "season" };
const rankTabs = () => `<div class="ref-tabs">${[["season", "🏆 Season"], ["ref", "🤝 Referrals"]].map(([k, n]) => `<button type="button" class="ref-tab${RANKS.tab === k ? " on" : ""}" data-rt="${k}">${n}</button>`).join("")}</div>`;
const ranksOpen = () => !$("panel-ranks").classList.contains("hidden");
function fmtLeft(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(x).padStart(2, "0")}s`;
}
// "🥇 #1 ◈ 80,000 · #2–10 ◈ 35,556 each · #11–100 ◈ 6,667 each": what every tier of the prize pool pays (the server decides, this only displays)
function tierLine(s) {
  let from = 0;
  return s.tiers.map((t) => { const n = t.to - from, a = (s.prizePool * t.share) / n, txt = (n === 1 ? "#" + t.to : "#" + (from + 1) + "–" + t.to) + " ◈ " + formatToken(a) + (n > 1 ? " each" : ""); from = t.to; return "<span>" + (t.to === 1 ? "🥇 " : "") + txt + "</span>"; }).join("");
}
async function renderRanks() {
  if (RANKS.tab === "ref") return renderRefTab();
  if (!ranksData) $("ranks-content").innerHTML = rankTabs() + `<p class="dim small" style="padding:20px;text-align:center">Loading leaderboard…</p>`;
  try { ranksData = await netBoard(); } catch (e) {
    $("ranks-content").innerHTML = rankTabs() + `<div class="coming-soon"><span>📡</span><b>Can't reach the game server</b><small>${e.message}</small><button type="button" class="inv-btn" data-r="retry">Retry</button></div>`;
    return;
  }
  if (!ranksOpen() || RANKS.tab !== "season") return;
  const D = ranksData, over = D.season.over, mine = D.me || { rank: 0, pts: 0, prize: 0 }, m = miningInfo();
  const info = net.info, claimed = info && info.claimed;
  const medal = (r) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : r);
  const tr = (r, me) => `<tr class="${me ? "me" : ""}"><td class="rk">${medal(r.rank)}</td><td class="nmc">${me ? "⭐ " : ""}${tagHtml(r.tags)}${esc(r.name)}</td><td>${r.level}</td><td>${fmtN(r.power)}</td><td>${r.items}</td><td class="tokc">${formatToken(r.earned)}</td><td class="tokc">${r.prize ? formatToken(r.prize) : "–"}</td><td class="pts">${fmtN(r.pts)}</td></tr>`;
  const myName = info ? info.name : "";
  const inTop = D.me && D.me.rank <= LB_SIZE;
  const claim = over && info && !claimed ? `<button type="button" class="btn-primary claim" data-r="claim">🏆 Claim ${mine.prize ? formatToken(mine.prize) + " $AFKMINE" : "(no prize this season)"}</button>` : over ? `<p class="dim small">Prize claimed ✓</p>` : "";
  const dayNo = Math.min(SEASON_DAYS, Math.floor((D.season.now - D.season.start) / 864e5) + 1);
  $("ranks-content").innerHTML = rankTabs() + `
    <div class="season-hero"><small>SEASON 0 PRIZE POOL</small><b class="prize-big">◈ ${formatToken(D.season.prizePool)} $AFKMINE</b>
      <div class="season-split"><span>🏆 top ${LB_SIZE} prizes${D.season.prizePool < D.season.prizeMax - 1 ? " (max " + formatToken(D.season.prizeMax) + ", capped by the supply in circulation)" : ""}</span><span>⛏️ ${formatToken(D.season.miningPool)} mining</span></div>
      <div class="season-split">${tierLine(D.season)}</div>
      <div class="season-timer"><small>${over ? "SEASON ENDED" : "TIME REMAINING"}</small><b id="season-left">${fmtLeft(seasonLeftMs())}</b></div>
      <i class="dur"><u style="width:${Math.min(100, ((D.season.now - D.season.start) / SEASON_MS) * 100)}%"></u></i>
      <small class="dim">Day ${dayNo} of ${SEASON_DAYS} · ${D.players} active players · ${formatToken(D.minedAll)} / ${formatToken(D.season.miningPool)} mined</small></div>
    <div class="rank-me"><div><small>YOUR RANK</small><b>${mine.rank ? "#" + mine.rank : "–"}</b></div><div><small>POINTS</small><b>${fmtN(mine.pts)}</b></div><div><small>${over ? "PRIZE" : "PROJECTED PRIZE"}</small><b class="tokc">${mine.prize ? formatToken(mine.prize) : "–"}</b></div>
      <div><small>STAKE</small><b>${m.share * 100 < 0.01 ? "<0.01" : (m.share * 100).toFixed(2)}%</b></div></div>
    ${claim}
    <div class="rank-name"><span class="dim">Username:</span> <b>${esc(myName)}</b> <button type="button" class="inv-btn" data-r="rename">✎ Rename</button></div>
    <div class="rank-wrap"><table class="rank-t"><thead><tr><th>#</th><th>Player</th><th>Lvl</th><th>Power</th><th>Items</th><th>$AFKMINE</th><th>Prize</th><th>Pts</th></tr></thead><tbody>
      ${D.rows.map((r) => tr(r, D.me && r.rank === D.me.rank && r.name === myName)).join("")}${D.me && !inTop ? `<tr class="gap"><td colspan="8">⋯</td></tr>${tr(D.me, true)}` : ""}
    </tbody></table></div>
    <p class="dim small rank-note">Points = Power + Level×20 + Items×5 + $AFKMINE earned×0.1. Prizes shown are projected from the current rank and can be claimed when the season ends.</p>`;
}
const tagHtml = (tags) => (tags || []).map((t) => `<span class="tag ${t}" title="${t === "og" ? "OG: here in Season 0" : t === "ref2" ? "Referral tier 2" : "Referral tier 3"}">${t === "og" ? "OG" : t === "ref2" ? "T2" : "T3"}</span>`).join("");
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

// ---------------------------------------------------------------- referrals: your link + referral leaderboard
let refLinkText = "";
async function renderRefTab() {
  const el = $("ranks-content");
  if (!refLinkText) el.innerHTML = rankTabs() + `<p class="dim small" style="padding:20px;text-align:center">Loading…</p>`;
  let lb, mine;
  try { [lb, mine] = await Promise.all([api("GET", "referrals/leaderboard"), api("GET", "referrals")]); }
  catch (e) { el.innerHTML = rankTabs() + `<div class="coming-soon"><span>📡</span><b>Can't reach the game server</b><small>${esc(e.message)}</small><button type="button" class="inv-btn" data-r="retry">Retry</button></div>`; return; }
  if (!ranksOpen() || RANKS.tab !== "ref") return;
  refLinkText = location.origin + "/?ref=" + mine.code;
  const myName = state.name, pct = (b) => b / 100, nxt = mine.next, payD = mine.nextPayoutAt ? new Date(mine.nextPayoutAt).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "weekly";
  const row = (r, me) => `<tr class="${me ? "me" : ""}"><td class="rk">${r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : r.rank || "–"}</td><td class="nmc">${me ? "⭐ " : ""}${tagHtml(r.tags)}${esc(r.name)}</td><td>T${r.tier || 1}</td><td>${nf(r.referred)}</td><td class="tokc">${r.earnedSol ? "◎ " + fmtLam(r.earnedSol) + (r.earned ? " + " : "") : ""}${r.earned || !r.earnedSol ? "◈ " + formatToken(r.earned) : ""}</td></tr>`;
  const inTop = lb.me && lb.me.rank > 0 && lb.me.rank <= lb.rows.length;
  const people = mine.list.length ? mine.list.map((p) => `<div class="st-row"><span>${esc(p.name)}</span><b>${p.pack ? "📦 pack bought" : "<span class='dim'>no pack yet</span>"} <span class="tokc">${p.paidSol ? "◎ " + fmtLam(p.paidSol) + (p.paid ? " + " : "") : ""}${p.paid || !p.paidSol ? "◈ " + formatToken(p.paid) : ""}</span></b></div>`).join("")
    : `<p class="dim">Nobody yet — share your link!</p>`;
  el.innerHTML = rankTabs() + `<div class="ref-pad">
    <div class="inv-card"><h3>🤝 Invite friends</h3>
      <p class="dim">Share your personal link. When someone who joined through it buys a pack, you earn a share of what they spend. Rewards are collected as <b>pending</b> and paid out by hand once a week (${esc(payD)}), after a check.</p>
      <div class="ref-link"><input id="ref-link" class="name-in" readonly value="${esc(refLinkText)}" /><button type="button" class="inv-btn gold" data-r="copyref">Copy</button>${navigator.share ? `<button type="button" class="inv-btn" data-r="shareref">Share</button>` : ""}</div>
      <div class="ref-tier"><b>Your tier: ${tagHtml(mine.tags)} Tier ${mine.tier}</b> · ${pct(mine.packBps)}% of pack spending${mine.shopBps ? " + " + pct(mine.shopBps) + "% of shop spending" : ""}
        <p class="dim small">${nxt ? "Qualifying referrals (friends who bought a pack): <b>" + mine.qualifying + "</b>. " + nxt.need + " more for Tier " + nxt.tier + " (" + pct(nxt.packBps) + "%" + (nxt.shopBps ? " + " + pct(nxt.shopBps) + "% shop" : "") + ")." : "Qualifying referrals: <b>" + mine.qualifying + "</b>. You are at the top tier."} A tier only applies to purchases made after you reach it.</p></div>
      <div class="ref-stats"><div><b>${nf(mine.count)}</b><small>referred</small></div><div><b class="tokc">◎ ${fmtLam(mine.accruedLamports)}</b><small>pending</small></div><div><b class="tokc">◎ ${fmtLam(mine.paidLamports)}</b><small>paid out</small></div></div>
      ${mine.rejectedLamports ? `<p class="dim small">Rejected: ◎ ${fmtLam(mine.rejectedLamports)}</p>` : ""}
      <p class="dim small">Code: <b class="mono">${esc(mine.code)}</b>${state.ref && state.ref.by ? " · you joined through <b>" + esc(state.ref.by) + "</b>" : ""}</p></div>
    <div class="inv-card ref-list"><h3>Your referred players</h3>${people}</div>
    <h3 style="margin:12px 0 6px">🏆 Referral leaderboard</h3>
    <div class="rank-wrap"><table class="rank-t"><thead><tr><th>#</th><th>User</th><th>Tier</th><th>Referred</th><th>Earned</th></tr></thead><tbody>
      ${lb.rows.length ? lb.rows.map((r) => row(r, r.name === myName && lb.me && r.rank === lb.me.rank)).join("") : `<tr><td colspan="5" class="dim">No referrals yet — be the first!</td></tr>`}
      ${lb.me && !inTop ? `<tr class="gap"><td colspan="5">⋯</td></tr>${row(lb.me, true)}` : ""}
    </tbody></table></div>
    <p class="dim small rank-note">Ranked by referral rewards (pending + paid), then by number of referred players. Tags: gold OG = here in Season 0; T2 silver and T3 premium = referral tiers.</p></div>`;
}
async function copyRefLink() {
  try { await navigator.clipboard.writeText(refLinkText); toast("Link copied 📋"); }
  catch { const i = $("ref-link"); if (i) { i.select(); try { document.execCommand("copy"); toast("Link copied 📋"); } catch { toast("Press Ctrl+C to copy"); } } }
}
function shareRefLink() { navigator.share({ title: "Idle Mountain Miner", text: "Come mine with me!", url: refLinkText }).catch(() => {}); }
function setupRanks() {
  $("ranks-content").addEventListener("click", async (e) => {
    const tb = e.target.closest("[data-rt]");
    if (tb) { RANKS.tab = tb.dataset.rt; return renderRanks(); }
    const b = e.target.closest("[data-r]");
    if (!b) return;
    if (b.dataset.r === "copyref") return copyRefLink();
    if (b.dataset.r === "shareref") return shareRefLink();
    if (b.dataset.r === "rename") renameUser();
    else if (b.dataset.r === "retry") { await netSync(); renderRanks(); }
    else if (b.dataset.r === "claim") {
      try { const r = await netClaim(); if (!r.ok) toast(r.error); else toast(r.paid ? "🏆 Prize claimed: " + formatToken(r.paid) + " $AFKMINE!" : "Season 0 is over — thanks for playing!"); } catch (er) { toast(er.message); }
      renderHUD(); renderRanks();
    }
  });
  setInterval(() => {
    if (!ranksOpen()) return;
    setText($("season-left"), fmtLeft(seasonLeftMs()));
    if (++ranksTimer % 15 === 0) renderRanks();
  }, 1000);
}
