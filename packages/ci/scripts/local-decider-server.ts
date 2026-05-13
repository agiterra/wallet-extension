#!/usr/bin/env bun
/**
 * Local decider server — the test-side endpoint that the extension's
 * LocalRpcDecider POSTs sign requests to.
 *
 * This is what a Playwright test (or a manual smoke run) starts to
 * answer "approve / refuse" decisions per request.
 *
 * For the v0.2 smoke test, this approves everything. Real test fixtures
 * (lands with wallet-tools v0.5 WalletTestDriver) let the test register
 * per-request handlers — this script is the simplest possible version.
 *
 * Run:
 *   bun scripts/local-decider-server.ts
 *
 * Defaults: listens on 127.0.0.1:54321, expects Authorization: Bearer dev-token-v0.
 * Matches the dev defaults in src/vault-store.ts.
 */

const PORT = Number(process.env.PORT ?? 54321);
const TOKEN = process.env.DECIDER_TOKEN ?? "dev-token-v0";

interface SignRequest {
  request_id: string;
  method: string;
  wallet_address: string;
  origin: string;
  params: unknown[];
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/sign-request") {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await req.json()) as SignRequest;
      console.log(`[decider] received sign request: ${body.method} for ${body.wallet_address} from ${body.origin}`);
      console.log(`[decider] params:`, JSON.stringify(body.params));

      // Default: approve. Set REFUSE=1 in env to test refusal flow instead.
      if (process.env.REFUSE === "1") {
        console.log("[decider] returning REFUSE (REFUSE=1 in env)");
        return Response.json({
          request_id: body.request_id,
          action: "refuse",
          reason: "smoke_test_refuse_mode",
        });
      }
      console.log("[decider] returning APPROVE");
      return Response.json({
        request_id: body.request_id,
        action: "approve",
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[decider] listening on http://127.0.0.1:${server.port}`);
console.log(`[decider] token: ${TOKEN}`);
console.log(`[decider] set REFUSE=1 in env to refuse everything (test the 4001 flow)`);
