/**
 * EIP-1193 method → actual signing.
 *
 * v0.3:
 *   - eth_requestAccounts / eth_accounts / eth_chainId / net_version — direct returns
 *   - personal_sign — EIP-191 prefixed digest, sign via wallet-tools
 *   - eth_signTransaction — fill missing fields via RPC, RLP-encode EIP-1559,
 *     sign digest, return signed raw tx hex
 *   - eth_sendTransaction — as above, then broadcast via eth_sendRawTransaction
 *
 * EIP-712 (eth_signTypedData_v4) still TODO — caller passes pre-hashed digest.
 */

import { personalSign, signDigest } from "@agiterra/wallet-tools";
import { keccak_256 } from "@noble/hashes/sha3";
import { rlpEncode, toRlpBytes, bytesToHex, hexToBytes } from "./rlp.js";
import { computeEip712Digest, parseTypedData } from "./eip712.js";
import {
  estimateGas,
  getBlock,
  getTransactionCount,
  maxPriorityFeePerGas,
  sendRawTransaction,
} from "./rpc.js";

export interface SigningContext {
  privateKeyHex: string;
  address: string;
  chainId: number;
}

export interface SigningResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface TxRequest {
  from?: string;
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
  type?: string;
  chainId?: string;
}

export async function signEip1193(
  method: string,
  params: unknown[],
  ctx: SigningContext,
): Promise<SigningResult> {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return { result: [ctx.address] };

    case "eth_chainId":
      return { result: "0x" + ctx.chainId.toString(16) };

    case "net_version":
      return { result: String(ctx.chainId) };

    case "personal_sign": {
      // params: [message, address]  OR  [address, message]
      // Spec-correct order is [message, address] (per EIP-1474), but
      // some dApps send [address, message]. Detect by the 0x-prefix
      // pattern: addresses are exactly 42 chars, "0x" + 40 hex.
      const [a, b] = params as [string, string];
      const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);
      const message = isAddress(a) ? b : a;
      const messageStr = decodeMessage(message);
      const sig = personalSign(messageStr, ctx.privateKeyHex);
      return { result: sig };
    }

    case "eth_signTransaction": {
      const tx = params[0] as TxRequest;
      try {
        const signed = await buildAndSignTx(tx, ctx);
        return { result: signed.rawTxHex };
      } catch (e) {
        return { error: { code: -32603, message: `eth_signTransaction failed: ${(e as Error).message}` } };
      }
    }

    case "eth_sendTransaction": {
      const tx = params[0] as TxRequest;
      try {
        const signed = await buildAndSignTx(tx, ctx);
        const txHash = await sendRawTransaction(ctx.chainId, signed.rawTxHex);
        return { result: txHash };
      } catch (e) {
        return { error: { code: -32603, message: `eth_sendTransaction failed: ${(e as Error).message}` } };
      }
    }

    case "eth_signTypedData_v4": {
      // params: [address, typedDataJsonOrObject]
      // (Some dApps swap the order; detect by 0x-prefix.)
      const [a, b] = params as [unknown, unknown];
      const isAddr = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
      const tdInput = isAddr(a) ? b : a;
      try {
        const typed = parseTypedData(tdInput as string);
        const digestHex = computeEip712Digest(typed);
        const sig = signDigest(digestHex, ctx.privateKeyHex);
        // EIP-1193 returns 65-byte serialized signature (v=27|28, like personal_sign).
        return { result: sig.serialized };
      } catch (e) {
        return { error: { code: -32603, message: `eth_signTypedData_v4 failed: ${(e as Error).message}` } };
      }
    }

    default:
      return { error: { code: -32601, message: `Method ${method} not supported` } };
  }
}

/**
 * Build, sign, and serialize an EIP-1559 transaction. Fills missing
 * fee/nonce/gas fields via RPC against the wallet's configured chain.
 */
async function buildAndSignTx(
  tx: TxRequest,
  ctx: SigningContext,
): Promise<{ rawTxHex: string }> {
  const chainId = BigInt(ctx.chainId);

  // Nonce: dApp-provided or pending count.
  const nonce = tx.nonce != null
    ? BigInt(tx.nonce)
    : await getTransactionCount(ctx.chainId, ctx.address, "pending");

  // Fees: prefer dApp-provided, otherwise derive from RPC.
  let maxPriority: bigint;
  let maxFee: bigint;
  if (tx.maxPriorityFeePerGas && tx.maxFeePerGas) {
    maxPriority = BigInt(tx.maxPriorityFeePerGas);
    maxFee = BigInt(tx.maxFeePerGas);
  } else {
    maxPriority = await maxPriorityFeePerGas(ctx.chainId);
    const block = await getBlock(ctx.chainId, "latest");
    const baseFee = block.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
    // 2x baseFee headroom + priority tip (matches MetaMask's "fast" default shape).
    maxFee = baseFee * 2n + maxPriority;
  }

  // Gas limit: dApp-provided or estimate.
  let gasLimit: bigint;
  if (tx.gas != null) gasLimit = BigInt(tx.gas);
  else if (tx.gasLimit != null) gasLimit = BigInt(tx.gasLimit);
  else {
    gasLimit = await estimateGas(ctx.chainId, {
      from: ctx.address,
      to: tx.to,
      value: tx.value,
      data: tx.data,
    });
  }

  // EIP-1559 tx payload: [chainId, nonce, maxPriority, maxFee, gasLimit, to, value, data, accessList]
  const toBytes = tx.to ? hexToBytes(tx.to) : new Uint8Array(0);
  const valueBytes = toRlpBytes(tx.value ?? 0);
  const dataBytes = toRlpBytes(tx.data ?? "0x");
  const fields = [
    toRlpBytes(chainId),
    toRlpBytes(nonce),
    toRlpBytes(maxPriority),
    toRlpBytes(maxFee),
    toRlpBytes(gasLimit),
    toBytes,
    valueBytes,
    dataBytes,
    [] as never[], // accessList
  ];

  // EIP-1559 envelope prefix is 0x02 || rlp(payload). Unsigned digest hashes that.
  const unsignedRlp = rlpEncode(fields);
  const unsignedEnv = concatBytes(new Uint8Array([0x02]), unsignedRlp);
  const digest = keccak_256(unsignedEnv);
  const digestHex = bytesToHex(digest);

  // wallet-tools signDigest returns v = recovery + 27. EIP-1559 wants raw
  // recovery (y_parity ∈ {0,1}). Subtract 27.
  const sig = signDigest(digestHex, ctx.privateKeyHex);
  const yParity = sig.v - 27;
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(`unexpected y_parity ${yParity} (signDigest returned v=${sig.v})`);
  }

  const signedFields = [
    ...fields,
    toRlpBytes(BigInt(yParity)),
    hexToBytes(sig.r),
    hexToBytes(sig.s),
  ];
  const signedRlp = rlpEncode(signedFields);
  const signedEnv = concatBytes(new Uint8Array([0x02]), signedRlp);
  return { rawTxHex: bytesToHex(signedEnv) };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * personal_sign messages may be hex-encoded (0x-prefixed) or utf-8.
 * Decode hex; pass utf-8 through.
 */
function decodeMessage(input: string): string {
  if (typeof input !== "string") return String(input);
  if (input.startsWith("0x") && /^0x[0-9a-fA-F]*$/.test(input) && input.length % 2 === 0) {
    let out = "";
    for (let i = 2; i < input.length; i += 2) {
      out += String.fromCharCode(parseInt(input.slice(i, i + 2), 16));
    }
    return out;
  }
  return input;
}
