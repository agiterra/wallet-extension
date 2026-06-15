# @agiterra/wallet-extension-browser-use

Thin launcher/bridge that loads the **existing** prod Agiterra Wallet
extension into a [browser-use](https://github.com/browser-use/browser-use)
(Playwright/patchright/CDP) Chromium, so an agent can drive dApp
interactions through the same Wire-mediated signing path it uses in
Claude-in-Chrome — **without** building an injected `window.ethereum`.
The extension already injects `window.ethereum`
(`core/src/inpage.ts` → `AgiterraEthereumProvider`) and signs via Wire;
this package just launches a browser with that extension loaded and
binds the session.

Part of ENG-2947 (migrate agent browser testing from Claude-in-Chrome to
browser-use, reusing the existing wallet). Sits beside `packages/ci`;
`wallet-claude-code` and the CI/local-rpc path are untouched here.

## ⚠️ Gotchas the spike found (read before debugging a "won't load")

These will bite the next person:

1. **Branded Google Chrome stable REJECTS the extension flags.** Launching
   `/Applications/Google Chrome.app/...` with `--load-extension` /
   `--disable-extensions-except` logs
   `extension_service.cc:440 --disable-extensions-except is not allowed in
   Google Chrome, ignoring` and silently drops the extension (observed
   Chrome 148). You **must** launch **Chrome for Testing / Chromium** — the
   binary Playwright/browser-use bundles
   (`~/Library/Caches/ms-playwright/chromium-*/.../Google Chrome for Testing`).
   `launcher.py` resolves it explicitly; never point it at system Chrome.

2. **`enable_default_extensions=False` is required.** browser-use otherwise
   appends its OWN `--load-extension` (uBlock, etc.); Chrome honors only the
   **last** `--load-extension` on the command line, clobbering ours. With it
   off, our single `--load-extension` is the only one.

3. **`headless='new'` works** for the MV3 service worker + content-script
   injection. Old `--headless` does not run MV3 service workers.

4. **Persistent context.** MV3 service workers need a real `user_data_dir`
   (a persistent context). browser-use uses one by default.

## Verified (spike, 2026-06-08)

Through browser-use's real launch path (`BrowserSession(BrowserProfile(...))`):
- MV3 service worker runs: `chrome-extension://<id>/background.js`
- `window.ethereum.isAgiterraWallet === true` on a normal http page (no MetaMask)

(The unpacked extension id is derived from the dist's absolute path; for
`packages/prod/dist` it is `kddloahnoaaokkindgcfeklbhbobmhlg`.)

## Usage

```bash
# from repo root: build the extension the launcher loads
bun run build:prod                 # → packages/prod/dist

cd packages/browser-use
python -m venv .venv && source .venv/bin/activate
pip install -e .                   # load-path only (browser-use + websockets)
python smoke_test.py               # proves the load-path end-to-end (no Wire)

# to run the Wire-driven sign tests, add the harness deps + your Wire creds:
pip install -e '.[test]'           # + eth-account, cryptography
AGENT_ID=<you> AGENT_PRIVATE_KEY=<key> WIRE_URL=<wire> python e2e_sign_solo.py
```

## The harness (scripts)

- `launcher.py` — launch + load extension; CDP helpers (seed/read/remove
  storage, reload SW, open page, `eth_request`); `provision_vault_identity()`
  (re-mint the instance's Wire id as a non-default `vault_id`, race-free —
  seeds `wire-url` LAST so the default `wallet-vault` never touches Wire).
- `wire_admin.py` — Ed25519 JWT + `sponsor_register()` (an already-registered
  agent enrolls the instance's id — no operator step) + `is_registered()` +
  Wire-direct wallet ops (`wallet_create` / `wallet_use` / `wallet_approve` /
  `wallet_refuse` / `wallet_reject_with_error` / `get_directory`) — the harness
  drives create/sign/approve straight over Wire, **no MCP round-trip and no
  dependency on the `wallet-claude-code` plugin version**.
- `wire_test_utils.py` — self-contained loop helpers: `provision_register_connect`,
  `create_and_get`, `bind_and_sign` (drives `personal_sign`, reads the
  `request_id` from `~/.wire/wire.db`, **self-approves**), and `bind_and_reject`
  (same, but rejects with a custom JSON-RPC error and asserts the page sees it).
- `smoke_test.py` — load-path proof (SW + `window.ethereum`; no Wire).
- `provision_test.py` — re-mint under a non-default vault id (no Wire).
- `e2e_connect.py` — live coexistence proof: launch → provision →
  sponsor-register (force_rotate) → connect as `wallet-vault-e2e`.
- `pertab_test.py` / `persist_switch_test.py` — **the proven self-contained sign
  loops**: two tabs → two wallets → two distinct signatures (per-tab binding via
  `agiterra_getTabId` + the Wire `tab_claim`), and vault persistence across a
  restart.
- `e2e_sign_solo.py` — the **ENG-3326 FV demo**: one process, no external
  approver — launch → provision (distinct vault id, decider = self) →
  `wallet_create` → happy `personal_sign` + recover → forced
  `reject_with_error` + assert the custom `{code,message}` surfaces.
- `e2e_sign.py` — the cross-agent variant (a second agent supplies
  `wallet_create` + `wallet_approve`). Prefer the self-contained path above;
  the 60s WireDecider window is too tight for live inter-agent approval.

## The single-signature e2e (per-instance vault id)

Self-contained (decider-target = the running agent's own id; the harness
self-approves over Wire — sub-second, no 60s-window risk):

1. Launch browser-use + prod extension (`launcher`).
2. Provision the instance's Wire id as a non-default `vault_id` + seed
   `decider-target=<self>` (`provision_vault_identity`).
3. Sponsor-register that id with the running agent's own creds
   (`wire_admin.sponsor_register`, `force_rotate` for repeat runs).
4. Seed `wire-url` → the instance connects to Wire (coexists with a live
   `wallet-vault`; no 409).
5. `wallet_create` over Wire (`wire_admin.wallet_create`) → a wire-mode EOA
   lands in this instance's namespace.
6. Drive `personal_sign` (`launcher.eth_request`); the harness reads the
   `request_id` from `wire.db` and `wallet_approve`s itself → page gets the sig.
   (Or `wallet_reject_with_error` for the error-path FV.)

## Status / scope

- ✅ Load-path, configurable vault id, per-instance namespace, sponsor-register,
  live Wire connect, per-tab binding, **happy-path signature + recover, and the
  forced custom-error rejection** — all proven self-contained
  (`pertab_test.py`, `persist_switch_test.py`, `e2e_sign_solo.py`).
- The live wallet-mode signature is independent of the `wallet-claude-code`
  plugin version (the harness drives Wire directly); the live plugin is v0.8.0
  (namespace-aware `readDirectory(vault_id)`) if you prefer the MCP path.

### Known follow-ups

- **True cross-instance shared pool.** plugin_settings writes are namespace==
  writer-locked (wire server), so per-instance pools don't share. A shared
  pool across Chrome + browser-use needs an arch call (operator-mediated
  writes / canonical writer / auth relax). Today's harness is per-instance.
- **`SignRequest.payload.source`** is still the literal `"wallet-vault"`
  (in shared core); routing uses the Wire envelope source, so it's cosmetic.
