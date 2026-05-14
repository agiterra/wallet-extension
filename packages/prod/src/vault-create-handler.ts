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
import {
  getVault,
  setVault,
  getPassphrase,
  devChainId,
} from "@agiterra/wallet-extension-core";
import type { WireConnection } from "./wire-connection.js";
import type { WalletDirectory } from "./wallet-directory.js";

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
    private connection: WireConnection,
    private directory: WalletDirectory,
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

  private async handleCreate(req: CreateRequest, sourceAgent: string): Promise<void> {
    try {
      const dir = this.directory.all();

      // Name uniqueness per creator. Different agents can have wallets
      // sharing a name; same agent cannot.
      for (const meta of Object.values(dir)) {
        if (meta.creator === sourceAgent && (meta.name === req.name || meta.operator_name === req.name)) {
          await this.respondError(req.request_id, sourceAgent, `wallet named '${req.name}' already exists for agent '${sourceAgent}'`);
          return;
        }
      }

      const pkHex = generatePrivateKey();
      const address = addressFromPrivateKey(pkHex);
      const lowerAddr = address.toLowerCase();

      // (Belt + suspenders) reject if the just-generated address somehow
      // collides with an existing entry — astronomically unlikely but a
      // collision means key reuse, which we never want to silently overwrite.
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

      const meta: WalletMeta = {
        name: req.name,
        creator: sourceAgent,
        created_at: entry.created_at,
        chain_id: req.chain_id ?? devChainId(),
        access: { mode: "specific", agents: [sourceAgent] },
      };
      const nextDir = { ...dir, [lowerAddr]: meta };
      await this.connection.setPluginSetting("wallet-vault", "wallets", nextDir);

      console.log(`[wallet-vault] created wallet ${address} (name='${req.name}', creator=${sourceAgent})`);

      const response: CreatedResponseOk = {
        request_id: req.request_id,
        ok: true,
        address,
        name: req.name,
      };
      await this.connection.publish(WALLET_VAULT_CREATED, response, sourceAgent);
    } catch (e) {
      console.error(`[wallet-vault] wallet.vault.create_request failed:`, e);
      await this.respondError(req.request_id, sourceAgent, (e as Error).message);
    }
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
