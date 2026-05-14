export { installRequestHandler, tabActiveWallet } from "./background-core.js";
export { LocalRpcDecider, ManualDecider } from "./decider.js";
export type { Decider, DeciderFactory } from "./decider.js";
export {
  getVault,
  setVault,
  getPassphrase,
  setPassphrase,
  unlockPrivateKey,
  bootstrapDevWalletIfEmpty,
  devChainId,
  getActiveChainId,
  setActiveChainId,
  isDevPassphrase,
  devPassphrase,
  migrateVaultPassphrase,
} from "./vault-store.js";
export { signEip1193 } from "./sign.js";
export type { SigningContext, SigningResult } from "./sign.js";
