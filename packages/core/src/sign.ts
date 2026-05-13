/**
 * EIP-1193 method → actual signing. For v0.2 we implement personal_sign
 * and eth_requestAccounts / eth_accounts. eth_signTransaction (EIP-1559
 * RLP-encoded signing) ships in v0.3 alongside chain config.
 */

import { personalSign } from "@agiterra/wallet-tools";

export interface SigningContext {
  privateKeyHex: string;
  address: string;
  chainId: number;
}

export interface SigningResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function signEip1193(
  method: string,
  params: unknown[],
  ctx: SigningContext,
): SigningResult {
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

    case "eth_sendTransaction":
    case "eth_signTransaction":
    case "eth_signTypedData_v4":
      return {
        error: {
          code: -32601,
          message: `${method} is not yet implemented in wallet-extension v0.2. Lands in v0.3 with RLP/EIP-712 helpers.`,
        },
      };

    default:
      return {
        error: { code: -32601, message: `Method ${method} not supported` },
      };
  }
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
