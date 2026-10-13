import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Minimal chrome.* stub: storage.local/session + the runtime.onMessage hook the
// background handler installs. Seeded so neither startup bootstrap does work.
const RPC = "https://rpc.example.test/sepolia";
let local: Record<string, unknown>;
let listener: ((msg: unknown, sender: unknown, send: (r: unknown) => void) => boolean) | null = null;
const area = (store: () => Record<string, unknown>) => ({
  get: async (keys: string | string[]) => {
    const ks = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(ks.filter((k) => k in store()).map((k) => [k, store()[k]]));
  },
  set: async (o: Record<string, unknown>) => { Object.assign(store(), o); },
});
let session: Record<string, unknown> = {};
(globalThis as any).chrome = {
  storage: { local: area(() => local), session: area(() => session) },
  runtime: { onMessage: { addListener: (l: typeof listener) => { listener = l; } } },
};

const fetched: Array<{ url: string; body: any }> = [];
const realFetch = globalThis.fetch;
let reply: unknown;

beforeEach(() => {
  local = {
    "agiterra-wallet-extension-rpc-urls": { "11155111": RPC },
    "agiterra-wallet-extension-default-rpc-bootstrapped": true,
    "agiterra-wallet-active-chain-id": 11155111,
    // A non-empty vault so the dev-wallet bootstrap is a no-op.
    "agiterra-wallet-vault": [{ name: "w", address: "0x0000000000000000000000000000000000000001", encrypted_key: "x" }],
  };
  session = {};
  fetched.length = 0;
  (globalThis as any).fetch = async (url: string, init: RequestInit) => {
    fetched.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), { status: 200 });
  };
});
afterEach(() => { (globalThis as any).fetch = realFetch; });

const { installRequestHandler, READ_PASSTHROUGH_METHODS } = await import("./background-core.js");
installRequestHandler(() => { throw new Error("decider must not be built for a read"); });

function call(method: string, params: unknown[] = []): Promise<any> {
  return new Promise((resolve) => {
    listener!({ type: "wallet/request", request_id: "r1", request: { method, params }, origin: "https://x", tab_url: "https://x" },
      { tab: { id: 7 } }, resolve);
  });
}

describe("read passthrough (0.5.1)", () => {
  test("eth_call is forwarded to the active chain's RPC with params intact", async () => {
    reply = { jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(63) + "5" };
    const p = [{ to: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", data: "0x70a08231" }, "latest"];
    const r = await call("eth_call", p);
    expect(r).toEqual({ result: "0x" + "0".repeat(63) + "5" });
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe(RPC);
    expect(fetched[0].body.method).toBe("eth_call");
    expect(fetched[0].body.params).toEqual(p);
  });

  test("a node error object reaches the dApp unchanged (revert code + data)", async () => {
    reply = { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x08c379a0" } };
    const r = await call("eth_estimateGas", [{}]);
    expect(r).toEqual({ error: { code: 3, message: "execution reverted", data: "0x08c379a0" } });
  });

  test("HTTP failure maps to -32603", async () => {
    (globalThis as any).fetch = async () => new Response("bad gateway", { status: 502 });
    const r = await call("eth_blockNumber");
    expect(r.error.code).toBe(-32603);
    expect(r.error.message).toContain("502");
  });

  test("no RPC URL for the active chain maps to -32603, no fetch", async () => {
    local["agiterra-wallet-active-chain-id"] = 1;
    const r = await call("eth_getBalance", ["0x01", "latest"]);
    expect(r.error.code).toBe(-32603);
    expect(fetched).toHaveLength(0);
  });

  test("sign methods are NOT passthrough", () => {
    for (const m of ["eth_sendTransaction", "eth_signTransaction", "personal_sign", "eth_sign", "eth_signTypedData_v4", "eth_sendRawTransaction"]) {
      expect(READ_PASSTHROUGH_METHODS.has(m)).toBe(false);
    }
  });

  test("an unknown method still returns -32601 without a fetch", async () => {
    const r = await call("eth_subscribe");
    expect(r.error.code).toBe(-32601);
    expect(fetched).toHaveLength(0);
  });
});
