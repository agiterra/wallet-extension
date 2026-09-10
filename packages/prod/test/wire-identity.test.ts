/**
 * loadOrCreateIdentity reconciles the stored Wire identity against the configured
 * vault id on EVERY boot (AGI-130). Before this, VAULT_ID_KEY was read only on
 * the mint path, so a lane whose service worker booted before the launcher
 * seeded the key kept a stale "wallet-vault" identity forever and registered on
 * the Wire as the shared vault (panadas, 2026-09-10 ~19:15Z).
 */
import { test, expect, beforeEach } from "bun:test";

let local: Record<string, unknown> = {};
const chromeStub = {
  storage: {
    local: {
      get: async (keys: string | string[]) =>
        Array.isArray(keys) ? Object.fromEntries(keys.map((k) => [k, local[k]])) : { [keys]: local[keys] },
      set: async (obj: Record<string, unknown>) => { Object.assign(local, obj); },
      remove: async (key: string) => { delete local[key]; },
    },
  },
};
globalThis.chrome = chromeStub as unknown as typeof chrome;

const { loadOrCreateIdentity, WALLET_VAULT_VAULT_ID_KEY, WALLET_VAULT_AGENT_ID } = await import("../src/wire-identity.js");
const STORAGE_KEY = "agiterra-wallet-extension-wire-identity";
const quiet = { log: console.log, warn: console.warn };
beforeEach(() => { local = {}; console.log = () => {}; console.warn = () => {}; });
const restore = () => { console.log = quiet.log; console.warn = quiet.warn; };

test("first boot with a seeded vault id mints under that id", async () => {
  local[WALLET_VAULT_VAULT_ID_KEY] = "wallet-vault-lane1";
  const id = await loadOrCreateIdentity();
  expect(id.agentId).toBe("wallet-vault-lane1");
  expect((local[STORAGE_KEY] as { agentId: string }).agentId).toBe("wallet-vault-lane1");
  restore();
});

test("first boot with no vault id mints the default (operator Chrome, back-compat)", async () => {
  const id = await loadOrCreateIdentity();
  expect(id.agentId).toBe(WALLET_VAULT_AGENT_ID);
  restore();
});

test("THE INCIDENT: a stale default identity is DROPPED and re-minted when the vault id is seeded afterwards", async () => {
  // boot 1: launcher has not seeded yet -> mints "wallet-vault"
  const first = await loadOrCreateIdentity();
  expect(first.agentId).toBe("wallet-vault");
  // launcher seeds the per-lane id, extension restarts
  local[WALLET_VAULT_VAULT_ID_KEY] = "wallet-vault-panadas";
  const second = await loadOrCreateIdentity();
  expect(second.agentId).toBe("wallet-vault-panadas");
  expect(second.publicKeyB64).not.toBe(first.publicKeyB64); // fresh key, the stale one is discarded
  expect((local[STORAGE_KEY] as { agentId: string }).agentId).toBe("wallet-vault-panadas");
  restore();
});

test("a matching stored identity is kept, same key, across boots", async () => {
  local[WALLET_VAULT_VAULT_ID_KEY] = "wallet-vault-lane2";
  const a = await loadOrCreateIdentity();
  const b = await loadOrCreateIdentity();
  expect(b.agentId).toBe("wallet-vault-lane2");
  expect(b.publicKeyB64).toBe(a.publicKeyB64);
  restore();
});

test("a per-lane identity with NO configured id is kept — never silently reverts to the shared default", async () => {
  local[WALLET_VAULT_VAULT_ID_KEY] = "wallet-vault-lane3";
  const a = await loadOrCreateIdentity();
  delete local[WALLET_VAULT_VAULT_ID_KEY]; // seed lost (profile copied, key cleared)
  const b = await loadOrCreateIdentity();
  expect(b.agentId).toBe("wallet-vault-lane3");
  expect(b.publicKeyB64).toBe(a.publicKeyB64);
  restore();
});
