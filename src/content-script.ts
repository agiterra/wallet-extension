/**
 * Content script — runs in the extension's ISOLATED world per page.
 * Two jobs:
 *   1. Inject inpage.js into the page's MAIN world (so window.ethereum
 *      is set up before any dApp script runs).
 *   2. Bridge messages between the page and the background service worker.
 *
 * The bridge is unidirectional-per-message: page sends a
 * `agiterra-wallet-inpage` message via window.postMessage; we forward
 * it to background via chrome.runtime.sendMessage. Background eventually
 * resolves; we postMessage the response back to the page.
 */

// Inject inpage.js into the MAIN world.
const script = document.createElement("script");
script.src = chrome.runtime.getURL("inpage.js");
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

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
