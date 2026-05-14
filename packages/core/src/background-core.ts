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
  getActiveChainId,
  setActiveChainId,
} from "./vault-store.js";
import { setRpcUrl } from "./rpc.js";

/**
 * Resolve which wallet address is bound to a given browser tab.
 * Implemented by the prod entry against TabClaims (Wire plugin_settings
 * source of truth); CI entry passes null to fall back to the in-memory
 * map / first-wallet default.
 */
export type TabWalletResolver = (tabId: string | undefined) => Promise<string | null>;

// Legacy in-memory fallback for ci variant / pre-claim flows.
const tabActiveWallet = new Map<number, string>(); // tab_id → wallet address

async function getActiveWallet(
  tabId: number | undefined,
  tabResolver: TabWalletResolver | null,
): Promise<WalletEntry | null> {
  const wallets = await getVault();
  if (wallets.length === 0) return null;

  // Prefer the persistent tab-claim resolver (prod path).
  if (tabResolver) {
    const claimedAddress = await tabResolver(tabId != null ? String(tabId) : undefined);
    if (claimedAddress) {
      const w = wallets.find((x) => x.address.toLowerCase() === claimedAddress.toLowerCase());
      if (w) return w;
    }
  }

  // Legacy in-memory fallback.
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

export function installRequestHandler(
  makeDecider: DeciderFactory,
  tabResolver: TabWalletResolver | null = null,
): void {
  chrome.runtime.onMessage.addListener(
    (msg: IncomingRequest, sender, sendResponse) => {
      if (msg.type !== "wallet/request") return false;
      void handle(msg, sender, makeDecider, tabResolver)
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
  tabResolver: TabWalletResolver | null,
): Promise<SignResult> {
  const wallet = await getActiveWallet(sender.tab?.id, tabResolver);
  const method = msg.request.method;
  const params = msg.request.params ?? [];
  const activeChain = await getActiveChainId();

  // Read-only methods that don't need a decider:
  if (method === "eth_chainId") return { result: "0x" + activeChain.toString(16) };
  if (method === "net_version") return { result: String(activeChain) };

  // Permission-introspection methods. Per EIP-2255, return capabilities for
  // accounts. We auto-approve since the tab claim / operator default is
  // already the consent surface.
  if (method === "wallet_getPermissions" || method === "wallet_requestPermissions") {
    return { result: [{ parentCapability: "eth_accounts", caveats: [] }] };
  }

  // Chain management. Per EIP-3326 / EIP-3085: success returns null. After
  // updating active chain we fire chainChanged so the dApp re-reads state.
  if (method === "wallet_switchEthereumChain") {
    const arg = (params[0] ?? {}) as { chainId?: string };
    if (!arg.chainId) return { error: { code: -32602, message: "wallet_switchEthereumChain: missing chainId param" } };
    let id: number;
    try { id = parseChainIdParam(arg.chainId); } catch (e) {
      return { error: { code: -32602, message: (e as Error).message } };
    }
    await setActiveChainId(id);
    broadcastWalletEvent("chainChanged", "0x" + id.toString(16));
    return { result: null };
  }
  if (method === "wallet_addEthereumChain") {
    // EIP-3085: { chainId, chainName, nativeCurrency, rpcUrls, blockExplorerUrls? }
    const arg = (params[0] ?? {}) as { chainId?: string; rpcUrls?: string[] };
    if (!arg.chainId) return { error: { code: -32602, message: "wallet_addEthereumChain: missing chainId param" } };
    let id: number;
    try { id = parseChainIdParam(arg.chainId); } catch (e) {
      return { error: { code: -32602, message: (e as Error).message } };
    }
    const rpcUrl = (arg.rpcUrls ?? []).find((u) => typeof u === "string" && /^https?:\/\//.test(u));
    if (rpcUrl) {
      try { await setRpcUrl(id, rpcUrl); } catch (e) {
        console.warn(`[wallet-vault] wallet_addEthereumChain: failed to persist RPC URL: ${(e as Error).message}`);
      }
    }
    // Per spec, returning null doesn't auto-switch. dApps usually follow
    // up with wallet_switchEthereumChain if they want active.
    return { result: null };
  }

  if (!wallet) {
    return {
      error: {
        code: -32603,
        message: "No wallets in vault. (Extension auto-bootstraps a dev wallet on first run; reload extension if missing.)",
      },
    };
  }

  // Account-introspection methods return the tab's bound wallet directly —
  // these are reads, not signs, and going through the decider adds an
  // agent-loop latency floor of 5-25s that makes the wallet picker feel
  // hung. The agent already authorized the wallet by claiming the tab
  // (or the operator picked the default); no per-call decision needed.
  if (method === "eth_accounts" || method === "eth_requestAccounts") {
    return { result: [wallet.address] };
  }

  const needsDecision = new Set([
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
      chain_id: activeChain,
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
          const signedChain = await getActiveChainId();
          const signed = await signEip1193(method, params, {
            privateKeyHex,
            address: wallet.address,
            chainId: signedChain,
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

/**
 * Parse a chainId param from EIP-3085/3326 dApp callers. The spec says hex
 * 0x-prefixed but some dApps send decimal — accept both.
 */
function parseChainIdParam(s: string): number {
  const n = /^0x/i.test(s) ? parseInt(s, 16) : Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid chainId '${s}'`);
  return n;
}

/**
 * Broadcast an EIP-1193 event to every open tab. Content scripts forward
 * to inpage; inpage emits to dApp listeners. Used for chainChanged and
 * accountsChanged.
 */
function broadcastWalletEvent(name: string, data: unknown): void {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return;
  void chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      void chrome.tabs.sendMessage(tab.id, {
        type: "wallet/event",
        event: name,
        data,
      }).catch(() => { /* tabs without our content script ignore this */ });
    }
  });
}
