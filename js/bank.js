"use strict";
// Bank panel: Deposit SOL from your wallet, Withdraw SOL back to the SAME wallet, Trade $AFKMINE <-> SOL (js/trade.js), History.
// The only real blockchain operations are SOL deposits and SOL withdrawals. $AFKMINE is an in-game currency (no token mint).
let bankData = null, bankBusy = false;
const BANK_STATE = { tab: "deposit" };
const stLabel = { pending: "⏳ Waiting for approval", approved: "Approved — sending…", queued: "Approved — sending…", signed: "Sending…", sent: "Sent — confirming…", done: "Sent ✓", rejected: "✖ Rejected", failed: "Failed — SOL stays locked, the team will retry or refund" };
const BANK_TABS = [["deposit", "DEPOSIT"], ["withdraw", "WITHDRAW"], ["trade", "TRADE"], ["history", "HISTORY"]];
async function renderBank() {
  const el = $("bank-content");
  if (state.guest) { el.innerHTML = `<div class="acct-pad"><div class="inv-card"><h3>🔒 Wallet needed</h3><p>Deposits, withdrawals and trading use your Solana wallet. Tap the 👤 icon at the top right and connect one — your guest progress will move onto it.</p></div></div>`; return; }
  if (!bankData) el.innerHTML = `<p class="dim small acct-pad">Loading…</p>`;
  try { bankData = await api("GET", "bank"); bankData._at = performance.now(); } catch (e) { el.innerHTML = `<p class="dim small acct-pad">${esc(e.message)}</p>`; return; }
  drawBank();
}
function depositHTML(d) {
  return `<div class="inv-card"><h3>⬇ Deposit SOL</h3>
      <p class="dim">Send SOL from your wallet to the game. The server checks the transaction on-chain, then credits your SOL balance. Between ${fmtLam(d.minDeposit)} and ${fmtLam(d.maxDeposit)} SOL.</p>
      <div class="bk-row"><input id="bk-dep" class="name-in" type="text" inputmode="decimal" autocomplete="off" placeholder="Amount in SOL" /><button type="button" class="inv-btn gold" id="bk-dep-go">Deposit</button></div>
      <p class="dim small">Your wallet must be on <b>Solana ${esc(d.cluster)}</b>. Your SOL balance can be used for packs, traded for $AFKMINE, or withdrawn again.</p>
      <details class="bk-manual"><summary>Already sent SOL yourself?</summary><p class="dim small">Send it to <span class="mono">${esc(short(d.treasury))}</span> <button type="button" class="linkish" data-copy="${esc(d.treasury)}">copy</button> from your connected wallet, then paste the transaction signature:</p>
      <div class="bk-row"><input id="bk-sig" class="name-in" placeholder="Transaction signature" /><button type="button" class="inv-btn" id="bk-sig-go">Claim</button></div></details></div>`;
}
function withdrawHTML(d) {
  const why = !d.canWithdraw ? "Buy a pack to unlock withdrawals (Packs tab)." : "";
  const wait = d.canWithdraw ? Math.max(0, d.cooldownLeft - (performance.now() - bankData._at)) : 0;
  const open = d.withdrawals.find((w) => w.unit === "sol" && (w.status === "pending" || w.status === "failed")), off = !!why || wait > 0 || !!open;
  return `<div class="inv-card"><h3>⬆ Withdraw SOL</h3>
      <div class="st-row"><span>Available</span><b class="solc">◎ ${fmtLam(state.sol)} SOL</b></div>
      <div class="st-row"><span>Sent to your wallet</span><b class="mono">${esc(short(d.wallet))}</b></div>
      <div class="st-row"><span>Withdrawal fee</span><b>${pct(d.withdrawFee)}</b></div>
      <div class="st-row"><span>Per withdrawal</span><b>${fmtLam(d.minWithdraw)} – ${fmtLam(d.maxWithdraw)} SOL</b></div>
      <div class="st-row"><span>Cooldown</span><b>${fmtDur(d.withdrawCooldownMs)} between withdrawals</b></div>
      ${open ? `<p class="warn">⏳ Your request for ◎ ${fmtLam(open.amount)} SOL is ${open.status === "pending" ? "waiting for approval" : "being retried by the game team"}. The SOL is locked until then.</p>` : ""}
      ${why ? `<p class="warn">🔒 ${why}</p>` : wait > 0 && !open ? `<p class="warn">⏳ Next withdrawal possible in ${fmtDur(wait)}.</p>` : ""}
      <div class="bk-row"><input id="bk-wd" class="name-in" type="text" inputmode="decimal" autocomplete="off" placeholder="Min ${fmtLam(d.minWithdraw)} SOL" ${off ? "disabled" : ""}/><button type="button" class="inv-btn" id="bk-wd-max" ${off ? "disabled" : ""}>Max</button><button type="button" class="inv-btn gold" id="bk-wd-go" ${off ? "disabled" : ""}>Withdraw</button></div>
      <p class="dim small" id="bk-wd-preview">Enter an amount: ${pct(d.withdrawFee)} stays with the game, you receive the rest.</p>
      <p class="dim small">Every withdrawal is <b>checked and approved by hand</b> before it is sent, so it can take a while. The SOL is locked while it waits; if a request is rejected you get the SOL back together with the reason. Withdrawals always go to the wallet you signed in with. Withdrawing restarts the “24h without withdrawing” quest. $AFKMINE cannot be withdrawn: sell it for SOL in the Trade tab first.</p></div>`;
}
function historyHTML(d) {
  const dep = d.deposits.map((h) => `<div class="st-row"><span>⬇ Deposit · ${new Date(h.t).toLocaleString()}</span><b class="solc">+${fmtLam(h.lamports)} SOL</b></div>`);
  const wd = d.withdrawals.map((w) => {
    const sol = w.unit === "sol", f = sol ? (x) => fmtLam(x) + " SOL" : (x) => formatToken(x) + " $AFKMINE";
    return `<div class="st-row"><span>⬆ ${new Date(w.created).toLocaleString()} · ${stLabel[sol ? w.status : w.state] || w.state}${w.reason ? ` · ${esc(w.reason)}` : ""}${sol ? "" : " · old token withdrawal"}${w.sig ? ` · <a class="linkish" target="_blank" rel="noopener noreferrer" href="${esc(Wallet.explorer(w.sig))}">view</a>` : ""}${w.error && w.state === "failed" ? `<br><small class="dim">${esc(w.error)}</small>` : ""}</span><b class="${sol ? "solc" : "tokc"}">−${f(w.amount)}<br><small class="dim">${f(w.net)} sent · fee ${f(w.fee || 0)}</small></b></div>`;
  });
  return `<div class="inv-card"><h3>📜 Recent activity</h3>${dep.concat(wd).join("") || `<p class="dim">Nothing yet.</p>`}</div>`;
}
function drawBank() {
  const d = bankData, el = $("bank-content");
  if (!d || !$("panel-bank") || $("panel-bank").classList.contains("hidden")) return;
  if (!$("bk-shell")) el.innerHTML = `<div class="acct-pad" id="bk-shell"><div class="inv-top"><span class="inv-title">🏦 BANK</span><nav id="bk-tabs"></nav></div><div id="bk-bal"></div><div id="bk-body"></div></div>`;
  const tab = BANK_STATE.tab;
  $("bk-tabs").innerHTML = BANK_TABS.map(([t, n]) => `<button type="button" class="inv-tab${tab === t ? " on" : ""}" data-bt="${t}">${n}</button>`).join("");
  $("bk-bal").innerHTML = `<div class="inv-card"><div class="st-row"><span>In-game SOL</span><b class="solc">◎ ${fmtLam(state.sol)}</b></div><div class="st-row"><span>In-game $AFKMINE</span><b class="tokc">◈ ${formatToken(state.token)}</b></div><div class="st-row"><span>Network</span><b>Solana ${esc(d.cluster)}</b></div></div>`;
  const body = $("bk-body");
  if (tab === "trade") {
    if (body._tab !== "trade") { body.innerHTML = tradeHTML(); body._tab = "trade"; tradeOpened(); } else tradeUpdate();   // keep the typed amount while prices refresh
    return;
  }
  body._tab = tab;
  if (!d.enabled && (tab === "deposit" || tab === "withdraw")) body.innerHTML = `<div class="inv-card"><h3>🛠 Not set up yet</h3><p>The server owner has not configured the treasury wallet (TREASURY_SECRET_KEY). SOL deposits and withdrawals are off. You can still trade $AFKMINE for SOL with your game balance.</p></div>`;
  else body.innerHTML = tab === "deposit" ? depositHTML(d) : tab === "withdraw" ? withdrawHTML(d) : historyHTML(d);
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
  if (e.target.closest("#tr-root")) return tradeClick(e);
  if (bankBusy) return;
  const id = e.target.id;
  const run = async (fn) => { bankBusy = true; try { await fn(); } catch (er) { toast(/reject|denied|cancel/i.test(er.message) ? "Cancelled" : er.message); } bankBusy = false; try { bankData = await api("GET", "bank"); bankData._at = performance.now(); } catch { /* */ } drawBank(); renderHUD(); };
  if (id === "bk-dep-go") {
    const lamports = Shared.parseUnits($("bk-dep").value, 9);
    if (!lamports) return toast("Enter an amount in SOL, e.g. 0.5");
    return run(async () => {
      await Wallet.ensure(state.wallet);
      const p = await netPost("bank/deposit/prepare", { lamports });
      const sig = await Wallet.signAndSend(p.tx);
      toast("Deposit sent — waiting for the network…");
      const r = await waitConfirm("bank/deposit/confirm", { signature: sig });
      toast(r.status === "ok" ? "✅ Deposited " + fmtLam(r.credited) + " SOL" : "Still confirming… it will be credited once it lands; press Claim with the signature if needed.");
    });
  }
  if (id === "bk-sig-go") {
    const signature = $("bk-sig").value.trim();
    if (!signature) return toast("Paste the signature");
    return run(async () => { const r = await waitConfirm("bank/deposit/confirm", { signature }); toast(r.status === "ok" ? "✅ Deposited " + fmtLam(r.credited) + " SOL" : "Not confirmed yet — try again in a moment"); });
  }
  if (id === "bk-wd-max") { const m = Math.min(state.sol, bankData.maxWithdraw); $("bk-wd").value = m > 0 ? unitsText(m, 9) : ""; return wdPreview(); }
  if (id === "bk-wd-go") {
    const lamports = Shared.parseUnits($("bk-wd").value, 9);
    if (!lamports) return toast("Enter an amount in SOL");
    if (lamports < bankData.minWithdraw) return toast("Minimum withdrawal is " + fmtLam(bankData.minWithdraw) + " SOL");
    if (lamports > bankData.maxWithdraw) return toast("Maximum per withdrawal is " + fmtLam(bankData.maxWithdraw) + " SOL");
    if (lamports > state.sol) return toast("Not enough SOL in your balance");
    const fee = Math.ceil((lamports * Math.round(bankData.withdrawFee * 10000)) / 10000);
    return confirmModal("Withdraw?", `Take <b>${fmtLam(lamports)} SOL</b> from your balance. Fee ${pct(bankData.withdrawFee)} (${fmtLam(fee)} SOL) — <b>${fmtLam(lamports - fee)} SOL</b> are sent to ${esc(short(bankData.wallet))}. Your next withdrawal is possible in ${fmtDur(bankData.withdrawCooldownMs)}.`, "Withdraw", () => run(async () => {
      await netPost("bank/withdraw", { lamports });
      toast("Withdrawal requested — it is waiting for approval.");
      BANK_STATE.tab = "history";
    }));
  }
}
function wdPreview() { // live "you receive" line under the withdraw box
  const el = $("bk-wd-preview"), a = Shared.parseUnits($("bk-wd") && $("bk-wd").value, 9);
  if (!el || !bankData) return;
  const bps = Math.round(bankData.withdrawFee * 10000);
  el.textContent = a > 0 ? "You receive ◎ " + fmtLam(a - Math.ceil((a * bps) / 10000)) + " SOL (fee ◎ " + fmtLam(Math.ceil((a * bps) / 10000)) + ")." : "Enter an amount: " + pct(bankData.withdrawFee) + " stays with the game, you receive the rest.";
}
function setupBank() {
  $("bank-content").addEventListener("click", bankClick);
  $("bank-content").addEventListener("input", (e) => { if (e.target.id === "bk-wd") wdPreview(); else if (e.target.id === "tr-amt") tradeQuoteUpdate(); });
  setInterval(() => { if ($("panel-bank") && !$("panel-bank").classList.contains("hidden") && !bankBusy && net.token && (BANK_STATE.tab === "history" || (BANK_STATE.tab === "withdraw" && $("bk-wd") && !$("bk-wd").value))) renderBank(); }, 8000);
  setupTrade();
}
