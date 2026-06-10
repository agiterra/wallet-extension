#!/usr/bin/env python
"""
ENG-3313 — prove PER-TAB WALLET BINDING end to end, fully automated.

One browser, TWO wallets ("seller", "buyer"), TWO tabs. Each tab is bound to a
different wallet via the new agiterra_getTabId -> wallet_use. A personal_sign in
each tab must route to and sign with THAT tab's wallet:

  1. launch + provision the instance ('wallet-vault-3313') + sponsor-register + connect
  2. wallet_create seller + buyer (signed Wire publishes; creator=canele -> in access)
  3. open tab A and tab B; read each tab's Chrome tab id (agiterra_getTabId)
  4. bind tabA->seller, tabB->buyer and personal_sign in each (bind_and_sign)
  5. VERIFY each signature recovers to its tab's wallet, and the two differ

Shared Wire-DB polling + create/bind/sign helpers live in wire_test_utils.

Env: AGENT_ID, AGENT_PRIVATE_KEY, WIRE_URL.  Run: python pertab_test.py
"""
import asyncio
import sys
import uuid

from launcher import launch_with_extension
import wire_test_utils as tu

NONCE = uuid.uuid4().hex[:6]
# fresh namespace per run — no cross-run create_request replay backlog
VAULT_ID = f"wallet-vault-3313-{NONCE}"
WALLETS = {"seller": f"seller-{NONCE}", "buyer": f"buyer-{NONCE}"}
MSG = {"seller": "ENG-3313 seller tab — list property", "buyer": "ENG-3313 buyer tab — buy property"}


async def main() -> int:
    wire_url, me, key = tu.load_env()
    httpd, url = tu.start_page_server()
    h = await launch_with_extension(headless="new")
    results: dict = {}
    try:
        # 1) provision + sponsor-register + connect (decider-target=me as a safety net)
        await tu.provision_register_connect(h, wire_url, me, key, VAULT_ID, "Wallet Vault (3313)")
        print(f"[3313] connected as {VAULT_ID}")

        # 2) create the two wallets (re-publish until each lands). The per-key
        # `wallet:<addr>` write-path (ENG-3313) means concurrent creates touch
        # distinct keys and no longer race — we create one-at-a-time here only for
        # readable logging. Per-tab claim overrides wallets[0], so no vault-clear.
        addrs = {}
        for role, name in WALLETS.items():
            addrs[role] = await tu.create_and_get(wire_url, me, key, VAULT_ID, name)
            assert addrs[role], f"wallet '{name}' never appeared"
            print(f"[3313] created {role}: {addrs[role]} ({name})")
        assert addrs["seller"].lower() != addrs["buyer"].lower()

        # 3)+4)+5) open each tab, read its Chrome tab id, bind it to its wallet,
        # personal_sign, and verify the signature recovers to THAT tab's wallet.
        tabids = {}
        for role in WALLETS:
            sid = await h.cdp.open_page(url)
            r = await h.cdp.eth_request(sid, "agiterra_getTabId", [])
            assert r.get("ok") and r.get("result") is not None, f"agiterra_getTabId failed: {r}"
            tabids[role] = r["result"]
            print(f"[3313] {role} tab -> Chrome tab id {tabids[role]}")
            recovered = await tu.bind_and_sign(h, me, key, wire_url, VAULT_ID, sid, tabids[role], addrs[role], MSG[role])
            ok = recovered.lower() == addrs[role].lower()
            results[role] = {"recovered": recovered, "expected": addrs[role], "match": ok}
            print(f"[3313] {role}: sig recovers to {recovered} — {'MATCH' if ok else 'MISMATCH'}")
        assert tabids["seller"] != tabids["buyer"]
    finally:
        try: await h.cdp.close()
        finally:
            await h.session.stop(); httpd.shutdown()

    ok = (results["seller"]["match"] and results["buyer"]["match"]
          and results["seller"]["recovered"].lower() != results["buyer"]["recovered"].lower())
    print("\n[3313] VERDICT:", "PASS ✅ per-tab binding: two tabs signed with two different wallets" if ok else "FAIL ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
