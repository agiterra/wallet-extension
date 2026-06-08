"""
Launch a browser-use Chromium with the EXISTING prod Agiterra Wallet
extension loaded, and (optionally) seed the extension's chrome.storage.local
config before it connects to Wire.

Why this exists: the extension already injects window.ethereum and signs via
Wire (see core/src/inpage.ts, prod/src/decider-wire.ts). ENG-2947 only needs
to LOAD it into browser-use's browser and bind the session — not reimplement a
provider. See README.md for the (load-bearing) gotchas.

No browser-use Agent / LLM is used here — only its browser layer
(BrowserSession/BrowserProfile). Verification + config-seeding go over raw CDP
on the browser websocket so we don't fight browser-use's high-level API.
"""

from __future__ import annotations

import asyncio
import glob
import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import websockets

# packages/browser-use/launcher.py → repo root is two parents up.
_REPO_ROOT = Path(__file__).resolve().parents[2]
PROD_DIST = _REPO_ROOT / "packages" / "prod" / "dist"


def find_chrome_for_testing() -> str:
    """Resolve a Chrome for Testing / Chromium binary that ALLOWS
    --load-extension. Branded Google Chrome stable silently rejects the flag
    (see README gotcha #1), so we never fall back to it.

    Override with AGITERRA_CHROME_FOR_TESTING=/abs/path if needed.
    """
    override = os.environ.get("AGITERRA_CHROME_FOR_TESTING")
    if override:
        if not os.path.exists(override):
            raise FileNotFoundError(f"AGITERRA_CHROME_FOR_TESTING does not exist: {override}")
        return override

    # Patterns are in priority order; the first pattern with any match wins, and
    # within it we pick the highest Playwright revision. Revisions are bare
    # integers (e.g. chromium-999, chromium-1208), so sort NUMERICALLY — a
    # lexical sort would rank "999" above "1208".
    patterns = [
        # Playwright's bundled Chrome for Testing (what browser-use downloads)
        os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"),
        os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]

    def _revision(path: str) -> int:
        m = re.search(r"chromium-(\d+)", path)
        return int(m.group(1)) if m else -1

    for p in patterns:
        hits = glob.glob(p)
        if hits:
            return max(hits, key=_revision)
    raise FileNotFoundError(
        "No Chrome for Testing / Chromium found. Install one (e.g. `python -m playwright install chromium`) "
        "or set AGITERRA_CHROME_FOR_TESTING. Do NOT use branded Google Chrome — it ignores --load-extension."
    )


def extension_id_for(dist_path: str | os.PathLike) -> str:
    """Chrome derives an unpacked extension's id from the sha256 of its
    absolute path, mapping the first 32 hex nibbles to a-p. Handy for
    asserting the right extension loaded.
    """
    h = hashlib.sha256(str(Path(dist_path).resolve()).encode()).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in h)


class CDP:
    """Minimal CDP client over a single websocket (browser-level endpoint).

    NOTE: assumes SERIAL use — one in-flight call() at a time. call() reads the
    socket until it sees its own response id and drops everything else, so two
    concurrent call()s on the same instance could consume each other's frames.
    The harness drives it sequentially; don't gather() calls on one CDP.
    """

    def __init__(self, ws):
        self._ws = ws
        self._id = 0

    @classmethod
    async def connect(cls, cdp_url: str) -> "CDP":
        ws = await websockets.connect(cdp_url, max_size=None)
        return cls(ws)

    async def call(self, method: str, params: dict | None = None, session_id: str | None = None) -> dict:
        self._id += 1
        mid = self._id
        msg: dict = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        await self._ws.send(json.dumps(msg))
        while True:
            resp = json.loads(await self._ws.recv())
            if resp.get("id") == mid:
                if "error" in resp:
                    raise RuntimeError(f"{method}: {resp['error']}")
                return resp.get("result", {})

    async def close(self):
        await self._ws.close()

    async def wait_for_extension_sw(self, timeout_s: float = 12.0) -> str | None:
        """Poll Target.getTargets for our extension's MV3 service worker.
        Returns the chrome-extension://<id> origin, or None on timeout.
        """
        deadline = timeout_s
        while deadline > 0:
            targets = (await self.call("Target.getTargets"))["targetInfos"]
            for t in targets:
                if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://"):
                    return t["url"].split("/")[2]
            await asyncio.sleep(0.5)
            deadline -= 0.5
        return None

    async def _sw_session(self, ext_id: str) -> str:
        targets = (await self.call("Target.getTargets"))["targetInfos"]
        sw = next((t for t in targets if t["type"] == "service_worker" and ext_id in t["url"]), None)
        if not sw:
            raise RuntimeError(f"no service_worker target for extension {ext_id}")
        att = await self.call("Target.attachToTarget", {"targetId": sw["targetId"], "flatten": True})
        sid = att["sessionId"]
        await self.call("Runtime.enable", {}, sid)
        return sid

    async def open_page(self, url: str, settle_s: float = 1.5) -> str:
        """Open a tab at `url`, attach, enable Page+Runtime, and let the
        content script inject window.ethereum. Returns the CDP session id."""
        t = await self.call("Target.createTarget", {"url": url})
        att = await self.call("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
        sid = att["sessionId"]
        await self.call("Page.enable", {}, sid)
        await self.call("Runtime.enable", {}, sid)
        await asyncio.sleep(settle_s)
        return sid

    async def eth_request(self, page_sid: str, method: str, params: list | None = None, timeout_s: float = 90.0) -> dict:
        """Call window.ethereum.request({method, params}) in the page and await
        it. Sign methods block until the decider responds (WireDecider bounds it
        at 60s); `timeout_s` is a client-side backstop so a never-settling
        round-trip can't hang the harness on the shared socket. Returns
        {ok, result} or {ok:false, error:{code,message}}.
        """
        expr = (
            "(async()=>{try{const r=await window.ethereum.request("
            + json.dumps({"method": method, "params": params or []})
            + ");return JSON.stringify({ok:true,result:r});}"
            "catch(e){return JSON.stringify({ok:false,error:{code:e&&e.code,message:String(e&&e.message||e)}});}})()"
        )
        try:
            r = await asyncio.wait_for(
                self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, page_sid),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            return {"ok": False, "error": {"code": None, "message": f"eth_request({method}) timed out after {timeout_s}s"}}
        if r.get("exceptionDetails"):
            raise RuntimeError(f"eth_request({method}) threw: {r['exceptionDetails']}")
        return json.loads(r["result"]["value"])

    async def seed_storage(self, ext_id: str, mapping: dict) -> None:
        """Set chrome.storage.local keys inside the extension's service worker
        — e.g. the Wire URL, the (future) vault id, and the decider-target.
        Seed BEFORE the extension connects to Wire (it is inert until
        'agiterra-wallet-extension-wire-url' is set; see wire-connection.ts).
        """
        sid = await self._sw_session(ext_id)
        expr = (
            "new Promise((res,rej)=>chrome.storage.local.set(" + json.dumps(mapping) +
            ",()=>{const e=chrome.runtime.lastError;e?rej(new Error(e.message)):res('ok')}))"
        )
        r = await self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, sid)
        if r.get("exceptionDetails"):
            raise RuntimeError(f"seed_storage failed: {r['exceptionDetails']}")

    async def remove_storage(self, ext_id: str, keys: list[str]) -> None:
        sid = await self._sw_session(ext_id)
        expr = (
            "new Promise((res,rej)=>chrome.storage.local.remove(" + json.dumps(keys) +
            ",()=>{const e=chrome.runtime.lastError;e?rej(new Error(e.message)):res('ok')}))"
        )
        r = await self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, sid)
        if r.get("exceptionDetails"):
            raise RuntimeError(f"remove_storage failed: {r['exceptionDetails']}")

    async def reload_extension(self, ext_id: str, timeout_s: float = 12.0) -> str | None:
        """chrome.runtime.reload() from inside the SW, then wait for the SW to
        come back. The eval call won't return cleanly (the context is torn down),
        so we fire-and-forget and re-poll for the (path-stable) extension id.
        """
        sid = await self._sw_session(ext_id)
        try:
            await self.call("Runtime.evaluate", {"expression": "chrome.runtime.reload()"}, sid)
        except Exception:
            pass  # context destroyed mid-call — expected
        await asyncio.sleep(0.5)
        return await self.wait_for_extension_sw(timeout_s)

    async def read_storage(self, ext_id: str, keys: list[str] | None = None) -> dict:
        sid = await self._sw_session(ext_id)
        arg = json.dumps(keys) if keys is not None else "null"
        expr = (
            "new Promise((res,rej)=>chrome.storage.local.get(" + arg +
            ",(v)=>{const e=chrome.runtime.lastError;e?rej(new Error(e.message)):res(JSON.stringify(v))}))"
        )
        r = await self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True}, sid)
        if r.get("exceptionDetails"):
            raise RuntimeError(f"read_storage failed: {r['exceptionDetails']}")
        return json.loads(r["result"]["value"])


# chrome.storage.local keys the extension reads (see prod/src/*).
WIRE_IDENTITY_KEY = "agiterra-wallet-extension-wire-identity"
VAULT_ID_KEY = "agiterra-wallet-extension-vault-id"
WIRE_URL_KEY = "agiterra-wallet-extension-wire-url"
DECIDER_TARGET_KEY = "agiterra-wallet-extension-decider-target"


async def provision_vault_identity(
    cdp: "CDP",
    ext_id: str,
    vault_id: str,
    wire_url: str | None = None,
    decider_target: str | None = None,
) -> dict:
    """Make a freshly-launched instance register under its OWN Wire id.

    The SW mints its identity at boot, BEFORE we can seed anything — and on a
    fresh profile that mint uses the default id 'wallet-vault'. So we: seed the
    vault id (+ decider-target), DELETE the default-minted identity, reload the
    SW (re-mints under the seeded id), and ONLY THEN seed the wire-url — because
    the connect loop is inert until wire-url is set (wire-connection.ts), this
    ordering guarantees the default 'wallet-vault' id never touches Wire (no 409
    collision with a live Chrome wallet-vault).

    Returns the stored identity ({agentId, ...}) after re-mint.
    """
    seed: dict = {VAULT_ID_KEY: vault_id}
    if decider_target:
        seed[DECIDER_TARGET_KEY] = decider_target
    await cdp.seed_storage(ext_id, seed)
    await cdp.remove_storage(ext_id, [WIRE_IDENTITY_KEY])
    new_ext_id = await cdp.reload_extension(ext_id)
    if not new_ext_id:
        raise RuntimeError("extension service worker did not return after reload")

    # The SW target can reappear BEFORE loadOrCreateIdentity finishes writing the
    # re-minted identity, so poll storage until it shows the seeded vault id
    # (otherwise we'd read a stale/empty identity). Seed wire-url only after —
    # the connect loop must not start under the wrong id.
    ident: dict = {}
    for _ in range(40):
        ident = (await cdp.read_storage(new_ext_id, [WIRE_IDENTITY_KEY])).get(WIRE_IDENTITY_KEY, {})
        if ident.get("agentId") == vault_id:
            break
        await asyncio.sleep(0.25)
    if ident.get("agentId") != vault_id:
        raise RuntimeError(f"re-mint did not take: identity={ident!r} (wanted vault_id={vault_id})")

    if wire_url:
        await cdp.seed_storage(new_ext_id, {WIRE_URL_KEY: wire_url})
    return ident


@dataclass
class LaunchHandle:
    session: Any           # browser_use.BrowserSession
    cdp: CDP
    cdp_url: str
    extension_id: str


async def launch_with_extension(
    dist: str | os.PathLike = PROD_DIST,
    headless: bool | str = "new",
    chrome_path: str | None = None,
    user_data_dir: str | None = None,
) -> LaunchHandle:
    """Launch browser-use Chromium with the prod extension loaded and return a
    handle (session + a CDP client on the browser endpoint).

    Caller is responsible for `await handle.session.stop()` and
    `await handle.cdp.close()`.
    """
    from browser_use import BrowserSession, BrowserProfile

    dist = str(Path(dist).resolve())
    if not os.path.isdir(dist):
        raise FileNotFoundError(f"extension dist not found: {dist} — run `bun run build:prod` first")
    chrome_path = chrome_path or find_chrome_for_testing()

    profile_kwargs: dict = dict(
        headless=(headless if isinstance(headless, bool) else True),  # browser-use maps True→--headless=new
        executable_path=chrome_path,
        enable_default_extensions=False,  # else browser-use's --load-extension clobbers ours (last wins)
        args=[f"--load-extension={dist}", f"--disable-extensions-except={dist}"],
    )
    if user_data_dir:
        profile_kwargs["user_data_dir"] = user_data_dir

    session = BrowserSession(browser_profile=BrowserProfile(**profile_kwargs))
    await session.start()
    cdp = await CDP.connect(session.cdp_url)
    ext_id = await cdp.wait_for_extension_sw()
    if not ext_id:
        raise RuntimeError(
            "extension service worker did not appear — extension failed to load "
            "(check Chrome-for-Testing is in use; Google Chrome stable ignores --load-extension)"
        )
    return LaunchHandle(session=session, cdp=cdp, cdp_url=session.cdp_url, extension_id=ext_id)
