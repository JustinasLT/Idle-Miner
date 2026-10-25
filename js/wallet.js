"use strict";
// Browser-wallet access through the wallets' own official provider APIs (Phantom, Solflare, Backpack).
// Transactions are built by the SERVER; the wallet only shows them to you and signs. Nothing here handles private keys.
const Wallet = {
  list() {
    const w = window, c = [
      ["phantom", "Phantom", w.phantom && w.phantom.solana && w.phantom.solana.isPhantom ? w.phantom.solana : null],
      ["solflare", "Solflare", w.solflare && w.solflare.isSolflare ? w.solflare : null],
      ["backpack", "Backpack", w.backpack && w.backpack.isBackpack ? w.backpack : null],
    ];
    return c.filter((x) => x[2]).map((x) => ({ id: x[0], name: x[1], p: x[2] }));
  },
  current: null,
  async connect(entry) {
    const r = await entry.p.connect();
    const pk = (r && r.publicKey) || entry.p.publicKey;
    if (!pk) throw new Error("The wallet did not return an address");
    this.current = entry;
    return pk.toString();
  },
  // signs a plain-text login message (no transaction, no fee). returns base64
  async signMessage(message) {
    const r = await this.current.p.signMessage(new TextEncoder().encode(message), "utf8");
    const bytes = r && r.signature ? r.signature : r;
    let bin = ""; new Uint8Array(bytes).forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  },
  // make sure a wallet is connected AND is the same account the player signed in with
  async ensure(expected) {
    if (!expected) throw new Error("Connect a wallet first");
    if (this.current) {
      const pk = this.current.p.publicKey;
      if (pk && pk.toString() === expected) return;
      this.current = null;
    }
    const list = this.list();
    if (!list.length) throw new Error("No Solana wallet found in this browser");
    for (const e of list) { try { if ((await this.connect(e)) === expected) return; } catch { /* try the next one */ } }
    this.current = null;
    throw new Error("In your wallet, select the account " + short(expected) + " (the one you signed in with), then try again");
  },
  // loads the official @solana/web3.js build served by our own server (needed to hand a transaction to the wallet)
  async lib() {
    if (window.solanaWeb3) return window.solanaWeb3;
    await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "/vendor/solana-web3.js"; s.onload = ok; s.onerror = () => no(new Error("Wallet library missing on the server (run npm install)")); document.head.appendChild(s); });
    if (!window.solanaWeb3) throw new Error("Wallet library failed to load");
    return window.solanaWeb3;
  },
  // the player's wallet signs and sends a transaction that the server built. returns the signature
  async signAndSend(base64Tx) {
    const web3 = await this.lib();
    const bin = atob(base64Tx), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const tx = web3.Transaction.from(bytes);
    const r = await this.current.p.signAndSendTransaction(tx);
    const sig = typeof r === "string" ? r : r && r.signature;
    if (!sig) throw new Error("The wallet did not return a transaction signature");
    return String(sig);
  },
  explorer(sig) { const c = net.config && net.config.cluster; return "https://explorer.solana.com/tx/" + sig + (c && c !== "mainnet-beta" ? "?cluster=" + c : ""); },
};
