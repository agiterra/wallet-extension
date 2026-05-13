/**
 * Background service worker entry — CI variant.
 *
 * NO Wire dependency, enforced at the package level: ci/package.json does
 * not list @agiterra/wallet-tools' wire client, and this file does not
 * import any wire module. A wallet configured with mode:"wire" will throw
 * at decide-time, surfacing the misconfiguration loudly.
 *
 * For Playwright tests, configure each wallet with mode:"local-rpc"
 * pointing at the test's decider server (see packages/ci/scripts/).
 */

import {
  installRequestHandler,
  LocalRpcDecider,
  ManualDecider,
  type Decider,
} from "@agiterra/wallet-extension-core";
import type { DeciderConfig } from "@agiterra/wallet-tools";

function makeDecider(config: DeciderConfig): Decider {
  switch (config.mode) {
    case "local-rpc":
      return new LocalRpcDecider(config.url, config.auth_token);
    case "manual":
      return new ManualDecider();
    case "wire":
      throw new Error(
        "Wallet has mode:\"wire\" but this is the CI build of the extension. " +
        "Reconfigure the wallet with mode:\"local-rpc\" or load the prod build (@agiterra/wallet-extension).",
      );
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown decider mode: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

installRequestHandler(makeDecider);

console.log("[wallet-vault] background service worker started, CI variant, v0.3.0-dev");
