/**
 * Minimal RLP encoder — only what EIP-1559 transaction signing needs.
 *
 * RLP rules (in brief):
 *   - A single byte < 0x80 encodes as itself.
 *   - A byte string up to 55 bytes: 0x80 + len, then the string.
 *   - A byte string > 55 bytes: 0xb7 + len-of-len, then BE(len), then string.
 *   - A list with total payload up to 55 bytes: 0xc0 + len, then payload.
 *   - A list with payload > 55 bytes: 0xf7 + len-of-len, then BE(len), then payload.
 *
 * Numbers are encoded as their minimal big-endian byte representation
 * (no leading zeros). Zero encodes as the empty byte string.
 */

export type RlpInput = Uint8Array | RlpInput[];

export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) return encodeBytes(input);
  return encodeList(input);
}

function encodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0]! < 0x80) return bytes;
  return concat(encodeLength(bytes.length, 0x80), bytes);
}

function encodeList(items: RlpInput[]): Uint8Array {
  const encoded = items.map(rlpEncode);
  const payload = concat(...encoded);
  return concat(encodeLength(payload.length, 0xc0), payload);
}

function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([offset + len]);
  const lenBytes = toMinimalBytes(BigInt(len));
  return concat(new Uint8Array([offset + 55 + lenBytes.length]), lenBytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Convert a hex string (with or without 0x) to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const norm = s.length % 2 === 1 ? "0" + s : s;
  const out = new Uint8Array(norm.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(norm.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Convert bytes to a 0x-prefixed lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Encode a non-negative integer as its minimal big-endian byte representation.
 * Zero → empty byte string (per RLP convention for integers).
 */
export function toMinimalBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("negative integers not allowed in RLP");
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return hexToBytes(hex);
}

/**
 * Encode a value as bytes for RLP: hex strings → bytes, bigints → minimal,
 * numbers → bigint conversion → minimal, undefined → empty.
 */
export function toRlpBytes(value: bigint | number | string | Uint8Array | null | undefined): Uint8Array {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    return value === "0x" || value === "" ? new Uint8Array(0) : hexToBytes(value);
  }
  if (typeof value === "number") return toMinimalBytes(BigInt(value));
  return toMinimalBytes(value);
}
