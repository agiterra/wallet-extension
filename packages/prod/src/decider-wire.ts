/**
 * WireDecider — production-path decider for the wallet-vault extension.
 *
 * Flow per sign:
 *   1. Publish wallet.sign.request as a directed message (dest = decider
 *      agent on the wallet's allowlist; v0.3-dev: broadcasts, no allowlist
 *      enforcement yet) — JWT-signed by the extension's Wire identity.
 *   2. Wait for a matching wallet.sign.response on the open SSE stream,
 *      keyed by request_id. Timeout after N seconds.
 *   3. Return the SignResponse to background-core, which then either signs
 *      (action='approve') or returns the appropriate error to the dApp.
 *
 * TODO(v0.3+): allowlist verification — check the response's `source` field
 * is in the wallet's allowlist before trusting the decision. Plumbing for
 * allowlist storage (wire.plugin_settings) is part of wire-dashboard-plugability.
 */

import type { DeciderConfig, SignRequest, SignResponse } from "@agiterra/wallet-tools";
import type { Decider } from "@agiterra/wallet-extension-core";
import { WALLET_SIGN_REQUEST, WALLET_SIGN_RESPONSE } from "@agiterra/wallet-tools/topics";
import type { WireConnection } from "./wire-connection.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export class WireDecider implements Decider {
  private pending = new Map<string, (res: SignResponse) => void>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private connection: WireConnection,
    private _config: Extract<DeciderConfig, { mode: "wire" }>,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.unsubscribe = this.connection.onEvent((event) => {
      if (event.topic !== WALLET_SIGN_RESPONSE) return;
      const payload = event.payload as SignResponse | undefined;
      if (!payload || typeof payload.request_id !== "string") return;
      const resolve = this.pending.get(payload.request_id);
      if (!resolve) return; // not for us, or already timed out
      this.pending.delete(payload.request_id);
      resolve(payload);
    });
  }

  async decide(req: SignRequest): Promise<SignResponse> {
    const responsePromise = new Promise<SignResponse>((resolve, reject) => {
      this.pending.set(req.request_id, resolve);
      setTimeout(() => {
        if (this.pending.delete(req.request_id)) {
          reject(new Error(`WireDecider timeout after ${this.timeoutMs}ms (no wallet.sign.response for ${req.request_id})`));
        }
      }, this.timeoutMs);
    });

    await this.connection.publish(WALLET_SIGN_REQUEST, req);

    return responsePromise;
  }

  /** Tear down event subscription. Call on shutdown. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pending.clear();
  }
}
