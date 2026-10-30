"use strict";
// Admin dashboard. Plain DOM, no innerHTML with data (everything goes through textContent), no inline handlers.
// It only talks to /api/admin/* with its own session id (x-admin-session); it never uses a player token.
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = "idleMiner_admin_session";
  let session = ""; try { session = sessionStorage.getItem(KEY) || ""; } catch { /* storage blocked */ }
  let page = "overview";

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") el.className = v; else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v); }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  };
  const sol = (l, dp = 4) => { const s = (l || 0) / 1e9; return (Math.abs(s) >= 1 ? s.toFixed(3) : s.toFixed(dp)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + " SOL"; };
  const when = (t) => (t ? new Date(t).toLocaleString() : "—");
  const short = (s) => (s ? String(s).slice(0, 4) + "…" + String(s).slice(-4) : "—");
  const toast = (m) => { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 4000); };

  async function api(method, path, body) {
    const r = await fetch("/api/admin/" + path, { method, headers: { "Content-Type": "application/json", "x-admin-session": session }, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch { /* empty */ }
    if (r.status === 401) { showLogin(); throw new Error("Signed out"); }
    if (!r.ok) throw new Error(j.error || "Error " + r.status);
    return j;
  }
  const act = async (label, fn) => { try { const r = await fn(); toast(label + " ✓"); await render(); return r; } catch (e) { toast("✖ " + e.message); } };
  const ask = (q) => { const v = window.prompt(q); return v == null ? null : v.trim(); };

  const flagsEl = (fl) => h("span", {}, fl.map((f) => h("span", { class: "flag s" + f.sev, title: f.text }, f.k.replace(/_/g, " "))));
  const tagsEl = (t) => h("span", {}, (t || []).map((x) => h("span", { class: "tag " + x }, x === "og" ? "OG" : x === "ref2" ? "T2" : "T3")));
  const stat = (label, value, cls) => h("div", { class: "stat" }, h("small", {}, label), h("b", { class: cls || "" }, value));
  const table = (head, rows) => h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows));
  const empty = (m) => h("p", { class: "dim" }, m);

  // ---------------------------------------------------------------- pages
  const PAGES = {
    async overview() {
      const o = await api("GET", "overview"), s = o.solvency, f = o.flows;
      const ratio = s.ratio == null ? "n/a" : s.ratio.toFixed(4);
      return [
        h("div", { class: "card" }, h("h2", {}, "Treasury & solvency"), h("div", { class: "grid" },
          stat("Solvency", s.ok ? "OK" : "BROKEN", s.ok ? "ok" : "bad"), stat("Ratio assets / liabilities", ratio),
          stat("Ledger assets", sol(s.assets)), stat("Liabilities (balances + locked)", sol(s.liabilities)), stat("Equity", sol(s.equity), s.equity < 0 ? "bad" : ""),
          stat("On-chain treasury", o.onchainLamports && /^\d+$/.test(o.onchainLamports) ? sol(+o.onchainLamports) : String(o.onchainLamports || "n/a")), stat("Sell room (liquidity)", sol(s.sellRoom)),
          stat("Pending withdrawals", o.pending.count + " · " + sol(o.pending.lamports), o.pending.count ? "warn" : ""), stat("Failed sends (locked)", o.pending.failed + " · " + sol(o.pending.failedLamports), o.pending.failed ? "bad" : ""))),
        h("div", { class: "card" }, h("h2", {}, "Pool"), h("div", { class: "grid" },
          stat("Price", o.pool.price.toPrecision(5) + " SOL"), stat("24h change", o.pool.change24h.toFixed(2) + "%", o.pool.change24h < 0 ? "bad" : "ok"),
          stat("SOL reserve (virtual + backed)", sol(+o.pool.solReserve)), stat("$AFKMINE reserve", (+o.pool.tokenReserve / 1e6).toLocaleString()), stat("Circulating", Math.round(o.pool.circulating).toLocaleString()),
          stat("Fees kept in pool", sol(+o.pool.feeSol)))),
        h("div", { class: "card" }, h("h2", {}, "Flows"), table(["", "Deposits in", "Withdrawals out (net)", "Pack revenue", "Referral accrued", "Referral paid"],
          ["24h", "7d"].map((k) => h("tr", {}, h("td", {}, k), h("td", {}, sol(f[k].inflow)), h("td", {}, sol(f[k].outflow)), h("td", {}, sol(f[k].packRevenue)), h("td", {}, sol(f[k].referralAccrued)), h("td", {}, sol(f[k].referralPaid)))))),
        h("div", { class: "card" }, h("h2", {}, "Referral cost"), h("div", { class: "grid" },
          stat("Paid out so far", sol(o.referral.paidTotal)), stat("All-time pack revenue", sol(o.referral.packRevenue)), stat("Referral cost / revenue", o.referral.costPct.toFixed(1) + "%"),
          stat("Waiting for payout", o.referral.accruedCount + " · " + sol(o.referral.accruedLamports)), stat("…of which not backed by real SOL", sol(o.referral.accruedUnbacked), o.referral.accruedUnbacked ? "warn" : ""), stat("Players", String(o.players)))),
      ];
    },

    async withdrawals() {
      const st = PAGES._wdStatus || "pending", d = await api("GET", "withdrawals?status=" + st);
      const bar = h("div", { class: "row" }, ["pending", "approved", "sent", "failed", "rejected", "all"].map((k) => h("button", { class: "btn" + (k === st ? " pri" : ""), on: { click: () => { PAGES._wdStatus = k; render(); } } }, k)));
      const rows = d.rows.map((w) => h("tr", {},
        h("td", {}, h("b", {}, w.status.toUpperCase()), h("div", { class: "dim" }, when(w.created))),
        h("td", {}, w.player ? [tagsEl(w.player.tags), w.player.name, h("div", { class: "dim mono" }, w.player.id.slice(0, 8))] : "(deleted)"),
        h("td", {}, h("div", {}, sol(w.amount)), h("div", { class: "dim" }, "fee " + sol(w.fee) + " → send " + sol(w.net)), h("div", { class: "mono dim" }, short(w.wallet))),
        h("td", {}, w.player ? h("div", { class: "dim" }, "deposited " + sol(w.player.deposited) + " · balance " + sol(w.player.solBalance)) : "", flagsEl(w.flags), w.history.length ? h("details", {}, h("summary", { class: "dim" }, "history (" + w.history.length + ")"), w.history.map((x) => h("div", { class: "dim" }, sol(x.amount) + " · " + x.status + " · " + when(x.created) + (x.reason ? " · " + x.reason : "")))) : null),
        h("td", {}, w.reason ? h("div", { class: "dim" }, "Reason: " + w.reason) : null, w.error ? h("div", { class: "bad" }, w.error) : null,
          w.status === "pending" ? h("div", { class: "row" },
            h("button", { class: "btn pri", on: { click: () => { if (window.confirm("Send " + sol(w.net) + " to " + w.wallet + " ?" + (w.risk ? "\nThis player has risk flags." : ""))) act("Approved", () => api("POST", "withdrawal/approve", { id: w.id })); } } }, "Approve & send"),
            h("button", { class: "btn red", on: { click: () => { const r = ask("Reason shown to the player:"); if (r) act("Rejected", () => api("POST", "withdrawal/reject", { id: w.id, reason: r })); } } }, "Reject")) : null,
          w.status === "failed" ? h("div", { class: "row" },
            h("button", { class: "btn pri", on: { click: () => act("Retry queued", () => api("POST", "withdrawal/retry", { id: w.id })) } }, "Retry send"),
            h("button", { class: "btn red", on: { click: () => { const r = ask("Reason (optional):") ; if (r != null) act("Refunded", () => api("POST", "withdrawal/refund", { id: w.id, reason: r || undefined })); } } }, "Refund")) : null,
          w.sig ? h("div", { class: "mono dim" }, w.sig) : null)));
      return [h("div", { class: "card" }, h("h2", {}, "Withdrawals"), h("p", { class: "dim" }, "Allowed per request: " + sol(d.min) + " – " + sol(d.max) + ". Nothing is sent until you approve."), bar),
        h("div", { class: "card" }, rows.length ? table(["Status", "Player", "Amount", "Risk", "Actions"], rows) : empty("Nothing here."))];
    },

    async referrals() {
      const d = await api("GET", "referrals");
      const head = h("div", { class: "card" }, h("h2", {}, "Weekly referral payout"),
        h("p", { class: "dim" }, "Current week starts " + d.currentWeek + " · next payout date shown to players: " + when(d.nextPayoutAt) + " · revenue available to cover real-SOL rewards: " + sol(d.available)),
        h("p", { class: "dim" }, "Backed rewards are credited as SOL balance. Rewards funded by $AFKMINE or by SOL that was not really deposited are paid as $AFKMINE at today's pool price."));
      const cards = d.groups.map((g) => h("div", { class: "card" },
        h("div", { class: "row" }, h("b", {}, g.referrer.name), tagsEl(g.referrer.tags), h("span", { class: "pill" }, "tier " + g.tier + " · " + g.qualifying + " qualifying / " + g.referred + " referred"), flagsEl(g.flags), h("span", { class: "dim" }, "total " + sol(g.total) + " (backed " + sol(g.backed) + ", unbacked " + sol(g.unbacked) + ")")),
        h("details", {}, h("summary", { class: "dim" }, g.entries.length + " entries · referred: " + g.referredList.map((x) => x.name + (x.flags ? " ⚑" : "")).join(", ")),
          table(["When", "Buyer", "What", "Spend", "Rate", "Reward", "Funding"], g.entries.map((e) => h("tr", {}, h("td", {}, when(e.t)), h("td", {}, e.buyer), h("td", {}, e.kind + " (" + (e.cur === "sol" ? "SOL" : "$AFKMINE") + ")"), h("td", {}, sol(e.spend)), h("td", {}, "T" + e.tier + " · " + (e.bps / 100) + "%"), h("td", {}, sol(e.amount)), h("td", { class: e.real ? "ok" : "warn" }, e.real ? "real SOL" : "unbacked"))))),
        h("div", { class: "row" },
          h("button", { class: "btn pri", on: { click: () => { if (window.confirm("Pay " + sol(g.total) + " to " + g.referrer.name + "?" + (g.risk ? "\nThey have risk flags." : ""))) act("Paid", () => api("POST", "referrals/payout", { ids: g.entries.map((e) => e.id) })); } } }, "Approve & pay"),
          h("button", { class: "btn red", on: { click: () => { const r = ask("Rejection reason:"); if (r) act("Rejected", () => api("POST", "referrals/reject", { ids: g.entries.map((e) => e.id), reason: r })); } } }, "Reject all"))));
      const all = d.groups.length ? h("div", { class: "card row" }, h("button", { class: "btn pri", on: { click: () => { const ids = d.groups.filter((g) => !g.risk).flatMap((g) => g.entries.map((e) => e.id)); if (ids.length && window.confirm("Pay all " + ids.length + " entries of players WITHOUT risk flags?")) act("Batch paid", () => api("POST", "referrals/payout", { ids })); } } }, "Pay every group without risk flags"), h("span", { class: "dim" }, "Flagged groups stay for review.")) : null;
      const paid = h("div", { class: "card" }, h("h3", {}, "Recently paid"), d.recentPaid.length ? table(["Batch", "Referrer", "Amount", "Paid as", "When"], d.recentPaid.map((e) => h("tr", {}, h("td", {}, e.batch), h("td", {}, e.referrer), h("td", {}, sol(e.amount)), h("td", {}, e.as === "sol" ? "SOL balance" : "$AFKMINE"), h("td", {}, when(e.paidAt))))) : empty("No payouts yet."));
      return [head, all, d.groups.length ? cards : h("div", { class: "card" }, empty("No accrued rewards waiting.")), paid];
    },

    async players() {
      const q = PAGES._q || "", d = await api("GET", "players?q=" + encodeURIComponent(q));
      const inp = h("input", { placeholder: "Search by name, id, wallet or referral code", value: q });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { PAGES._q = inp.value; render(); } });
      const rows = d.rows.map((p) => h("tr", {}, h("td", {}, tagsEl(p.tags), h("b", {}, p.name), h("div", { class: "mono dim" }, p.id.slice(0, 8))), h("td", {}, p.guest ? "guest" : short(p.wallet), h("div", { class: "dim" }, p.pack ? "has pack" : "free")), h("td", {}, sol(p.solBalance), h("div", { class: "dim" }, Math.round(p.balance).toLocaleString() + " $AFKMINE")), h("td", {}, p.flags ? h("span", { class: "flag s" + p.risk }, p.flags + " flag" + (p.flags > 1 ? "s" : "")) : "—"), h("td", {}, h("button", { class: "btn", on: { click: () => { PAGES._pid = p.id; render(); } } }, "Open"))));
      const out = [h("div", { class: "card" }, h("h2", {}, "Players"), h("div", { class: "row" }, inp, h("button", { class: "btn pri", on: { click: () => { PAGES._q = inp.value; render(); } } }, "Search"))), h("div", { class: "card" }, table(["Player", "Account", "Balances", "Risk", ""], rows))];
      if (PAGES._pid) {
        const x = await api("GET", "player?id=" + encodeURIComponent(PAGES._pid)), p = x.player;
        out.unshift(h("div", { class: "card" }, h("div", { class: "row" }, h("h2", {}, p.name), tagsEl(p.tags), h("span", { class: "dim mono" }, p.id), h("button", { class: "btn", on: { click: () => { PAGES._pid = null; render(); } } }, "Close")),
          h("div", { class: "grid" }, stat("SOL balance", sol(p.solBalance)), stat("$AFKMINE", Math.round(p.balance).toLocaleString()), stat("Deposited (lifetime)", sol(x.stats.depositedLamports)), stat("Bought / sold", sol(x.stats.bought) + " / " + sol(x.stats.sold)), stat("Manager level", String(x.stats.hero)), stat("Qualifying referrals", String(x.stats.refQualifying))),
          h("p", {}, "Flags: ", x.flags.length ? x.flags.map((f) => h("div", { class: "warn" }, "⚑ " + f.text)) : h("span", { class: "dim" }, "none")),
          h("div", { class: "row" },
            h("button", { class: "btn", on: { click: () => { const n = ask("Admin note (empty clears the manual flag):", ""); if (n != null) act("Saved", () => api("POST", "player/flag", { id: p.id, note: n })); } } }, "Set / clear manual flag"),
            h("button", { class: "btn", on: { click: () => act(x.stats.ogExcluded ? "OG restored" : "OG removed", () => api("POST", "player/og", { id: p.id, exclude: !x.stats.ogExcluded })) } }, x.stats.ogExcluded ? "Include in OG tag" : "Exclude from OG tag")),
          h("h3", {}, "Trades"), x.trades.length ? table(["When", "Side", "SOL", "$AFKMINE"], x.trades.map((t) => h("tr", {}, h("td", {}, when(t.t)), h("td", { class: t.side === "buy" ? "ok" : "bad" }, t.side), h("td", {}, sol(t.lamports)), h("td", {}, (t.micro / 1e6).toLocaleString())))) : empty("No trades."),
          h("h3", {}, "Withdrawals"), x.withdrawals.length ? table(["When", "Amount", "Status"], x.withdrawals.map((w) => h("tr", {}, h("td", {}, when(w.created)), h("td", {}, sol(w.amount)), h("td", {}, w.status + (w.reason ? " · " + w.reason : ""))))) : empty("None."),
          h("h3", {}, "Referral entries"), x.entries.length ? table(["When", "Kind", "Reward", "Status"], x.entries.map((e) => h("tr", {}, h("td", {}, when(e.t)), h("td", {}, e.kind + " T" + e.tier), h("td", {}, sol(e.amount)), h("td", {}, e.status)))) : empty("None.")));
      }
      return out;
    },

    async trades() {
      const d = await api("GET", "trades");
      const top = (title, list) => h("div", { class: "card" }, h("h3", {}, title), list.length ? table(["Player", "Sold"], list.map((x) => h("tr", {}, h("td", {}, x.name), h("td", {}, sol(x.lamports))))) : empty("No sells."));
      return [h("div", { class: "grid" }, top("Top sellers 24h", d.topSellers24h), top("Top sellers 7d", d.topSellers7d)),
        h("div", { class: "card" }, h("h3", {}, "Suspicious patterns"), d.suspicious.length ? table(["Player", "Flags"], d.suspicious.map((s) => h("tr", {}, h("td", {}, s.name), h("td", {}, flagsEl(s.flags), s.flags.map((f) => h("div", { class: "dim" }, f.text)))))) : empty("Nothing suspicious right now.")),
        h("div", { class: "card" }, h("h3", {}, "Recent trades"), table(["When", "Player", "Side", "SOL", "$AFKMINE", "Price"], d.recent.map((t) => h("tr", {}, h("td", {}, when(t.t)), h("td", {}, t.name), h("td", { class: t.side === "buy" ? "ok" : "bad" }, t.side), h("td", {}, sol(t.lamports)), h("td", {}, (t.micro / 1e6).toLocaleString()), h("td", {}, t.price.toPrecision(4))))))];
    },

    async audit() {
      const d = await api("GET", "audit?n=300");
      return [h("div", { class: "card" }, h("h2", {}, "Audit log"), h("p", { class: "dim" }, "Append-only: every admin decision and sign-in. Rows are never edited or deleted."),
        d.rows.length ? table(["When", "Who", "Action", "Details"], d.rows.map((r) => h("tr", {}, h("td", {}, when(r.t)), h("td", {}, r.admin), h("td", {}, r.action), h("td", { class: "mono dim" }, JSON.stringify(r.data))))) : empty("Empty."))];
    },
  };
  const TITLES = [["overview", "Overview"], ["withdrawals", "Withdrawals"], ["referrals", "Referrals"], ["players", "Players"], ["trades", "Trades"], ["audit", "Audit log"]];

  async function render() {
    const main = $("main");
    $("nav").replaceChildren(...TITLES.map(([k, n]) => h("button", { class: k === page ? "on" : "", on: { click: () => { page = k; render(); } } }, n)));
    try { const nodes = await PAGES[page](); main.replaceChildren(...nodes.filter(Boolean)); }
    catch (e) { if (e.message !== "Signed out") main.replaceChildren(h("div", { class: "card bad" }, e.message)); }
  }
  function showLogin() { session = ""; try { sessionStorage.removeItem(KEY); } catch { /* */ } $("app").hidden = true; $("login").hidden = false; }
  async function enter() {
    try { const me = await api("GET", "me"); $("cluster").textContent = me.cluster; $("login").hidden = true; $("app").hidden = false; render(); } catch { showLogin(); }
  }
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault(); $("login-err").textContent = "";
    try {
      const r = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: $("token").value }) }), j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed");
      session = j.session; try { sessionStorage.setItem(KEY, session); } catch { /* */ } $("token").value = ""; enter();
    } catch (er) { $("login-err").textContent = er.message; }
  });
  $("logout").addEventListener("click", async () => { try { await api("POST", "logout", {}); } catch { /* */ } showLogin(); });
  setInterval(() => { if (!$("app").hidden && page !== "players") render(); }, 30000);
  if (session) enter(); else showLogin();
})();
