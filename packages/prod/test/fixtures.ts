/** Shared test fixtures for the prod package. */
import type { WalletMeta } from "@agiterra/wallet-tools";

/** A valid WalletMeta (passes wallet-tools isWalletMeta) for unit tests. */
export function meta(name: string, creator = "agent-x"): WalletMeta {
  return { name, creator, created_at: 1, chain_id: 11155111, access: { mode: "specific", agents: [creator] } };
}
