/**
 * VaultCreateHandler — extension-side responder for wallet.vault.create_request.
 *
 * When an agent calls the wallet_create MCP tool, the wallet-claude-code
 * server publishes wallet.vault.create_request directed at wallet-vault
 * with { request_id, name, chain_id?, source_agent }. This handler:
 *
 *   1. Validates: name unique per creator-agent.
 *   2. Generates a fresh secp256k1 keypair (EOA wallet).
 *   3. Encrypts the private key under the vault passphrase, stores the
 *      WalletEntry in chrome.storage.local vault.
 *   4. Publishes the new wallet's plugin_settings entry with
 *      creator = <calling agent>, access = creator-only initially.
 *   5. Publishes wallet.vault.created directed back to the source agent
 *      with the new public address (+ request_id for matching).
 *
 * The private key never leaves the extension. The caller receives only
 * the public address.
 */

import {
  generatePrivateKey,
  addressFromPrivateKey,
  encryptPrivateKey,
} from "@agiterra/wallet-tools";
import type { WalletEntry, WalletMeta } from "@agiterra/wallet-tools";
import {
  WALLET_VAULT_CREATE_REQUEST,
  WALLET_VAULT_CREATED,
} from "@agiterra/wallet-tools";
import { walletSettingKey } from "@agiterra/wallet-tools/directory";
import {
  getVault,
  setVault,
  getPassphrase,
  devChainId,
  isCreateProcessed,
  markCreateProcessed,
} from "@agiterra/wallet-extension-core";
/** The slice of WireConnection that VaultCreateHandler needs — event
 *  subscription + a plugin_settings write + publish. A real WireConnection
 *  satisfies it; unit tests supply a lightweight double. */
export interface CreateHandlerConnection {
  onEvent(handler: (event: { topic: string; payload: unknown; source: string }) => void): () => void;
  setPluginSetting(namespace: string, key: string, value: unknown): Promise<void>;
  publish(topic: string, payload: unknown, dest?: string): Promise<{ seq: number }>;
}

/** The slice of WalletDirectory that VaultCreateHandler reads. */
export interface CreateHandlerDirectory {
  all(): Record<string, WalletMeta>;
  readonly namespace: string;
}

interface CreateRequest {
  request_id: string;
  name: string;
  chain_id?: number;
}

interface CreatedResponseOk {
  request_id: string;
  ok: true;
  address: string;
  name: string;
}

interface CreatedResponseErr {
  request_id: string;
  ok: false;
  error: string;
}

export class VaultCreateHandler {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private connection: CreateHandlerConnection,
    private directory: CreateHandlerDirectory,
  ) {
    this.unsubscribe = this.connection.onEvent((event) => {
      const matches =
        event.topic === WALLET_VAULT_CREATE_REQUEST ||
        event.topic === `webhook.${WALLET_VAULT_CREATE_REQUEST}`;
      if (!matches) return;

      const raw = event.payload as { payload?: CreateRequest; request_id?: unknown } | undefined;
      const req = raw && typeof (raw as { request_id?: unknown }).request_id === "string"
        ? (raw as CreateRequest)
        : ((raw as { payload?: CreateRequest } | undefined)?.payload);
      if (!req || typeof req.request_id !== "string" || typeof req.name !== "string" || !req.name.trim()) {
        console.warn(`[wallet-vault] malformed wallet.vault.create_request`);
        return;
      }
      void this.handleCreate(req, event.source);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // Dedup keys (`<sourceAgent>:<request_id>`) being handled in THIS SW lifetime.
  // A synchronous guard taken BEFORE any await closes the check-then-act window:
  // Wire replays the duplicated create_request backlog into one SSE stream and
  // handleCreate is dispatched fire-and-forget per frame, so without this two
  // back-to-back duplicate frames could each pass the async isCreateProcessed()
  // check before either marks, and double-mint. The persisted set covers replays
  // across SW restarts; this covers duplicates within a single lifetime. Keyed
  // per source agent so one agent's request_id can't shadow another's.
  private inFlight = new Set<string>();

  /**
   * Handle one wallet.vault.create_request. Public so it can be unit-tested
   * directly; the SSE callback in the constructor is the production entry point.
   */
  async handleCreate(req: CreateRequest, sourceAgent: string): Promise<void> {
    const dedupKey = `${sourceAgent}:${req.request_id}`;
    if (this.inFlight.has(dedupKey)) return;
    this.inFlight.add(dedupKey);
    try {
      // Idempotency (ENG-3313): Wire replays the create_request backlog to a
      // freshly-(re)connected instance. Skip a request_id we've already handled
      // (the persisted set survives restarts) — independent of directory state,
      // so it's robust to the create-before-directory-loads race.
      if (await isCreateProcessed(dedupKey)) {
        console.log(`[wallet-vault] create ${req.request_id} from ${sourceAgent} already handled — skipping replay`);
        return;
      }
      const dir = this.directory.all();
      // Name uniqueness per creator: different agents can share a name, the same
      // agent cannot.
      for (const meta of Object.values(dir)) {
        if (meta.creator === sourceAgent && (meta.name === req.name || meta.operator_name === req.name)) {
          await this.respondError(req.request_id, sourceAgent, `wallet named '${req.name}' already exists for agent '${sourceAgent}'`);
          return;
        }
      }
      await this.mintAndPublish(req, sourceAgent, dir, dedupKey);
    } catch (e) {
      console.error(`[wallet-vault] wallet.vault.create_request failed:`, e);
      await this.respondError(req.request_id, sourceAgent, e instanceof Error ? e.message : String(e));
    } finally {
      this.inFlight.delete(dedupKey);
    }
  }

  /**
   * Generate a fresh EOA, persist it to the vault, mark the request handled,
   * publish the per-key directory entry, and reply to the creator. Assumes the
   * idempotency + name-uniqueness gates in handleCreate already passed.
   */
  private async mintAndPublish(
    req: CreateRequest,
    sourceAgent: string,
    dir: Record<string, WalletMeta>,
    dedupKey: string,
  ): Promise<void> {
    const pkHex = generatePrivateKey();
    const address = addressFromPrivateKey(pkHex);
    const lowerAddr = address.toLowerCase();
    // (Belt + suspenders) a just-generated address colliding with an existing
    // entry means key reuse — refuse rather than silently overwrite.
    if (dir[lowerAddr]) {
      await this.respondError(req.request_id, sourceAgent, `address collision (somehow) — refusing to overwrite ${address}`);
      return;
    }
    const passphrase = await getPassphrase();
    const encrypted_key = await encryptPrivateKey(pkHex, passphrase);
    const entry: WalletEntry = {
      name: req.name,
      address,
      encrypted_key,
      created_at: Date.now(),
      decider: { mode: "wire" },
    };
    const vault = await getVault();
    vault.push(entry);
    await setVault(vault);
    // Mark handled once the vault (the authoritative keystore) holds the new
    // wallet, so a replay is skipped. The directory publish below is best-effort
    // and reconciled on boot by seedDirectoryFromVault.
    await markCreateProcessed(dedupKey);
    const meta: WalletMeta = {
      name: req.name,
      creator: sourceAgent,
      created_at: entry.created_at,
      chain_id: req.chain_id ?? devChainId(),
      access: { mode: "specific", agents: [sourceAgent] },
    };
    // Per-key write (ENG-3313): store this wallet under `wallet:<lowercase-addr>`
    // rather than the whole `wallets` blob, so concurrent creates touch distinct
    // keys and can't clobber each other. The wire server only lets an agent write
    // its OWN namespace (= vault id).
    await this.connection.setPluginSetting(this.directory.namespace, walletSettingKey(lowerAddr), meta);
    console.log(`[wallet-vault] created wallet ${address} (name='${req.name}', creator=${sourceAgent})`);
    const response: CreatedResponseOk = { request_id: req.request_id, ok: true, address, name: req.name };
    await this.connection.publish(WALLET_VAULT_CREATED, response, sourceAgent);
  }

  private async respondError(request_id: string, dest: string, error: string): Promise<void> {
    const response: CreatedResponseErr = { request_id, ok: false, error };
    try {
      await this.connection.publish(WALLET_VAULT_CREATED, response, dest);
    } catch (e) {
      console.error(`[wallet-vault] failed to publish create_request error:`, e);
    }
  }
}
