/**
 * Background service worker core — variant-agnostic.
 *
 * Each extension variant (prod, ci) imports {@link installRequestHandler}
 * and supplies its own {@link DeciderFactory}. The factory decides which
 * concrete Decider to build for each wallet's configured `mode`
 * (local-rpc / wire / manual). Core never imports Wire.
 */

import type { SignRequest, WalletEntry } from "@agiterra/wallet-tools";
import type { DeciderFactory } from "./decider.js";
import { signEip1193 } from "./sign.js";
import {
  getVault,
  unlockPrivateKey,
  bootstrapDevWalletIfEmpty,
  devChainId,
} from "./vault-store.js";

// Active wallet per tab — explicit selection from agent (wallet_use).
// Default when no selection: first wallet in vault.
const tabActiveWallet = new Map<number, string>(); // tab_id → wallet address

async function getActiveWallet(tabId: number | undefined): Promise<WalletEntry | null> {
  const wallets = await getVault();
  if (wallets.length === 0) return null;
  if (tabId != null) {
    const explicit = tabActiveWallet.get(tabId);
    if (explicit) {
      const w = wallets.find((x) => x.address.toLowerCase() === explicit.toLowerCase());
      if (w) return w;
    }
  }
  return wallets[0];
}

interface IncomingRequest {
  type: "wallet/request";
  request_id: string;
  request: { method: string; params?: unknown[] };
  origin: string;
  tab_url: string;
}

type SignResult = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

export function installRequestHandler(makeDecider: DeciderFactory): void {
  chrome.runtime.onMessage.addListener(
    (msg: IncomingRequest, sender, sendResponse) => {
      if (msg.type !== "wallet/request") return false;
      void handle(msg, sender, makeDecider)
        .then(sendResponse)
        .catch((e: Error & { code?: number }) => {
          console.error("[wallet-vault] handler crashed:", e);
          sendResponse({ error: { code: e.code ?? -32603, message: e.message ?? "Internal error" } });
        });
      return true; // async response
    },
  );

  (async () => {
    try {
      await bootstrapDevWalletIfEmpty();
    } catch (e) {
      console.error("[wallet-vault] bootstrap failed:", e);
    }
  })();
}

async function handle(
  msg: IncomingRequest,
  sender: chrome.runtime.MessageSender,
  makeDecider: DeciderFactory,
): Promise<SignResult> {
  const wallet = await getActiveWallet(sender.tab?.id);
  const method = msg.request.method;
  const params = msg.request.params ?? [];

  // Read-only methods that don't need a decider:
  if (method === "eth_chainId") return { result: "0x" + devChainId().toString(16) };
  if (method === "net_version") return { result: String(devChainId()) };

  if (!wallet) {
    return {
      error: {
        code: -32603,
        message: "No wallets in vault. (Extension auto-bootstraps a dev wallet on first run; reload extension if missing.)",
      },
    };
  }

  // Methods that only need the active account, no signing decision:
  if (method === "eth_accounts") return { result: [wallet.address] };

  const needsDecision = new Set([
    "eth_requestAccounts",
    "eth_sendTransaction",
    "eth_signTransaction",
    "personal_sign",
    "eth_sign",
    "eth_signTypedData_v4",
  ]);

  if (needsDecision.has(method)) {
    const signReq: SignRequest = {
      request_id: msg.request_id,
      source: "wallet-vault",
      wallet_address: wallet.address,
      wallet_name: wallet.name,
      tab_id: String(sender.tab?.id ?? ""),
      origin: msg.origin,
      chain_id: devChainId(),
      method,
      params,
      created_at: Date.now(),
    };

    const decider = makeDecider(wallet.decider);

    console.log("[wallet-vault] dispatching sign request to decider:", signReq);
    let response;
    try {
      response = await decider.decide(signReq);
    } catch (e) {
      const err = e as Error;
      console.error("[wallet-vault] decider failed:", err);
      return { error: { code: -32603, message: `Decider error: ${err.message}` } };
    }
    console.log("[wallet-vault] decider response:", response);

    switch (response.action) {
      case "refuse":
        // EIP-1193 convention: code 4001 message is the literal sentinel
        // "User rejected the request." The decider's reason rides in `data`
        // so callers / tests can introspect it without scraping `message`.
        return {
          error: {
            code: 4001,
            message: "User rejected the request.",
            data: response.reason ? { reason: response.reason } : undefined,
          },
        };
      case "reject_with_error":
        return { error: { code: response.code, message: response.message, data: response.data } };
      case "approve_with_override":
        // TODO(v0.3+): apply override.params before signing. v0.2 rejects.
        return { error: { code: -32603, message: "approve_with_override not yet implemented" } };
      case "approve": {
        try {
          const privateKeyHex = await unlockPrivateKey(wallet);
          const signed = signEip1193(method, params, {
            privateKeyHex,
            address: wallet.address,
            chainId: devChainId(),
          });
          return signed;
        } catch (e) {
          const err = e as Error;
          console.error("[wallet-vault] signing failed:", err);
          return { error: { code: -32603, message: `Signing failed: ${err.message}` } };
        }
      }
    }
  }

  return { error: { code: -32601, message: `Method ${method} not supported by wallet-vault` } };
}

export { tabActiveWallet };
