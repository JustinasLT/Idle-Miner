"use strict";
// Everything that touches the Solana blockchain. There is NO token mint: the only real on-chain operations are
//   * SOL deposits   (player's wallet -> game treasury wallet)
//   * SOL withdrawals (game treasury wallet -> player's own wallet)
// Built ONLY on the official libraries: @solana/web3.js (Connection, Transaction, SystemProgram, Keypair, PublicKey) and bs58.
// The server never trusts the browser about money: it builds the transactions itself, and it only credits
// something after reading the confirmed transaction back from the RPC node and re-checking every field.

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ---- pure verification helpers (unit-tested without a network) ---------------------------------
const keyOf = (k) => String(k && k.pubkey !== undefined ? k.pubkey : k);

// A SOL deposit counts only if the treasury received lamports AND the player's own wallet signed and paid at least that much.
// The credit is exactly what the treasury received.
function analyzeSolDeposit(tx, { wallet, treasury }) {
  if (!tx || !tx.meta) return { status: "pending" };
  if (tx.meta.err) return { status: "error", error: "That transaction failed on-chain." };
  const keys = tx.transaction.message.accountKeys;
  const idx = (addr) => keys.findIndex((k) => keyOf(k) === addr);
  const ti = idx(treasury), wi = idx(wallet);
  if (ti < 0 || wi < 0) return { status: "error", error: "That transaction did not send SOL from your wallet to the game treasury." };
  if (!(keys[wi].signer === true)) return { status: "error", error: "Your wallet did not sign this payment." };
  const got = BigInt(tx.meta.postBalances[ti]) - BigInt(tx.meta.preBalances[ti]);
  if (got <= 0n) return { status: "error", error: "That transaction did not send SOL to the game treasury." };
  const paid = BigInt(tx.meta.preBalances[wi]) - BigInt(tx.meta.postBalances[wi]);
  if (paid < got) return { status: "error", error: "That payment did not come from your wallet." };
  return { status: "ok", lamports: got };
}

// LEGACY: a pack payment made before packs moved to the SOL balance. Counts only if the merchant got >= price lamports, the player's wallet
// signed and paid it, and the transaction carries our one-time order memo. Kept only so already-paid open orders can still be confirmed.
function analyzePayment(tx, { wallet, merchant, lamports, memo }) {
  if (!tx || !tx.meta) return { status: "pending" };
  if (tx.meta.err) return { status: "error", error: "That transaction failed on-chain." };
  const keys = tx.transaction.message.accountKeys;
  const idx = (addr) => keys.findIndex((k) => keyOf(k) === addr);
  const mi = idx(merchant), wi = idx(wallet);
  if (mi < 0 || wi < 0) return { status: "error", error: "Payment does not involve the right accounts." };
  if (!(keys[wi].signer === true)) return { status: "error", error: "Your wallet did not sign this payment." };
  const got = BigInt(tx.meta.postBalances[mi]) - BigInt(tx.meta.preBalances[mi]);
  const paid = BigInt(tx.meta.preBalances[wi]) - BigInt(tx.meta.postBalances[wi]);
  if (got < BigInt(lamports)) return { status: "error", error: "The payment was smaller than the pack price." };
  if (paid < got) return { status: "error", error: "The payment did not come from your wallet." };
  const hasMemo = (tx.transaction.message.instructions || []).some((ix) => ix.program === "spl-memo" && ix.parsed === memo);
  if (!hasMemo) return { status: "error", error: "Payment is missing the order reference." };
  return { status: "ok", lamports: got };
}

// ---- chain client ---------------------------------------------------------------------------------
function createChain(SOL, libs) {
  const missing = [];
  if (!SOL.treasurySecret) missing.push("TREASURY_SECRET_KEY");
  const L = libs || (() => {
    try { return { web3: require("@solana/web3.js"), bs58: require("bs58") }; }
    catch (e) { missing.push("npm packages (@solana/web3.js, bs58): " + e.message); return null; }
  })();
  const out = { enabled: false, missing, merchant: SOL.merchant || "", payEnabled: false };
  if (!L) return out;
  const { web3, bs58 } = L;
  const { Connection, PublicKey, Keypair, Transaction, SystemProgram, TransactionInstruction } = web3;
  const conn = (libs && libs.connection) || new Connection(SOL.rpc, { commitment: SOL.commitment });
  out.conn = conn;

  // Transaction status lookups need no key: they are also used to settle old (pre-switch) token withdrawals that were still in flight.
  // -> "confirmed" | "failed" | "pending" | "expired"
  out.withdrawalStatus = async (sig, lastValid) => {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (st) {
      if (st.err) return "failed";
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "confirmed";
      return "pending";
    }
    const h = await conn.getBlockHeight(SOL.commitment);
    return h > lastValid + 30 ? "expired" : "pending"; // +30 blocks safety margin before we ever refund
  };
  out.broadcast = (raw) => conn.sendRawTransaction(Buffer.from(raw, "base64"), { skipPreflight: false, maxRetries: 5 });

  // legacy pack orders (confirm only): needs just the merchant address
  if (SOL.merchant) { try { new PublicKey(SOL.merchant); out.payEnabled = true; } catch { missing.push("MERCHANT_WALLET is not a valid address"); } }
  if (!SOL.treasurySecret) return out;

  let treasury;
  try {
    const raw = SOL.treasurySecret.trim();
    const secret = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
    treasury = Keypair.fromSecretKey(secret);
  } catch (e) { missing.push("TREASURY_SECRET_KEY could not be read: " + e.message); return out; }
  out.enabled = true;
  out.treasury = treasury.publicKey.toBase58();

  const isAddress = (a) => { try { return new PublicKey(a).toBase58() === a; } catch { return false; } };
  out.isAddress = isAddress;
  const serialize = (tx) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

  // real SOL in the treasury wallet (lamports, BigInt)
  out.treasuryBalance = async () => BigInt(await conn.getBalance(treasury.publicKey, SOL.commitment));

  // unsigned transaction the PLAYER signs: SOL from their wallet to the treasury
  out.buildDepositTx = async (wallet, lamports) => {
    const payer = new PublicKey(wallet);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(SOL.commitment);
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: treasury.publicKey, lamports }));
    return serialize(tx);
  };
  out.walletBalance = async (wallet) => BigInt(await conn.getBalance(new PublicKey(wallet), SOL.commitment));

  const fetchTx = (sig) => conn.getParsedTransaction(sig, { commitment: SOL.commitment, maxSupportedTransactionVersion: 0 });
  out.verifyDeposit = async (sig, wallet) => analyzeSolDeposit(await fetchTx(sig), { wallet, treasury: out.treasury });
  out.verifyPayment = async (sig, wallet, lamports, memo) => analyzePayment(await fetchTx(sig), { wallet, merchant: SOL.merchant, lamports, memo });

  // ---- withdrawals: treasury -> player's wallet --------------------------------------------------
  // Step 1 signs the transaction and returns its signature BEFORE anything is sent, so the caller can store it durably.
  // That makes crashes safe: on restart we look the signature up (or wait for the blockhash to expire) and never pay twice.
  out.signWithdrawal = async (wallet, lamports) => {
    const to = new PublicKey(wallet);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(SOL.commitment);
    const tx = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight });
    tx.add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: to, lamports }));
    tx.sign(treasury);
    return { sig: bs58.encode(tx.signature), raw: tx.serialize().toString("base64"), lastValid: lastValidBlockHeight };
  };
  return out;
}

module.exports = { createChain, analyzeSolDeposit, analyzePayment, MEMO_PROGRAM };
