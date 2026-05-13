/**
 * Background service worker. Owns:
 *   - The vault (chrome.storage.local)
 *   - The Decider abstraction (Wire / Manual / LocalRpc)
 *   - The chrome.runtime.onMessage handler that fields EIP-1193 requests
 *     from content scripts
 *
 * v0.1.0 SCAFFOLDING: handler routes requests, but the Decider isn't
 * wired up yet. Returns stub results so dApps don't crash during dev.
 * v0.2 implements WireDecider; v0.3 implements ManualDecider + UI;
 * v0.5 implements LocalRpcDecider for CI.
 */

import type { SignRequest, SignResponse, WalletEntry } from "@agiterra/wallet-tools";
import { WALLET_SIGN_REQUEST } from "@agiterra/wallet-tools";

// ----- Vault (minimal v0.1 stub) -----

const VAULT_KEY = "agiterra-wallet-vault";

async function getVault(): Promise<WalletEntry[]> {
  const stored = await chrome.storage.local.get(VAULT_KEY);
  return (stored[VAULT_KEY] as WalletEntry[]) ?? [];
}

async function setVault(wallets: WalletEntry[]): Promise<void> {
  await chrome.storage.local.set({ [VAULT_KEY]: wallets });
}

// ----- Active wallet per tab -----

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
  // Default: first wallet in vault.
  return wallets[0];
}

// ----- EIP-1193 request handler -----

interface IncomingRequest {
  type: "wallet/request";
  request_id: string;
  request: { method: string; params?: unknown[] };
  origin: string;
  tab_url: string;
}

chrome.runtime.onMessage.addListener(
  (msg: IncomingRequest, sender, sendResponse) => {
    if (msg.type !== "wallet/request") return false;
    void handle(msg, sender)
      .then(sendResponse)
      .catch((e: Error & { code?: number }) =>
        sendResponse({ error: { code: e.code ?? -32603, message: e.message ?? "Internal error" } }),
      );
    return true; // async response
  },
);

async function handle(
  msg: IncomingRequest,
  sender: chrome.runtime.MessageSender,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const wallet = await getActiveWallet(sender.tab?.id);
  const method = msg.request.method;

  // Read-only methods that don't need a decider:
  if (method === "eth_chainId") return { result: "0x1" /* TODO: from config */ };
  if (method === "eth_accounts") return { result: wallet ? [wallet.address] : [] };
  if (method === "net_version") return { result: "1" /* TODO: from config */ };

  if (!wallet) {
    return { error: { code: -32603, message: "No wallets in vault. Create one via wallet_create MCP tool." } };
  }

  // Methods that require a sign decision:
  if (
    method === "eth_requestAccounts" ||
    method === "eth_sendTransaction" ||
    method === "eth_signTransaction" ||
    method === "personal_sign" ||
    method === "eth_sign" ||
    method === "eth_signTypedData_v4"
  ) {
    const signReq: SignRequest = {
      request_id: msg.request_id,
      source: "wallet-vault",
      wallet_address: wallet.address,
      wallet_name: wallet.name,
      tab_id: String(sender.tab?.id ?? ""),
      origin: msg.origin,
      chain_id: 1, // TODO: from config
      method,
      params: msg.request.params ?? [],
      created_at: Date.now(),
    };

    // v0.1.0: stub. Log and refuse — dApps see standard 4001.
    console.log("[wallet-vault] sign request (v0.1 stub):", signReq);
    const stub: SignResponse = { request_id: msg.request_id, action: "refuse", reason: "v0.1_stub_not_implemented" };
    console.log("[wallet-vault] (stub) responding with:", stub);
    void WALLET_SIGN_REQUEST; // referenced for future use
    return { error: { code: 4001, message: "User rejected the request. (v0.1 stub — Decider not implemented yet)" } };
  }

  return { error: { code: -32601, message: `Method ${method} not supported by wallet-vault v0.1` } };
}

// Service worker keepalive ping (Manifest V3 service workers sleep
// after ~30s idle; we want to stay live to handle SSE from Wire in
// future versions). Harmless no-op in v0.1.
chrome.alarms?.create?.("wallet-vault-keepalive", { periodInMinutes: 0.5 });

console.log("[wallet-vault] background service worker started, v0.1.0");
