/**
 * WireDecider — production-path decider for the wallet-vault extension.
 *
 * Per sign:
 *   1. Resolve the target agent via the injected resolver. With tab-claim
 *      routing in place, the target is the agent who claimed `req.tab_id`.
 *      If unclaimed, falls back to chrome.storage.local decider-target
 *      (legacy v0.3-dev escape hatch).
 *   2. Publish wallet.sign.request directed at that agent.
 *   3. Await matching wallet.sign.response by request_id; on receipt,
 *      verify the source agent is in the wallet's access list (per the
 *      WalletDirectory) before resolving the promise. Reject otherwise.
 *   4. Time out after 60s.
 */

import type { DeciderConfig, SignRequest, SignResponse } from "@agiterra/wallet-tools";
import type { Decider } from "@agiterra/wallet-extension-core";
import { WALLET_SIGN_REQUEST, WALLET_SIGN_RESPONSE } from "@agiterra/wallet-tools/topics";
import type { WireConnection } from "./wire-connection.js";
import type { WalletDirectory } from "./wallet-directory.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DECIDER_TARGET_KEY = "agiterra-wallet-extension-decider-target";

/**
 * Resolve which Wire agent should decide a given sign request.
 * Returns the agent_id, or null to fall back to the legacy decider-target.
 */
export type DeciderTargetResolver = (req: SignRequest) => Promise<string | null>;

interface PendingEntry {
  resolve: (res: SignResponse) => void;
  wallet_address: string;
  target_agent: string | null;
}

export class WireDecider implements Decider {
  private pending = new Map<string, PendingEntry>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private connection: WireConnection,
    private _config: Extract<DeciderConfig, { mode: "wire" }>,
    private directory: WalletDirectory,
    private resolveTarget: DeciderTargetResolver,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.unsubscribe = this.connection.onEvent((event) => {
      // Accept both bare topic (broadcast) and webhook-prefixed (directed) shapes.
      const matches =
        event.topic === WALLET_SIGN_RESPONSE ||
        event.topic === `webhook.${WALLET_SIGN_RESPONSE}`;
      if (!matches) return;

      const raw = event.payload as { payload?: unknown; request_id?: unknown } | undefined;
      const candidate = raw && typeof (raw as { request_id?: unknown }).request_id === "string"
        ? (raw as SignResponse)
        : ((raw as { payload?: SignResponse } | undefined)?.payload);
      if (!candidate || typeof candidate.request_id !== "string") return;

      const entry = this.pending.get(candidate.request_id);
      if (!entry) return; // not for us, or already timed out

      // Allowlist enforcement: response source must be in the wallet's access list.
      // If the wallet isn't in the directory at all, we reject — better to fail
      // closed than honor a sign request for a wallet with no known policy.
      const sourceAgent = event.source;
      if (!this.directory.canAgentDecide(entry.wallet_address, sourceAgent)) {
        console.warn(
          `[wallet-vault] dropped wallet.sign.response for ${candidate.request_id}: ` +
          `source agent '${sourceAgent}' not in access list for ${entry.wallet_address}`,
        );
        return;
      }

      this.pending.delete(candidate.request_id);
      entry.resolve(candidate);
    });
  }

  async decide(req: SignRequest): Promise<SignResponse> {
    let target = await this.resolveTarget(req);
    if (!target) target = await this.fallbackDeciderTarget();

    const responsePromise = new Promise<SignResponse>((resolve, reject) => {
      this.pending.set(req.request_id, {
        resolve,
        wallet_address: req.wallet_address.toLowerCase(),
        target_agent: target,
      });
      setTimeout(() => {
        if (this.pending.delete(req.request_id)) {
          reject(new Error(`WireDecider timeout after ${this.timeoutMs}ms (no wallet.sign.response for ${req.request_id})`));
        }
      }, this.timeoutMs);
    });

    if (target) {
      await this.connection.publish(WALLET_SIGN_REQUEST, req, target);
    } else {
      console.warn(
        `[wallet-vault] no decider target for tab ${req.tab_id} / wallet ${req.wallet_address} — ` +
        `broadcasting wallet.sign.request. Bind a tab via wallet_use({tab_id,...}) or set ` +
        `chrome.storage.local["${DECIDER_TARGET_KEY}"] as a fallback.`,
      );
      await this.connection.publish(WALLET_SIGN_REQUEST, req);
    }

    return responsePromise;
  }

  private async fallbackDeciderTarget(): Promise<string | null> {
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
