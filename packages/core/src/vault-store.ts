/**
 * Vault storage layer for the extension. Reads/writes WalletEntry list
 * to chrome.storage.local. Unlock passphrase lives in chrome.storage.session
 * (RAM-resident, seeded at install).
 *
 * v0.2: dev-mode bootstrap creates a fresh wallet on first install with
 * a fixed dev passphrase and a hardcoded LocalRpcDecider config so the
 * Path B smoke test works out-of-the-box. v0.3 replaces this with a
 * proper UI-driven create flow.
 */

import type { WalletEntry } from "@agiterra/wallet-tools";
import { encryptPrivateKey, decryptPrivateKey, generatePrivateKey, addressFromPrivateKey } from "@agiterra/wallet-tools";

const VAULT_KEY = "agiterra-wallet-vault";
const PASSPHRASE_KEY = "agiterra-wallet-passphrase";

// v0.2 dev defaults — overridable via chrome.storage.local.set in devtools.
// The extension auto-creates one wallet pointing at this local-RPC URL so
// the smoke test (bun scripts/local-decider-server.ts) works immediately.
const DEV_PASSPHRASE = "dev-passphrase-v0";
const DEV_DECIDER_URL = "http://localhost:54321";
const DEV_DECIDER_TOKEN = "dev-token-v0";
const DEV_CHAIN_ID = 11155111; // Sepolia

export async function getVault(): Promise<WalletEntry[]> {
  const stored = await chrome.storage.local.get(VAULT_KEY);
  return (stored[VAULT_KEY] as WalletEntry[]) ?? [];
}

export async function setVault(wallets: WalletEntry[]): Promise<void> {
  await chrome.storage.local.set({ [VAULT_KEY]: wallets });
}

export async function getPassphrase(): Promise<string> {
  const stored = await chrome.storage.session.get(PASSPHRASE_KEY);
  return (stored[PASSPHRASE_KEY] as string) ?? DEV_PASSPHRASE;
}

export async function setPassphrase(passphrase: string): Promise<void> {
  await chrome.storage.session.set({ [PASSPHRASE_KEY]: passphrase });
}

/** Is this the hardcoded dev passphrase (testnet-only)? */
export function isDevPassphrase(passphrase: string): boolean {
  return passphrase === DEV_PASSPHRASE;
}

/** The dev passphrase constant — exposed only for migration probes. */
export function devPassphrase(): string {
  return DEV_PASSPHRASE;
}

/**
 * Migrate every WalletEntry's encrypted_key from `oldPassphrase` to
 * `newPassphrase`. Used when the operator sets a real passphrase for the
 * first time (replaces the testnet-default "dev-passphrase-v0").
 *
 * Atomicity: builds the new vault array, only commits if every entry
 * decrypted+re-encrypted successfully. Partial-failure means original
 * vault is untouched and the caller surfaces the error.
 */
export async function migrateVaultPassphrase(
  oldPassphrase: string,
  newPassphrase: string,
): Promise<{ migrated: number }> {
  const { decryptPrivateKey, encryptPrivateKey } = await import("@agiterra/wallet-tools");
  const vault = await getVault();
  const migrated: WalletEntry[] = [];
  for (const w of vault) {
    let pkHex: string;
    try {
      pkHex = await decryptPrivateKey(w.encrypted_key, oldPassphrase);
    } catch (e) {
      throw new Error(`failed to decrypt wallet '${w.name}' (${w.address}) under old passphrase: ${(e as Error).message}`);
    }
    const newEncrypted = await encryptPrivateKey(pkHex, newPassphrase);
    migrated.push({ ...w, encrypted_key: newEncrypted });
  }
  await setVault(migrated);
  return { migrated: migrated.length };
}

/** Decrypt a wallet's private key for one signing operation. */
export async function unlockPrivateKey(entry: WalletEntry): Promise<string> {
  const passphrase = await getPassphrase();
  return decryptPrivateKey(entry.encrypted_key, passphrase);
}

/**
 * One-time bootstrap on install / first run when the vault is empty.
 * Generates a fresh dev wallet with the LocalRpcDecider config baked in,
 * encrypted under DEV_PASSPHRASE.
 *
 * For Path B smoke test only. v0.3 replaces with UI-driven creation +
 * keychain-managed passphrase.
 */
export async function bootstrapDevWalletIfEmpty(): Promise<WalletEntry | null> {
  const existing = await getVault();
  if (existing.length > 0) return null;
  await setPassphrase(DEV_PASSPHRASE);
  const pkHex = generatePrivateKey();
  const address = addressFromPrivateKey(pkHex);
  const encrypted_key = await encryptPrivateKey(pkHex, DEV_PASSPHRASE);
  const entry: WalletEntry = {
    name: "dev-wallet",
    address,
    encrypted_key,
    created_at: Date.now(),
    decider: {
      mode: "local-rpc",
      url: DEV_DECIDER_URL,
      auth_token: DEV_DECIDER_TOKEN,
    },
  };
  await setVault([entry]);
  console.log("[wallet-vault] bootstrap: created dev wallet", address);
  console.log("[wallet-vault] dev decider:", DEV_DECIDER_URL);
  console.log("[wallet-vault] start the local decider with: bun scripts/local-decider-server.ts");
  return entry;
}

export function devChainId(): number {
  return DEV_CHAIN_ID;
}

const ACTIVE_CHAIN_KEY = "agiterra-wallet-active-chain-id";

/**
 * Read the currently active chain ID. Set by wallet_switchEthereumChain.
 * Falls back to DEV_CHAIN_ID on first install.
 */
export async function getActiveChainId(): Promise<number> {
  const stored = await chrome.storage.local.get(ACTIVE_CHAIN_KEY);
  const v = stored[ACTIVE_CHAIN_KEY];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = v.startsWith("0x") ? parseInt(v, 16) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return DEV_CHAIN_ID;
}

export async function setActiveChainId(chainId: number): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_CHAIN_KEY]: chainId });
}
