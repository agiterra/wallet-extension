/**
 * EIP-712 v4 — typed structured data hashing for `eth_signTypedData_v4`.
 *
 * Pure-JS implementation backed by @noble/hashes' keccak_256. Supports the
 * full spec needed by Seaport and modern OpenSea / marketplace dApps:
 *   - atomic types: uint*, int*, bool, address, bytes1..32
 *   - dynamic types: string, bytes
 *   - struct types: recursive
 *   - arrays (fixed & dynamic) of any of the above
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-712
 *
 * Algorithm:
 *   digest = keccak256( 0x1901 || domainSeparator || hashStruct(primaryType, message) )
 *   domainSeparator = hashStruct("EIP712Domain", domain)
 *   hashStruct(type, value) = keccak256( typeHash(type) || encodeData(type, value) )
 *   typeHash(type) = keccak256( encodeType(type) )
 *   encodeType(type) = `Name(t1 n1,t2 n2,...)` ++ encoded dependent struct types,
 *                       alphabetically sorted, primary first
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes, bytesToHex } from "./rlp.js";

export interface TypedDataField {
  name: string;
  type: string;
}

export interface TypedData {
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

// ---- Type encoding ----

function arrayBaseType(type: string): string | null {
  const m = /^(.+)\[\d*\]$/.exec(type);
  return m ? m[1]! : null;
}

/** Walk dependent struct types reachable from `typeName` (excluding itself). */
function findDependencies(
  typeName: string,
  types: Record<string, TypedDataField[]>,
  found: Set<string> = new Set(),
): Set<string> {
  if (found.has(typeName) || !(typeName in types)) return found;
  found.add(typeName);
  for (const field of types[typeName]!) {
    const base = arrayBaseType(field.type) ?? field.type;
    if (base in types) findDependencies(base, types, found);
  }
  return found;
}

/** Encode a struct type per EIP-712: `Name(t1 n1,...)` + sorted dependents. */
export function encodeType(typeName: string, types: Record<string, TypedDataField[]>): string {
  const deps = findDependencies(typeName, types);
  deps.delete(typeName);
  const sorted = [...deps].sort();
  const ordered = [typeName, ...sorted];
  return ordered
    .map((t) => {
      const fields = types[t]!.map((f) => `${f.type} ${f.name}`).join(",");
      return `${t}(${fields})`;
    })
    .join("");
}

function typeHash(typeName: string, types: Record<string, TypedDataField[]>): Uint8Array {
  return keccak_256(new TextEncoder().encode(encodeType(typeName, types)));
}

// ---- Value encoding ----

function pad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("value > 32 bytes");
  if (bytes.length === 32) return bytes;
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function leftPad32(bytes: Uint8Array): Uint8Array {
  return pad32(bytes);
}

function rightPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("value > 32 bytes");
  if (bytes.length === 32) return bytes;
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

function intToBytes(n: bigint, signed: boolean, bits: number): Uint8Array {
  const byteLen = Math.ceil(bits / 8);
  if (signed) {
    // Two's complement for negative values, then pad with 0xff for sign extension
    const max = 1n << BigInt(byteLen * 8);
    if (n < 0n) n = max + n; // two's complement
    const hex = n.toString(16).padStart(byteLen * 2, "0");
    const bytes = hexToBytes(hex);
    if (bytes.length > byteLen) return bytes.slice(bytes.length - byteLen);
    // Sign extend with leading 0xff if originally negative
    const out = new Uint8Array(byteLen);
    out.set(bytes, byteLen - bytes.length);
    return out;
  }
  if (n < 0n) throw new Error(`unsigned int got negative: ${n}`);
  const hex = n.toString(16).padStart(byteLen * 2, "0");
  return hexToBytes(hex);
}

function encodeValue(
  type: string,
  value: unknown,
  types: Record<string, TypedDataField[]>,
): Uint8Array {
  // Struct: hashStruct(value)
  if (type in types) {
    return hashStruct(type, value as Record<string, unknown>, types);
  }

  // Array
  const arrayBase = arrayBaseType(type);
  if (arrayBase) {
    const arr = value as unknown[];
    // For arrays: keccak256(concat of each element's encodeData)
    let buf = new Uint8Array(0);
    for (const el of arr) {
      const enc = encodeValue(arrayBase, el, types);
      const merged = new Uint8Array(buf.length + enc.length);
      merged.set(buf, 0);
      merged.set(enc, buf.length);
      buf = merged;
    }
    return keccak_256(buf);
  }

  // bytes (dynamic): keccak256(value)
  if (type === "bytes") {
    const b = typeof value === "string" ? hexToBytes(value) : (value as Uint8Array);
    return keccak_256(b);
  }

  // string (dynamic): keccak256(utf8 bytes)
  if (type === "string") {
    return keccak_256(new TextEncoder().encode(String(value)));
  }

  // bool: pad32 of single byte
  if (type === "bool") {
    return leftPad32(new Uint8Array([value ? 1 : 0]));
  }

  // address: 20 bytes, left-padded to 32
  if (type === "address") {
    return leftPad32(hexToBytes(value as string));
  }

  // bytes1..32 (fixed): right-pad to 32
  const fixedBytes = /^bytes([1-9]|[12]\d|3[0-2])$/.exec(type);
  if (fixedBytes) {
    const b = typeof value === "string" ? hexToBytes(value) : (value as Uint8Array);
    return rightPad32(b);
  }

  // uint* / int*
  const intMatch = /^(u?)int(\d+)$/.exec(type);
  if (intMatch) {
    const signed = intMatch[1] === "";
    const bits = parseInt(intMatch[2]!, 10);
    const n = typeof value === "bigint" ? value : BigInt(value as number | string);
    return leftPad32(intToBytes(n, signed, bits));
  }

  throw new Error(`unsupported EIP-712 type: ${type}`);
}

function hashStruct(
  typeName: string,
  value: Record<string, unknown>,
  types: Record<string, TypedDataField[]>,
): Uint8Array {
  const fields = types[typeName];
  if (!fields) throw new Error(`unknown struct type: ${typeName}`);
  // Concat typeHash + encodeValue per field
  const parts: Uint8Array[] = [typeHash(typeName, types)];
  for (const f of fields) {
    parts.push(encodeValue(f.type, value[f.name], types));
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return keccak_256(buf);
}

// ---- Public API ----

/**
 * Compute the 32-byte EIP-712 v4 digest to sign. The wallet then runs
 * its standard secp256k1 signDigest over this. Result: 0x-prefixed hex.
 */
export function computeEip712Digest(data: TypedData): string {
  // EIP712Domain is implicit if not declared by the caller.
  const types = { ...data.types };
  if (!types.EIP712Domain) {
    // Build a default EIP712Domain shape from the provided domain object.
    // Standard fields, in canonical order.
    const candidates: TypedDataField[] = [];
    if ("name" in data.domain) candidates.push({ name: "name", type: "string" });
    if ("version" in data.domain) candidates.push({ name: "version", type: "string" });
    if ("chainId" in data.domain) candidates.push({ name: "chainId", type: "uint256" });
    if ("verifyingContract" in data.domain) candidates.push({ name: "verifyingContract", type: "address" });
    if ("salt" in data.domain) candidates.push({ name: "salt", type: "bytes32" });
    types.EIP712Domain = candidates;
  }

  const domainSep = hashStruct("EIP712Domain", data.domain, types);
  const msgHash = hashStruct(data.primaryType, data.message, types);

  const buf = new Uint8Array(2 + 32 + 32);
  buf[0] = 0x19;
  buf[1] = 0x01;
  buf.set(domainSep, 2);
  buf.set(msgHash, 34);
  return bytesToHex(keccak_256(buf));
}

/** Parse the JSON string a dApp typically passes to eth_signTypedData_v4. */
export function parseTypedData(input: string | TypedData): TypedData {
  if (typeof input === "string") return JSON.parse(input) as TypedData;
  return input;
}
