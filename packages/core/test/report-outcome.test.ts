/**
 * TOOL GAP 31 (eng-2792 r13, 2026-11-04): an approved eth_sendTransaction failed in
 * estimateGas and the approving agent never learned it. After an approve, the core
 * must hand the decider the exact outcome the dApp got, success or error.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import type { SignRequest } from "@agiterra/wallet-tools";

type Store = Record<string, unknown>;
type Listener = (msg: unknown, sender: unknown, send: (r: unknown) => void) => boolean;
let local: Store, session: Store, onMessage: Listener | null;
const realFetch = globalThis.fetch;

function area(s: () => Store) {
  return {
    get: async (k: string | string[] | null) => {
      if (k == null) return { ...s() };
      const keys = Array.isArray(k) ? k : [k];
      return Object.fromEntries(keys.filter((x) => x in s()).map((x) => [x, s()[x]]));
    },
    set: async (o: Store) => { Object.assign(s(), o); },
    remove: async (k: string) => { delete s()[k]; },
  };
}

beforeEach(() => {
  local = {}; session = {}; onMessage = null;
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    storage: { local: area(() => local), session: area(() => session) },
    runtime: { onMessage: { addListener: (f: Listener) => { onMessage = f; } } },
    tabs: {
      onRemoved: { addListener: () => {} },
      query: (_q: unknown, cb: (t: { id: number }[]) => void) => cb([]),
      sendMessage: async () => {},
    },
  };
  // Every RPC answers with the r13 revert, so estimateGas fails.
  globalThis.fetch = (async () => new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: ERC20: transfer amount exceeds allowance" },
  }))) as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

async function run(method: string, params: unknown[]) {
  const reports: { req: SignRequest; outcome: { result?: unknown; error?: { code: number; message: string } } }[] = [];
  const decider = {
    decide: async (req: SignRequest) => ({ request_id: req.request_id, action: "approve" }),
    report: async (req: SignRequest, outcome: never) => { reports.push({ req, outcome }); },
  };
  const { installRequestHandler } = await import("../src/background-core.js");
  installRequestHandler((() => decider) as never);
  const reply = await new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
    onMessage!(
      { type: "wallet/request", request_id: "rq-1", request: { method, params }, origin: "https://x", tab_url: "https://x" },
      { tab: { id: 3 } },
      resolve as (r: unknown) => void,
    );
  });
  await Bun.sleep(0);
  return { reply, reports };
}

test("an approved tx that fails in estimateGas is reported to the decider with the dApp's error", async () => {
  const { reply, reports } = await run("eth_sendTransaction", [{ to: "0x" + "b".repeat(40), data: "0x" }]);
  expect(reply.error?.message).toContain("transfer amount exceeds allowance");
  expect(reports.length).toBe(1);
  expect(reports[0].req.request_id).toBe("rq-1");
  expect(reports[0].outcome).toEqual(reply);
});

test("an approved signature is reported with its result (positive control)", async () => {
  const { reply, reports } = await run("personal_sign", ["0x68656c6c6f", "0x" + "c".repeat(40)]);
  expect(reply.error).toBeUndefined();
  expect(typeof reply.result).toBe("string");
  expect(reports.length).toBe(1);
  expect(reports[0].outcome).toEqual(reply);
});
