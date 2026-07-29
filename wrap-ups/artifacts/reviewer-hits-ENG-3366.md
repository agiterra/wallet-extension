# ENG-3366 Adversarial Reviewer Board

PR: https://github.com/agiterra/wallet-extension/pull/7

Initial reviewed head: `6b63a5c74277f113d64a4819b4304f3edf8d6d16`

Final reviewed code head before this artifact: `677b606`

Scope: full PR diff from `main`, including the Sepolia RPC bootstrap code, tests, and FV artifact.

## Board Seats

### TypeScript/API

Initial verdict: FAIL

Finding:

- `packages/core/src/background-core.ts:94`, `packages/core/src/vault-store.ts:149`, `packages/prod/src/options.ts:180`: default Sepolia RPC was re-seeded on every service-worker start if absent, so options-page removal was not sticky.

Fix:

- Added a one-time bootstrap marker, `agiterra-wallet-extension-default-rpc-bootstrapped`, so first-run seeding happens once and later operator removal stays removed.

Ratification: PASS

### Correctness

Initial verdict: FAIL

Finding:

- `packages/core/src/background-core.ts:92`: startup RPC seeding was detached after listener registration, so an immediate cold-start request could reach `getRpcUrl()` before the default URL write completed.

Fix:

- Created `startupBootstrap` and chained request handling through it before entering `handle()`.

Ratification: PASS

### Security

Initial verdict: FAIL

Finding:

- `packages/core/src/background-core.ts:92-95`, `packages/core/src/vault-store.ts:137-154`: automatic re-seeding could silently restore trust in the public Sepolia RPC after an operator attempted to opt out.

Fix:

- The one-time marker provides a durable removal/opt-out path while retaining first-run safety.

Ratification: PASS

### Test Coverage

Initial verdict: PASS on the original diff; RATIFY FAIL after the first fix-set because the marker behavior itself was not directly covered.

Finding:

- The original FV artifact stays valid for the broadcast bar but did not prove marker persistence or no-reseed-after-removal behavior.

Fix:

- Added focused unit tests that call `bootstrapDefaultDevChainRpcUrl()` with mocked `chrome.storage.local`, proving both first-run marker/RPC write and marker-honored no-reseed behavior.

Ratification: PASS

### Scope/Regression

Initial verdict: FAIL

Finding:

- `packages/core/src/background-core.ts:92`, `packages/core/src/vault-store.ts:148`, `packages/prod/src/options.ts:176`: default re-seeding regressed the existing Networks remove workflow.

Fix:

- One-time marker limits the default to bootstrap behavior and preserves later options-page removal.

Ratification: PASS

## Fix Commits

- `728ae74` - Honor one-time Sepolia RPC bootstrap.
- `677b606` - Cover Sepolia RPC bootstrap marker.

## Final Validation

```text
bun test packages/core/test/processed-creates.test.ts packages/core/src/sign.test.ts packages/core/test/sign-tx.test.ts
11 pass
0 fail
24 expect() calls
```

```text
bun test
PASS
```

```text
bun run build
@agiterra/wallet-extension build: Exited with code 0
@agiterra/wallet-extension-ci build: Exited with code 0
```

FV evidence remains in `wrap-ups/artifacts/ENG-3366-sepolia-rpc-fv.md`:

- Fresh profile.
- No manual RPC config.
- Auto-seeded Sepolia RPC.
- Real Sepolia broadcast `0xb14737a7c6b85bffdc77498f6e99f423ae758086b8f9feba8e7202a083e42a52`.
- Nonce `415 -> 416`, receipt status `0x1`.
