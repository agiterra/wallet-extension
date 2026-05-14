/**
 * Inpage script — runs in the page's MAIN world. Injects window.ethereum
 * (EIP-1193 provider) and bridges page calls to the content script via
 * postMessage. The content script forwards to the background service
 * worker, which talks to the configured Decider.
 *
 * Loaded by content-script.ts via a <script src="inpage.js"> injection
 * (web_accessible_resources). Once loaded, dApps see a standard
 * EIP-1193 provider and have no way to tell it from MetaMask, except
 * by EIP-6963 announcements (which we control).
 *
 * v0.1.0: scaffolding. Only eth_chainId + eth_accounts return sane
 * defaults; signing methods route through the bridge but the bridge's
 * response side is not yet implemented.
 */

interface Eip1193Request {
  method: string;
  params?: unknown[];
}

interface BridgeMessage {
  source: "agiterra-wallet-inpage";
  request_id: string;
  request: Eip1193Request;
}

interface BridgeResponse {
  source: "agiterra-wallet-content";
  request_id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

function genId(): string {
  return crypto.randomUUID();
}

type EventHandler = (...args: unknown[]) => void;

class AgiterraEthereumProvider {
  readonly isMetaMask = false; // Don't impersonate
  readonly isAgiterraWallet = true;

  private listeners = new Map<string, Set<EventHandler>>();

  async request(req: Eip1193Request): Promise<unknown> {
    const request_id = genId();
    const msg: BridgeMessage = {
      source: "agiterra-wallet-inpage",
      request_id,
      request: req,
    };
    return new Promise((resolve, reject) => {
      pending.set(request_id, { resolve, reject });
      window.postMessage(msg, window.location.origin);
    });
  }

  // EIP-1193 event emitter. Supports `chainChanged`, `accountsChanged`,
  // `connect`, `disconnect`, `message`. Events fired by the SW via
  // content-script forwarding (see WalletEventBridgeMessage below).
  on(event: string, handler: EventHandler): this {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(handler);
    return this;
  }
  removeListener(event: string, handler: EventHandler): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }
  addListener(event: string, handler: EventHandler): this {
    return this.on(event, handler);
  }
  off(event: string, handler: EventHandler): this {
    return this.removeListener(event, handler);
  }

  _emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const h of set) {
      try { h(...args); } catch (e) {
        console.error(`[agiterra-wallet] listener for '${event}' threw:`, e);
      }
    }
  }
}

interface WalletEventBridgeMessage {
  source: "agiterra-wallet-content-event";
  event: string;
  data: unknown;
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as BridgeResponse | WalletEventBridgeMessage | undefined;
  if (!data) return;

  // EIP-1193 event from the SW (chainChanged, accountsChanged, etc.)
  if ((data as WalletEventBridgeMessage).source === "agiterra-wallet-content-event") {
    const ev = data as WalletEventBridgeMessage;
    provider._emit(ev.event, ev.data);
    return;
  }

  // Standard request/response bridge.
  const resp = data as BridgeResponse;
  if (resp.source !== "agiterra-wallet-content") return;
  const handler = pending.get(resp.request_id);
  if (!handler) return;
  pending.delete(resp.request_id);
  if (resp.error) {
    const e = new Error(resp.error.message);
    (e as Error & { code: number; data?: unknown }).code = resp.error.code;
    (e as Error & { code: number; data?: unknown }).data = resp.error.data;
    handler.reject(e);
  } else {
    handler.resolve(resp.result);
  }
});

const provider = new AgiterraEthereumProvider();

// EIP-6963 multi-wallet discovery announcement.
// The UUID is a stable identifier for this wallet (per EIP-6963 — must NOT
// regenerate per page-load; dApps use it to dedupe across reloads).
import { AGITERRA_WALLET_ICON_DATA_URI } from "./icon-data-uri.js";
const eip6963Info = {
  uuid: "474cd34c-8091-4ce8-9560-ea19b312c6fc",
  name: "Agiterra Wallet",
  icon: AGITERRA_WALLET_ICON_DATA_URI,
  rdns: "land.agiterra.wallet",
};

window.addEventListener("eip6963:requestProvider", () => {
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info: eip6963Info, provider }),
    }),
  );
});

// Announce on load
window.dispatchEvent(
  new CustomEvent("eip6963:announceProvider", {
    detail: Object.freeze({ info: eip6963Info, provider }),
  }),
);

// Also set window.ethereum if no provider is already installed.
// dApps that don't yet use EIP-6963 still see a working provider.
if (!(window as { ethereum?: unknown }).ethereum) {
  (window as { ethereum?: unknown }).ethereum = provider;
}
