/**
 * Invariant: every method that asks the agent for approval has a signer case. eth_sign used to be
 * routed for approval with no case in signEip1193, so an approved request failed with -32601.
 */
import { test, expect } from "bun:test";
import { DECISION_METHODS } from "../src/background-core.js";
import { signEip1193 } from "../src/sign.js";

const CTX = {
  privateKeyHex: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  chainId: 11155111,
};

test("every decision method has a signer case (never -32601 after approval)", async () => {
  for (const method of DECISION_METHODS) {
    // Params are deliberately empty: we only care that the switch has a case, not that signing succeeds.
    const r = await signEip1193(method, [], CTX).catch((e: Error) => ({ error: { code: 0, message: e.message } }));
    expect({ method, code: (r as { error?: { code: number } }).error?.code }).not.toEqual({ method, code: -32601 });
  }
});

test("eth_sign is not routed for approval (refused, not implemented)", () => {
  expect(DECISION_METHODS.has("eth_sign")).toBe(false);
});

test("the signer still refuses eth_sign with -32601", async () => {
  const r = await signEip1193("eth_sign", [CTX.address, "0x" + "ab".repeat(32)], CTX);
  expect((r as { error?: { code: number } }).error?.code).toBe(-32601);
});
