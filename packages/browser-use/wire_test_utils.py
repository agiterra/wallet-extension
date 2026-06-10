#!/usr/bin/env python
"""Shared e2e harness utilities for the ENG-3313 browser-use wallet tests
(pertab_test.py, persist_switch_test.py): a tiny localhost page server, Wire-DB
(~/.wire/wire.db) polling, and the create/bind/sign helpers — parametrized by
`vault_id` so each test drives its own instance.

Kept OUT of wire_admin.py (the Wire HTTP client) on purpose: these are test-only
and read the Wire server's sqlite DB directly, which is not a client concern.
"""
import asyncio
import http.server
import json
import os
import socketserver
import sys
import threading
import uuid
from sqlite3 import Connection, connect

from eth_account import Account
from eth_account.messages import encode_defunct

from launcher import provision_vault_identity, WIRE_URL_KEY
import wire_admin as wa

DB = os.path.expanduser("~/.wire/wire.db")
PAGE = b"<!doctype html><meta charset=utf-8><title>eng-3313</title><body>eng-3313</body>"


class PageHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(PAGE)
    # silence per-request access logging
    def log_message(self, *_):
        pass


def load_env():
    """Read the agent's Wire creds from the environment; exit(2) if missing.
    Returns (wire_url, agent_id, agent_private_key)."""
    wire_url = os.environ.get("WIRE_URL", "http://localhost:9800")
    me = os.environ.get("AGENT_ID")
    key = os.environ.get("AGENT_PRIVATE_KEY")
    if not me or not key:
        print("AGENT_ID / AGENT_PRIVATE_KEY required")
        sys.exit(2)
    return wire_url, me, key


def start_page_server():
    """Start a localhost page server on an ephemeral port; return (httpd, url).
    Caller must httpd.shutdown() when done."""
    httpd = socketserver.TCPServer(("127.0.0.1", 0), PageHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


def _ro() -> Connection:
    return connect(f"file:{DB}?mode=ro", uri=True)


def max_seq() -> int:
    """Highest message sequence number currently in the Wire DB (a watermark we
    poll past when waiting for the next sign request)."""
    c = _ro(); v = c.execute("SELECT MAX(seq) FROM messages").fetchone()[0] or 0; c.close(); return v


def find_request_id(payload):
    """Recursively pull the first string `request_id` out of a nested Wire message
    payload, or None if absent."""
    if isinstance(payload, dict):
        if isinstance(payload.get("request_id"), str):
            return payload["request_id"]
        for v in payload.values():
            r = find_request_id(v)
            if r:
                return r
    return None


async def next_sign_request(agent: str, after_seq: int, timeout_s: float = 30.0):
    """Wait for a new wallet.sign.request directed at `agent`; return (seq, request_id)."""
    for _ in range(int(timeout_s * 4)):
        c = _ro()
        row = c.execute(
            "SELECT seq, payload FROM messages WHERE dest=? AND topic LIKE '%wallet.sign.request%' AND seq>? ORDER BY seq LIMIT 1",
            (agent, after_seq),
        ).fetchone()
        c.close()
        if row:
            return row[0], find_request_id(json.loads(row[1]))
        await asyncio.sleep(0.25)
    return None, None


async def wait_connected(agent: str, timeout_s: float = 25.0) -> bool:
    """Wait until `agent` has an open SSE session — create/claim/sign publishes
    sent before it connects aren't delivered (no live subscriber)."""
    for _ in range(int(timeout_s * 2)):
        c = _ro()
        row = c.execute("SELECT 1 FROM agent_sessions WHERE agent_id=? AND status='connected' LIMIT 1", (agent,)).fetchone()
        c.close()
        if row:
            return True
        await asyncio.sleep(0.5)
    return False


async def provision_register_connect(h, wire_url, me, key, vault_id, display_name):
    """Provision the launched instance's Wire identity under `vault_id`, sponsor-
    register it (signing as `me`), seed the wire-url, and wait for it to connect.
    Returns the provisioned identity dict."""
    ident = await provision_vault_identity(h.cdp, h.extension_id, vault_id, decider_target=me)
    pub = wa.derive_pubkey_b64(ident["privateKeyB64"])
    status = wa.sponsor_register(wire_url, me, key, vault_id, pub, display_name, force_rotate=True)["status"]
    assert status in (200, 201), f"sponsor_register({vault_id}) failed: {status}"
    await h.cdp.seed_storage(h.extension_id, {WIRE_URL_KEY: wire_url})
    assert await wait_connected(vault_id), f"{vault_id} never opened its Wire session"
    return ident


async def create_and_get(wire_url, me, key, vault_id, name, total_s=45):
    """(Re)publish wallet_create until `name` lands in the vault directory; return
    its address, or None on timeout. Re-publishing is safe — duplicate names are
    rejected by the extension; SSE replay right after connect can drop a single
    publish, so we retry every few seconds."""
    last_pub = -100
    for i in range(total_s):
        if i - last_pub >= 4:
            wa.wallet_create(wire_url, me, key, vault_id, str(uuid.uuid4()), name)
            last_pub = i
        for addr, meta in wa.get_directory(wire_url, vault_id).items():
            if (meta or {}).get("name") == name:
                # let the SW's in-memory directory absorb the update before returning
                await asyncio.sleep(2.0)
                return addr
        await asyncio.sleep(1.0)
    return None


async def bind_and_sign(h, me, key, wire_url, vault_id, sid, tab_id, addr, msg, tries=5):
    """Bind tab_id -> addr (re-publish to absorb SSE lag — a refused claim silently
    falls back to wallets[0]), then personal_sign + approve, and return the
    recovered signer address."""
    for _ in range(tries):
        wa.wallet_use(wire_url, me, key, vault_id, tab_id, addr)
        await asyncio.sleep(1.0)
    base = max_seq()
    task = asyncio.create_task(h.cdp.eth_request(sid, "personal_sign", [msg, addr]))
    _, req_id = await next_sign_request(me, base)
    if not req_id:
        # cancel the still-pending sign so a failed run gives a clean traceback
        task.cancel()
        raise AssertionError(f"no sign.request seen (addr={addr})")
    wa.wallet_approve(wire_url, me, key, vault_id, req_id)
    sig = await task
    assert sig.get("ok"), f"personal_sign failed: {sig}"
    return Account.recover_message(encode_defunct(text=msg), signature=sig["result"])
