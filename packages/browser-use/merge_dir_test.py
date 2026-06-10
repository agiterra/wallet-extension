#!/usr/bin/env python
"""Unit test for wire_admin.merge_wallet_directory (ENG-3313 dual-read port of
wallet-tools mergeWalletDirectory). Pure function — no browser/Wire needed.
Run: python merge_dir_test.py"""
import sys

from wire_admin import merge_wallet_directory

A = "0x" + "a" * 40
B = "0x" + "b" * 40


def meta(name, creator="agent-x"):
    return {"name": name, "creator": creator, "created_at": 1, "chain_id": 11155111,
            "access": {"mode": "specific", "agents": [creator]}}


def main() -> int:
    # legacy blob only
    assert merge_wallet_directory({"wallets": {A: meta("legacy")}}) == {A: meta("legacy")}
    # per-key only
    assert merge_wallet_directory({f"wallet:{A}": meta("perkey")}) == {A: meta("perkey")}
    # per-key WINS over legacy for the same address; a legacy-only address survives
    out = merge_wallet_directory({"wallets": {A: meta("legacy"), B: meta("b-legacy")}, f"wallet:{A}": meta("perkey")})
    assert out[A]["name"] == "perkey" and out[B]["name"] == "b-legacy" and len(out) == 2, out
    # malformed per-key value, unrelated key, and non-dict legacy are all skipped
    assert merge_wallet_directory({"__vault_meta": {"x": 1}, f"wallet:{A}": {"bad": True}, "wallets": "nope"}) == {}
    # uppercase address in the per-key key normalizes to lowercase
    assert merge_wallet_directory({f"wallet:{A.upper()}": meta("up")}) == {A: meta("up")}
    # empty namespace -> empty directory
    assert merge_wallet_directory({}) == {}
    print("merge_wallet_directory: ALL PASS ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
