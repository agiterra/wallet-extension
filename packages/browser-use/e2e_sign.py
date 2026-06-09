#!/usr/bin/env python
"""
ENG-2947 — the full single-signature e2e (steps 1-6). Run interactively WITH
Fondant (he supplies wallet_create + wallet_approve over Wire).

  1-4. launch → provision 'wallet-vault-e2e' → sponsor-register → connect
       (same as e2e_connect.py — proven).
  5.   wait for Fondant to wallet_create({name:'eng-2947-e2e',
       vault_id:'wallet-vault-e2e'}); poll the instance's directory until the
       wire-mode EOA appears, then read its address.
  6.   open a browser-use tab, eth_requestAccounts, then personal_sign — the
       WireDecider routes to Fondant (decider-target), he wallet_approve's, and
       the page receives the signature.

Needs wallet-claude-code v0.7.0 (readDirectory(vault_id)) so Fondant's
wallet_create lands in the 'wallet-vault-e2e' namespace, and Fondant online as
approver. Env: AGENT_ID, AGENT_PRIVATE_KEY, WIRE_URL.

Run:
    bun run build:prod
    cd packages/browser-use && python e2e_sign.py
"""
import asyncio
import json
import os
import sys

from launcher import launch_with_extension, provision_vault_identity, WIRE_URL_KEY, VAULT_KEY
from wire_admin import derive_pubkey_b64, sponsor_register, get_directory

VAULT_ID = "wallet-vault-e2e"
WALLET_NAME = "eng-2947-e2e"
DISPLAY_NAME = "Wallet Vault (e2e)"
DECIDER_TARGET = "fondant"
MESSAGE = "ENG-2947 browser-use e2e — Agiterra Wallet personal_sign"
WALLET_WAIT_S = 300  # generous window for the human/agent-in-the-loop wallet_create


async def main() -> int:
    wire_url = os.environ.get("WIRE_URL", "http://localhost:9800")
    sponsor_id = os.environ.get("AGENT_ID")
    sponsor_key = os.environ.get("AGENT_PRIVATE_KEY")
    if not sponsor_id or not sponsor_key:
        print("AGENT_ID / AGENT_PRIVATE_KEY required (the sponsor identity)")
        return 2

    h = await launch_with_extension(headless="new")
    try:
        # 1-4: provision + sponsor-register + connect
        ident = await provision_vault_identity(h.cdp, h.extension_id, VAULT_ID, decider_target=DECIDER_TARGET)
        pubkey = derive_pubkey_b64(ident["privateKeyB64"])
        reg = sponsor_register(wire_url, sponsor_id, sponsor_key, VAULT_ID, pubkey, DISPLAY_NAME, force_rotate=True)
        assert reg["status"] in (200, 201), f"sponsor_register failed: {reg}"
        await h.cdp.seed_storage(h.extension_id, {WIRE_URL_KEY: wire_url})
        # The extension auto-bootstraps a local-rpc "dev-wallet" as wallets[0];
        # getActiveWallet defaults to wallets[0], which would route personal_sign
        # to the dead local-rpc decider. Clear the vault so Fondant's wire-mode
        # e2e wallet becomes the SINGLE active wallet (the PR#1 sidestep).
        await h.cdp.seed_storage(h.extension_id, {VAULT_KEY: []})
        print(f"[e2e] instance connected as {VAULT_ID} (pubkey {pubkey}); vault cleared for single-active-wallet.")

        # 5: wait for Fondant's wallet_create to land a wallet in our namespace
        print(f"[e2e] >>> ping Fondant: wallet_create({{name:'{WALLET_NAME}', vault_id:'{VAULT_ID}'}})")
        print(f"[e2e] waiting up to {WALLET_WAIT_S}s for the wallet to appear in the {VAULT_ID} directory...")
        address = None
        for _ in range(WALLET_WAIT_S * 2):
            wallets = get_directory(wire_url, VAULT_ID)
            if wallets:
                # pick the wallet we asked Fondant to create, not an arbitrary entry
                address = next(
                    (a for a, m in wallets.items()
                     if (m or {}).get("name") == WALLET_NAME or (m or {}).get("operator_name") == WALLET_NAME),
                    next(iter(wallets)),
                )
                print(f"[e2e] wallet appeared: {address} ({wallets[address].get('name')})")
                break
            await asyncio.sleep(0.5)
        if not address:
            print("[e2e] FAIL: no wallet appeared (did Fondant wallet_create with the vault_id? is v0.7.0 deployed?)")
            return 1

        # 6: drive the signature (blocks on Fondant's wallet_approve)
        return await _drive_sign(h, address)
    finally:
        await h.cdp.close()
        await h.session.stop()


async def _drive_sign(h, address: str) -> int:
    import http.server, socketserver, threading
    page_bytes = b"<!doctype html><meta charset=utf-8><title>e2e</title><body>eng-2947 sign</body>"

    class _H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(page_bytes)
        def log_message(self, *_): pass

    httpd = socketserver.TCPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        sid = await h.cdp.open_page(f"http://127.0.0.1:{httpd.server_address[1]}/")
        accts = await h.cdp.eth_request(sid, "eth_requestAccounts", [])
        print(f"[e2e] eth_requestAccounts -> {accts}")
        print(f"[e2e] >>> driving personal_sign; ping Fondant to wallet_approve({{request_id, vault_id:'{VAULT_ID}'}})")
        sig = await h.cdp.eth_request(sid, "personal_sign", [MESSAGE, address])
        print("[e2e] personal_sign ->", json.dumps(sig))
        ok = bool(sig.get("ok") and isinstance(sig.get("result"), str) and sig["result"].startswith("0x") and len(sig["result"]) == 132)
        print("[e2e] VERDICT:", "PASS ✅ real 65-byte signature" if ok else "FAIL ❌")
        return 0 if ok else 1
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
