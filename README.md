# @agiterra/wallet-extension

Chrome extension that lets agents drive dApp interactions as if they
were a MetaMask user, including refusal flows for testing dApp
behavior under wallet errors. Loaded into the operator's existing
Chrome profile so Google SSO and other web sessions are preserved.

## Design

See [agiterra/architecture/agent-wallet-extension.md](https://github.com/agiterra/architecture/blob/main/agent-wallet-extension.md).

Key properties:
- **Daemon-less.** Extension is itself a Wire participant (v0.3+);
  agents subscribe to sign requests via the same pattern as
  webhook.ipc / webhook.github.
- **Decider abstraction.** Three modes: Wire (interactive / production),
  Manual (operator popup), Local RPC (CI / Playwright tests). Same
  request/response shape across all three.
- **Multi-wallet vault.** N named wallets in one extension instance.
  Encrypted at rest. Per-wallet decider config.
- **Popup-free agent path.** Agent decisions go through Wire, not
  through extension UI. User-facing UI exists separately for manual
  inspection + key export.

## Status

- **v0.1.0** — scaffolding (manifest, three bundles, bridge plumbed, Decider stubbed).
- **v0.2.0** — Path B end-to-end signing. LocalRpcDecider works.
  personal_sign works. Auto-bootstraps a dev wallet on first install.
- **v0.3** (next) — WireDecider, user-facing UI (options page, key
  export), `eth_signTransaction` with RLP/EIP-1559, ManualDecider popup.

## Build

```bash
bun install
bun run build
```

Outputs `dist/manifest.json` + three bundles (`background.js`,
`content-script.js`, `inpage.js`).

For active development:

```bash
bun run watch  # rebuilds on src/ changes; refresh extension in chrome://extensions
```

## Path B smoke test (v0.2.0)

End-to-end manual test: load extension → start local-decider server →
visit test page → see a real `personal_sign` signature come back.

1. **Build the extension:**

   ```bash
   bun install
   bun run build
   ```

2. **Load it into Chrome:**

   - Open `chrome://extensions`
   - Enable Developer mode (top right)
   - Click "Load unpacked"
   - Select the `dist/` directory of this repo

3. **Inspect the service worker** to confirm the dev wallet bootstrapped:

   - On the Agiterra Wallet card, click "service worker" (or "inspect views: service worker")
   - You should see logs like:
     ```
     [wallet-vault] bootstrap: created dev wallet 0x...
     [wallet-vault] dev decider: http://localhost:54321
     [wallet-vault] start the local decider with: bun scripts/local-decider-server.ts
     [wallet-vault] background service worker started, v0.2.0
     ```
   - Copy the wallet address; you'll see it again in step 6.

4. **Start the local decider:**

   ```bash
   bun scripts/local-decider-server.ts
   ```

   Default approve-all. Set `REFUSE=1` to test the 4001 refusal flow:

   ```bash
   REFUSE=1 bun scripts/local-decider-server.ts
   ```

5. **Start the test-page server:**

   ```bash
   bun scripts/test-page-server.ts
   ```

   In another terminal so both stay running.

6. **Drive the test:**

   - Open `http://localhost:54322/` in the same Chrome profile that
     has the extension loaded.
   - Click "1. Discover provider" — should show "Found provider:
     Agiterra Wallet".
   - Click "2. Request accounts" — should show one address matching
     the dev wallet bootstrapped in step 3.
   - Click "3. personal_sign" — should show a 132-character signature
     (0x + 65 bytes hex) in the result pane.

7. **Verify the signature** is real (optional, recovers the signing
   address from the signature):

   ```javascript
   // In any Node REPL with `ethers` available:
   const ethers = require('ethers');
   const message = '<the exact message from the result>';
   const sig = '<the 132-char signature>';
   const recovered = ethers.verifyMessage(message, sig);
   // recovered should equal the wallet address from step 3
   ```

8. **Test refusal flow** (optional, validates the 4001 path):

   - Stop the decider server, restart with `REFUSE=1`:
     ```bash
     REFUSE=1 bun scripts/local-decider-server.ts
     ```
   - Click "3b. personal_sign (expect refusal)" — should show "Got
     expected 4001 refusal" in green.

If all four steps pass: v0.2 is working. The EIP-1193 plumbing,
Decider abstraction, vault encryption, and signing are all validated
end-to-end.

## What's NOT in v0.2

- `eth_signTransaction` / `eth_sendTransaction` — RLP encoding for
  EIP-1559 ships in v0.3.
- `eth_signTypedData_v4` — EIP-712 hashing ships in v0.3.
- WireDecider — production Wire-mediated signing ships in v0.3.
- ManualDecider — operator popup approval UI ships in v0.3.
- Wallet management UI — options page with list/create/delete/import/export
  ships in v0.3.
- Multi-wallet (more than one entry in vault) — works architecturally but
  no UI to manage; manual chrome.storage.local edits only in v0.2.

## Loading into a specific Chrome profile

If you have multiple Chrome profiles, make sure to load the extension
into the right one. The vault lives in chrome.storage.local of whichever
profile loaded it.

For CI / headless use (Playwright with `--load-extension=`), see the
design doc's §CI mode section.
