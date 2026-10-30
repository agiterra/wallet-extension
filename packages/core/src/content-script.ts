/**
 * Content script — runs in the extension's ISOLATED world per page.
 * Two jobs:
 *   Bridge messages between the page and the background service worker.
 *   (inpage.js is its own MAIN-world content script in the manifest: a
 *   <script src> injection runs async, so on a reload a cached dApp
 *   bundle could init before window.ethereum existed. Dynamic then
 *   restored no wallet, wagmi kept 0 connections (ENG-5331 FV, eng-2452).)
 *
 * The bridge is unidirectional-per-message: page sends a
 * `agiterra-wallet-inpage` message via window.postMessage; we forward
 * it to background via chrome.runtime.sendMessage. Background eventually
 * resolves; we postMessage the response back to the page.
 */

interface BridgeMessage {
  source: "agiterra-wallet-inpage";
  request_id: string;
  request: { method: string; params?: unknown[] };
}

interface BridgeResponse {
  source: "agiterra-wallet-content";
  request_id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// EIP-1193 event forwarding: SW broadcasts `wallet/event` messages to all
// tabs when chain or accounts change. Content script forwards them into the
// page so inpage's provider can fire registered listeners (chainChanged,
// accountsChanged, etc.).
interface WalletEventMessage {
  type: "wallet/event";
  event: string;
  data: unknown;
}
chrome.runtime.onMessage.addListener((msg: WalletEventMessage) => {
  if (msg?.type !== "wallet/event") return false;
  window.postMessage(
    { source: "agiterra-wallet-content-event", event: msg.event, data: msg.data },
    window.location.origin,
  );
  return false;
});

window.addEventListener("message", async (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as BridgeMessage | undefined;
  if (!msg || msg.source !== "agiterra-wallet-inpage") return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "wallet/request",
      request_id: msg.request_id,
      request: msg.request,
      origin: window.location.origin,
      tab_url: window.location.href,
    });
    const out: BridgeResponse = {
      source: "agiterra-wallet-content",
      request_id: msg.request_id,
      ...(response.error ? { error: response.error } : { result: response.result }),
    };
    window.postMessage(out, window.location.origin);
  } catch (e) {
    const err = e as Error & { code?: number };
    const out: BridgeResponse = {
      source: "agiterra-wallet-content",
      request_id: msg.request_id,
      error: { code: err.code ?? -32603, message: err.message ?? "Internal error" },
    };
    window.postMessage(out, window.location.origin);
  }
});
