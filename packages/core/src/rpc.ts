/**
 * JSON-RPC client for chain interaction.
 *
 * RPC URLs are stored per-chain in chrome.storage.local under
 * `agiterra-wallet-extension-rpc-urls` as `{ [chainId: string]: url }`.
 *
 * v0.3-dev: operator pastes the mapping via SW devtools. v0.3 ship
 * surfaces this on the options page (Task 7).
 *
 * No retry / backoff — chain RPCs are typically reliable. Errors
 * propagate to the caller, which surfaces them to the dApp.
 */

const RPC_URLS_KEY = "agiterra-wallet-extension-rpc-urls";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export async function getRpcUrl(chainId: number): Promise<string> {
  const stored = await chrome.storage.local.get(RPC_URLS_KEY);
  const map = (stored[RPC_URLS_KEY] as Record<string, string> | undefined) ?? {};
  const url = map[String(chainId)];
  if (!url) {
    throw new Error(
      `No RPC URL configured for chain ${chainId}. Set chrome.storage.local["${RPC_URLS_KEY}"] = { "${chainId}": "https://..." } via the options page or service-worker devtools.`,
    );
  }
  return url;
}

let nextId = 1;

export async function rpcCall<T = unknown>(
  chainId: number,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const url = await getRpcUrl(chainId);
  const body: JsonRpcRequest = { jsonrpc: "2.0", id: nextId++, method, params };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`RPC ${method} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as JsonRpcResponse;
  if (data.error) {
    throw new Error(`RPC ${method} error ${data.error.code}: ${data.error.message}`);
  }
  return data.result as T;
}

// ---- Typed accessors for the chain methods we need ----

export async function getTransactionCount(chainId: number, address: string, block: "latest" | "pending" = "pending"): Promise<bigint> {
  const hex = await rpcCall<string>(chainId, "eth_getTransactionCount", [address, block]);
  return BigInt(hex);
}

export async function estimateGas(chainId: number, tx: Record<string, unknown>): Promise<bigint> {
  const hex = await rpcCall<string>(chainId, "eth_estimateGas", [tx]);
  return BigInt(hex);
}

export async function maxPriorityFeePerGas(chainId: number): Promise<bigint> {
  const hex = await rpcCall<string>(chainId, "eth_maxPriorityFeePerGas", []);
  return BigInt(hex);
}

export async function getBlock(chainId: number, block: "latest" | "pending" = "latest"): Promise<{ baseFeePerGas?: string }> {
  return rpcCall<{ baseFeePerGas?: string }>(chainId, "eth_getBlockByNumber", [block, false]);
}

export async function sendRawTransaction(chainId: number, rawTxHex: string): Promise<string> {
  return rpcCall<string>(chainId, "eth_sendRawTransaction", [rawTxHex]);
}
