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

class AgiterraEthereumProvider {
  readonly isMetaMask = false; // Don't impersonate
  readonly isAgiterraWallet = true;

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

  // EIP-1193 event emitter stubs. v0.1.0 doesn't emit events; v0.2
  // wires accountsChanged / chainChanged when the agent calls
  // wallet_use() or wallet_switch_chain.
  on(_event: string, _handler: (...args: unknown[]) => void): this { return this; }
  removeListener(_event: string, _handler: (...args: unknown[]) => void): this { return this; }
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as BridgeResponse | undefined;
  if (!data || data.source !== "agiterra-wallet-content") return;
  const handler = pending.get(data.request_id);
  if (!handler) return;
  pending.delete(data.request_id);
  if (data.error) {
    const e = new Error(data.error.message);
    (e as Error & { code: number; data?: unknown }).code = data.error.code;
    (e as Error & { code: number; data?: unknown }).data = data.error.data;
    handler.reject(e);
  } else {
    handler.resolve(data.result);
  }
});

const provider = new AgiterraEthereumProvider();

// EIP-6963 multi-wallet discovery announcement
const eip6963Info = {
  uuid: "agiterra-wallet-" + crypto.randomUUID(),
  name: "Agiterra Wallet",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPjwvc3ZnPg==",
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
