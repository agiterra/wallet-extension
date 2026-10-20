/**
 * ENG-5081 handler path: drives installRequestHandler's onMessage listener with
 * a minimal in-memory chrome mock and asserts what wallet_switchEthereumChain
 * does to the active chain in each switch mode, per tab, and after tab close.
 */
import { test, expect, beforeEach } from "bun:test";

type Store = Record<string, unknown>;
type Listener = (msg: unknown, sender: unknown, send: (r: unknown) => void) => boolean;
let local: Store, session: Store, onMessage: Listener | null, onRemoved: ((id: number) => void) | null, events: string[];

function area(s: () => Store) {
  return {
    get: async (k: string | string[]) => {
      const keys = Array.isArray(k) ? k : [k];
      return Object.fromEntries(keys.filter((x) => x in s()).map((x) => [x, s()[x]]));
    },
    set: async (o: Store) => { Object.assign(s(), o); },
    remove: async (k: string) => { delete s()[k]; },
  };
}

beforeEach(() => {
  local = {}; session = {}; onMessage = null; onRemoved = null; events = [];
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    storage: { local: area(() => local), session: area(() => session) },
    runtime: { onMessage: { addListener: (f: Listener) => { onMessage = f; } } },
    tabs: {
      onRemoved: { addListener: (f: (id: number) => void) => { onRemoved = f; } },
      query: (_q: unknown, cb: (t: { id: number }[]) => void) => cb([{ id: 1 }]),
      sendMessage: async (_id: number, m: { event: string }) => { events.push(m.event); },
    },
  };
});

async function call(tabId: number, method: string, params: unknown[] = []) {
  return await new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
    onMessage!(
      { type: "wallet/request", request_id: "r", request: { method, params }, origin: "https://x", tab_url: "https://x" },
      { tab: { id: tabId } },
      resolve as (r: unknown) => void,
    );
  });
}

async function setup() {
  const { installRequestHandler } = await import("../src/background-core.js");
  installRequestHandler((() => { throw new Error("no decider in this test"); }) as never);
  expect(onMessage).not.toBeNull();
  expect(onRemoved).not.toBeNull();
}

test("default mode lands the switch and fires chainChanged (positive control)", async () => {
  await setup();
  expect((await call(7, "wallet_switchEthereumChain", [{ chainId: "0x1" }])).result).toBeNull();
  expect((await call(7, "eth_chainId")).result).toBe("0x1");
  expect(events).toEqual(["chainChanged"]);
});

test("ack-no-land returns success but leaves the chain and fires no event", async () => {
  await setup();
  await call(7, "wallet_switchEthereumChain", [{ chainId: "0x1" }]);
  events = [];
  expect((await call(7, "agiterra_setSwitchMode", [{ mode: "ack-no-land" }])).result).toBe("ack-no-land");
  const r = await call(7, "wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }]);
  expect(r.error).toBeUndefined();
  expect(r.result).toBeNull();
  expect((await call(7, "eth_chainId")).result).toBe("0x1");
  expect(events).toEqual([]);
});

test("the mode is per tab: another tab still lands", async () => {
  await setup();
  await call(7, "agiterra_setSwitchMode", ["ack-no-land"]);
  await call(8, "wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }]);
  expect((await call(8, "eth_chainId")).result).toBe("0xaa36a7");
});

test("setting land again restores normal switching", async () => {
  await setup();
  await call(7, "agiterra_setSwitchMode", ["ack-no-land"]);
  await call(7, "agiterra_setSwitchMode", ["land"]);
  await call(7, "wallet_switchEthereumChain", [{ chainId: "0x89" }]);
  expect((await call(7, "eth_chainId")).result).toBe("0x89");
});

test("closing the tab drops its mode, so a reused tab id lands", async () => {
  await setup();
  await call(7, "agiterra_setSwitchMode", ["ack-no-land"]);
  onRemoved!(7);
  await new Promise((r) => setTimeout(r, 0));
  await call(7, "wallet_switchEthereumChain", [{ chainId: "0x89" }]);
  expect((await call(7, "eth_chainId")).result).toBe("0x89");
});

test("an unknown mode is refused with -32602 and changes nothing", async () => {
  await setup();
  const r = await call(7, "agiterra_setSwitchMode", [{ mode: "bogus" }]);
  expect(r.error?.code).toBe(-32602);
  expect(r.error?.message).toContain("mode must be one of land, ack-no-land, reject");
  await call(7, "wallet_switchEthereumChain", [{ chainId: "0x89" }]);
  expect((await call(7, "eth_chainId")).result).toBe("0x89");
});

test("reject answers 4001, leaves the chain and fires no event", async () => {
  await setup();
  await call(7, "wallet_switchEthereumChain", [{ chainId: "0x1" }]);
  events = [];
  expect((await call(7, "agiterra_setSwitchMode", [{ mode: "reject" }])).result).toBe("reject");
  const r = await call(7, "wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }]);
  expect(r.result).toBeUndefined();
  expect(r.error?.code).toBe(4001);
  expect(r.error?.message).toBe("User rejected the request.");
  expect((await call(7, "eth_chainId")).result).toBe("0x1");
  expect(events).toEqual([]);
});

test("reject is per tab and closing the tab drops it", async () => {
  await setup();
  await call(7, "agiterra_setSwitchMode", ["reject"]);
  expect((await call(8, "wallet_switchEthereumChain", [{ chainId: "0x89" }])).error).toBeUndefined();
  onRemoved!(7);
  await new Promise((r) => setTimeout(r, 0));
  expect((await call(7, "wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }])).error).toBeUndefined();
  expect((await call(7, "eth_chainId")).result).toBe("0xaa36a7");
});
