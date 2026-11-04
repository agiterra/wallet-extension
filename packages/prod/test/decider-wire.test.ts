/**
 * WireDecider timeout path. A pod lane's inbox session cold-starts on its
 * first sign request (eng-2473, 2026-10-30: approve 64 s after the request,
 * against a 60 s cap), so the default must leave room for that, and a response
 * that arrives after the timeout must be logged, not silently dropped.
 */
import { test, expect, spyOn } from "bun:test";
import { WireDecider, DEFAULT_TIMEOUT_MS, WALLET_SIGN_RESULT } from "../src/decider-wire.js";
import type { WireConnection } from "../src/wire-connection.js";
import type { WalletDirectory } from "../src/wallet-directory.js";
import type { SignRequest } from "@agiterra/wallet-tools";

type Ev = { topic: string; source: string; payload: unknown };

function harness(timeoutMs: number) {
  let handler: ((e: Ev) => void) | null = null;
  const published: { topic: string; payload: unknown; dest?: string }[] = [];
  const conn = {
    onEvent: (h: (e: Ev) => void) => { handler = h; return () => { handler = null; }; },
    publish: async (topic: string, payload: unknown, dest?: string) => { published.push({ topic, payload, dest }); },
  } as unknown as WireConnection;
  const dir = { canAgentDecide: () => true } as unknown as WalletDirectory;
  const decider = new WireDecider(conn, { mode: "wire" } as never, dir, async () => "lane-x", timeoutMs);
  const respond = (request_id: string) =>
    handler!({ topic: "webhook.wallet.sign.response", source: "lane-x", payload: { payload: { request_id, approved: true } } });
  return { decider, respond, published };
}

const req = (request_id: string) =>
  ({ request_id, wallet_address: "0x" + "a".repeat(40), tab_id: "1", origin: "https://x", method: "personal_sign" }) as unknown as SignRequest;

test("default timeout leaves room for a cold inbox session (> 64 s)", () => {
  expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
});

test("a response inside the timeout resolves", async () => {
  const h = harness(1_000);
  const p = h.decider.decide(req("r1"));
  await Bun.sleep(5);
  h.respond("r1");
  expect((await p).request_id).toBe("r1");
  h.decider.dispose();
});

test("a response after the timeout is logged as late", async () => {
  const h = harness(20);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  await expect(h.decider.decide(req("r2"))).rejects.toThrow("WireDecider timeout after 20ms");
  h.respond("r2");
  expect(warn.mock.calls.some((c) => String(c[0]).includes("late wallet.sign.response for r2"))).toBe(true);
  warn.mockRestore();
  h.decider.dispose();
});

test("an unknown request id stays silent", () => {
  const h = harness(20);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  h.respond("never-sent");
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
  h.decider.dispose();
});

test("an approved request that failed is reported to the agent that approved it", async () => {
  const h = harness(1_000);
  const p = h.decider.decide(req("r3"));
  await Bun.sleep(5);
  h.respond("r3");
  await p;
  const error = { code: -32603, message: "eth_sendTransaction failed: execution reverted" };
  await h.decider.report(req("r3"), { error });
  const sent = h.published.filter((x) => x.topic === WALLET_SIGN_RESULT);
  expect(sent).toEqual([{
    topic: "wallet.sign.result",
    dest: "lane-x",
    payload: { request_id: "r3", method: "personal_sign", wallet_address: "0x" + "a".repeat(40), chain_id: undefined, error },
  }]);
  h.decider.dispose();
});

test("a success is reported with its result, once", async () => {
  const h = harness(1_000);
  const p = h.decider.decide(req("r4"));
  await Bun.sleep(5);
  h.respond("r4");
  await p;
  await h.decider.report(req("r4"), { result: "0xhash" });
  await h.decider.report(req("r4"), { result: "0xhash" });
  const sent = h.published.filter((x) => x.topic === WALLET_SIGN_RESULT);
  expect(sent.length).toBe(1);
  expect((sent[0].payload as { result: string }).result).toBe("0xhash");
  h.decider.dispose();
});

test("a report for a request this decider never sent publishes nothing", async () => {
  const h = harness(20);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  await h.decider.report(req("never-sent"), { result: "0x1" });
  expect(h.published.length).toBe(0);
  warn.mockRestore();
  h.decider.dispose();
});
