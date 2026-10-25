"use strict";
// Everything that touches the Solana blockchain. Built ONLY on the official libraries:
//   @solana/web3.js (Connection, Transaction, SystemProgram, Keypair, PublicKey)
//   @solana/spl-token (associated token accounts, transferChecked)
//   bs58 (address / signature encoding)
// The server never trusts the browser about money: it builds the transactions itself, and it only credits
// something after reading the confirmed transaction back from the RPC node and re-checking every field.

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ---- pure verification helpers (unit-tested without a network) ---------------------------------
// net change of one owner's balance of one mint inside a confirmed transaction (base units)
function tokenDelta(meta, owner, mint) {
  let d = 0n;
  for (const b of meta.postTokenBalances || []) if (b.owner === owner && b.mint === mint) d += BigInt(b.uiTokenAmount.amount);
  for (const b of meta.preTokenBalances || []) if (b.owner === owner && b.mint === mint) d -= BigInt(b.uiTokenAmount.amount);
  return d;
}
const keyOf = (k) => String(k && k.pubkey !== undefined ? k.pubkey : k);

// A deposit counts only if the game treasury received $MINE AND that same amount left the player's own wallet.
function analyzeDeposit(tx, { wallet, treasuryOwner, mint }) {
  if (!tx) return { status: "pending" };
  if (!tx.meta) return { status: "pending" };
  if (tx.meta.err) return { status: "error", error: "That transaction failed on-chain." };
  const got = tokenDelta(tx.meta, treasuryOwner, mint);
  if (got <= 0n) return { status: "error", error: "That transaction did not send $MINE to the game treasury." };
  const sent = -tokenDelta(tx.meta, wallet, mint);
  if (sent < got) return { status: "error", error: "That transfer was not sent from your connected wallet." };
  return { status: "ok", baseUnits: got };
}

// A pack payment counts only if the merchant got >= price lamports, the player's wallet signed and paid it,
// and the transaction carries our one-time order memo (so an old payment can never be reused for a new order).
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
  if (!SOL.mint) missing.push("MINE_MINT");
  if (!SOL.treasurySecret) missing.push("TREASURY_SECRET_KEY");
  const L = libs || (() => {
    try { return { web3: require("@solana/web3.js"), spl: require("@solana/spl-token"), bs58: require("bs58") }; }
    catch (e) { missing.push("npm packages (@solana/web3.js, @solana/spl-token, bs58): " + e.message); return null; }
  })();
  const out = { enabled: false, missing, merchant: SOL.merchant || "", tokenEnabled: false, payEnabled: false };
  if (!L) return out;
  const { web3, spl, bs58 } = L;
  const { Connection, PublicKey, Keypair, Transaction, SystemProgram, TransactionInstruction } = web3;
  const conn = (libs && libs.connection) || new Connection(SOL.rpc, { commitment: SOL.commitment });
  out.conn = conn;

  // pay-with-SOL needs only a receiving address (no private key on the server)
  if (SOL.merchant) { try { new PublicKey(SOL.merchant); out.payEnabled = true; } catch { missing.push("MERCHANT_WALLET is not a valid address"); } }
  if (!SOL.mint || !SOL.treasurySecret) return out;

  let treasury, mint, treasuryAta;
  try {
    const raw = SOL.treasurySecret.trim();
    const secret = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
    treasury = Keypair.fromSecretKey(secret);
    mint = new PublicKey(SOL.mint);
    treasuryAta = spl.getAssociatedTokenAddressSync(mint, treasury.publicKey);
  } catch (e) { missing.push("TREASURY_SECRET_KEY / MINE_MINT could not be read: " + e.message); return out; }
  out.tokenEnabled = true;
  out.enabled = true;
  out.treasury = treasury.publicKey.toBase58();
  out.treasuryAta = treasuryAta.toBase58();
  out.mint = mint.toBase58();

  const isAddress = (a) => { try { return new PublicKey(a).toBase58() === a; } catch { return false; } };
  out.isAddress = isAddress;
  const toBase = (tokens) => BigInt(Math.round(tokens * 10 ** SOL.decimals));
  out.toBase = toBase;
  out.fromBase = (b) => Number(b) / 10 ** SOL.decimals;
  const serialize = (tx) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

  out.treasuryBalance = async () => {
    try { return BigInt((await conn.getTokenAccountBalance(treasuryAta)).value.amount); } catch { return 0n; }
  };
  out.userBalance = async (wallet) => {
    try { return BigInt((await conn.getTokenAccountBalance(spl.getAssociatedTokenAddressSync(mint, new PublicKey(wallet)))).value.amount); } catch { return 0n; }
  };

  // unsigned transaction the PLAYER signs: transfer $MINE from their wallet to the treasury
  out.buildDepositTx = async (wallet, baseUnits) => {
    const owner = new PublicKey(wallet);
    const from = spl.getAssociatedTokenAddressSync(mint, owner);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(SOL.commitment);
    const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight });
    tx.add(spl.createTransferCheckedInstruction(from, mint, treasuryAta, owner, baseUnits, SOL.decimals));
    return serialize(tx);
  };
  // unsigned transaction the PLAYER signs: SOL straight to the merchant wallet (+ order memo)
  out.buildPackTx = async (wallet, lamports, memo) => {
    if (!out.payEnabled) throw new Error("SOL payments are not configured");
    const payer = new PublicKey(wallet);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(SOL.commitment);
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(SOL.merchant), lamports }));
    tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, "utf8") }));
    return serialize(tx);
  };

  const fetchTx = (sig) => conn.getParsedTransaction(sig, { commitment: SOL.commitment, maxSupportedTransactionVersion: 0 });
  out.verifyDeposit = async (sig, wallet) => analyzeDeposit(await fetchTx(sig), { wallet, treasuryOwner: out.treasury, mint: out.mint });
  out.verifyPayment = async (sig, wallet, lamports, memo) => analyzePayment(await fetchTx(sig), { wallet, merchant: SOL.merchant, lamports, memo });

  // ---- withdrawals: treasury -> player's wallet --------------------------------------------------
  // Step 1 signs the transaction and returns its signature BEFORE anything is sent, so the caller can store it durably.
  // That makes crashes safe: on restart we look the signature up (or wait for the blockhash to expire) and never pay twice.
  out.signWithdrawal = async (wallet, baseUnits) => {
    const owner = new PublicKey(wallet);
    const to = spl.getAssociatedTokenAddressSync(mint, owner);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(SOL.commitment);
    const tx = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight });
    tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, to, owner, mint));
    tx.add(spl.createTransferCheckedInstruction(treasuryAta, mint, to, treasury.publicKey, baseUnits, SOL.decimals));
    tx.sign(treasury);
    return { sig: bs58.encode(tx.signature), raw: tx.serialize().toString("base64"), lastValid: lastValidBlockHeight };
  };
  out.broadcast = (raw) => conn.sendRawTransaction(Buffer.from(raw, "base64"), { skipPreflight: false, maxRetries: 5 });
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
  return out;
}

module.exports = { createChain, analyzeDeposit, analyzePayment, tokenDelta, MEMO_PROGRAM };
