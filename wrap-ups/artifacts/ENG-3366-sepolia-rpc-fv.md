# ENG-3366 Sepolia RPC default FV

Branch: `chausson/eng-3366-sepolia-rpc-default`

## Local checks

```text
bun test packages/core/test/processed-creates.test.ts packages/core/src/sign.test.ts packages/core/test/sign-tx.test.ts
8 pass
0 fail
16 expect() calls
```

```text
bun test
PASS (full wallet-extension suite)
```

```text
bun run build
@agiterra/wallet-extension build: Exited with code 0
@agiterra/wallet-extension-ci build: Exited with code 0
```

## Fresh-profile Sepolia broadcast FV

Setup:

- Fresh Playwright persistent browser profile.
- Built prod extension loaded from `packages/prod/dist`.
- No manual write to `agiterra-wallet-extension-rpc-urls`.
- Funded Sepolia key imported into the fresh profile vault with the existing local-RPC decider.
- Local approve-all decider already listening on `http://127.0.0.1:54321`.

Observed storage before broadcast:

```json
{
  "11155111": "https://ethereum-sepolia-rpc.publicnode.com"
}
```

Successful `eth_sendTransaction` result:

```json
{
  "address": "0xbf03076547a99857b796717faf4034dea94569df",
  "accounts": [
    "0xbf03076547a99857b796717faf4034dea94569df"
  ],
  "txHash": "0xb14737a7c6b85bffdc77498f6e99f423ae758086b8f9feba8e7202a083e42a52",
  "pendingNonceBefore": 415,
  "pendingNonceAfter": 416,
  "nonceDelta": 1,
  "txNonce": 415,
  "receiptBlock": "0xad9e7d",
  "receiptStatus": "0x1"
}
```

Secondary investigation:

- Extension-side provider bridge rejects immediately with the JSON-RPC error it receives; no retry loop found in `packages/core/src/inpage.ts` or `packages/core/src/content-script.ts`.
- Narrow source search in `soil-app` for `eth_sendTransaction` and `-32603` found no direct dApp-side swallow/retry handler to patch in this PR.
