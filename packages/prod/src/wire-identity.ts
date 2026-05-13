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
const AGENT_ID = "wallet-vault";
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

  const kp = await generateKeyPair();
  const privateKeyB64 = await exportPrivateKeyB64(kp.privateKey);
  const entry: StoredIdentity = { agentId: AGENT_ID, privateKeyB64 };
  await chrome.storage.local.set({ [STORAGE_KEY]: entry });

  console.log(
    `[wallet-vault] generated Wire identity (first install)\n` +
    `  agent_id: ${AGENT_ID}\n` +
    `  pubkey:   ${kp.publicKeyB64}\n` +
    `\n` +
    `  Register with The Wire (operator-side, one-time):\n` +
    `  curl -sS -X POST "$WIRE_URL/agents/register" \\\n` +
    `    -H "Authorization: Bearer $WIRE_OPERATOR_TOKEN" \\\n` +
    `    -H "Content-Type: application/json" \\\n` +
    `    -d '{"id":"${AGENT_ID}","display_name":"${DISPLAY_NAME}","pubkey":"${kp.publicKeyB64}","kind":"integration"}'`,
  );

  return { agentId: AGENT_ID, displayName: DISPLAY_NAME, publicKeyB64: kp.publicKeyB64, privateKey: kp.privateKey };
}

export const WALLET_VAULT_AGENT_ID = AGENT_ID;
export const WALLET_VAULT_DISPLAY_NAME = DISPLAY_NAME;
