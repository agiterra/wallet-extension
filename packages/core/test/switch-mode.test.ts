/**
 * agiterra_setSwitchMode (ENG-5081) — the per-tab test mode in which
 * wallet_switchEthereumChain is acknowledged but never lands. Covers the mode
 * parser; the storage + switch branch is exercised by switch-mode-handler.test.ts.
 */
import { test, expect } from "bun:test";
import { parseSwitchMode, SWITCH_MODES } from "../src/background-core.js";

test("parseSwitchMode accepts {mode} and a bare string for every known mode", () => {
  for (const m of SWITCH_MODES) {
    expect(parseSwitchMode({ mode: m })).toBe(m);
    expect(parseSwitchMode(m)).toBe(m);
  }
});

test("parseSwitchMode refuses unknown, missing and non-string modes", () => {
  expect(parseSwitchMode({ mode: "bogus" })).toBeNull();
  expect(parseSwitchMode({})).toBeNull();
  expect(parseSwitchMode(undefined)).toBeNull();
  expect(parseSwitchMode(null)).toBeNull();
  expect(parseSwitchMode({ mode: 1 })).toBeNull();
});
