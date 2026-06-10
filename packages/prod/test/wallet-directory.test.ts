/**
 * WalletDirectory dual-read SSE path (ENG-3313). Covers the live
 * `plugin_settings.updated`/`.deleted` handling that mergeWalletDirectory feeds:
 * per-key adds, per-key-wins over the legacy blob, per-key replace, deletion,
 * and namespace/unrelated-key filtering. The boot `refresh()` fetch path is
 * exercised by the browser-use e2e harness, not here.
 */
import { test, expect } from "bun:test";
import { WalletDirectory } from "../src/wallet-directory.js";
import type { WireConnection } from "../src/wire-connection.js";

const NS = "wallet-vault";
const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);

function meta(name: string, creator = "agent-x") {
  return { name, creator, created_at: 1, chain_id: 11155111, access: { mode: "specific", agents: [creator] } };
}

/** Minimal WireConnection double: captures the directory's event handler so the
 *  test can fire synthetic SSE events. WireConnection is a class (private
 *  fields), so a structural object needs a cast to stand in for it. */
function mockConn() {
  let handler: ((e: unknown) => void) | null = null;
  const connection = { onEvent: (h: (e: unknown) => void) => { handler = h; return () => {}; } } as unknown as WireConnection;
  return { connection, fire: (event: unknown) => handler?.(event) };
}

const updated = (key: string, value: unknown, namespace = NS) =>
  ({ topic: "plugin_settings.updated", payload: { namespace, key, value } });
const deleted = (key: string, namespace = NS) =>
  ({ topic: "plugin_settings.deleted", payload: { namespace, key } });

test("per-key SSE update adds a wallet to the directory", () => {
  const { connection, fire } = mockConn();
  const dir = new WalletDirectory(connection, NS);
  fire(updated(`wallet:${ADDR_A}`, meta("alpha")));
  expect(dir.get(ADDR_A)?.name).toBe("alpha");
  expect(Object.keys(dir.all()).length).toBe(1);
});

test("per-key entry shadows the legacy blob for the same address (per-key wins)", () => {
  const { connection, fire } = mockConn();
  const dir = new WalletDirectory(connection, NS);
  fire(updated("wallets", { [ADDR_A]: meta("legacy-name") }));
  expect(dir.get(ADDR_A)?.name).toBe("legacy-name");
  fire(updated(`wallet:${ADDR_A}`, meta("perkey-name")));
  expect(dir.get(ADDR_A)?.name).toBe("perkey-name");
  expect(Object.keys(dir.all()).length).toBe(1);
});

test("a second per-key update for the same address replaces the first", () => {
  const { connection, fire } = mockConn();
  const dir = new WalletDirectory(connection, NS);
  fire(updated(`wallet:${ADDR_A}`, meta("v1")));
  fire(updated(`wallet:${ADDR_A}`, meta("v2")));
  expect(dir.get(ADDR_A)?.name).toBe("v2");
  expect(Object.keys(dir.all()).length).toBe(1);
});

test("plugin_settings.deleted removes the per-key wallet, leaving the rest", () => {
  const { connection, fire } = mockConn();
  const dir = new WalletDirectory(connection, NS);
  fire(updated(`wallet:${ADDR_A}`, meta("alpha")));
  fire(updated(`wallet:${ADDR_B}`, meta("beta")));
  expect(Object.keys(dir.all()).length).toBe(2);
  fire(deleted(`wallet:${ADDR_A}`));
  expect(dir.get(ADDR_A)).toBeNull();
  expect(dir.get(ADDR_B)?.name).toBe("beta");
  expect(Object.keys(dir.all()).length).toBe(1);
});

test("events for a different namespace or an unrelated key are ignored", () => {
  const { connection, fire } = mockConn();
  const dir = new WalletDirectory(connection, NS);
  fire(updated(`wallet:${ADDR_A}`, meta("alpha"), "some-other-vault")); // wrong namespace
  fire(updated("__vault_meta", { anything: true }));                    // unrelated key
  expect(Object.keys(dir.all()).length).toBe(0);
});

test("canAgentDecide reflects per-key access policy", () => {
  const { connection, fire } = mockConn();
  const dir = new WalletDirectory(connection, NS);
  fire(updated(`wallet:${ADDR_A}`, meta("alpha", "agent-x")));
  expect(dir.canAgentDecide(ADDR_A, "agent-x")).toBe(true);
  expect(dir.canAgentDecide(ADDR_A, "agent-y")).toBe(false);
});
