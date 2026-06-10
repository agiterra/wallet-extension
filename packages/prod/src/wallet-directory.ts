/**
 * WalletDirectory — local cache of wallet metadata + access policy.
 *
 * Sourced from Wire's plugin_settings (namespace = this instance's Wire vault
 * id, default "wallet-vault"). Reads the WHOLE namespace and dual-read merges
 * the legacy `wallets` blob with per-key `wallet:<addr>` entries (per-key wins;
 * see wallet-tools mergeWalletDirectory). Subscribes to `plugin_settings`
 * updated/deleted events for live refresh. Used by:
 *   - WireDecider to verify response sender against the wallet's allowlist.
 *   - TabClaims to gate tab-bind requests on the requesting agent's access.
 *   - background-core to look up per-wallet chain_id, name, etc.
 *
 * The extension never stores private keys here — those live encrypted
 * in chrome.storage.local (vault-store.ts). The directory is the public
 * facts: who created each wallet, who's allowed to sign with it, name,
 * default chain.
 */

import type { WalletDirectory as WalletDirectoryMap, WalletMeta } from "@agiterra/wallet-tools";
import {
  mergeWalletDirectory,
  WALLETS_LEGACY_KEY,
  addressFromWalletSettingKey,
} from "@agiterra/wallet-tools/directory";
import type { WireConnection } from "./wire-connection.js";

interface PluginSettingsUpdatedPayload {
  namespace: string;
  key: string;
  value: unknown;
  updated_by?: string;
  updated_at?: number;
}

const WALLET_VAULT_NAMESPACE = "wallet-vault";

export class WalletDirectory {
  private wallets: WalletDirectoryMap = {};
  // Raw `GET /plugin_settings/<namespace>` listing (key → value), kept so a
  // single per-key SSE update can be applied and the directory re-merged
  // (legacy `wallets` blob ∪ per-key `wallet:<addr>` entries; per-key wins).
  private rawSettings: Record<string, unknown> = {};
  private subscribers = new Set<(map: WalletDirectoryMap) => void>();

  // `namespace` is this extension instance's Wire vault id (identity.agentId).
  // The wire server enforces writer==namespace on plugin_settings PUT, so a
  // non-default instance (ENG-2947 browser-use, e.g. "wallet-vault-e2e") can
  // only write — and must therefore read — its OWN namespace. Defaults to
  // "wallet-vault" so existing single-instance installs are unchanged.
  constructor(
    private connection: WireConnection,
    public readonly namespace: string = WALLET_VAULT_NAMESPACE,
  ) {
    this.connection.onEvent((event) => {
      // plugin_settings.updated is published as a broadcast (no dest), so
      // it arrives with the bare topic — no envelope unwrap needed here.
      // (The webhook-prefix shape only happens for /webhooks/:dest/:topic.)
      if (event.topic !== "plugin_settings.updated" && event.topic !== "plugin_settings.deleted") return;
      const payload = event.payload as PluginSettingsUpdatedPayload | undefined;
      if (!payload || payload.namespace !== this.namespace) return;
      // React only to directory keys: the legacy `wallets` blob or a per-key
      // `wallet:<addr>` entry. The namespace is shared, so ignore everything else
      // (e.g. a future `__vault_meta` marker) — mergeWalletDirectory skips it too.
      if (payload.key !== WALLETS_LEGACY_KEY && addressFromWalletSettingKey(payload.key) === null) return;
      if (event.topic === "plugin_settings.deleted") {
        delete this.rawSettings[payload.key];
      } else {
        this.rawSettings[payload.key] = payload.value;
      }
      this.recompute();
      console.log(`[wallet-vault] directory ${event.topic} (${payload.key}) → ${Object.keys(this.wallets).length} wallets`);
    });
  }

  /** One-shot initial pull from Wire on boot. Subsequent updates come via SSE. */
  async refresh(wireUrl: string): Promise<void> {
    // Whole-namespace GET → Record<key, value>. Dual-read: mergeWalletDirectory
    // seeds from the legacy `wallets` blob, then per-key `wallet:<addr>` entries
    // overwrite for the same address (incremental migration off the blob).
    const res = await fetch(`${wireUrl}/plugin_settings/${this.namespace}`);
    if (res.status === 404) {
      this.rawSettings = {};
      this.recompute();
      return;
    }
    if (!res.ok) {
      console.warn(`[wallet-vault] directory refresh failed (${res.status})`);
      return;
    }
    this.rawSettings = (await res.json()) as Record<string, unknown>;
    this.recompute();
    console.log(`[wallet-vault] directory loaded on boot: ${Object.keys(this.wallets).length} wallets`);
  }

  get(address: string): WalletMeta | null {
    return this.wallets[address.toLowerCase()] ?? null;
  }

  all(): WalletDirectoryMap {
    return this.wallets;
  }

  /** Can `agentId` decide sign requests for the wallet at `address`? */
  canAgentDecide(address: string, agentId: string): boolean {
    const w = this.get(address);
    if (!w) return false;
    if (w.access.mode === "all") return true;
    return w.access.agents.includes(agentId);
  }

  /** Subscribe to directory updates. Returns an unsubscribe function. */
  onUpdate(handler: (map: WalletDirectoryMap) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** Re-derive the merged directory from the cached raw namespace settings. */
  private recompute(): void {
    this.wallets = mergeWalletDirectory(this.rawSettings);
    this.notify();
  }

  private notify(): void {
    for (const s of this.subscribers) {
      try { s(this.wallets); } catch (e) { console.error("[wallet-vault] directory subscriber threw:", e); }
    }
  }
}
