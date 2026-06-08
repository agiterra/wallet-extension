/**
 * The wallet-vault extension's Wire identity.
 *
 * Generated once on first install, persisted in chrome.storage.local. The
 * extension self-identifies as a single Wire identity of kind='integration'
 * regardless of how many EOA wallets live in the vault — the wallets are
 * Ethereum keypairs, this is the Wire transport keypair, two different
 * concerns.
 *
 * Bootstrap: extension creates its own keypair on first launch and logs the
 * pubkey + a one-shot operator curl that registers it as
 * `kind:"integration"` in Wire. Once registered, subsequent extension loads
 * just import the stored private key and reconnect.
 */

import {
  generateKeyPair,
  importPrivateKey,
  exportPrivateKeyB64,
  derivePublicKeyB64,
} from "./wire-crypto.js";

const STORAGE_KEY = "agiterra-wallet-extension-wire-identity";
// First-boot Wire agent id. Read from VAULT_ID_KEY (default DEFAULT_AGENT_ID),
// then frozen into STORAGE_KEY — so it is consulted ONLY on first install.
// This lets a second extension instance (e.g. a browser-use-launched profile,
// ENG-2947) register under its OWN id and coexist with a live "wallet-vault"
// instead of colliding on the shared id (Wire rejects a re-register with a
// different pubkey: 409 agent_exists_pubkey_mismatch). Every existing install —
// including the operator's Chrome — has no VAULT_ID_KEY set, so it keeps the
// default and is completely unaffected.
const VAULT_ID_KEY = "agiterra-wallet-extension-vault-id";
const DEFAULT_AGENT_ID = "wallet-vault";
const DISPLAY_NAME = "Wallet Vault";

interface StoredIdentity {
  agentId: string;
  privateKeyB64: string;
}

export interface WireIdentity {
  agentId: string;
  displayName: string;
  publicKeyB64: string;
  privateKey: CryptoKey;
}

export async function loadOrCreateIdentity(): Promise<WireIdentity> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const existing = stored[STORAGE_KEY] as StoredIdentity | undefined;
  if (existing) {
    const privateKey = await importPrivateKey(existing.privateKeyB64);
    const publicKeyB64 = await derivePublicKeyB64(privateKey);
    return { agentId: existing.agentId, displayName: DISPLAY_NAME, publicKeyB64, privateKey };
  }

  // First mint: pick the Wire agent id (default "wallet-vault"). A coexisting
  // instance seeds VAULT_ID_KEY before first boot to claim its own id.
  const vaultIdStored = await chrome.storage.local.get(VAULT_ID_KEY);
  const agentId =
    (vaultIdStored[VAULT_ID_KEY] as string | undefined)?.trim() || DEFAULT_AGENT_ID;

  const kp = await generateKeyPair();
  const privateKeyB64 = await exportPrivateKeyB64(kp.privateKey);
  const entry: StoredIdentity = { agentId, privateKeyB64 };
  await chrome.storage.local.set({ [STORAGE_KEY]: entry });

  console.log(
    `[wallet-vault] generated Wire identity (first install)\n` +
    `  agent_id: ${agentId}\n` +
    `  pubkey:   ${kp.publicKeyB64}\n` +
    `\n` +
    `  Register with The Wire (operator-side, one-time):\n` +
    `  curl -sS -X POST "$WIRE_URL/agents/register" \\\n` +
    `    -H "Authorization: Bearer $WIRE_OPERATOR_TOKEN" \\\n` +
    `    -H "Content-Type: application/json" \\\n` +
    `    -d '{"id":"${agentId}","display_name":"${DISPLAY_NAME}","pubkey":"${kp.publicKeyB64}","kind":"integration"}'`,
  );

  return { agentId, displayName: DISPLAY_NAME, publicKeyB64: kp.publicKeyB64, privateKey: kp.privateKey };
}

/** Default Wire agent id when VAULT_ID_KEY is unset (back-compat). */
export const WALLET_VAULT_AGENT_ID = DEFAULT_AGENT_ID;
export const WALLET_VAULT_DISPLAY_NAME = DISPLAY_NAME;
/** chrome.storage.local key a coexisting instance seeds (pre-first-boot) to
 *  claim its own Wire agent id. See the launcher's seed_storage(). */
export const WALLET_VAULT_VAULT_ID_KEY = VAULT_ID_KEY;
