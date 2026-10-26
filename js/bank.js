"use strict";
// Bank panel: deposit $MINE from your wallet into the game, withdraw it back to the SAME wallet.
let bankData = null, bankBusy = false;
const BANK_STATE = { tab: "deposit" };
const stLabel = { queued: "Preparing…", signed: "Sending…", sent: "Confirming…", done: "Done ✓", failed: "Failed — refunded" };
async function renderBank() {
  const el = $("bank-content");
  if (state.guest) { el.innerHTML = `<div class="acct-pad"><div class="inv-card"><h3>🔒 Wallet needed</h3><p>Deposits and withdrawals use your Solana wallet. Tap the 👤 icon at the top right and connect one — your guest progress will move onto it.</p></div></div>`; return; }
  if (!bankData) el.innerHTML = `<p class="dim small acct-pad">Loading…</p>`;
  try { bankData = await api("GET", "bank"); bankData._at = performance.now(); } catch (e) { el.innerHTML = `<p class="dim small acct-pad">${esc(e.message)}</p>`; return; }
  drawBank();
}
function drawBank() {
  const d = bankData, el = $("bank-content");
  if (!d || !$("panel-bank") || $("panel-bank").classList.contains("hidden")) return;
  const tabs = [["deposit", "DEPOSIT"], ["withdraw", "WITHDRAW"], ["history", "HISTORY"]].map(([t, n]) => `<button type="button" class="inv-tab${BANK_STATE.tab === t ? " on" : ""}" data-bt="${t}">${n}</button>`).join("");
  let body = "";
  if (!d.tokenEnabled) body = `<div class="inv-card"><h3>🛠 Not set up yet</h3><p>The server owner has not configured the $MINE token (MINE_MINT / TREASURY_SECRET_KEY). Deposits and withdrawals are off.</p></div>`;
  else if (BANK_STATE.tab === "deposit") {
    body = `<div class="inv-card"><h3>⬇ Deposit $MINE</h3>
      <p class="dim">Send $MINE from your wallet to the game. The server checks the transaction on-chain, then credits your balance.</p>
      <div class="bk-row"><input id="bk-dep" class="name-in" type="number" min="1" step="any" inputmode="decimal" placeholder="Amount" /><button type="button" class="inv-btn gold" id="bk-dep-go">Deposit</button></div>
      <p class="dim small">Your wallet must be on <b>Solana ${esc(d.cluster)}</b> and hold the $MINE token with mint <span class="mono">${esc(short(d.mint))}</span> <button type="button" class="linkish" data-copy="${esc(d.mint)}">copy</button>.</p>
      <details class="bk-manual"><summary>Already sent $MINE yourself?</summary><p class="dim small">Send it to <span class="mono">${esc(short(d.treasury))}</span> <button type="button" class="linkish" data-copy="${esc(d.treasury)}">copy</button> from your connected wallet, then paste the transaction signature:</p>
      <div class="bk-row"><input id="bk-sig" class="name-in" placeholder="Transaction signature" /><button type="button" class="inv-btn" id="bk-sig-go">Claim</button></div></details></div>`;
  } else if (BANK_STATE.tab === "withdraw") {
    const why = !d.canWithdraw ? "Buy a pack to unlock withdrawals (Packs tab)." : "";
    const wait = d.canWithdraw ? Math.max(0, d.cooldownLeft - (performance.now() - bankData._at)) : 0, off = !!why || wait > 0;
    body = `<div class="inv-card"><h3>⬆ Withdraw $MINE</h3>
      <div class="st-row"><span>Available</span><b class="tokc">◈ ${formatToken(state.token)}</b></div>
      <div class="st-row"><span>Sent to your wallet</span><b class="mono">${esc(short(d.wallet))}</b></div>
      <div class="st-row"><span>Withdrawal fee</span><b>${pct(d.withdrawFee)}</b></div>
      <div class="st-row"><span>Max per withdrawal</span><b>${fmtN(d.maxWithdraw)} $MINE</b></div>
      <div class="st-row"><span>Cooldown</span><b>${fmtDur(d.withdrawCooldownMs)} between withdrawals</b></div>
      ${why ? `<p class="warn">🔒 ${why}</p>` : wait > 0 ? `<p class="warn">⏳ Next withdrawal possible in ${fmtDur(wait)}.</p>` : ""}
      <div class="bk-row"><input id="bk-wd" class="name-in" type="number" min="${d.minWithdraw}" max="${d.maxWithdraw}" step="any" inputmode="decimal" placeholder="Min ${fmtN(d.minWithdraw)}" ${off ? "disabled" : ""}/><button type="button" class="inv-btn" id="bk-wd-max" ${off ? "disabled" : ""}>Max</button><button type="button" class="inv-btn gold" id="bk-wd-go" ${off ? "disabled" : ""}>Withdraw</button></div>
      <p class="dim small" id="bk-wd-preview">Enter an amount: ${pct(d.withdrawFee)} stays with the game, you receive the rest.</p>
      <p class="dim small">Withdrawals always go to the wallet you signed in with and usually arrive within a minute. Withdrawing restarts the “24h without withdrawing” quest.</p></div>`;
  } else {
    const dep = d.deposits.map((h) => `<div class="st-row"><span>⬇ Deposit · ${new Date(h.t).toLocaleString()}</span><b class="tokc">+${formatToken(h.amount)}</b></div>`);
    const wd = d.withdrawals.map((w) => `<div class="st-row"><span>⬆ ${new Date(w.created).toLocaleString()} · ${stLabel[w.state] || w.state}${w.sig ? ` · <a class="linkish" target="_blank" rel="noopener noreferrer" href="${esc(Wallet.explorer(w.sig))}">view</a>` : ""}${w.error && w.state === "failed" ? `<br><small class="dim">${esc(w.error)}</small>` : ""}</span><b class="tokc">−${formatToken(w.amount)}<br><small class="dim">${formatToken(w.net)} sent · fee ${formatToken(w.fee || 0)}</small></b></div>`);
    body = `<div class="inv-card"><h3>📜 Recent activity</h3>${dep.concat(wd).join("") || `<p class="dim">Nothing yet.</p>`}</div>`;
  }
  el.innerHTML = `<div class="acct-pad"><div class="inv-top"><span class="inv-title">🏦 BANK</span><nav>${tabs}</nav></div>
    <div class="inv-card"><div class="st-row"><span>In-game $MINE</span><b class="tokc">◈ ${formatToken(state.token)}</b></div><div class="st-row"><span>Network</span><b>Solana ${esc(d.cluster)}</b></div></div>${body}</div>`;
}
async function waitConfirm(path, payload) { // poll the server until it has seen the transaction on-chain
  for (let i = 0; i < 45; i++) {
    const r = await netPost(path, payload);
    if (r.status === "ok") return r;
    await sleep(2500);
  }
  return { status: "pending" };
}
async function bankClick(e) {
  const t = e.target.closest("[data-bt]");
  if (t) { BANK_STATE.tab = t.dataset.bt; return drawBank(); }
  const cp = e.target.closest("[data-copy]");
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast("Copied"); } catch { toast("Copy failed"); } return; }
  if (bankBusy) return;
  const id = e.target.id;
  const run = async (fn) => { bankBusy = true; try { await fn(); } catch (er) { toast(/reject|denied|cancel/i.test(er.message) ? "Cancelled" : er.message); } bankBusy = false; try { bankData = await api("GET", "bank"); bankData._at = performance.now(); } catch { /* */ } drawBank(); renderHUD(); };
  if (id === "bk-dep-go") {
    const amount = parseFloat($("bk-dep").value);
    if (!(amount > 0)) return toast("Enter an amount");
    return run(async () => {
      await Wallet.ensure(state.wallet);
      const p = await netPost("bank/deposit/prepare", { amount });
      const sig = await Wallet.signAndSend(p.tx);
      toast("Deposit sent — waiting for the network…");
      const r = await waitConfirm("bank/deposit/confirm", { signature: sig });
      toast(r.status === "ok" ? "✅ Deposited " + formatToken(r.credited) + " $MINE" : "Still confirming… it will be credited once it lands; press Claim with the signature if needed.");
    });
  }
  if (id === "bk-sig-go") {
    const signature = $("bk-sig").value.trim();
    if (!signature) return toast("Paste the signature");
    return run(async () => { const r = await waitConfirm("bank/deposit/confirm", { signature }); toast(r.status === "ok" ? "✅ Deposited " + formatToken(r.credited) + " $MINE" : "Not confirmed yet — try again in a moment"); });
  }
  if (id === "bk-wd-max") { const m = Math.min(Math.floor(state.token * 1e6) / 1e6, bankData.maxWithdraw); $("bk-wd").value = m > 0 ? String(m) : ""; return wdPreview(); }
  if (id === "bk-wd-go") {
    const amount = parseFloat($("bk-wd").value);
    if (!(amount > 0)) return toast("Enter an amount");
    if (amount < bankData.minWithdraw) return toast("Minimum withdrawal is " + fmtN(bankData.minWithdraw) + " $MINE");
    if (amount > bankData.maxWithdraw) return toast("Maximum per withdrawal is " + fmtN(bankData.maxWithdraw) + " $MINE");
    const fee = amount * bankData.withdrawFee;
    return confirmModal("Withdraw?", `Take <b>${formatToken(amount)} $MINE</b> from your balance. Fee ${pct(bankData.withdrawFee)} (${formatToken(fee)}) — <b>${formatToken(amount - fee)} $MINE</b> are sent to ${esc(short(bankData.wallet))}. Your next withdrawal is possible in ${fmtDur(bankData.withdrawCooldownMs)}.`, "Withdraw", () => run(async () => {
      await netPost("bank/withdraw", { amount });
      toast("Withdrawal started — it will arrive in your wallet shortly.");
      BANK_STATE.tab = "history";
    }));
  }
}
function wdPreview() { // live "you receive" line under the withdraw box
  const el = $("bk-wd-preview"), a = parseFloat($("bk-wd") && $("bk-wd").value);
  if (!el || !bankData) return;
  el.textContent = a > 0 ? "You receive ◈ " + formatToken(a * (1 - bankData.withdrawFee)) + " $MINE (fee ◈ " + formatToken(a * bankData.withdrawFee) + ")." : "Enter an amount: " + pct(bankData.withdrawFee) + " stays with the game, you receive the rest.";
}
function setupBank() {
  $("bank-content").addEventListener("click", bankClick);
  $("bank-content").addEventListener("input", (e) => { if (e.target.id === "bk-wd") wdPreview(); });
  setInterval(() => { if ($("panel-bank") && !$("panel-bank").classList.contains("hidden") && !bankBusy && net.token && BANK_STATE.tab === "history") renderBank(); }, 8000);
}
