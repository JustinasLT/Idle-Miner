"use strict";
// One-time setup of the $MINE token on a Solana test network. Built only on the official @solana/web3.js + @solana/spl-token.
//   npm install
//   node scripts/setup-token.js            (default cluster: testnet)
//   SOLANA_CLUSTER=devnet node scripts/setup-token.js
// It creates the treasury wallet (or reuses TREASURY_SECRET_KEY), creates the token with a fixed supply and prints the
// environment variables the game server needs. Needs a little test SOL in the treasury wallet (the script tells you where to get it).
const web3 = require("@solana/web3.js"), spl = require("@solana/spl-token"), bs58 = require("bs58");
const { Connection, Keypair, LAMPORTS_PER_SOL } = web3;
const cluster = process.env.SOLANA_CLUSTER || "testnet";
const rpc = process.env.SOLANA_RPC_URL || { testnet: "https://api.testnet.solana.com", devnet: "https://api.devnet.solana.com" }[cluster];
if (!rpc) { console.error("Use SOLANA_CLUSTER=testnet or devnet (this script refuses to run on mainnet-beta)."); process.exit(1); }
const DECIMALS = +process.env.MINE_DECIMALS || 6, SUPPLY = BigInt(process.env.MINE_SUPPLY || 100_000_000);

(async () => {
  const conn = new Connection(rpc, "confirmed");
  let treasury;
  if (process.env.TREASURY_SECRET_KEY) {
    const raw = process.env.TREASURY_SECRET_KEY.trim();
    treasury = Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  } else {
    treasury = Keypair.generate();
    console.log("\nNew treasury wallet created. SAVE THIS SECRET (it is shown only now):");
    console.log("TREASURY_SECRET_KEY=" + bs58.encode(treasury.secretKey));
  }
  console.log("\nTreasury address:", treasury.publicKey.toBase58(), "| cluster:", cluster);
  let bal = await conn.getBalance(treasury.publicKey);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    try { console.log("Requesting a test-SOL airdrop…"); const s = await conn.requestAirdrop(treasury.publicKey, 1 * LAMPORTS_PER_SOL); await conn.confirmTransaction(s, "confirmed"); bal = await conn.getBalance(treasury.publicKey); }
    catch (e) { /* airdrops are often rate-limited */ }
  }
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    console.error(`\nThe treasury needs a little test SOL. Open https://faucet.solana.com, choose "${cluster}", paste the address above,\nthen run this script again with:  TREASURY_SECRET_KEY=<the secret above> node scripts/setup-token.js`);
    process.exit(2);
  }
  console.log("Creating the token…");
  const mint = await spl.createMint(conn, treasury, treasury.publicKey, null, DECIMALS);
  const ata = await spl.getOrCreateAssociatedTokenAccount(conn, treasury, mint, treasury.publicKey);
  await spl.mintTo(conn, treasury, mint, ata.address, treasury, SUPPLY * 10n ** BigInt(DECIMALS));
  if (!process.env.KEEP_MINT_AUTHORITY) {
    await spl.setAuthority(conn, treasury, mint, treasury, spl.AuthorityType.MintTokens, null); // fixed supply: nobody can mint more, ever
    console.log("Mint authority removed: the supply is fixed.");
  }
  console.log(`\nDone. ${SUPPLY} $MINE now sit in the treasury. Put these in your host's environment (Render → Environment):\n`);
  console.log(`SOLANA_CLUSTER=${cluster}\nMINE_MINT=${mint.toBase58()}\nMINE_DECIMALS=${DECIMALS}\nTREASURY_SECRET_KEY=${bs58.encode(treasury.secretKey)}\nMERCHANT_WALLET=<your own wallet address that should receive the SOL from pack sales>`);
  console.log("\nTo test as a player: import the token in your wallet by its mint address and send yourself some $MINE from the treasury\n(or use the treasury secret in a wallet). Token name/logo need Metaplex metadata, which is optional.");
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
