/**
 * Decider abstraction. Three implementations expected over the v0 lifecycle:
 *   - LocalRpcDecider     (v0.2, CI, this file)
 *   - WireDecider         (v0.3, production / interactive)
 *   - ManualDecider       (v0.3, operator popup fallback)
 *
 * Each wallet entry in the vault references one decider config; the
 * background service worker constructs the appropriate Decider per
 * sign request.
 */

import type { DeciderConfig, SignRequest, SignResponse } from "@agiterra/wallet-tools";

export interface Decider {
  /** Ask the configured decider what to do with this sign request. */
  decide(req: SignRequest): Promise<SignResponse>;
}

export class LocalRpcDecider implements Decider {
  constructor(private url: string, private authToken: string) {}

  async decide(req: SignRequest): Promise<SignResponse> {
    const res = await fetch(`${this.url}/sign-request`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Decider HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as SignResponse;
    if (body.request_id !== req.request_id) {
      throw new Error(
        `Decider returned mismatched request_id (got ${body.request_id}, expected ${req.request_id})`,
      );
    }
    return body;
  }
}

/**
 * Stub for v0.3 — Wire-mediated decider. Throws so the dev environment
 * surfaces "you configured a Wire wallet but didn't ship the impl yet"
 * loudly rather than silently routing nowhere.
 */
export class WireDecider implements Decider {
  async decide(_req: SignRequest): Promise<SignResponse> {
    throw new Error("WireDecider not yet implemented (lands in wallet-extension v0.3)");
  }
}

/**
 * Stub for v0.3 — operator popup. Same loudness rule as WireDecider.
 */
export class ManualDecider implements Decider {
  async decide(_req: SignRequest): Promise<SignResponse> {
    throw new Error("ManualDecider not yet implemented (lands in wallet-extension v0.3)");
  }
}

/** Factory: pick the right decider from a wallet's config. */
export function makeDecider(config: DeciderConfig): Decider {
  switch (config.mode) {
    case "local-rpc":
      return new LocalRpcDecider(config.url, config.auth_token);
    case "wire":
      return new WireDecider();
    case "manual":
      return new ManualDecider();
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown decider mode: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
