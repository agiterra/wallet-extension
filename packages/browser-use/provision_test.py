#!/usr/bin/env python
"""
Proves the configurable-vault-id path (ENG-2947) WITHOUT touching Wire:
launch → provision_vault_identity('wallet-vault-e2e') → the extension re-mints
its Wire identity under the seeded id. No wire-url is seeded, so the connect
loop stays inert (nothing registers) — this isolates the extension's
wire-identity.ts change + the launcher's seed/reload ordering.

Run:
    bun run build:prod
    cd packages/browser-use && python provision_test.py
"""
import asyncio
import json
import sys

from launcher import launch_with_extension, provision_vault_identity

VAULT_ID = "wallet-vault-e2e"


async def main() -> int:
    h = await launch_with_extension(headless="new")
    try:
        before = await h.cdp.read_storage(h.extension_id, ["agiterra-wallet-extension-wire-identity"])
        ident = await provision_vault_identity(h.cdp, h.extension_id, VAULT_ID, decider_target="fondant")
        result = {
            "minted_default_first": before.get("agiterra-wallet-extension-wire-identity", {}).get("agentId"),
            "after_provision": ident.get("agentId"),
        }
    finally:
        await h.cdp.close()
        await h.session.stop()

    ok = result["after_provision"] == VAULT_ID and result["minted_default_first"] == "wallet-vault"
    print(json.dumps(result, indent=2))
    print("VERDICT:", "PASS ✅" if ok else "FAIL ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
