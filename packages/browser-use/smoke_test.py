#!/usr/bin/env python
"""
Load-path smoke test for ENG-2947 — proves the launcher loads the EXISTING
prod Agiterra Wallet extension into browser-use and that it (1) boots its MV3
service worker and (2) injects window.ethereum (AgiterraEthereumProvider) on a
normal page. No Wire, no signing, no LLM — just the load-path.

Run:
    bun run build:prod                       # from repo root → packages/prod/dist
    cd packages/browser-use && python smoke_test.py [headful]
"""
import asyncio
import http.server
import json
import socketserver
import sys
import threading

from launcher import launch_with_extension, extension_id_for, PROD_DIST

_PAGE = b"<!doctype html><meta charset=utf-8><title>smoke</title><body>agiterra wallet smoke</body>"


class _H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(_PAGE)

    def log_message(self, *_):
        pass


async def main() -> int:
    headless = "new" if (len(sys.argv) < 2 or sys.argv[1] != "headful") else False

    httpd = socketserver.TCPServer(("127.0.0.1", 0), _H)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    test_url = f"http://127.0.0.1:{port}/"

    results: dict = {"expected_ext_id": extension_id_for(PROD_DIST)}
    h = await launch_with_extension(headless=headless)
    try:
        results["launched"] = bool(h.cdp_url)
        results["service_worker_ext_id"] = h.extension_id

        # open a page, navigate, check window.ethereum
        t = await h.cdp.call("Target.createTarget", {"url": test_url})
        att = await h.cdp.call("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
        sid = att["sessionId"]
        await h.cdp.call("Page.enable", {}, sid)
        await h.cdp.call("Runtime.enable", {}, sid)
        await asyncio.sleep(1.5)  # let the content script inject inpage.js
        ev = await h.cdp.call("Runtime.evaluate", {
            "expression": "JSON.stringify({has:!!window.ethereum,isAgiterra:!!(window.ethereum&&window.ethereum.isAgiterraWallet),isMM:!!(window.ethereum&&window.ethereum.isMetaMask)})",
            "returnByValue": True,
        }, sid)
        results["window_ethereum"] = json.loads(ev["result"]["value"])
    finally:
        try:
            await h.cdp.close()
        finally:
            await h.session.stop()
            httpd.shutdown()

    ok = bool(
        results.get("launched")
        and results.get("service_worker_ext_id") == results["expected_ext_id"]
        and results.get("window_ethereum", {}).get("isAgiterra")
    )
    print(json.dumps(results, indent=2))
    print("VERDICT:", "PASS ✅" if ok else "FAIL ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
