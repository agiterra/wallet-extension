# ENG-3313 — wrap-up (canele-2947)

Browser-use wallet: per-tab binding + persistent agent-wallet roster. ENG-2947 follow-on. Shipped end-to-end 2026-06-10.

## What shipped (PR #3, merged → main @ 51bce152, rolled out as v0.4.0)
- **Per-tab binding:** `agiterra_getTabId` exposes Chrome's `sender.tab.id` (self-scoped) so `wallet_use({tab_id, wallet})` binds a wallet to a specific tab.
- **Persistent agent-wallet roster:** per-key wallet directory (`wallet:<lowercase-addr>` per entry) with legacy-blob dual-read merge (per-key wins), matching wallet-tools v0.3.0 / wallet-claude-code v0.8.0. `creator` = provenance only, never ownership; no operator/human wallets.
- **Idempotent + serialized creates:** persisted processed-`request_id` dedup + a single promise-chain serializer so the Wire reconnect-backlog replay no longer re-mints or drops wallets.
- **Persistent browser-use profile:** stable `user_data_dir` (browser-use sentinel-prefixed) — vault + Wire identity survive restarts; FV no longer needs the vault-clear step.

## Verification
- Self-review gate: all 10 specialty seats PASS (12 rounds + 1 adjudication pass + 1 focused 5-seat verify, under the ED 8-round circuit breaker).
- FV (real flows: browser-use → prod WireDecider → Wire): pertab (two tabs → two wallets → two sigs) + persist (8/8 incl `no_dupe_mints`, `no_dupe_after_restart`, `sign_after_restart`).
- **Post-rollout staging verification:** both FVs PASS against the live rolled-out v0.4.0 artifact (`packages/prod/dist`, `background.js` sha256 `65d59a56…`, gateway wire#30), verified **as-is** — dist sha identical pre/post (no rebuild).

## Postmortem digest — three concurrency bugs caught pre-merge (one failure family)
Common root: the **persistent profile turned an ephemeral system durable**, exposing that **Wire reconnect-backlog replay + non-atomic `chrome.storage` read-modify-writes + fire-and-forget SSE dispatch** combine to silently re-mint or drop wallets — the exact integrity property the persistent roster needs.
1. **Check-then-act race (R7):** async `isCreateProcessed()`→mint under fire-and-forget; two duplicate frames both pass the check before either marks → double-mint.
2. **RMW lost-update (R10):** `markCreateProcessed` and the vault commit are non-atomic `chrome.storage` RMWs; under backlog replay two distinct creates interleave and the second `set()` clobbers the first → lost `request_id` re-minted / dropped vault key. (Same shape as the blob-clobber Fondant found on the Wire directory — `chrome.storage` has no transactions.) **Fix:** serialize all create handling through one promise chain (`tail`) → `check→mint→mark→commit` atomic per create; subsumes the R7 guard.
3. **Post-commit mark mis-placement (R11):** the best-effort refactor left `markCreateProcessed` between the commit and the best-effort try; a mark storage-failure replied `ok:false` for a committed wallet AND left it unmarked → re-mint on replay. **Fix:** mark-first inside the best-effort block (swallow + warn).

Each fix has a dedicated regression test.

**Incident-rule exemplar:** post-merge the merge was verified independently via `gh` (`state=MERGED`, `mergedBy.is_bot:false` = Tim, merge commit = `origin/main` head, branch tip an ancestor) rather than trusting a relayed "Tim merged" claim — the standard under the Fede-compromise rule.

## Deferred follow-ups (next PR cycle / arch)
- **Cross-instance SHARED pool** (one pool across Tim's Chrome + browser-use) collides with Wire's `namespace==writer` auth model — needs a Tim/Brioche **arch pass** (operator-mediated policy writes, a canonical `wallet-vault` writer, or a wire-server auth relax).
- **Configurable wire-mode decider timeout:** the 60s window is too tight for live cross-agent agent approval (the ENG-2947 finding) — make it configurable/per-wallet.
- **Boot reseed-clobber hardening:** `WalletDirectory.refresh()` should signal a non-404 failure so the boot seed skips on a transient error (today it can re-seed `creator:operator` over agent-owned per-key entries). Pre-existing.
- **Per-tab-binding + persistent-roster queue items** carried into the next PR cycle as iteration on this foundation.
- **Fondant's Wire-dashboard Vaults panel** (his design call; C-then-B) — read-shape rides the cross-instance-sharing decision.
