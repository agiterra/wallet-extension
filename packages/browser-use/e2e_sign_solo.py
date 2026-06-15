#!/usr/bin/env python
"""
ENG-3326 — the Agiterra-wallet FV loop under browser-use, SELF-CONTAINED.

Proves what Chrome MCP + embedded (Dynamic WaaS) wallets cannot: an agent-driven
EIP-6963 wallet the harness fully controls, with BOTH a happy-path signature and
a forced custom-error rejection — all in one Python process, no second agent and
no MCP round-trip. The harness IS the decider (decider-target = its own Wire id),
so the 60s WireDecider window is never a factor (the ENG-2947 inter-agent-latency
finding). Coexists with a live Chrome `wallet-vault` via a distinct vault id
(provision_vault_identity), so it never 409-collides with another instance.

  1. launch browser-use Chromium + the prod extension (fresh v0.4.x dist load)
  2. provision the instance under a distinct vault id + sponsor-register (self) + connect
  3. wallet_create a fresh EOA in this vault (Wire-direct; no MCP)
  4. open a tab, bind it, personal_sign -> APPROVE -> recover == the EOA  (happy path)
  5. personal_sign again -> REJECT with a custom JSON-RPC error -> the page's
     request() promise rejects with EXACTLY that {code, message}  (error path)

Env: AGENT_ID, AGENT_PRIVATE_KEY, WIRE_URL (the sponsor identity — also the
decider). Optional: E2E_VAULT_ID (default wallet-vault-<AGENT_ID>).

Run:
    bun run build:prod
    cd packages/browser-use && python e2e_sign_solo.py
"""
import asyncio
import os
import sys
import uuid

from launcher import launch_with_extension
import wire_test_utils as tu

NONCE = uuid.uuid4().hex[:6]
HAPPY_MSG = "ENG-3326 browser-use FV — happy-path personal_sign"
REJECT_MSG = "ENG-3326 browser-use FV — forced rejection"
# A deliberately non-standard JSON-RPC error code, matching the Chrome-MCP proof.
REJECT_CODE = 4900
REJECT_TEXT = "ENG-3326 FV: forced signature rejection (custom error path)"


async def main() -> int:
    wire_url, me, key = tu.load_env()
    vault_id = os.environ.get("E2E_VAULT_ID", f"wallet-vault-{me}")
    httpd, url = tu.start_page_server()
    h = await launch_with_extension(headless="new")
    out: dict = {"vault_id": vault_id}
    try:
        # 2) provision under a distinct id + sponsor-register (self) + connect.
        #    decider-target = me, so sign requests route back to this process.
        await tu.provision_register_connect(h, wire_url, me, key, vault_id, f"Wallet Vault ({me})")
        print(f"[3326] connected as {vault_id} (decider-target={me})")

        # 3) mint a fresh EOA in this vault, Wire-direct (no MCP dependency).
        name = f"eng-3326-{NONCE}"
        addr = await tu.create_and_get(wire_url, me, key, vault_id, name)
        assert addr, f"wallet '{name}' never appeared in {vault_id}"
        out["wallet"] = addr
        print(f"[3326] created wallet {addr} ({name})")

        # 4) HAPPY PATH — bind a tab, personal_sign, self-approve, recover.
        sid = await h.cdp.open_page(url)
        tab = (await h.cdp.eth_request(sid, "agiterra_getTabId", []))["result"]
        recovered = await tu.bind_and_sign(h, me, key, wire_url, vault_id, sid, tab, addr, HAPPY_MSG)
        happy_ok = recovered.lower() == addr.lower()
        out["happy"] = {"recovered": recovered, "expected": addr, "match": happy_ok}
        print(f"[3326] happy-path sig recovers to {recovered} — {'MATCH' if happy_ok else 'MISMATCH'}")

        # 5) ERROR PATH — same tab, personal_sign, reject with a custom error;
        #    the page must reject with exactly that code+message.
        err = await tu.bind_and_reject(
            h, me, key, wire_url, vault_id, sid, tab, addr, REJECT_MSG, REJECT_CODE, REJECT_TEXT,
            data={"smoke": "eng-3326", "decider": me},
        )
        reject_ok = err.get("code") == REJECT_CODE and err.get("message") == REJECT_TEXT
        out["reject"] = {"observed": err, "expected_code": REJECT_CODE, "match": reject_ok}
        print(f"[3326] error-path page error: {err} — {'MATCH' if reject_ok else 'MISMATCH'}")
    finally:
        try:
            await h.cdp.close()
        finally:
            await h.session.stop()
            httpd.shutdown()

    import json
    print(json.dumps(out, indent=2))
    ok = out.get("happy", {}).get("match") and out.get("reject", {}).get("match")
    print("[3326] VERDICT:", "PASS ✅ happy-path sig + forced custom-error reject, under browser-use" if ok else "FAIL ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
