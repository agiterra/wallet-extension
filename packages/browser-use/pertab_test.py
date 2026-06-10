#!/usr/bin/env python
"""
ENG-3313 — prove PER-TAB WALLET BINDING end to end, fully automated.

One browser, TWO wallets ("seller", "buyer"), TWO tabs. Each tab is bound to a
different wallet via the new agiterra_getTabId -> wallet_use. A personal_sign in
each tab must route to and sign with THAT tab's wallet:

  1. launch + provision the instance ('wallet-vault-3313') + sponsor-register + connect
  2. wallet_create seller + buyer (signed Wire publishes; creator=canele -> in access)
  3. open tab A and tab B; read each tab's Chrome tab id (agiterra_getTabId)
  4. wallet_use(tabA->seller), wallet_use(tabB->buyer)
  5. personal_sign in each tab; approve (canele is the tab-claim agent + decider target)
  6. VERIFY each signature recovers to its tab's wallet, and the two differ

Env: AGENT_ID, AGENT_PRIVATE_KEY, WIRE_URL.  Run: python pertab_test.py
"""
import asyncio
import http.server
import json
import os
import socketserver
import sqlite3
import sys
import threading
import uuid

from eth_account import Account
from eth_account.messages import encode_defunct

from launcher import launch_with_extension, provision_vault_identity, WIRE_URL_KEY
import wire_admin as wa

VAULT_ID = "wallet-vault-3313"
NONCE = uuid.uuid4().hex[:6]
WALLETS = {"seller": f"seller-{NONCE}", "buyer": f"buyer-{NONCE}"}
MSG = {"seller": "ENG-3313 seller tab — list property", "buyer": "ENG-3313 buyer tab — buy property"}
DB = os.path.expanduser("~/.wire/wire.db")
_PAGE = b"<!doctype html><meta charset=utf-8><title>pertab</title><body>eng-3313</body>"


class _H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(_PAGE)
    def log_message(self, *_): pass


def _ro():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def _max_seq() -> int:
    c = _ro(); v = c.execute("SELECT MAX(seq) FROM messages").fetchone()[0] or 0; c.close(); return v


def _find_request_id(obj):
    if isinstance(obj, dict):
        if isinstance(obj.get("request_id"), str):
            return obj["request_id"]
        for v in obj.values():
            r = _find_request_id(v)
            if r:
                return r
    return None


async def _next_sign_request(agent: str, after_seq: int, timeout_s: float = 30.0):
    """Wait for a new wallet.sign.request directed at `agent`; return (seq, request_id)."""
    for _ in range(int(timeout_s * 4)):
        c = _ro()
        row = c.execute(
            "SELECT seq, payload FROM messages WHERE dest=? AND topic LIKE '%wallet.sign.request%' AND seq>? ORDER BY seq LIMIT 1",
            (agent, after_seq),
        ).fetchone()
        c.close()
        if row:
            return row[0], _find_request_id(json.loads(row[1]))
        await asyncio.sleep(0.25)
    return None, None


async def _wait_connected(agent: str, timeout_s: float = 25.0) -> bool:
    """Wait until the instance has an open SSE session — create_requests
    published before it connects aren't delivered (no live subscriber)."""
    for _ in range(int(timeout_s * 2)):
        c = _ro()
        row = c.execute("SELECT 1 FROM agent_sessions WHERE agent_id=? AND status='connected' LIMIT 1", (agent,)).fetchone()
        c.close()
        if row:
            return True
        await asyncio.sleep(0.5)
    return False


async def _create_and_get(wire_url: str, me: str, key: str, name: str, total_s: int = 45):
    """(Re)publish wallet_create until the wallet lands in the directory. Right
    after connect the SSE stream may not be replaying yet, so a single publish
    can be dropped; re-publishing every few seconds is safe (duplicate names are
    rejected by the extension). Returns the address, or None on timeout."""
    last_pub = -100
    for i in range(total_s):
        if i - last_pub >= 4:
            wa.wallet_create(wire_url, me, key, VAULT_ID, str(uuid.uuid4()), name)
            last_pub = i
        for addr, meta in wa.get_directory(wire_url, VAULT_ID).items():
            if (meta or {}).get("name") == name:
                await asyncio.sleep(2.0)  # let the SW's in-memory directory absorb the update
                return addr
        await asyncio.sleep(1.0)
    return None


async def main() -> int:
    wire_url = os.environ.get("WIRE_URL", "http://localhost:9800")
    me = os.environ.get("AGENT_ID")
    key = os.environ.get("AGENT_PRIVATE_KEY")
    if not me or not key:
        print("AGENT_ID / AGENT_PRIVATE_KEY required"); return 2

    httpd = socketserver.TCPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"

    h = await launch_with_extension(headless="new")
    out = {"vault_id": VAULT_ID}
    try:
        # 1) provision + sponsor-register + connect (decider-target=me as a safety net)
        ident = await provision_vault_identity(h.cdp, h.extension_id, VAULT_ID, decider_target=me)
        pub = wa.derive_pubkey_b64(ident["privateKeyB64"])
        assert wa.sponsor_register(wire_url, me, key, VAULT_ID, pub, "Wallet Vault (3313)", force_rotate=True)["status"] in (200, 201)
        await h.cdp.seed_storage(h.extension_id, {WIRE_URL_KEY: wire_url})
        assert await _wait_connected(VAULT_ID), "instance never opened its Wire session"
        print(f"[3313] connected as {VAULT_ID}")

        # 2) create the two wallets SEQUENTIALLY (re-publish until each lands, and
        # confirm seller before buyer to avoid a directory-overwrite race). Per-tab
        # claim overrides wallets[0], so no vault-clear is needed.
        addrs = {}
        for role, name in WALLETS.items():
            addrs[role] = await _create_and_get(wire_url, me, key, name)
            assert addrs[role], f"wallet '{name}' never appeared"
            print(f"[3313] created {role}: {addrs[role]} ({name})")
        assert addrs["seller"].lower() != addrs["buyer"].lower()

        # 3) open two tabs, read each tab's Chrome tab id via the new method
        sids, tabids = {}, {}
        for role in WALLETS:
            sid = await h.cdp.open_page(url)
            r = await h.cdp.eth_request(sid, "agiterra_getTabId", [])
            assert r.get("ok") and r.get("result") is not None, f"agiterra_getTabId failed: {r}"
            sids[role], tabids[role] = sid, r["result"]
            print(f"[3313] {role} tab -> Chrome tab id {tabids[role]}")
        assert tabids["seller"] != tabids["buyer"]

        # 4) bind each tab to its wallet. Re-publish — the claim is refused unless
        # the SW's in-memory directory already has the wallet, so retry to absorb
        # SSE lag (a refused claim silently falls back to wallets[0]).
        for _ in range(4):
            for role in WALLETS:
                wa.wallet_use(wire_url, me, key, VAULT_ID, tabids[role], addrs[role])
            await asyncio.sleep(1.0)

        # 5) + 6) sign in each tab; approve; verify recovery to THAT tab's wallet
        results = {}
        for role in WALLETS:
            base = _max_seq()
            task = asyncio.create_task(h.cdp.eth_request(sids[role], "personal_sign", [MSG[role], addrs[role]]))
            _, req_id = await _next_sign_request(me, base)
            assert req_id, f"no sign.request seen for {role}"
            wa.wallet_approve(wire_url, me, key, VAULT_ID, req_id)
            sig = await task
            assert sig.get("ok"), f"{role} personal_sign failed: {sig}"
            recovered = Account.recover_message(encode_defunct(text=MSG[role]), signature=sig["result"])
            ok = recovered.lower() == addrs[role].lower()
            results[role] = {"recovered": recovered, "expected": addrs[role], "match": ok}
            print(f"[3313] {role}: sig recovers to {recovered} — {'MATCH' if ok else 'MISMATCH'}")
        out["results"] = results
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
