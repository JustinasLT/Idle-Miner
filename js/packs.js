"use strict";
// Packs panel: three one-time packs, payable in SOL (straight to the game's wallet) or in $MINE (10 % cheaper).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEAR_NAMES = { 3: "Epic", 4: "Legendary", 5: "Mythic" };
const fmtSol = (x) => (x >= 1 ? x.toFixed(3) : x.toFixed(4)).replace(/0+$/, "").replace(/\.$/, "");
function ensureWalletAccount() {
  if (state.guest) { toast("Connect a wallet first (tap the 👤 icon)"); return false; }
  return true;
}
function renderPacks() {
  const cfg = net.config, el = $("packs-content");
  if (!cfg || !net.info) { el.innerHTML = `<p class="dim small acct-pad">Loading…</p>`; return; }
  const f = net.info.free, earned = f.earned, pct = Math.min(100, (earned / f.cap) * 100);
  const meter = state.paid ? `<div class="inv-card"><h3>✅ You own a pack</h3><p class="dim">Mining has no free-tier cap. Withdrawals are unlocked (see the Bank tab).</p></div>`
    : `<div class="inv-card"><h3>🆓 Free tier</h3>
        <div class="st-row"><span>$MINE mined so far</span><b class="tokc">◈ ${formatToken(earned)} / ${fmtN(f.cap)}</b></div>
        <i class="dur"><u style="width:${pct}%"></u></i>
        <p class="dim small">${earned >= f.cap ? "You reached the free limit — mining is paused. Any pack restarts it." : "Free players can play everything but cannot withdraw, and stop earning $MINE at " + fmtN(f.cap) + "."}
        <br>Your $MINE balance counts toward a pack when you pay in $MINE, so after the free ${fmtN(f.cap)} you only need to deposit the difference.</p></div>`;
  el.innerHTML = `<div class="acct-pad">${meter}${cfg.packs.map((p) => {
    const owned = !!state.packs[p.id], need = Math.max(0, p.mine - state.token);
    const mineBtn = owned ? "" : `<button type="button" class="pk-btn mine" data-pk="${p.id}" data-how="mine">Pay ${fmtN(p.mine)} $MINE<small>${need > 0 ? "need " + formatToken(need) + " more" : "10% cheaper than SOL"}</small></button>`;
    const solBtn = owned ? "" : `<button type="button" class="pk-btn sol" data-pk="${p.id}" data-how="sol" ${cfg.payEnabled ? "" : "disabled"}>Pay ${fmtSol(p.sol)} SOL<small>${cfg.payEnabled ? "goes straight to the game" : "not set up yet"}</small></button>`;
    return `<div class="pack-card t${p.id}${owned ? " owned" : ""}"><div class="pack-head"><b>${["", "🥉", "🥈", "🥇"][p.id]} ${p.name}</b>${owned ? `<span class="badge">OWNED ✓</span>` : ""}</div>
      <ul class="pack-perks"><li>🛡️ 8 ${GEAR_NAMES[p.gear]} gear pieces, one per slot (auto-equipped)</li><li>🪙 ${formatMoney(p.cash)} cash</li><li>⭐ +${fmtN(p.xp)} hero XP</li><li>📦 ${p.crates} equipment crates</li><li>💸 Unlocks $MINE withdrawals &amp; endless mining</li></ul>
      ${owned ? "" : `<div class="pack-buy">${mineBtn}${solBtn}</div>`}</div>`;
  }).join("")}<p class="dim small">Each pack can be bought once. Prices are fixed by the server. Network: Solana ${esc(cfg.cluster)}.</p></div>`;
}
let packBusy = false;
async function onPackClick(e) {
  const b = e.target.closest("[data-pk]");
  if (!b || b.disabled || packBusy) return;
  if (!ensureWalletAccount()) return;
  const id = +b.dataset.pk, pack = net.config.packs.find((p) => p.id === id);
  if (b.dataset.how === "mine") {
    if (state.token < pack.mine) return toast("You need " + formatToken(pack.mine - state.token) + " more $MINE — deposit it in the Bank tab");
    return confirmModal("Buy " + pack.name + "?", `Pay ${fmtN(pack.mine)} $MINE from your in-game balance (${formatToken(state.token)}).`, "Buy", async () => {
      packBusy = true;
      try { await netPost("pack/mine", { pack: id }); toast("🎉 " + pack.name + " pack unlocked!"); }
      catch (er) { toast(er.message); }
      packBusy = false; renderPacks(); renderHUD();
    });
  }
  confirmModal("Buy " + pack.name + "?", `Your wallet will ask you to approve a payment of ${fmtSol(pack.sol)} SOL on Solana ${esc(net.config.cluster)}.`, "Open wallet", async () => {
    packBusy = true;
    try {
      await Wallet.ensure(state.wallet);
      const o = await netPost("pack/order", { pack: id });
      const sig = await Wallet.signAndSend(o.tx);
      toast("Payment sent — waiting for the network…");
      let done = false;
      for (let i = 0; i < 45 && !done; i++) {
        await sleep(2500);
        const r = await netPost("pack/confirm", { order: o.orderId, signature: sig });
        done = r.status === "ok";
      }
      toast(done ? "🎉 " + pack.name + " pack unlocked!" : "Still confirming… check back in a minute (your payment is safe).");
    } catch (er) { toast(/reject|denied|cancel/i.test(er.message) ? "Payment cancelled" : er.message); }
    packBusy = false; renderPacks(); renderHUD();
  });
}
function setupPacks() { $("packs-content").addEventListener("click", onPackClick); }
