#!/usr/bin/env python
"""
ENG-2947 — prove the COEXISTENCE registration path live (steps 1-3 of the e2e),
solo, without Fondant or the operator:

  1. launch browser-use + the existing prod extension
  2. provision the instance's Wire identity as a NON-default vault id
     ('wallet-vault-e2e') — re-mint only, still inert (no wire-url yet)
  3. SPONSOR-register that id with the orchestrator's (canele's) Wire creds
  4. seed wire-url → the instance connects to Wire as 'wallet-vault-e2e',
     coexisting with any live 'wallet-vault' (Tim's Chrome) — no 409 collision

Then it verifies the new id is registered on Wire. Steps 4-6 of the full e2e
(Fondant wallet_create → personal_sign → Fondant approve) need his MCP
readDirectory(vault_id) + him as approver, and are NOT run here.

Env: AGENT_ID, AGENT_PRIVATE_KEY, WIRE_URL (the orchestrator/sponsor identity).

Run:
    bun run build:prod
    cd packages/browser-use && python e2e_connect.py
"""
import asyncio
import json
import os
import sys

from launcher import launch_with_extension, provision_vault_identity, WIRE_URL_KEY
from wire_admin import derive_pubkey_b64, sponsor_register, is_registered

VAULT_ID = "wallet-vault-e2e"
DISPLAY_NAME = "Wallet Vault (e2e)"
DECIDER_TARGET = "fondant"


async def main() -> int:
    wire_url = os.environ.get("WIRE_URL", "http://localhost:9800")
    sponsor_id = os.environ.get("AGENT_ID")
    sponsor_key = os.environ.get("AGENT_PRIVATE_KEY")
    if not sponsor_id or not sponsor_key:
        print("AGENT_ID / AGENT_PRIVATE_KEY required (the sponsor identity)")
        return 2

    out: dict = {"vault_id": VAULT_ID}
    h = await launch_with_extension(headless="new")
    try:
        # 2) re-mint under the e2e vault id (no wire-url → stays inert)
        ident = await provision_vault_identity(h.cdp, h.extension_id, VAULT_ID, decider_target=DECIDER_TARGET)
        out["minted_agent_id"] = ident.get("agentId")
        priv_b64 = ident.get("privateKeyB64")
        assert out["minted_agent_id"] == VAULT_ID and priv_b64, "re-mint did not take"

        # 3) sponsor-register the new id with the orchestrator's creds
        pubkey = derive_pubkey_b64(priv_b64)
        out["pubkey"] = pubkey
        # force_rotate: each fresh launch mints a new keypair; the previous
        # ephemeral instance under this id is already gone, so rotating its
        # registered key is safe (nothing live holds the old private key).
        reg = sponsor_register(wire_url, sponsor_id, sponsor_key, VAULT_ID, pubkey, DISPLAY_NAME, force_rotate=True)
        out["sponsor_register"] = reg
        assert reg["status"] in (200, 201), f"sponsor_register failed: {reg}"

        # 4) seed wire-url → instance self-registers (pubkey now matches) + opens
        # its SSE session. Give the connect loop (1s backoff) ample time before
        # we tear the browser down, so we can observe an actual connection.
        await h.cdp.seed_storage(h.extension_id, {WIRE_URL_KEY: wire_url})
        await asyncio.sleep(9)
        out["registered_on_wire"] = is_registered(wire_url, VAULT_ID)
    finally:
        await h.cdp.close()
        await h.session.stop()

    ok = out.get("minted_agent_id") == VAULT_ID and out.get("registered_on_wire") is True
    print(json.dumps(out, indent=2))
    print("VERDICT:", "PASS ✅" if ok else "FAIL ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
