/**
 * VaultCreateHandler (ENG-3313): per-key write-path + create idempotency.
 * Covers the behaviors that the browser-use FV can't prove deterministically —
 * the synchronous in-flight guard's race-window closure, the persisted
 * already-handled skip, the per-key directory write, and the name-conflict path.
 * Mocks the Wire connection + directory via the handler's narrow interfaces and
 * stubs chrome.storage; the EOA crypto (wallet-tools) runs for real.
 */
import { test, expect, beforeEach } from "bun:test";
import {
  VaultCreateHandler,
  type CreateHandlerConnection,
  type CreateHandlerDirectory,
} from "../src/vault-create-handler.js";
import { getVault, markCreateProcessed } from "@agiterra/wallet-extension-core";
import { walletSettingKey } from "@agiterra/wallet-tools/directory";
import type { WalletMeta } from "@agiterra/wallet-tools";
import { meta } from "./fixtures.js";

let local: Record<string, unknown> = {};
let session: Record<string, unknown> = {};

const chromeStub = {
  storage: {
    local: {
      get: async (keys: string | string[]) =>
        Array.isArray(keys) ? Object.fromEntries(keys.map((k) => [k, local[k]])) : { [keys]: local[keys] },
      set: async (obj: Record<string, unknown>) => { Object.assign(local, obj); },
    },
    session: {
      get: async (key: string) => ({ [key]: session[key] }),
      set: async (obj: Record<string, unknown>) => { Object.assign(session, obj); },
    },
  },
};
// A full chrome typing is huge; a test double necessarily stands in via a cast.
globalThis.chrome = chromeStub as unknown as typeof chrome;

beforeEach(() => { local = {}; session = {}; });

function setup(dirEntries: Record<string, WalletMeta> = {}) {
  const calls = {
    setPluginSetting: [] as Array<{ namespace: string; key: string; value: unknown }>,
    publish: [] as Array<{ topic: string; dest?: string }>,
  };
  const connection: CreateHandlerConnection = {
    onEvent: () => () => {},
    setPluginSetting: async (namespace, key, value) => { calls.setPluginSetting.push({ namespace, key, value }); },
    publish: async (topic, _payload, dest) => { calls.publish.push({ topic, dest }); return { seq: 1 }; },
  };
  const directory: CreateHandlerDirectory = { all: () => dirEntries, namespace: "wallet-vault" };
  const handler = new VaultCreateHandler(connection, directory);
  return { handler, calls };
}

test("normal create persists the wallet, writes its per-key directory entry, and replies", async () => {
  const { handler, calls } = setup();
  await handler.handleCreate({ request_id: "r1", name: "alpha" }, "agent-x");

  const vault = await getVault();
  expect(vault.length).toBe(1);
  expect(vault[0].name).toBe("alpha");
  expect(calls.setPluginSetting.length).toBe(1);
  expect(calls.setPluginSetting[0].key).toBe(walletSettingKey(vault[0].address));
  expect(calls.publish.length).toBe(1);
});

test("a replay of an already-handled request_id is skipped (idempotency, even with a stale directory)", async () => {
  const { handler, calls } = setup();
  await handler.handleCreate({ request_id: "r1", name: "alpha" }, "agent-x");
  // the mock directory never reflects the new wallet, so only the persisted
  // processed-set can stop the re-mint
  await handler.handleCreate({ request_id: "r1", name: "alpha" }, "agent-x");
  expect((await getVault()).length).toBe(1);
  expect(calls.setPluginSetting.length).toBe(1);
});

test("a request_id already in the persisted set is skipped (no vault write, no reply)", async () => {
  const { handler, calls } = setup();
  await markCreateProcessed("agent-x:r1"); // dedup key is `${sourceAgent}:${request_id}`
  await handler.handleCreate({ request_id: "r1", name: "alpha" }, "agent-x");
  expect((await getVault()).length).toBe(0);
  expect(calls.setPluginSetting.length).toBe(0);
  expect(calls.publish.length).toBe(0);
});

test("a synchronous duplicate is dropped by the in-flight guard (single mint)", async () => {
  const { handler, calls } = setup();
  const req = { request_id: "r1", name: "alpha" };
  // fire twice before the first await resolves — the second must hit the
  // synchronous inFlight guard and return without minting
  const p1 = handler.handleCreate(req, "agent-x");
  const p2 = handler.handleCreate(req, "agent-x");
  await Promise.all([p1, p2]);
  expect((await getVault()).length).toBe(1);
  expect(calls.setPluginSetting.length).toBe(1);
});

test("the same request_id from a DIFFERENT agent is NOT shadowed (dedup is per-agent)", async () => {
  const { handler } = setup();
  await handler.handleCreate({ request_id: "r1", name: "alpha" }, "agent-x");
  await handler.handleCreate({ request_id: "r1", name: "beta" }, "agent-y");
  expect((await getVault()).length).toBe(2);
});

test("name conflict for the same creator -> error reply, no vault write", async () => {
  const addr = "0x" + "a".repeat(40);
  const { handler, calls } = setup({ [addr]: meta("alpha", "agent-x") });
  await handler.handleCreate({ request_id: "r2", name: "alpha" }, "agent-x");
  expect((await getVault()).length).toBe(0);
  expect(calls.setPluginSetting.length).toBe(0);
  expect(calls.publish.length).toBe(1); // respondError published
});
