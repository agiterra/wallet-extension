/**
 * WalletDirectory — local cache of wallet metadata + access policy.
 *
 * Sourced from Wire's plugin_settings (namespace="wallet-vault",
 * key="wallets"). Subscribes to `plugin_settings.updated` for live
 * refresh. Used by:
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
import type { WireConnection } from "./wire-connection.js";

interface PluginSettingsUpdatedPayload {
  namespace: string;
  key: string;
  value: unknown;
  updated_by?: string;
  updated_at?: number;
}

const WALLET_VAULT_NAMESPACE = "wallet-vault";
const WALLETS_KEY = "wallets";

export class WalletDirectory {
  private wallets: WalletDirectoryMap = {};
  private subscribers = new Set<(map: WalletDirectoryMap) => void>();

  constructor(private connection: WireConnection) {
    this.connection.onEvent((event) => {
      // plugin_settings.updated is published as a broadcast (no dest), so
      // it arrives with the bare topic — no envelope unwrap needed here.
      // (The webhook-prefix shape only happens for /webhooks/:dest/:topic.)
      if (event.topic !== "plugin_settings.updated" && event.topic !== "plugin_settings.deleted") return;
      const payload = event.payload as PluginSettingsUpdatedPayload | undefined;
      if (!payload || payload.namespace !== WALLET_VAULT_NAMESPACE || payload.key !== WALLETS_KEY) return;
      this.wallets = (payload.value ?? {}) as WalletDirectoryMap;
      this.notify();
      console.log(`[wallet-vault] directory refreshed via Wire: ${Object.keys(this.wallets).length} wallets`);
    });
  }

  /** One-shot initial pull from Wire on boot. Subsequent updates come via SSE. */
  async refresh(wireUrl: string): Promise<void> {
    const res = await fetch(`${wireUrl}/plugin_settings/${WALLET_VAULT_NAMESPACE}/${WALLETS_KEY}`);
    if (res.status === 404) {
      this.wallets = {};
      this.notify();
      return;
    }
    if (!res.ok) {
      console.warn(`[wallet-vault] directory refresh failed (${res.status})`);
      return;
    }
    const body = await res.json() as { value?: WalletDirectoryMap };
    this.wallets = (body.value ?? {}) as WalletDirectoryMap;
    this.notify();
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

  private notify(): void {
    for (const s of this.subscribers) {
      try { s(this.wallets); } catch (e) { console.error("[wallet-vault] directory subscriber threw:", e); }
    }
  }
}
