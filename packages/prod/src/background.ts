/**
 * Background service worker entry — production variant.
 *
 * Boot sequence:
 *   1. Load/create the extension's Wire identity (Ed25519 keypair).
 *   2. Open a single long-lived WireConnection (registers self as
 *      kind='integration', connects, opens SSE).
 *   3. Wire up the EIP-1193 handler with a DeciderFactory that supplies
 *      WireDecider, LocalRpcDecider, and ManualDecider as appropriate
 *      per-wallet.
 *
 * The CI variant does NOT include WireConnection or WireDecider — its entry
 * uses a factory that throws on mode:"wire".
 */

import {
  installRequestHandler,
  LocalRpcDecider,
  ManualDecider,
  type Decider,
} from "@agiterra/wallet-extension-core";
import type { DeciderConfig } from "@agiterra/wallet-tools";
import { loadOrCreateIdentity } from "./wire-identity.js";
import { WireConnection } from "./wire-connection.js";
import { WireDecider } from "./decider-wire.js";

(async () => {
  const identity = await loadOrCreateIdentity();
  const connection = new WireConnection(identity);
  connection.start();

  function makeDecider(config: DeciderConfig): Decider {
    switch (config.mode) {
      case "local-rpc":
        return new LocalRpcDecider(config.url, config.auth_token);
      case "wire":
        return new WireDecider(connection, config);
      case "manual":
        return new ManualDecider();
      default: {
        const _exhaustive: never = config;
        throw new Error(`Unknown decider mode: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  installRequestHandler(makeDecider);
  console.log(`[wallet-vault] background service worker started, prod variant, v0.3.0-dev (identity: ${identity.agentId})`);
})().catch((e: Error) => {
  console.error("[wallet-vault] boot failed:", e);
});
