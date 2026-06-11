import { describe, expect, test } from "bun:test";
import { signEip1193 } from "./sign.js";
import { rlpEncode, toRlpBytes, hexToBytes, bytesToHex } from "./rlp.js";

// Anvil test key #0 — public, well-known.
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const CTX = { privateKeyHex: PK, address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 11155111 };

// Fully-specified tx so buildAndSignTx fills nothing via RPC (offline test).
// This is the ERC-20 approve shape both ENG-3231/3312 hit: value 0, calldata present.
const ERC20_APPROVE = {
  to: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", // Sepolia USDC
  value: "0x0", // <-- the regression trigger: hex-string zero
  data: "0x095ea7b3" + "0".repeat(64),
  nonce: "0xe",
  gas: "0x13880",
  maxPriorityFeePerGas: "0x59682f00",
  maxFeePerGas: "0x12a05f200",
  chainId: "0xaa36a7",
};

/**
 * Walk an EIP-1559 raw tx (0x02 || rlp([...])) and return the decoded field
 * byte-arrays. Minimal RLP list decoder — enough to assert canonical encoding.
 */
function decode1559Fields(rawHex: string): Uint8Array[] {
  const all = hexToBytes(rawHex);
  expect(all[0]).toBe(0x02); // envelope type
  let p = 1;
  // outer list header
  const h = all[p]!;
  if (h >= 0xf7) p += 1 + (h - 0xf7);
  else p += 1;
  const out: Uint8Array[] = [];
  while (p < all.length) {
    const b = all[p]!;
    if (b < 0x80) { out.push(all.slice(p, p + 1)); p += 1; }
    else if (b < 0xb8) { const len = b - 0x80; out.push(all.slice(p + 1, p + 1 + len)); p += 1 + len; }
    else if (b < 0xc0) { const ll = b - 0xb7; const len = Number(BigInt(bytesToHex(all.slice(p + 1, p + 1 + ll)))); out.push(all.slice(p + 1 + ll, p + 1 + ll + len)); p += 1 + ll + len; }
    else if (b < 0xf8) { const len = b - 0xc0; out.push(all.slice(p, p + 1 + len)); p += 1 + len; } // nested list (accessList) — keep raw
    else { const ll = b - 0xf7; const len = Number(BigInt(bytesToHex(all.slice(p + 1, p + 1 + ll)) || "0x0")); out.push(all.slice(p, p + 1 + ll + len)); p += 1 + ll + len; }
  }
  return out;
}

describe("eth_sendTransaction serialization — canonical integer fields (ENG-3231/3312 regression)", () => {
  test("fully-specified ERC-20 approve produces a decodable, canonical raw tx", async () => {
    const res = (await signEip1193("eth_signTransaction", [ERC20_APPROVE], CTX)) as { result?: string; error?: unknown };
    expect(res.error).toBeUndefined();
    const raw = res.result!;
    const fields = decode1559Fields(raw);
    // EIP-1559: [chainId, nonce, maxPrio, maxFee, gas, to, value, data, accessList, yParity, r, s]
    const value = fields[6]!;
    expect(value.length).toBe(0); // canonical zero = empty byte string (the bug produced [0x00])

    // r and s (indices 10, 11) must have no leading zero byte (canonical integer).
    const r = fields[10]!, s = fields[11]!;
    expect(r.length === 0 || r[0] !== 0).toBe(true);
    expect(s.length === 0 || s[0] !== 0).toBe(true);
  });

  test("the buggy encoding is what we moved away from (guard the helper contract)", () => {
    // value as a hex string through the byte-string path = the non-canonical 0x00 bug.
    expect(Array.from(toRlpBytes("0x0"))).toEqual([0]); // byte-string interpretation (WRONG for an integer field)
    expect(Array.from(toRlpBytes(0n))).toEqual([]);     // integer interpretation (canonical) — the fix routes value here
    expect(bytesToHex(rlpEncode(toRlpBytes(0n)))).toBe("0x80");
  });
});
