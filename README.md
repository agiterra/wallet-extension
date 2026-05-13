# @agiterra/wallet-extension

Chrome extension that lets agents drive dApp interactions as if they
were a MetaMask user, including refusal flows for testing dApp
behavior under wallet errors. Loaded into the operator's existing
Chrome profile so Google SSO and other web sessions are preserved.

## Design

See [agiterra/architecture/agent-wallet-extension.md](https://github.com/agiterra/architecture/blob/main/agent-wallet-extension.md).

Key properties:
- **Daemon-less.** Extension is itself a Wire participant; agents
  subscribe to sign requests via the same pattern as webhook.ipc /
  webhook.github.
- **Decider abstraction.** Three modes: Wire (interactive / production),
  Manual (operator popup), Local RPC (CI / Playwright tests). Same
  request/response shape across all three.
- **Multi-wallet vault.** N named wallets in one extension instance.
  Encrypted at rest. Per-wallet decider config.
- **Popup-free agent path.** Agent decisions go through Wire, not
  through extension UI. User-facing UI exists separately for manual
  inspection + key export.

## Status

v0.1.0 — scaffolding. Not yet functional. See `agiterra/architecture`
for the design + scope.

## Loading the extension

Once built:

```bash
bun install
bun run build
# Then in Chrome: chrome://extensions → Developer mode → Load unpacked → select dist/
```

Or for active development:

```bash
bun run watch  # rebuilds on src/ changes; refresh extension in chrome://extensions
```
