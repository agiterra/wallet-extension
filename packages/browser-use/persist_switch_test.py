#!/usr/bin/env python
"""
ENG-3313 — prove (a) ROSTER-SWITCH signing and (b) ROSTER + VAULT PERSISTENCE
across a browser restart, on a PERSISTENT browser-use profile (no vault-clear).

PHASE 1 (launch #1, persistent profile):
  - provision instance 'wallet-vault-3313-persist' + sponsor-register + connect
  - wallet_create two roster wallets: alpha, beta
  - open ONE tab; bind tab -> alpha; personal_sign -> recovers alpha
  - SWITCH the same tab -> beta; personal_sign -> recovers beta   [roster-switch]
  - snapshot the vault addresses + the extension's Wire identity
  - stop the browser but KEEP the profile dir

PHASE 2 (launch #2, SAME profile, NO re-provision):
  - the SW boots from the persisted profile: same identity, vault is NOT empty
    (so NO dev-wallet bootstrap), and it reconnects to Wire on its own
  - assert: vault still holds alpha+beta; identity agentId unchanged; the
    roster (directory) still lists alpha+beta
  - open a NEW tab; bind -> alpha; personal_sign -> recovers alpha
    [the persisted wallet is usable after restart, no re-create — this is the
     "drop the FV vault-clear step" proof]

Shared Wire-DB polling + create/bind/sign helpers live in wire_test_utils.

Env: AGENT_ID, AGENT_PRIVATE_KEY, WIRE_URL.  Run: python persist_switch_test.py
"""
import asyncio
import json
import os
import sys
import uuid

from launcher import (
    launch_with_extension,
    create_persistent_profile_dir,
    provision_vault_identity,
    WIRE_URL_KEY,
    WIRE_IDENTITY_KEY,
    VAULT_KEY,
)
import wire_admin as wa
import wire_test_utils as tu

VAULT_ID = "wallet-vault-3313-persist"
NONCE = uuid.uuid4().hex[:6]
ALPHA, BETA = f"alpha-{NONCE}", f"beta-{NONCE}"


async def main() -> int:
    wire_url = os.environ.get("WIRE_URL", "http://localhost:9800")
    me = os.environ.get("AGENT_ID")
    key = os.environ.get("AGENT_PRIVATE_KEY")
    if not me or not key:
        print("AGENT_ID / AGENT_PRIVATE_KEY required"); return 2

    httpd, url = tu.start_page_server()
    profile = create_persistent_profile_dir("3313-persist")
    print(f"[persist] persistent profile: {profile}")
    checks: dict = {}

    # ---------------- PHASE 1 ----------------
    h = await launch_with_extension(headless="new", user_data_dir=profile)
    try:
        ident = await provision_vault_identity(h.cdp, h.extension_id, VAULT_ID, decider_target=me)
        pub = wa.derive_pubkey_b64(ident["privateKeyB64"])
        assert wa.sponsor_register(wire_url, me, key, VAULT_ID, pub, "Wallet Vault (3313 persist)", force_rotate=True)["status"] in (200, 201)
        await h.cdp.seed_storage(h.extension_id, {WIRE_URL_KEY: wire_url})
        assert await tu.wait_connected(VAULT_ID), "instance never connected (phase 1)"
        id1 = (await h.cdp.read_storage(h.extension_id, [WIRE_IDENTITY_KEY])).get(WIRE_IDENTITY_KEY, {})
        agent1 = id1.get("agentId")
        print(f"[persist] phase1 connected as {agent1}")

        a_addr = await tu.create_and_get(wire_url, me, key, VAULT_ID, ALPHA)
        b_addr = await tu.create_and_get(wire_url, me, key, VAULT_ID, BETA)
        assert a_addr and b_addr and a_addr.lower() != b_addr.lower(), "alpha/beta create failed"
        print(f"[persist] roster: alpha={a_addr} beta={b_addr}")

        sid = await h.cdp.open_page(url)
        r = await h.cdp.eth_request(sid, "agiterra_getTabId", [])
        assert r.get("ok") and r.get("result") is not None, f"getTabId failed: {r}"
        tab_id = r["result"]

        rec_a = await tu.bind_and_sign(h, me, key, wire_url, VAULT_ID, sid, tab_id, a_addr, "ENG-3313 persist — sign as ALPHA")
        checks["bind_alpha"] = rec_a.lower() == a_addr.lower()
        print(f"[persist] tab->alpha sig recovers {rec_a} — {'MATCH' if checks['bind_alpha'] else 'MISMATCH'}")

        # SWITCH the same tab to beta and sign again — proves roster switching.
        rec_b = await tu.bind_and_sign(h, me, key, wire_url, VAULT_ID, sid, tab_id, b_addr, "ENG-3313 persist — switch to BETA")
        checks["switch_beta"] = rec_b.lower() == b_addr.lower()
        print(f"[persist] tab->beta (switch) sig recovers {rec_b} — {'MATCH' if checks['switch_beta'] else 'MISMATCH'}")

        vault1 = (await h.cdp.read_storage(h.extension_id, [VAULT_KEY])).get(VAULT_KEY, [])
        print(f"[persist] phase1 vault has {len(vault1)} wallets; browser stopped, profile kept")
    finally:
        try: await h.cdp.close()
        finally: await h.session.stop()

    # ---------------- PHASE 2 (restart, SAME profile, no re-provision) ----------------
    h2 = await launch_with_extension(headless="new", user_data_dir=profile)
    try:
        # No provisioning: identity + wire-url + vault all persisted in the profile.
        assert await tu.wait_connected(VAULT_ID), "instance never reconnected (phase 2)"
        id2 = (await h2.cdp.read_storage(h2.extension_id, [WIRE_IDENTITY_KEY])).get(WIRE_IDENTITY_KEY, {})
        agent2 = id2.get("agentId")
        checks["identity_persisted"] = agent2 == agent1 and agent2 == VAULT_ID
        print(f"[persist] phase2 reconnected as {agent2} (== phase1 {agent1}: {checks['identity_persisted']})")

        vault2 = (await h2.cdp.read_storage(h2.extension_id, [VAULT_KEY])).get(VAULT_KEY, [])
        vault2_addrs = {w["address"].lower() for w in vault2}
        checks["vault_persisted"] = a_addr.lower() in vault2_addrs and b_addr.lower() in vault2_addrs
        print(f"[persist] phase2 vault has {len(vault2_addrs)} wallets; alpha+beta present: {checks['vault_persisted']}")

        roster = wa.get_directory(wire_url, VAULT_ID)
        checks["roster_persisted"] = a_addr.lower() in roster and b_addr.lower() in roster
        print(f"[persist] phase2 roster lists alpha+beta: {checks['roster_persisted']}")

        # The persisted wallet is usable after restart with NO re-create.
        sid2 = await h2.cdp.open_page(url)
        r2 = await h2.cdp.eth_request(sid2, "agiterra_getTabId", [])
        assert r2.get("ok") and r2.get("result") is not None, f"getTabId failed (phase2): {r2}"
        rec_a2 = await tu.bind_and_sign(h2, me, key, wire_url, VAULT_ID, sid2, r2["result"], a_addr, "ENG-3313 persist — sign after restart")
        checks["sign_after_restart"] = rec_a2.lower() == a_addr.lower()
        print(f"[persist] phase2 tab->alpha sig recovers {rec_a2} — {'MATCH' if checks['sign_after_restart'] else 'MISMATCH'}")
    finally:
        try: await h2.cdp.close()
        finally:
            await h2.session.stop(); httpd.shutdown()

    ok = all(checks.values())
    print("\n[persist] checks:", json.dumps(checks))
    print("[persist] VERDICT:", "PASS ✅ roster-switch + vault/roster persistence across restart" if ok else "FAIL ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
