#!/usr/bin/env python
"""
ENG-3313 — prove (a) ROSTER-SWITCH signing and (b) ROSTER + VAULT PERSISTENCE
across a browser restart, on a PERSISTENT browser-use profile (no vault-clear).

PHASE 1 (launch #1, persistent profile):
  - provision instance 'wallet-vault-3313-persist' + sponsor-register + connect
  - wallet_create two roster wallets: alpha, beta
  - open ONE tab; bind tab -> alpha; personal_sign -> recovers alpha
  - SWITCH the same tab -> beta; personal_sign -> recovers beta   [roster-switch]
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
import sys
import uuid

from launcher import (
    launch_with_extension,
    create_persistent_profile_dir,
    WIRE_IDENTITY_KEY,
    VAULT_KEY,
)
import wire_admin as wa
import wire_test_utils as tu

NONCE = uuid.uuid4().hex[:6]
VAULT_ID = f"wallet-vault-3313-persist-{NONCE}"  # fresh namespace per run — no cross-run replay backlog
ALPHA, BETA = f"alpha-{NONCE}", f"beta-{NONCE}"


async def _phase1(wire_url, me, key, url, profile):
    """Launch #1: provision + create alpha/beta + sign-as-alpha + switch-to-beta.
    Returns (a_addr, b_addr, agent1, checks)."""
    checks: dict = {}
    h = await launch_with_extension(headless="new", user_data_dir=profile)
    try:
        await tu.provision_register_connect(h, wire_url, me, key, VAULT_ID, "Wallet Vault (3313 persist)")
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
        names1 = [w["name"] for w in vault1]
        # idempotency (ENG-3313): create_request replays + harness retries must NOT
        # re-mint the same name at a new address
        checks["no_dupe_mints"] = len(names1) == len(set(names1))
        print(f"[persist] phase1 vault has {len(vault1)} wallets, no dupe names: {checks['no_dupe_mints']}; profile kept")
        return a_addr, b_addr, agent1, checks
    finally:
        try: await h.cdp.close()
        finally: await h.session.stop()


async def _phase2(wire_url, me, key, url, profile, a_addr, b_addr, agent1):
    """Launch #2 on the SAME profile (no re-provision): assert identity + vault +
    roster persisted, and a persisted wallet still signs. Returns checks."""
    checks: dict = {}
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
        return checks
    finally:
        try: await h2.cdp.close()
        finally: await h2.session.stop()


async def main() -> int:
    wire_url, me, key = tu.load_env()
    httpd, url = tu.start_page_server()
    profile = create_persistent_profile_dir("3313-persist")
    print(f"[persist] persistent profile: {profile}")
    try:
        a_addr, b_addr, agent1, checks = await _phase1(wire_url, me, key, url, profile)
        checks.update(await _phase2(wire_url, me, key, url, profile, a_addr, b_addr, agent1))
    finally:
        httpd.shutdown()

    ok = all(checks.values())
    print("\n[persist] checks:", json.dumps(checks))
    print("[persist] VERDICT:", "PASS ✅ roster-switch + vault/roster persistence across restart" if ok else "FAIL ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
