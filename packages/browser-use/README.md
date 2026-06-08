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
uv venv && source .venv/bin/activate
uv pip install -e .                 # installs browser-use
python smoke_test.py               # proves the load-path end-to-end
```

## The harness (scripts)

- `launcher.py` — launch + load extension; CDP helpers (seed/read/remove
  storage, reload SW, open page, `eth_request`); `provision_vault_identity()`
  (re-mint the instance's Wire id as a non-default `vault_id`, race-free).
- `wire_admin.py` — Ed25519 JWT + `sponsor_register()` (an already-registered
  agent enrolls the instance's id — no operator step) + `is_registered()`.
- `smoke_test.py` — load-path proof (SW + `window.ethereum`).
- `provision_test.py` — re-mint under `wallet-vault-e2e` (no Wire).
- `e2e_connect.py` — **live** coexistence proof: launch → provision →
  sponsor-register (force_rotate) → connect to Wire as `wallet-vault-e2e`.

## The single-signature e2e (per-instance vault id)

1. Launch browser-use + prod extension (`launcher`).
2. Provision the instance's Wire id as `wallet-vault-e2e` + seed
   `decider-target=fondant` (`provision_vault_identity`).
3. Sponsor-register `wallet-vault-e2e` with the orchestrator's creds
   (`wire_admin.sponsor_register`, `force_rotate` for repeat runs).
4. Seed `wire-url` → the instance connects to Wire (coexists with a live
   `wallet-vault`; no 409). **Steps 1–4 proven live (`e2e_connect.py`).**
5. Fondant `wallet_create({name:'eng-2947-e2e', vault_id:'wallet-vault-e2e'})`
   → a wire-mode EOA + policy land in this instance's `wallet-vault-e2e`
   namespace (needs `wallet-claude-code` `readDirectory(vault_id)`, v0.7.0).
6. Drive `personal_sign` (`launcher.eth_request`) → WireDecider routes to
   `fondant` → he `wallet_approve({request_id, vault_id})` → page gets the sig.

## Status / scope

- ✅ Load-path, configurable vault id, per-instance namespace, sponsor-register,
  live Wire connect as `wallet-vault-e2e` — all proven.
- ⏳ The signature itself (steps 5–6) — pending `wallet-claude-code`
  `readDirectory(vault_id)` + Fondant as approver.

### Known follow-ups (NOT in PR#1)

- **True cross-instance shared pool.** plugin_settings writes are namespace==
  writer-locked (wire server), so per-instance pools don't share. A shared
  pool across Chrome + browser-use needs an arch call (operator-mediated
  writes / canonical writer / auth relax). PR#1 is per-instance.
- **Per-tab binding.** The extension stamps `tab_id = String(sender.tab.id)`
  (the Chrome tab id), which a browser-use/CDP context can't readily supply;
  `wallet_use({tab_id})` can't bind a browser-use tab yet. The first e2e
  sidesteps this with a single active wallet (`decider-target`).
- **`SignRequest.payload.source`** is still the literal `"wallet-vault"`
  (in shared core); routing uses the Wire envelope source, so it's cosmetic.
