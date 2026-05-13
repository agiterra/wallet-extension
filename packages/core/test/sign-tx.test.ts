#!/usr/bin/env bun
/**
 * Offline sanity test for the new eth_signTransaction path.
 * Reuses wallet-tools' signDigest so we depend on the same primitives.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { signDigest, addressFromPrivateKey } from "@agiterra/wallet-tools";
import { Transaction, Wallet } from "ethers";
import { rlpEncode, toRlpBytes, bytesToHex, hexToBytes } from "../src/rlp.ts";

// Public test key from EIP-1559 spec examples — DO NOT FUND.
const privKeyHex = "0x4646464646464646464646464646464646464646464646464646464646464646";

const chainId = 11155111n;
const nonce = 0n;
const maxPriority = 1000000000n;
const maxFee = 30000000000n;
const gasLimit = 21000n;
const to = "0x000000000000000000000000000000000000dEaD";
const value = 1000000000000000n;
const data = "0x";

const fields = [
  toRlpBytes(chainId),
  toRlpBytes(nonce),
  toRlpBytes(maxPriority),
  toRlpBytes(maxFee),
  toRlpBytes(gasLimit),
  hexToBytes(to),
  toRlpBytes(value),
  toRlpBytes(data),
  [] as never[],
];

const unsignedRlp = rlpEncode(fields);
const envelope = new Uint8Array(unsignedRlp.length + 1);
envelope[0] = 0x02;
envelope.set(unsignedRlp, 1);
const digest = keccak_256(envelope);
const digestHex = bytesToHex(digest);

const sig = signDigest(digestHex, privKeyHex);
const yParity = sig.v - 27;
if (yParity !== 0 && yParity !== 1) {
  console.error("FAIL: unexpected y_parity", yParity, "v=", sig.v);
  process.exit(1);
}

const signedFields = [
  ...fields,
  toRlpBytes(BigInt(yParity)),
  hexToBytes(sig.r),
  hexToBytes(sig.s),
];
const signedRlp = rlpEncode(signedFields);
const signedEnv = new Uint8Array(signedRlp.length + 1);
signedEnv[0] = 0x02;
signedEnv.set(signedRlp, 1);
const rawTxHex = bytesToHex(signedEnv);

const parsed = Transaction.from(rawTxHex);
const expectedAddr = addressFromPrivateKey(privKeyHex);
const expectedFromEthers = new Wallet(privKeyHex).address;

console.log("expected (wallet-tools):", expectedAddr);
console.log("expected (ethers):      ", expectedFromEthers);
console.log("parsed from:            ", parsed.from);
console.log("hash:                   ", parsed.hash);
console.log("to:                     ", parsed.to);
console.log("value:                  ", parsed.value.toString());
console.log("chainId:                ", parsed.chainId.toString());

if (
  parsed.from?.toLowerCase() === expectedAddr.toLowerCase() &&
  parsed.to?.toLowerCase() === to.toLowerCase() &&
  parsed.value === value &&
  parsed.chainId === chainId
) {
  console.log("\nPASS — signed tx round-trips through ethers cleanly + sender recovers.");
} else {
  console.error("\nFAIL — mismatch");
  process.exit(1);
}
