/**
 * agiterra_getTabId (ENG-3313) — the provider read that lets a browser-use/CDP
 * agent learn its own Chrome tab id so it can wallet_use({tab_id, wallet}).
 * Covers the happy path and the null-fallback (no tab context), which the
 * browser-use e2e harnesses can't exercise.
 */
import { test, expect } from "bun:test";
import { resolveOwnTabId } from "../src/background-core.js";

test("resolveOwnTabId returns the caller's own tab id", () => {
  expect(resolveOwnTabId({ tab: { id: 42 } })).toBe(42);
});

test("resolveOwnTabId returns null when the sender has no tab context", () => {
  expect(resolveOwnTabId({})).toBeNull();
  expect(resolveOwnTabId({ tab: {} })).toBeNull();
});
