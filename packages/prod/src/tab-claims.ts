/**
 * TabClaims — extension-local mapping of browser tab → (agent, wallet).
 *
 * When an agent calls `wallet_use({tab_id, wallet})` via the MCP plugin,
 * that publishes `wallet.vault.tab_claim` directed at the wallet-vault
 * extension. The extension verifies the requesting agent has access to
 * the wallet (per the WalletDirectory access policy), then records the
 * claim. From then on, any EIP-1193 sign request originating in that
 * tab routes to that agent.
 *
 * Claims survive SW reload (chrome.storage.local). Re-claiming a tab
 * silently replaces the previous owner.
 */

import type {
  WalletTabClaimRequest,
} from "@agiterra/wallet-tools";
import { WALLET_VAULT_TAB_CLAIM } from "@agiterra/wallet-tools";
import type { WireConnection } from "./wire-connection.js";
import type { WalletDirectory } from "./wallet-directory.js";

const STORAGE_KEY = "agiterra-wallet-extension-tab-claims";

interface TabClaim {
  agent_id: string;
  wallet_address: string; // lowercase
  claimed_at: number;
}

type TabClaimMap = Record<string, TabClaim>; // tab_id → TabClaim

export class TabClaims {
  private claims: TabClaimMap = {};
  private loaded = false;

  constructor(
    private connection: WireConnection,
    private directory: WalletDirectory,
  ) {
    this.connection.onEvent((event) => {
      // Directed via /webhooks/wallet-vault/wallet.vault.tab_claim → topic gets
      // "webhook." prefix and payload is wrapped (per Wire convention; see
      // .knowledge/convention-wire-topic-prefixing.md in fondant's vault).
      const matches =
        event.topic === WALLET_VAULT_TAB_CLAIM ||
        event.topic === `webhook.${WALLET_VAULT_TAB_CLAIM}`;
      if (!matches) return;

      const raw = event.payload as { payload?: WalletTabClaimRequest; tab_id?: unknown } | undefined;
      const claim = raw && typeof (raw as { tab_id?: unknown }).tab_id === "string"
        ? (raw as WalletTabClaimRequest)
        : ((raw as { payload?: WalletTabClaimRequest } | undefined)?.payload);

      if (!claim || typeof claim.tab_id !== "string" || typeof claim.wallet_address !== "string") {
        console.warn(`[wallet-vault] malformed tab_claim payload`);
        return;
      }

      void this.acceptClaim(claim, event.source);
    });
  }

  private async acceptClaim(req: WalletTabClaimRequest, sourceAgent: string): Promise<void> {
    const addr = req.wallet_address.toLowerCase();

    if (!this.directory.get(addr)) {
      console.warn(`[wallet-vault] tab_claim refused: unknown wallet ${addr}`);
      return;
    }
    if (!this.directory.canAgentDecide(addr, sourceAgent)) {
      console.warn(`[wallet-vault] tab_claim refused: agent ${sourceAgent} has no access to ${addr}`);
      return;
    }

    await this.load();
    this.claims[req.tab_id] = {
      agent_id: sourceAgent,
      wallet_address: addr,
      claimed_at: Date.now(),
    };
    await this.persist();
    console.log(`[wallet-vault] tab ${req.tab_id} claimed by ${sourceAgent} for ${addr}`);
  }

  async getClaimByTab(tabId: string | undefined | null): Promise<TabClaim | null> {
    if (!tabId) return null;
    await this.load();
    return this.claims[tabId] ?? null;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    this.claims = (stored[STORAGE_KEY] as TabClaimMap | undefined) ?? {};
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: this.claims });
  }
}
