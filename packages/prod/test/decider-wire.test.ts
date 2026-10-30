/**
 * WireDecider timeout path. A pod lane's inbox session cold-starts on its
 * first sign request (eng-2473, 2026-10-30: approve 64 s after the request,
 * against a 60 s cap), so the default must leave room for that, and a response
 * that arrives after the timeout must be logged, not silently dropped.
 */
import { test, expect, spyOn } from "bun:test";
import { WireDecider, DEFAULT_TIMEOUT_MS } from "../src/decider-wire.js";
import type { WireConnection } from "../src/wire-connection.js";
import type { WalletDirectory } from "../src/wallet-directory.js";
import type { SignRequest } from "@agiterra/wallet-tools";

type Ev = { topic: string; source: string; payload: unknown };

function harness(timeoutMs: number) {
  let handler: ((e: Ev) => void) | null = null;
  const published: unknown[] = [];
  const conn = {
    onEvent: (h: (e: Ev) => void) => { handler = h; return () => { handler = null; }; },
    publish: async (_topic: string, payload: unknown) => { published.push(payload); },
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
