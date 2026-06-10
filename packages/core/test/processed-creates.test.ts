/**
 * Idempotency set for wallet.vault.create_request (ENG-3313): dedup by
 * request_id so a Wire replay to a freshly-(re)connected instance does not
 * re-mint a wallet. Tests the pure bounding/dedup logic (the chrome.storage
 * wrappers around it are thin and exercised by the browser-use FV).
 */
import { test, expect } from "bun:test";
import { appendProcessedCreate } from "../src/vault-store.js";

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
