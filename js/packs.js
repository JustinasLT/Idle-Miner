"use strict";
// Packs panel: three one-time packs (a head start, not a shortcut), payable from the in-game SOL balance or in $AFKMINE (10 % cheaper, at the market price).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEAR_NAMES = { 2: "Rare", 3: "Epic", 4: "Legendary", 5: "Mythic" };
const fmtSol = (x) => (x >= 1 ? x.toFixed(3) : x.toFixed(4)).replace(/0+$/, "").replace(/\.$/, "");
function ensureWalletAccount() {
  if (state.guest) { toast("Connect a wallet first (tap the ⚙️ icon)"); return false; }
  return true;
}
function renderPacks() {
  const cfg = net.config, el = $("packs-content");
  if (!cfg || !net.info) { el.innerHTML = `<p class="dim small acct-pad">Loading…</p>`; return; }
  const f = net.info.free, earned = f.earned, pct = Math.min(100, (earned / f.cap) * 100);
  const meter = state.paid ? `<div class="inv-card"><h3>✅ You own a pack</h3><p class="dim">Mining has no free-tier cap. Selling $AFKMINE for SOL and withdrawing SOL are unlocked (see the Bank tab).</p></div>`
    : `<div class="inv-card"><h3>🆓 Free tier</h3>
        <div class="st-row"><span>$AFKMINE mined so far</span><b class="tokc">◈ ${formatToken(earned)} / ${fmtN(f.cap)}</b></div>
        <i class="dur"><u style="width:${pct}%"></u></i>
        <p class="dim small">${earned >= f.cap ? "You reached the free limit — mining is paused. Any pack restarts it." : "Free players can play everything but cannot sell $AFKMINE for SOL or withdraw SOL, and stop earning $AFKMINE at " + fmtN(f.cap) + "."}
        <br>Pay with your $AFKMINE balance (10% cheaper — the price follows the market) or with SOL from your balance (Bank → Deposit).</p></div>`;
  const bal = `<div class="inv-card"><div class="st-row"><span>Your SOL</span><b class="solc">◎ ${fmtLam(state.sol)} SOL</b></div><div class="st-row"><span>Your $AFKMINE</span><b class="tokc">◈ ${formatToken(state.token)}</b></div></div>`;
  el.innerHTML = `<div class="acct-pad">${bal}${meter}${cfg.packs.map((p) => {
    const owned = !!state.packs[p.id], need = Math.max(0, p.mine - state.token), needSol = Math.max(0, p.lamports - state.sol);
    const mineBtn = owned ? "" : `<button type="button" class="pk-btn mine" data-pk="${p.id}" data-how="mine">Pay ◈ ${fmtN(p.mine)} $AFKMINE<small>${need > 0 ? "need " + formatToken(need) + " more" : "10% cheaper than SOL"}</small></button>`;
    const solBtn = owned ? "" : `<button type="button" class="pk-btn sol" data-pk="${p.id}" data-how="sol">Pay ◎ ${fmtSol(p.sol)} SOL<small>${needSol > 0 ? "need " + fmtLam(needSol) + " more — deposit in the Bank" : "from your SOL balance"}</small></button>`;
    return `<div class="pack-card t${p.id}${owned ? " owned" : ""}"><div class="pack-head"><b>${["", "🥉", "🥈", "🥇"][p.id]} ${p.name}</b>${owned ? `<span class="badge">OWNED ✓</span>` : ""}</div>
      <ul class="pack-perks"><li>🛡️ ${p.pieces} ${GEAR_NAMES[p.gear]} gear pieces (${p.slots.join(", ")}), auto-equipped</li><li>🪙 ${formatMoney(p.cash)} cash</li><li>⭐ +${fmtN(p.xp)} manager XP</li><li>📦 ${p.crates} equipment crate${p.crates === 1 ? "" : "s"}</li><li>💸 Unlocks selling $AFKMINE for SOL, SOL withdrawals &amp; endless mining</li></ul>
      ${owned ? "" : `<div class="pack-buy">${mineBtn}${solBtn}</div>`}</div>`;
  }).join("")}<p class="dim small">Each pack can be bought once. SOL prices are fixed by the server; the $AFKMINE price is the SOL price minus 10%, converted at the market price of the moment. Paid $AFKMINE is ${net.config.sinkMode === "recycle" ? "returned to the pool" : "burned"}.</p></div>`;
}
// prices in $AFKMINE follow the market, so fetch them fresh whenever the panel opens
async function refreshPacks() { try { net.config = await api("GET", "config"); } catch { /* keep the old numbers */ } renderPacks(); }
let packBusy = false;
async function onPackClick(e) {
  const b = e.target.closest("[data-pk]");
  if (!b || b.disabled || packBusy) return;
  if (!ensureWalletAccount()) return;
  const id = +b.dataset.pk, pack = net.config.packs.find((p) => p.id === id);
  const go = async (path, body) => {
    packBusy = true;
    try { await netPost(path, body); toast("🎉 " + pack.name + " pack unlocked!"); }
    catch (er) { toast(er.message); }
    packBusy = false; await refreshPacks(); renderHUD();
  };
  if (b.dataset.how === "mine") {
    if (state.token < pack.mine) return toast("You need " + formatToken(pack.mine - state.token) + " more $AFKMINE — mine it or buy it in the Bank → Trade tab");
    return confirmModal("Buy " + pack.name + "?", `Pay about ${fmtN(pack.mine)} $AFKMINE from your in-game balance (${formatToken(state.token)}). The price follows the market and may move up to 3% before the server processes this.`, "Buy", () => go("pack/mine", { pack: id, maxMine: Math.ceil(pack.mine * 1.03) }));
  }
  if (state.sol < pack.lamports) return toast("You need " + fmtLam(pack.lamports - state.sol) + " more SOL — deposit it in the Bank tab");
  confirmModal("Buy " + pack.name + "?", `Pay ${fmtSol(pack.sol)} SOL from your in-game SOL balance (${fmtLam(state.sol)} SOL).`, "Buy", () => go("pack/sol", { pack: id }));
}
function setupPacks() { $("packs-content").addEventListener("click", onPackClick); }
