/**
 * TabClaims — extension-local mapping of browser tab → (agent, wallet).
 *
 * When an agent calls `wallet_use({tab_id, wallet})` via the MCP plugin,
 * that publishes `wallet.vault.tab_claim` directed at the wallet-vault
 * extension. The extension verifies the requesting agent has access to
 * the wallet (per the WalletDirectory access policy) AND that the wallet
 * is signable here (present in this instance's local vault), then records
 * the claim. From then on, any EIP-1193 sign request originating in that
 * tab routes to that agent.
 *
 * Every claim gets an explicit outcome (AGI-16 fail-loud binding): the
 * result — accepted, or refused with a reason — is written to Wire's
 * plugin_settings under `tab_claim:<tab_id>` so the MCP's wallet_use can
 * poll it and surface refusals instead of fire-and-forget success.
 *
 * Claims survive SW reload (chrome.storage.local). Re-claiming a tab
 * silently replaces the previous owner. Claims are released — claim map
 * entry AND plugin_settings ack deleted — via the `wallet.vault.tab_release`
 * channel (claim owner only), when the tab closes (chrome.tabs.onRemoved),
 * and at startup for tabs that no longer exist (browser restarts re-mint
 * tab ids; a stale claim must not bind an unrelated new tab).
 */

import type {
  WalletTabClaimRequest,
  WalletTabClaimStatus,
  WalletTabReleaseRequest,
} from "@agiterra/wallet-tools";
import {
  WALLET_VAULT_TAB_CLAIM,
  WALLET_VAULT_TAB_RELEASE,
  tabClaimSettingKey,
} from "@agiterra/wallet-tools";
import type { WireConnection } from "./wire-connection.js";
import type { WalletDirectory } from "./wallet-directory.js";

const STORAGE_KEY = "agiterra-wallet-extension-tab-claims";

interface TabClaim {
  agent_id: string;
  wallet_address: string; // lowercase
  claimed_at: number;
}

type TabClaimMap = Record<string, TabClaim>; // tab_id → TabClaim

/** Is this address signable by this extension instance (present in the
 *  LOCAL vault)? The directory alone is not enough — a wallet can be in
 *  the shared directory but held by a different vault instance, and a
 *  claim on it here would silently fall back to first-wallet. */
export type VaultLookup = (addrLowercase: string) => Promise<boolean>;

export class TabClaims {
  private claims: TabClaimMap = {};
  private loaded = false;

  constructor(
    private connection: WireConnection,
    private directory: WalletDirectory,
    private vaultHas: VaultLookup | null = null,
  ) {
    this.connection.onEvent((event) => {
      // Directed via /webhooks/wallet-vault/<topic> → topic gets a
      // "webhook." prefix and payload is wrapped (per Wire convention; see
      // .knowledge/convention-wire-topic-prefixing.md in fondant's vault).
      const isClaim =
        event.topic === WALLET_VAULT_TAB_CLAIM ||
        event.topic === `webhook.${WALLET_VAULT_TAB_CLAIM}`;
      const isRelease =
        event.topic === WALLET_VAULT_TAB_RELEASE ||
        event.topic === `webhook.${WALLET_VAULT_TAB_RELEASE}`;
      if (!isClaim && !isRelease) return;

      const raw = event.payload as { payload?: unknown; tab_id?: unknown } | undefined;
      const body = raw && typeof (raw as { tab_id?: unknown }).tab_id === "string"
        ? raw
        : (raw as { payload?: unknown } | undefined)?.payload;

      if (isClaim) {
        const claim = body as WalletTabClaimRequest | undefined;
        if (!claim || typeof claim.tab_id !== "string" || typeof claim.wallet_address !== "string") {
          console.warn(`[wallet-vault] malformed tab_claim payload`);
          return;
        }
        void this.acceptClaim(claim, event.source);
      } else {
        const release = body as WalletTabReleaseRequest | undefined;
        if (!release || typeof release.tab_id !== "string") {
          console.warn(`[wallet-vault] malformed tab_release payload`);
          return;
        }
        void this.handleRelease(release, event.source);
      }
    });
  }

  private async acceptClaim(req: WalletTabClaimRequest, sourceAgent: string): Promise<void> {
    const addr = req.wallet_address.toLowerCase();

    const refuse = async (reason: string): Promise<void> => {
      console.warn(`[wallet-vault] tab_claim refused: ${reason}`);
      await this.writeAck({
        tab_id: req.tab_id,
        wallet_address: addr,
        agent_id: sourceAgent,
        status: "refused",
        reason,
        at: Date.now(),
      });
    };

    // The tab must actually exist HERE. This is the original wallet_use
    // failure mode: a Playwright page INDEX (0, 1, …) isn't a chrome.tabs id,
    // and the old code recorded a claim for a tab that would never match.
    const tabIdNum = Number(req.tab_id);
    const tab = Number.isInteger(tabIdNum) && tabIdNum >= 0
      ? await chrome.tabs.get(tabIdNum).catch(() => null)
      : null;
    if (!tab) {
      await refuse(`tab '${req.tab_id}' does not exist in this browser — pass the REAL chrome.tabs id (in-page: window.ethereum.request({method:'agiterra_getTabId'})); a Playwright page index is not a tab id`);
      return;
    }

    if (!this.directory.get(addr)) {
      await refuse(`unknown wallet ${addr} (not in directory)`);
      return;
    }
    if (!this.directory.canAgentDecide(addr, sourceAgent)) {
      await refuse(`agent ${sourceAgent} has no access to ${addr}`);
      return;
    }
    if (this.vaultHas && !(await this.vaultHas(addr))) {
      await refuse(`wallet ${addr} is not in this vault instance's local keystore (directory-only — unsignable here)`);
      return;
    }

    await this.load();
    this.claims[req.tab_id] = {
      agent_id: sourceAgent,
      wallet_address: addr,
      claimed_at: Date.now(),
    };
    await this.persist();
    await this.writeAck({
      tab_id: req.tab_id,
      wallet_address: addr,
      agent_id: sourceAgent,
      status: "accepted",
      at: Date.now(),
    });
    console.log(`[wallet-vault] tab ${req.tab_id} claimed by ${sourceAgent} for ${addr}`);
  }

  private async handleRelease(req: WalletTabReleaseRequest, sourceAgent: string): Promise<void> {
    await this.load();
    const existing = this.claims[req.tab_id];
    if (!existing) {
      // Idempotent: nothing bound; clear any orphaned ack so wallet_release
      // callers polling for absence converge.
      await this.deleteAck(req.tab_id);
      return;
    }
    if (existing.agent_id !== sourceAgent) {
      console.warn(`[wallet-vault] tab_release refused: ${sourceAgent} is not the claim owner (${existing.agent_id}) for tab ${req.tab_id}`);
      return;
    }
    await this.releaseTab(req.tab_id, `released by ${sourceAgent}`);
  }

  /** Remove a tab's claim + its plugin_settings ack. Callers: the Wire
   *  release channel, chrome.tabs.onRemoved, and startup pruning. */
  async releaseTab(tabId: string, why: string): Promise<void> {
    await this.load();
    const had = !!this.claims[tabId];
    if (had) {
      delete this.claims[tabId];
      await this.persist();
    }
    await this.deleteAck(tabId);
    if (had) console.log(`[wallet-vault] tab ${tabId} claim released (${why})`);
  }

  /** Drop claims whose tab no longer exists. Safe to run on every SW
   *  wake — claims for live tabs are untouched. */
  async pruneStale(liveTabIds: Set<string>): Promise<void> {
    await this.load();
    for (const tabId of Object.keys(this.claims)) {
      if (!liveTabIds.has(tabId)) {
        await this.releaseTab(tabId, "stale — tab no longer exists");
      }
    }
  }

  async getClaimByTab(tabId: string | undefined | null): Promise<TabClaim | null> {
    if (!tabId) return null;
    await this.load();
    return this.claims[tabId] ?? null;
  }

  private async writeAck(status: WalletTabClaimStatus): Promise<void> {
    try {
      await this.connection.setPluginSetting(
        this.directory.namespace,
        tabClaimSettingKey(status.tab_id),
        status,
      );
    } catch (e) {
      // The claim itself already applied (or was refused) — a lost ack only
      // degrades wallet_use back to its pre-ack timeout behavior.
      console.error(`[wallet-vault] tab_claim ack write failed for tab ${status.tab_id}:`, e instanceof Error ? e.message : String(e));
    }
  }

  private async deleteAck(tabId: string): Promise<void> {
    try {
      await this.connection.deletePluginSetting(this.directory.namespace, tabClaimSettingKey(tabId));
    } catch (e) {
      console.error(`[wallet-vault] tab_claim ack delete failed for tab ${tabId}:`, e instanceof Error ? e.message : String(e));
    }
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
