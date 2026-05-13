/**
 * WireDecider — production-path decider. Authenticates the extension to
 * Wire as the `wallet-vault` agent and routes sign requests through the
 * wire-mediated channel pattern.
 *
 * v0.3 implementation pending (Task 4 in session-state). This file
 * currently throws so a wire-mode wallet in dev surfaces "you didn't ship
 * the impl yet" loudly rather than hanging.
 */

import type { DeciderConfig, SignRequest, SignResponse } from "@agiterra/wallet-tools";
import type { Decider } from "@agiterra/wallet-extension-core";

export class WireDecider implements Decider {
  constructor(private config: Extract<DeciderConfig, { mode: "wire" }>) {}

  async decide(_req: SignRequest): Promise<SignResponse> {
    throw new Error(
      "WireDecider not yet implemented (lands in wallet-extension v0.3, Task 4)",
    );
  }
}
