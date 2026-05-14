/**
 * Background service worker entry — production variant.
 *
 * Boot sequence:
 *   1. Load/create the extension's Wire identity (Ed25519 keypair).
 *   2. Open a single long-lived WireConnection (registers self as
 *      kind='integration', connects, opens SSE).
 *   3. Initialize WalletDirectory (caches plugin_settings.wallet-vault.wallets)
 *      and TabClaims (binds tab_id → agent for routing).
 *   4. Seed the directory from any local vault entries that aren't yet
 *      in plugin_settings (handles migration from pre-v0.4 wallets).
 *   5. Wire up the EIP-1193 handler with a DeciderFactory that supplies
 *      WireDecider with tab-claim routing + access-policy verification.
 *
 * The CI variant does NOT include any of the Wire-aware modules — its
 * entry uses a factory that throws on mode:"wire".
 */

import {
  installRequestHandler,
  LocalRpcDecider,
  ManualDecider,
  getVault,
  devChainId,
  type Decider,
} from "@agiterra/wallet-extension-core";
import type { DeciderConfig, WalletMeta } from "@agiterra/wallet-tools";
import { loadOrCreateIdentity } from "./wire-identity.js";
import { WireConnection } from "./wire-connection.js";
import { WalletDirectory } from "./wallet-directory.js";
import { TabClaims } from "./tab-claims.js";
import { WireDecider } from "./decider-wire.js";

const WIRE_URL_KEY = "agiterra-wallet-extension-wire-url";
const DECIDER_TARGET_KEY = "agiterra-wallet-extension-decider-target";

(async () => {
  const identity = await loadOrCreateIdentity();
  const connection = new WireConnection(identity);
  connection.start();

  const directory = new WalletDirectory(connection);
  const tabClaims = new TabClaims(connection, directory);

  // Initial directory pull + seeding (best-effort; runs in background so
  // chrome.runtime.onMessage handler is registered before anything async).
  void (async () => {
    const stored = await chrome.storage.local.get([WIRE_URL_KEY, DECIDER_TARGET_KEY]);
    const wireUrl = (stored[WIRE_URL_KEY] as string | undefined)?.replace(/\/$/, "");
    if (!wireUrl) return;
    try {
      await directory.refresh(wireUrl);
    } catch (e) {
      console.warn("[wallet-vault] initial directory refresh failed:", (e as Error).message);
      return;
    }
    await seedDirectoryFromVault(
      connection,
      directory,
      (stored[DECIDER_TARGET_KEY] as string | undefined)?.trim() ?? null,
    );
  })();

  function makeDecider(config: DeciderConfig): Decider {
    switch (config.mode) {
      case "local-rpc":
        return new LocalRpcDecider(config.url, config.auth_token);
      case "wire":
        return new WireDecider(
          connection,
          config,
          directory,
          async (req) => {
            const claim = await tabClaims.getClaimByTab(req.tab_id ?? null);
            return claim?.agent_id ?? null;
          },
        );
      case "manual":
        return new ManualDecider();
      default: {
        const _exhaustive: never = config;
        throw new Error(`Unknown decider mode: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // Resolver: which wallet address is bound to a given tab? Uses TabClaims
  // (persistent across SW reloads via chrome.storage.local), set by agents
  // calling wallet_use({tab_id, wallet}). Returns null when no claim — the
  // core falls back to the first vault wallet so operator-driven clicks
  // still work without an explicit claim.
  const tabResolver = async (tabId: string | undefined): Promise<string | null> => {
    const claim = await tabClaims.getClaimByTab(tabId ?? null);
    return claim?.wallet_address ?? null;
  };

  installRequestHandler(makeDecider, tabResolver);
  console.log(`[wallet-vault] background service worker started, prod variant, v0.4.0-dev (identity: ${identity.agentId})`);
})().catch((e: Error) => {
  console.error("[wallet-vault] boot failed:", e);
});

/**
 * Migration: for every wallet in the local vault that doesn't yet have a
 * plugin_settings entry, publish a default policy so its responses pass
 * WireDecider's access check. Default access:
 *   - mode: "specific"
 *   - agents: [decider-target if set, else "operator"]
 * Creator is recorded as "operator" since we don't have provenance for
 * pre-v0.4 wallets. Operator can adjust later via the dashboard.
 */
async function seedDirectoryFromVault(
  connection: WireConnection,
  directory: WalletDirectory,
  deciderTarget: string | null,
): Promise<void> {
  const vault = await getVault();
  if (vault.length === 0) return;

  const current = { ...directory.all() };
  let mutated = false;

  for (const w of vault) {
    const addr = w.address.toLowerCase();
    if (current[addr]) continue;
    const meta: WalletMeta = {
      name: w.name,
      creator: "operator",
      created_at: w.created_at,
      chain_id: devChainId(),
      access: {
        mode: "specific",
        agents: deciderTarget ? [deciderTarget] : ["operator"],
      },
    };
    current[addr] = meta;
    mutated = true;
    console.log(`[wallet-vault] seeding plugin_settings for ${addr} (${w.name}) — access: ${meta.access.mode}/${meta.access.agents.join(",")}`);
  }

  if (mutated) {
    try {
      await connection.setPluginSetting("wallet-vault", "wallets", current);
    } catch (e) {
      console.warn("[wallet-vault] failed to seed plugin_settings:", (e as Error).message);
    }
  }
}
