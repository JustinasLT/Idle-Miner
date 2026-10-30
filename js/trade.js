"use strict";
// Bank → Trade tab: swap SOL <-> $AFKMINE in the game's VIRTUAL constant-product pool (x*y = k).
// The numbers shown here come from Shared.quote — the very same function the server uses to settle the trade. The server recomputes everything
// from its own pool state and ignores the price shown here; the "minimum received" (slippage) we send is only a protection for the player.
const TRADE = { side: "buy", slip: 1, pool: null, busy: false, err: "" };
const tradeVisible = () => !!$("tr-root") && !!$("panel-bank") && !$("panel-bank").classList.contains("hidden") && BANK_STATE.tab === "trade";
const tradeDec = () => (TRADE.side === "buy" ? 9 : 6);
const big = (x) => BigInt(String(x));

function tradeHTML() {
  return `<div id="tr-root">
    <div class="inv-card tr-head">
      <div class="tr-pricebox"><small>$AFKMINE PRICE</small><b id="tr-price">…</b><span class="tr-chg" id="tr-chg"></span></div>
      <div class="tr-chart" id="tr-chart"></div>
      <div class="tr-stats">
        <div><small>POOL SOL</small><b id="tr-sol">…</b></div><div><small>POOL $AFKMINE</small><b id="tr-tok">…</b></div>
        <div><small>CIRCULATING</small><b id="tr-circ">…</b></div><div><small>FEE</small><b id="tr-fee">…</b></div>
      </div>
      <p class="dim small" id="tr-note"></p>
    </div>
    <div class="inv-card">
      <div class="tr-toggle"><button type="button" id="tr-buy" data-tside="buy">BUY</button><button type="button" id="tr-sell" data-tside="sell">SELL</button></div>
      <div class="st-row"><span>Your SOL</span><b class="solc" id="tr-bsol"></b></div>
      <div class="st-row"><span>Your $AFKMINE</span><b class="tokc" id="tr-bafk"></b></div>
      <label class="tr-lbl" for="tr-amt" id="tr-lbl">You pay (SOL)</label>
      <div class="bk-row"><input id="tr-amt" class="name-in" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" /><button type="button" class="inv-btn" id="tr-max" data-tmax="1">MAX</button></div>
      <div class="tr-quote" id="tr-quote"></div>
      <div class="tr-slip"><span class="dim small">Slippage</span>${[0.5, 1, 3, 5].map((s) => `<button type="button" class="tr-sl" data-slip="${s}">${s}%</button>`).join("")}</div>
      <p class="warn" id="tr-warn"></p>
      <button type="button" class="inv-btn gold tr-go" id="tr-go" data-tgo="1">Buy $AFKMINE</button>
      <p class="dim small" id="tr-limits"></p>
    </div>
    <div class="inv-card"><h3>Recent trades</h3><div id="tr-trades" class="tr-trades"></div></div>
  </div>`;
}
function tradeOpened() { loadPool(); tradeUpdate(); }
async function loadPool() {
  try { TRADE.pool = await api("GET", "pool"); TRADE.err = ""; } catch (e) { TRADE.err = e.message; }
  if (tradeVisible()) tradeUpdate();
}
// stepped price line (the price only changes when somebody trades), inline SVG
function tradeChart(h, now) {
  const W = 300, H = 90, P = 6;
  if (!h || !h.length) return "";
  let pts = h.slice(); if (pts.length === 1) pts = [[pts[0][0] - 36e5, pts[0][1]], pts[0]];
  pts.push([Math.max(now, pts[pts.length - 1][0] + 1), pts[pts.length - 1][1]]);
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const flat = hi === lo, span = flat ? hi || 1e-9 : hi - lo;
  const X = (t) => (P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P)).toFixed(1), Y = (v) => (H - P - (flat ? 0.5 : (v - lo) / span) * (H - 2 * P)).toFixed(1);
  let d = "M" + X(pts[0][0]) + "," + Y(pts[0][1]);
  for (let i = 1; i < pts.length; i++) d += " H" + X(pts[i][0]) + " V" + Y(pts[i][1]);
  const up = pts[pts.length - 1][1] >= pts[0][1];
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price history"><path class="tr-area ${up ? "up" : "dn"}" d="${d} V${H - P} H${X(t0)} Z"/><path class="tr-line ${up ? "up" : "dn"}" d="${d}"/></svg>
    <span class="tr-hi">${fmtPrice(hi)}</span><span class="tr-lo">${fmtPrice(lo)}</span>`;
}
function tradeUpdate() {
  if (!tradeVisible()) return;
  const P = TRADE.pool, st = state.trade || {};
  $("tr-buy").classList.toggle("on", TRADE.side === "buy"); $("tr-sell").classList.toggle("on", TRADE.side === "sell");
  document.querySelectorAll(".tr-sl").forEach((b) => b.classList.toggle("on", +b.dataset.slip === TRADE.slip));
  setText($("tr-lbl"), TRADE.side === "buy" ? "You pay (SOL)" : "You sell ($AFKMINE)");
  setText($("tr-go"), TRADE.side === "buy" ? "Buy $AFKMINE" : "Sell for SOL");
  $("tr-go").classList.toggle("sell", TRADE.side === "sell");
  setText($("tr-bsol"), "◎ " + fmtLam(state.sol)); setText($("tr-bafk"), "◈ " + formatToken(state.token));
  if (!P) { setText($("tr-note"), TRADE.err || "Loading the market…"); setText($("tr-price"), "…"); tradeQuoteUpdate(); return; }
  setText($("tr-price"), "◎ " + fmtPrice(P.price));
  const c = $("tr-chg"); setText(c, (P.change24h >= 0 ? "▲ +" : "▼ ") + P.change24h.toFixed(2) + "% 24h"); c.className = "tr-chg " + (P.change24h >= 0 ? "up" : "dn");
  setText($("tr-sol"), "◎ " + fmtLam(+P.solReserve)); setText($("tr-tok"), "◈ " + formatToken(+P.tokenReserve / 1e6));
  setText($("tr-circ"), "◈ " + formatToken(P.circulating)); setText($("tr-fee"), (P.feeBps / 100).toFixed(2).replace(/\.?0+$/, "") + "%");
  const chart = tradeChart(P.history, P.now); if ($("tr-chart")._h !== chart) { $("tr-chart").innerHTML = chart; $("tr-chart")._h = chart; }
  setText($("tr-note"), "A virtual pool that lives only in the game's database: prices follow x·y = k, buyers move the price up and sellers move it down. " +
    "Game rewards are " + (P.emissionMode === "mint" ? "newly created" : "paid from a limited reserve") + "; $AFKMINE spent in the game is " + (P.sinkMode === "burn" ? "burned" : "returned to the pool") + ".");
  const trades = P.trades.length ? P.trades.slice(0, 12).map((t) => `<div class="tr-row ${t.side}"><span>${new Date(t.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${t.side === "buy" ? "BUY" : "SELL"} · ${esc(t.name)}</span><b>${formatToken(t.micro / 1e6)} ◈ <small class="dim">for ${fmtLam(t.lamports)} ◎</small></b></div>`).join("") : `<p class="dim small">No trades yet.</p>`;
  if ($("tr-trades")._h !== trades) { $("tr-trades").innerHTML = trades; $("tr-trades")._h = trades; }
  const L = P.limits, left = Math.max(0, (st.cooldownLeft || 0) - (performance.now() - (net.viewAt || 0)));
  setText($("tr-limits"), "Max per trade " + L.maxTradePct + "% of the pool · " + Math.round(L.cooldownMs / 1000) + " s between your trades · sell limit " + fmtLam(L.dailySellCapLamports) + " SOL per day (" + fmtLam(Math.max(0, L.dailySellCapLamports - (st.soldToday || 0))) + " left today)" + (left > 0 ? " · wait " + Math.ceil(left / 1000) + " s" : "") + ".");
  tradeQuoteUpdate();
}
// the live quote under the amount box (also re-run on every keystroke)
function tradeQuoteUpdate() {
  const q = $("tr-quote"), warn = $("tr-warn"), go = $("tr-go");
  if (!q) return;
  const P = TRADE.pool, st = state.trade || {}, buy = TRADE.side === "buy", dec = tradeDec();
  const amount = Shared.parseUnits($("tr-amt").value, dec);
  let w = "", ok = false, html = `<p class="dim small">Enter an amount to see the price.</p>`;
  if (!P) w = TRADE.err;
  else if (st.canTrade === false) w = "Connect a Solana wallet to trade.";
  else if (!buy && st.canSell === false) w = "Buy a pack (Packs tab) to unlock selling $AFKMINE for SOL.";
  else if ($("tr-amt").value.trim() && !amount) w = "Enter a plain number" + (buy ? " (SOL, up to 9 decimals)." : " ($AFKMINE, up to 6 decimals).");
  else if (amount) {
    const sol = big(P.solReserve), tok = big(P.tokenReserve), r = Shared.quote(TRADE.side, sol, tok, amount, P.feeBps);
    if (!r.ok) w = r.error;
    else {
      const slipBps = BigInt(Math.round(TRADE.slip * 100)), minOut = (r.out * (10000n - slipBps)) / 10000n, pctBps = BigInt(Math.round(P.limits.maxTradePct * 100));
      TRADE.quote = { amount, minOut: Number(minOut), out: r.out, side: TRADE.side };
      const outTxt = buy ? "◈ " + formatToken(Number(r.out) / 1e6) : "◎ " + fmtLam(Number(r.out)), minTxt = buy ? "◈ " + formatToken(Number(minOut) / 1e6) : "◎ " + fmtLam(Number(minOut));
      const feeTxt = buy ? "◎ " + fmtLam(Number(r.fee)) : "◈ " + formatToken(Number(r.fee) / 1e6);
      html = `<div class="st-row"><span>You receive</span><b class="${buy ? "tokc" : "solc"}">${outTxt}</b></div>
        <div class="st-row"><span>Price impact</span><b class="${r.impactBps > 500 ? "bad" : ""}">${(r.impactBps / 100).toFixed(2)}%</b></div>
        <div class="st-row"><span>Fee (${(P.feeBps / 100).toFixed(2).replace(/\.?0+$/, "")}%, stays in the pool)</span><b>${feeTxt}</b></div>
        <div class="st-row"><span>Minimum received (${TRADE.slip}% slippage)</span><b>${minTxt}</b></div>
        <div class="st-row"><span>Price after the trade</span><b>◎ ${fmtPrice(r.priceAfter)}</b></div>`;
      const left = Math.max(0, (st.cooldownLeft || 0) - (performance.now() - (net.viewAt || 0)));
      if (buy && amount > state.sol) w = "Not enough SOL in your balance — deposit in the Deposit tab.";
      else if (!buy && amount > Math.floor(state.token * 1e6 + 1e-6)) w = "Not enough $AFKMINE.";
      else if (BigInt(amount) * 10000n > (buy ? sol : tok) * pctBps) w = "Too large: at most " + P.limits.maxTradePct + "% of the pool per trade.";
      else if (!buy && P.sellFloor === "backed" && r.newSol < big(P.initSol)) w = "The pool can only pay out SOL that buyers put in. Try a smaller amount.";
      else if (!buy && (st.soldToday || 0) + Number(r.out) > P.limits.dailySellCapLamports) w = "Daily sell limit reached (resets at 00:00 UTC).";
      else if (left > 0) w = "Cooldown: wait " + Math.ceil(left / 1000) + " s.";
      else ok = true;
    }
  }
  if (q._h !== html) { q.innerHTML = html; q._h = html; }
  setText(warn, w);
  go.disabled = !ok || TRADE.busy;
}
function tradeConfirm() {
  const t = TRADE.quote;
  if (!t || TRADE.busy) return;
  const buy = t.side === "buy";
  const text = buy ? `Pay <b>◎ ${fmtLam(Number(t.amount))} SOL</b> and receive about <b>◈ ${formatToken(Number(t.out) / 1e6)} $AFKMINE</b> (at least ${formatToken(t.minOut / 1e6)}).`
    : `Sell <b>◈ ${formatToken(Number(t.amount) / 1e6)} $AFKMINE</b> and receive about <b>◎ ${fmtLam(Number(t.out))} SOL</b> (at least ${fmtLam(t.minOut)}).`;
  confirmModal(buy ? "Buy $AFKMINE?" : "Sell $AFKMINE?", text + `<br><small class="dim">If the price moves more than your slippage setting before the server processes this, the trade is rejected and nothing is spent.</small>`, buy ? "Buy" : "Sell", async () => {
    TRADE.busy = true; tradeQuoteUpdate();
    const r = await netAct(buy ? { type: "tradeBuy", lamports: Number(t.amount), minOut: t.minOut } : { type: "tradeSell", tokens: Number(t.amount), minOut: t.minOut });
    TRADE.busy = false;
    if (r.ok) {
      Sound.play("coin"); $("tr-amt").value = "";
      toast(buy ? "✅ Bought ◈ " + formatToken(r.traded.received / 1e6) : "✅ Sold for ◎ " + fmtLam(r.traded.received));
    } else { Sound.play("error"); toast(r.error); }
    renderHUD(); drawBank(); loadPool();
  });
}
function tradeClick(e) {
  const side = e.target.closest("[data-tside]"), sl = e.target.closest("[data-slip]");
  if (side) { TRADE.side = side.dataset.tside; $("tr-amt").value = ""; return tradeUpdate(); }
  if (sl) { TRADE.slip = +sl.dataset.slip; return tradeUpdate(); }
  if (e.target.closest("[data-tmax]")) {
    const P = TRADE.pool; if (!P) return;
    const pctBps = BigInt(Math.round(P.limits.maxTradePct * 100)), buy = TRADE.side === "buy";
    const cap = Number(((buy ? big(P.solReserve) : big(P.tokenReserve)) * pctBps) / 10000n), have = buy ? state.sol : Math.floor(state.token * 1e6 + 1e-6);
    const v = Math.max(0, Math.min(cap, have));
    $("tr-amt").value = v > 0 ? unitsText(v, tradeDec()) : "";
    return tradeQuoteUpdate();
  }
  if (e.target.closest("[data-tgo]")) tradeConfirm();
}
function setupTrade() { setInterval(() => { if (tradeVisible() && !TRADE.busy) loadPool(); }, 5000); }
