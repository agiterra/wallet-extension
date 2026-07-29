/**
 * Idempotency set for wallet.vault.create_request (ENG-3313): dedup by
 * request_id so a Wire replay to a freshly-(re)connected instance does not
 * re-mint a wallet. Tests the pure bounding/dedup logic (the chrome.storage
 * wrappers around it are thin and exercised by the browser-use FV).
 */
import { test, expect } from "bun:test";
import {
  appendProcessedCreate,
  bootstrapDefaultDevChainRpcUrl,
  devChainId,
  devChainRpcUrl,
  withDefaultDevChainRpcUrl,
} from "../src/vault-store.js";
import { RPC_URLS_KEY } from "../src/rpc.js";

const DEV_CHAIN_RPC_BOOTSTRAPPED_KEY = "agiterra-wallet-extension-default-rpc-bootstrapped";

test("appendProcessedCreate appends a new request id", () => {
  expect(appendProcessedCreate([], "a")).toEqual(["a"]);
  expect(appendProcessedCreate(["a"], "b")).toEqual(["a", "b"]);
});

test("appendProcessedCreate is a no-op (returns the same ref) for a duplicate id", () => {
  const ids = ["a", "b"];
  // same reference back -> markCreateProcessed skips a redundant storage write
  expect(appendProcessedCreate(ids, "a")).toBe(ids);
});

test("appendProcessedCreate grows up to `max` without trimming (boundary is > not >=)", () => {
  expect(appendProcessedCreate(["a", "b"], "c", 3)).toEqual(["a", "b", "c"]);
});

test("appendProcessedCreate bounds the set to the most recent `max` (drops oldest)", () => {
  expect(appendProcessedCreate(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
});

test("withDefaultDevChainRpcUrl seeds Sepolia when no URL exists", () => {
  expect(withDefaultDevChainRpcUrl({})).toEqual({
    rpcUrls: { [String(devChainId())]: devChainRpcUrl() },
    seeded: true,
  });
});

test("withDefaultDevChainRpcUrl preserves an existing Sepolia URL", () => {
  const existing = { [String(devChainId())]: "https://example.invalid/rpc" };
  const result = withDefaultDevChainRpcUrl(existing);
  expect(result).toEqual({ rpcUrls: existing, seeded: false });
  expect(result.rpcUrls).toBe(existing);
});

test("withDefaultDevChainRpcUrl does not re-seed after the one-time bootstrap marker", () => {
  const existing = {};
  const result = withDefaultDevChainRpcUrl(existing, true);
  expect(result).toEqual({ rpcUrls: existing, seeded: false });
  expect(result.rpcUrls).toBe(existing);
});

function installMockLocalStorage(initial: Record<string, unknown> = {}): Record<string, unknown> {
  const state = { ...initial };
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
          if (keys == null) return { ...state };
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.map((key) => [key, state[key]]));
        },
        async set(mapping: Record<string, unknown>): Promise<void> {
          Object.assign(state, mapping);
        },
      },
    },
  };
  return state;
}

test("bootstrapDefaultDevChainRpcUrl writes the default Sepolia RPC and one-time marker", async () => {
  const state = installMockLocalStorage();
  await expect(bootstrapDefaultDevChainRpcUrl()).resolves.toBe(true);
  expect(state[RPC_URLS_KEY]).toEqual({ [String(devChainId())]: devChainRpcUrl() });
  expect(state[DEV_CHAIN_RPC_BOOTSTRAPPED_KEY]).toBe(true);
});

test("bootstrapDefaultDevChainRpcUrl honors the one-time marker after operator removal", async () => {
  const state = installMockLocalStorage({ [DEV_CHAIN_RPC_BOOTSTRAPPED_KEY]: true });
  await expect(bootstrapDefaultDevChainRpcUrl()).resolves.toBe(false);
  expect(state[RPC_URLS_KEY]).toBeUndefined();
  expect(state[DEV_CHAIN_RPC_BOOTSTRAPPED_KEY]).toBe(true);
});
