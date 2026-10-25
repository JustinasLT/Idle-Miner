"use strict";
// TEST-ONLY base58 (Bitcoin alphabet) so the self-test runs without installing packages.
// Production code uses the real `bs58` package; this file is only used by server/test.js when `bs58` is not installed.
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = Object.fromEntries([...A].map((c, i) => [c, i]));
exports.encode = (buf) => {
  const b = Uint8Array.from(buf);
  let zeros = 0; while (zeros < b.length && b[zeros] === 0) zeros++;
  let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x);
  let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  return "1".repeat(zeros) + s;
};
exports.decode = (str) => {
  let zeros = 0; while (zeros < str.length && str[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of str) { if (!(c in MAP)) throw new Error("Non-base58 character"); n = n * 58n + BigInt(MAP[c]); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...out]);
};
