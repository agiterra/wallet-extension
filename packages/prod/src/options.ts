/**
 * Options page — operator config surface for the wallet-vault extension.
 *
 * Sections:
 *   1. Wire — URL, extension pubkey display + registration status,
 *      fallback decider target.
 *   2. Networks — chain_id → RPC URL pairs (used by eth_sendTransaction).
 *   3. Wallets — read-only view of vault entries cross-referenced with
 *      plugin_settings access policy. Permission edits happen on the
 *      Wire dashboard, not here.
 *
 * All inputs persist to chrome.storage.local. The Wire identity pubkey is
 * derived from the stored keypair (wire-identity.ts created on first
 * install). Registration status is checked by polling /agents?kind=integration.
 */

import { importPrivateKey, derivePublicKeyB64 } from "./wire-crypto.js";
import { getVault } from "@agiterra/wallet-extension-core";

const WIRE_URL_KEY = "agiterra-wallet-extension-wire-url";
const DECIDER_TARGET_KEY = "agiterra-wallet-extension-decider-target";
const RPC_URLS_KEY = "agiterra-wallet-extension-rpc-urls";
const WIRE_IDENTITY_KEY = "agiterra-wallet-extension-wire-identity";

interface StoredIdentity { agentId: string; privateKeyB64: string }

interface WalletMeta {
  name: string;
  operator_name?: string;
  creator: string;
  chain_id: number;
  access: { mode: "creator-only" | "specific" | "all"; agents: string[] };
}

// ---- DOM helpers ----

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

function toast(id: string): void {
  const el = $(id);
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 1000);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function copyToClipboard(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch { /* noop */ }
}

// ---- Wire section ----

async function loadWireUrl(): Promise<string> {
  const stored = await chrome.storage.local.get(WIRE_URL_KEY);
  return (stored[WIRE_URL_KEY] as string | undefined)?.replace(/\/$/, "") ?? "";
}

async function loadDeciderTarget(): Promise<string> {
  const stored = await chrome.storage.local.get(DECIDER_TARGET_KEY);
  return (stored[DECIDER_TARGET_KEY] as string | undefined) ?? "";
}

async function loadIdentityPubkey(): Promise<{ agentId: string; pubkey: string } | null> {
  const stored = await chrome.storage.local.get(WIRE_IDENTITY_KEY);
  const id = stored[WIRE_IDENTITY_KEY] as StoredIdentity | undefined;
  if (!id) return null;
  const privateKey = await importPrivateKey(id.privateKeyB64);
  const pubkey = await derivePublicKeyB64(privateKey);
  return { agentId: id.agentId, pubkey };
}

async function checkRegistration(wireUrl: string, agentId: string, pubkey: string): Promise<"registered" | "pubkey-mismatch" | "not-registered"> {
  try {
    const res = await fetch(`${wireUrl}/agents?kind=integration`);
    if (!res.ok) return "not-registered";
    const arr = (await res.json()) as Array<{ id: string; pubkey: string }>;
    const found = arr.find((a) => a.id === agentId);
    if (!found) return "not-registered";
    if (found.pubkey !== pubkey) return "pubkey-mismatch";
    return "registered";
  } catch {
    return "not-registered";
  }
}

async function renderWireSection(): Promise<void> {
  const url = await loadWireUrl();
  ($("wire-url") as HTMLInputElement).value = url;

  const decider = await loadDeciderTarget();
  ($("decider-target") as HTMLInputElement).value = decider;

  const identity = await loadIdentityPubkey();
  const pubkeyEl = $("pubkey-block");
  if (!identity) {
    pubkeyEl.textContent = "(no identity yet — extension will generate one on first connect attempt)";
    $("reg-status").innerHTML = '<span class="pill pill-warn">no identity</span>';
    return;
  }
  pubkeyEl.textContent = `${identity.agentId} · ${identity.pubkey}`;
  pubkeyEl.onclick = () => { void copyToClipboard(identity.pubkey); };

  if (!url) {
    $("reg-status").innerHTML = '<span class="pill pill-warn">Wire URL not set</span>';
    return;
  }

  const status = await checkRegistration(url, identity.agentId, identity.pubkey);
  const statusEl = $("reg-status");
  const instrEl = $("register-instructions");
  if (status === "registered") {
    statusEl.innerHTML = `<span class="pill pill-ok">registered on ${esc(new URL(url).host)}</span>`;
    instrEl.style.display = "none";
  } else if (status === "pubkey-mismatch") {
    statusEl.innerHTML = '<span class="pill pill-err">registered with a different pubkey — needs force-rotate</span>';
    instrEl.style.display = "none";
  } else {
    statusEl.innerHTML = '<span class="pill pill-err">not registered</span>';
    instrEl.style.display = "block";
    const cmd = $("register-command");
    cmd.textContent = `Register ${identity.agentId} with pubkey ${identity.pubkey}`;
    cmd.onclick = () => { void copyToClipboard(cmd.textContent ?? ""); };
  }
}

$("save-wire-url").addEventListener("click", async () => {
  const url = ($("wire-url") as HTMLInputElement).value.trim().replace(/\/$/, "");
  await chrome.storage.local.set({ [WIRE_URL_KEY]: url });
  toast("wire-url-toast");
  await renderWireSection();
});

$("save-decider-target").addEventListener("click", async () => {
  const target = ($("decider-target") as HTMLInputElement).value.trim();
  await chrome.storage.local.set({ [DECIDER_TARGET_KEY]: target });
  toast("decider-target-toast");
});

// ---- Networks section ----

async function loadNetworks(): Promise<Record<string, string>> {
  const stored = await chrome.storage.local.get(RPC_URLS_KEY);
  return (stored[RPC_URLS_KEY] as Record<string, string> | undefined) ?? {};
}

async function saveNetworks(map: Record<string, string>): Promise<void> {
  await chrome.storage.local.set({ [RPC_URLS_KEY]: map });
}

async function renderNetworks(): Promise<void> {
  const map = await loadNetworks();
  const tbody = $("networks-tbody");
  const ids = Object.keys(map).sort((a, b) => Number(a) - Number(b));
  if (ids.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="table-empty">No networks configured. Add one below.</td></tr>';
    return;
  }
  tbody.innerHTML = ids.map((id) =>
    `<tr><td>${esc(id)}</td><td><code>${esc(map[id]!)}</code></td><td><button class="danger" data-del="${esc(id)}">remove</button></td></tr>`
  ).join("");
  tbody.querySelectorAll<HTMLButtonElement>("button[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.del!;
      const next = await loadNetworks();
      delete next[id];
      await saveNetworks(next);
      await renderNetworks();
    });
  });
}

$("add-network").addEventListener("click", async () => {
  const chainIdEl = $("new-chain-id") as HTMLInputElement;
  const rpcEl = $("new-rpc-url") as HTMLInputElement;
  const chainId = chainIdEl.value.trim();
  const rpc = rpcEl.value.trim();
  if (!chainId || !rpc) return;
  if (!/^\d+$/.test(chainId)) {
    alert("Chain ID must be a number");
    return;
  }
  const next = await loadNetworks();
  next[chainId] = rpc;
  await saveNetworks(next);
  chainIdEl.value = "";
  rpcEl.value = "";
  await renderNetworks();
});

// ---- Wallets section ----

async function loadWalletDirectory(wireUrl: string): Promise<Record<string, WalletMeta>> {
  try {
    const res = await fetch(`${wireUrl}/plugin_settings/wallet-vault/wallets`);
    if (res.status === 404) return {};
    if (!res.ok) return {};
    const body = (await res.json()) as { value?: Record<string, WalletMeta> };
    return body.value ?? {};
  } catch { return {}; }
}

async function renderWallets(): Promise<void> {
  const tbody = $("wallets-tbody");
  const vault = await getVault();
  const wireUrl = await loadWireUrl();
  const dir = wireUrl ? await loadWalletDirectory(wireUrl) : {};

  if (vault.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No wallets in vault.</td></tr>';
    return;
  }

  tbody.innerHTML = vault.map((w) => {
    const addr = w.address.toLowerCase();
    const meta = dir[addr];
    const shortAddr = w.address.slice(0, 8) + "…" + w.address.slice(-6);
    const name = meta?.operator_name ?? meta?.name ?? w.name;
    const chain = meta?.chain_id ?? "—";
    const decider = w.decider?.mode ?? "—";
    const access = meta
      ? (meta.access.mode === "all" ? "all" : meta.access.mode === "creator-only" ? "creator-only (" + esc(meta.creator) + ")" : meta.access.agents.map(esc).join(", "))
      : '<span class="pill pill-warn">not in plugin_settings</span>';
    return `<tr><td>${esc(name)}</td><td><code title="${esc(w.address)}">${esc(shortAddr)}</code></td><td>${esc(String(chain))}</td><td>${esc(decider)}</td><td>${access}</td></tr>`;
  }).join("");
}

// ---- Boot ----

void (async () => {
  await renderWireSection();
  await renderNetworks();
  await renderWallets();
})();
