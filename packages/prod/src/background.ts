/**
 * Background service worker entry — production variant.
 *
 * Wires up the core request handler with a DeciderFactory that supports
 * all three modes: local-rpc, manual, and wire. The wire path imports
 * from this package's own decider-wire.ts (which depends on wire-tools).
 * The CI variant does NOT include this entry — it uses its own factory
 * that omits WireDecider entirely.
 */

import {
  installRequestHandler,
  LocalRpcDecider,
  ManualDecider,
  type Decider,
} from "@agiterra/wallet-extension-core";
import type { DeciderConfig } from "@agiterra/wallet-tools";
import { WireDecider } from "./decider-wire.js";

function makeDecider(config: DeciderConfig): Decider {
  switch (config.mode) {
    case "local-rpc":
      return new LocalRpcDecider(config.url, config.auth_token);
    case "wire":
      return new WireDecider(config);
    case "manual":
      return new ManualDecider();
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown decider mode: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

installRequestHandler(makeDecider);

console.log("[wallet-vault] background service worker started, prod variant, v0.3.0-dev");
