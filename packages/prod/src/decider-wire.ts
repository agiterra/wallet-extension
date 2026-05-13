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
const DECIDER_TARGET_KEY = "agiterra-wallet-extension-decider-target";

export class WireDecider implements Decider {
  private pending = new Map<string, (res: SignResponse) => void>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private connection: WireConnection,
    private _config: Extract<DeciderConfig, { mode: "wire" }>,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.unsubscribe = this.connection.onEvent((event) => {
      // Wire stores directed (POST /webhooks/:dest/:topic) messages with the
      // topic prefixed by "webhook.", and wraps the body in an envelope.
      // Broadcasts (POST /broadcast/:topic) keep the bare topic + raw body.
      // Accept either shape so the decider works regardless of how the
      // responder chose to send.
      const matches =
        event.topic === WALLET_SIGN_RESPONSE ||
        event.topic === `webhook.${WALLET_SIGN_RESPONSE}`;
      if (!matches) return;
      const raw = event.payload as { payload?: unknown; request_id?: unknown } | undefined;
      const candidate = raw && typeof (raw as { request_id?: unknown }).request_id === "string"
        ? (raw as SignResponse)
        : ((raw as { payload?: SignResponse } | undefined)?.payload);
      if (!candidate || typeof candidate.request_id !== "string") return;
      const resolve = this.pending.get(candidate.request_id);
      if (!resolve) return; // not for us, or already timed out
      this.pending.delete(candidate.request_id);
      resolve(candidate);
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

    // Direct the request to a single configured decider when known, so we
    // don't spam every agent on the Wire. The dest comes from chrome.storage
    // .local["agiterra-wallet-extension-decider-target"] for v0.3-dev; in
    // v0.4 this will come from the wallet's allowlist (Wire plugin_settings).
    const target = await this.resolveDeciderTarget();
    if (target) {
      await this.connection.publish(WALLET_SIGN_REQUEST, req, target);
    } else {
      console.warn(
        `[wallet-vault] no decider target configured — broadcasting wallet.sign.request to every Wire agent. ` +
        `Set chrome.storage.local["${DECIDER_TARGET_KEY}"] = "<agent-id>" to direct it.`,
      );
      await this.connection.publish(WALLET_SIGN_REQUEST, req);
    }

    return responsePromise;
  }

  private async resolveDeciderTarget(): Promise<string | null> {
    const stored = await chrome.storage.local.get(DECIDER_TARGET_KEY);
    const target = stored[DECIDER_TARGET_KEY] as string | undefined;
    return target?.trim() || null;
  }

  /** Tear down event subscription. Call on shutdown. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pending.clear();
  }
}
