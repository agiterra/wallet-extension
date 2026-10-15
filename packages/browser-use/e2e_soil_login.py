#!/usr/bin/env python
"""
ENG-4948 — headless browser-use wallet proof against staging Soil (test.fabrica.land).

  1. launch browser-use headless=new with the prod Agiterra Wallet (CfT from find_chrome_for_testing)
  2. provision a Wire vault identity, sponsor-register it, wait for the approver's wallet_create
  3. staging login: EIP-6963 guard -> Log In -> Continue with a wallet -> Agiterra Wallet -> SIWE
     (the approver inspects and wallet_approve's the personal_sign over the Wire)
  4. one explicit Sepolia personal_sign, recovered with ethers to the wallet address

Run WITH an approver (default: fondant) online. Env: AGENT_ID, AGENT_PRIVATE_KEY, WIRE_URL.
  E2E_WALLET_NAME   unique per run (the vault directory persists)
  E2E_OUT           screenshot/log dir (default: a fresh temp dir)
  E2E_EMAIL         staging sandbox onboarding email (default <wallet-name>+dynamic_test@fabrica.land; static OTP 972081)
  VERCEL_AUTOMATION_BYPASS_SECRET  staging sits behind Vercel Deployment Protection (soil-app/.env.local);
                    the first navigation sets the bypass cookie, the token is redacted from every log line
Prints one `VERDICT:` line per proof; exits 0 only when both pass.
"""
import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time

from launcher import launch_with_extension, provision_vault_identity, WIRE_URL_KEY, VAULT_KEY
from wire_admin import derive_pubkey_b64, sponsor_register, get_directory

SITE = "https://test.fabrica.land"
VAULT_ID = "wallet-vault-e2e"
SEPOLIA = 11155111
AGITERRA_UUID = "474cd34c-8091-4ce8-9560-ea19b312c6fc"
WALLET_NAME = os.environ.get("E2E_WALLET_NAME", f"eng-4948-{int(time.time())}")
DECIDER_TARGET = os.environ.get("E2E_DECIDER_TARGET", "fondant")
OUT = os.environ.get("E2E_OUT") or tempfile.mkdtemp(prefix="eng4948-")
EMAIL = os.environ.get("E2E_EMAIL", f"{WALLET_NAME}+dynamic_test@fabrica.land")
SANDBOX_OTP = "972081"  # Dynamic sandbox static OTP: staging only (runbook-login-eoa.md)
ETHERS = "/opt/agiterra/wallet-extension/node_modules/.bun/ethers@6.16.0/node_modules/ethers"

# Dynamic renders its modal inside shadow roots: every query walks them.
DEEP = r"""
const __deep = () => { const out = []; const walk = (n) => { for (const el of n.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; };
const __own = (el) => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
const __vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
// Clickable elements only, shortest text wins: a container DIV holding the whole form must never be the target
// (run 6: the form DIV's center was 'Continue with Google').
const __find = (t) => { t = t.toLowerCase(); const hits = __deep().filter(e => e.matches('button,[role=button],a,li')
    && (e.textContent || '').trim().toLowerCase().includes(t) && __vis(e));
  hits.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length); return hits[0] || null; };
const __click = (t) => { const e = __find(t); if (!e) return false;
  (e.closest('button,[role=button],a,li,[data-testid]') || e).click(); return true; };
const __rect = (t) => { const e = __find(t); if (!e) return null; const c = e;
  const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: c.tagName, text: (c.textContent || '').trim().slice(0, 60) }; };
const __has = (t) => { t = t.toLowerCase(); return __deep().some(e => !e.children.length && (e.textContent || '').toLowerCase().includes(t) && __vis(e)); };
const __inputs = (sel) => __deep().filter(e => e.matches(sel) && __vis(e));
const __center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const __text = () => __deep().filter(e => e.shadowRoot).map(e => e.shadowRoot.textContent).join(' | ').replace(/\s+/g, ' ').slice(0, 1500)
  + ' || ' + document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500);
"""


BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")


def log(msg: str) -> None:
    msg = re.sub(r"(x-vercel-protection-bypass=)[^&\s\"']+", r"\1<redacted>", msg)
    if BYPASS:
        msg = msg.replace(BYPASS, "<redacted>")
    line = f"{time.strftime('%H:%M:%SZ', time.gmtime())} {msg}"
    print(line, flush=True)
    with open(os.path.join(OUT, "run.log"), "a") as f:
        f.write(line + "\n")


async def ev(cdp, sid, expr: str, timeout_s: float = 30.0):
    # Function scope per call: top-level consts in Runtime.evaluate persist and the second call would redeclare them.
    wrapped = f"(() => {{ {DEEP}\nreturn ({expr}); }})()"
    r = await asyncio.wait_for(cdp.call("Runtime.evaluate", {"expression": wrapped, "awaitPromise": True,
                                                              "returnByValue": True}, sid), timeout=timeout_s)
    if r.get("exceptionDetails"):
        raise RuntimeError(f"page eval failed: {json.dumps(r['exceptionDetails'])[:400]}")
    return r.get("result", {}).get("value")


async def shot(cdp, sid, name: str) -> None:
    # Best effort. A headless tab that is not in front never paints, and captureScreenshot then never returns
    # (run 3 hung 4 min here). Bring it to front and bound the wait; a missing screenshot must not stop the proof.
    try:
        await asyncio.wait_for(cdp.call("Page.bringToFront", {}, sid), timeout=5)
        r = await asyncio.wait_for(cdp.call("Page.captureScreenshot", {"format": "png"}, sid), timeout=10)
    except Exception as e:
        log(f"screenshot {name} skipped: {type(e).__name__} {e}")
        return
    path = os.path.join(OUT, f"{name}.png")
    with open(path, "wb") as f:
        f.write(base64.b64decode(r["data"]))
    log(f"screenshot {path}")


async def click(cdp, sid, text: str) -> dict | None:
    # A trusted CDP mouse click. Dynamic ignores a synthetic element.click() (run 5: 'Continue with a wallet' did nothing).
    r = await ev(cdp, sid, f"__rect({json.dumps(text)})")
    if not r:
        return None
    for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
        await cdp.call("Input.dispatchMouseEvent", {"type": kind, "x": r["x"], "y": r["y"], "button": "left", "clickCount": 1}, sid)
    return r


async def mouse(cdp, sid, x: float, y: float) -> None:
    for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
        await cdp.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}, sid)


async def type_into(cdp, sid, selector: str, index: int, text: str) -> bool:
    # Trusted click to focus, then trusted text input: a React-controlled field sees real input events.
    c = await ev(cdp, sid, f"(() => {{ const e = __inputs({json.dumps(selector)})[{index}]; return e ? __center(e) : null; }})()")
    if not c:
        return False
    await mouse(cdp, sid, c["x"], c["y"])
    await cdp.call("Input.insertText", {"text": text}, sid)
    return True


async def onboard(cdp, sid) -> None:
    """New wallet: Dynamic's 'Welcome to Fabrica Staging' gate after SIWE (email + ToS, then a sandbox OTP)."""
    ok = await type_into(cdp, sid, "input[type=email],input[name=email],input#email", 0, EMAIL)
    log(f"onboarding: email {EMAIL} typed={ok}")
    box = await ev(cdp, sid, """(() => { const e = __inputs('input[type=checkbox]')[0]
      || __deep().find(l => l.matches('label') && /agree/i.test(l.textContent || '') && __vis(l)); return e ? __center(e) : null; })()""")
    if box:
        await mouse(cdp, sid, box["x"], box["y"])
    checked = await ev(cdp, sid, "__inputs('input[type=checkbox]').map(e => e.checked)")
    log(f"onboarding: ToS checkbox clicked={bool(box)} checked={checked}")
    await shot(cdp, sid, "04-onboarding-filled")
    hit = await click(cdp, sid, "Continue")
    log(f"onboarding: clicked Continue -> {json.dumps(hit)}")
    for _ in range(30):
        await asyncio.sleep(1.0)
        n = await ev(cdp, sid, "__inputs('input[maxlength=\"1\"],input[autocomplete=one-time-code]').length")
        if n:
            log(f"onboarding: OTP inputs {n}; entering the sandbox code")
            for i, digit in enumerate(SANDBOX_OTP if n >= len(SANDBOX_OTP) else [SANDBOX_OTP]):
                await type_into(cdp, sid, 'input[maxlength="1"],input[autocomplete=one-time-code]', i, digit)
            await shot(cdp, sid, "05-otp")
            return
        if await ev(cdp, sid, "__has('My Portfolio')"):
            return


async def wait_text(cdp, sid, text: str, timeout_s: float) -> bool:
    for _ in range(int(timeout_s * 2)):
        if await ev(cdp, sid, f"!!__find({json.dumps(text)})"):
            return True
        await asyncio.sleep(0.5)
    return False


async def authed(cdp, sid) -> dict:
    return await ev(cdp, sid, """(() => {
      const keys = Object.keys(localStorage);
      const tok = keys.find(k => /dynamic_authentication_token|dynamic_min_authentication_token/.test(k));
      return { token_key: tok || null, token_present: !!(tok && localStorage.getItem(tok)),
               dynamic_keys: keys.filter(k => k.startsWith('dynamic')).slice(0, 12), url: location.href };
    })()""")


def recover(message: str, signature: str) -> str:
    js = f"const {{verifyMessage}} = require({json.dumps(ETHERS)}); console.log(verifyMessage(process.argv[1], process.argv[2]));"
    r = subprocess.run(["bun", "-e", js, message, signature], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ethers verifyMessage failed: {r.stderr.strip()[-300:]}")
    return r.stdout.strip()


async def login(h, address: str) -> bool:
    cdp = h.cdp
    if not BYPASS:
        log("FAIL: VERCEL_AUTOMATION_BYPASS_SECRET unset; staging answers with the Vercel login wall")
        return False
    sid = await cdp.open_page(f"{SITE}/?x-vercel-protection-bypass={BYPASS}&x-vercel-set-bypass-cookie=true", settle_s=6.0)
    await shot(cdp, sid, "01-landing")
    log(f"landed on {await ev(cdp, sid, 'location.origin + location.pathname')}")
    found = await ev(cdp, sid, f"""(async () => {{ const f = [];
      window.addEventListener('eip6963:announceProvider', e => f.push({{name: e.detail?.info?.name, uuid: e.detail?.info?.uuid}}));
      window.dispatchEvent(new Event('eip6963:requestProvider')); await new Promise(r => setTimeout(r, 800));
      return f; }})()""")
    log(f"EIP-6963 providers: {json.dumps(found)}")
    if not any(p.get("uuid") == AGITERRA_UUID for p in found or []):
        log("FAIL: Agiterra provider not announced (hard gate)")
        return False

    state = await authed(cdp, sid)
    if state["token_present"]:
        log(f"already authenticated: {json.dumps(state)}")
        return True
    for step in ("Log In", "Continue with a wallet", "Agiterra Wallet"):
        if not await wait_text(cdp, sid, step, 30):
            log(f"FAIL: '{step}' never appeared. Page text: {await ev(cdp, sid, '__text()')}")
            await shot(cdp, sid, f"fail-{step.replace(' ', '-')}")
            return False
        hit = await click(cdp, sid, step)
        log(f"clicked '{step}' -> {json.dumps(hit)}")
        await asyncio.sleep(2.0)
        await shot(cdp, sid, f"02-after-{step.replace(' ', '-')}")

    log(f">>> SIWE pending: approver {DECIDER_TARGET} inspects wallet.sign.request (vault {VAULT_ID}, {address})")
    # Success marker per runbook-login-eoa.md step 8: 'My Portfolio' in the header, no Welcome modal left.
    onboarded, deadline = False, time.time() + 180
    while time.time() < deadline:
        if await ev(cdp, sid, "__has('My Portfolio')") and not await ev(cdp, sid, "__has('Welcome to Fabrica')"):
            break
        if not onboarded and await ev(cdp, sid, "__has('Welcome to Fabrica')"):
            log("SIWE accepted: Dynamic shows the connected wallet and the Welcome onboarding gate")
            await shot(cdp, sid, "03-welcome")
            await onboard(cdp, sid)
            onboarded = True
        await asyncio.sleep(1.0)
    ok = bool(await ev(cdp, sid, "__has('My Portfolio')")) and not await ev(cdp, sid, "__has('Welcome to Fabrica')")
    href = await ev(cdp, sid, "(() => { const a = __deep().find(e => e.matches('a') && /my portfolio/i.test(e.textContent || '')); return a ? a.getAttribute('href') : null; })()")
    await shot(cdp, sid, "06-final")
    chip = await ev(cdp, sid, "__has('Sepolia')")
    log(f"final: My Portfolio={ok} href={href} sepolia_chip={chip} auth={json.dumps(await authed(cdp, sid))}")
    if not ok:
        log(f"page text: {await ev(cdp, sid, '__text()')}")
    return ok and bool(href) and address.lower() in href.lower()


async def sepolia_sign(h, address: str) -> bool:
    cdp = h.cdp
    sid = await cdp.open_page(SITE, settle_s=3.0)
    accts = await cdp.eth_request(sid, "eth_requestAccounts", [])
    chain = await cdp.eth_request(sid, "eth_chainId", [])
    log(f"eth_requestAccounts -> {json.dumps(accts)}; eth_chainId -> {json.dumps(chain)}")
    if chain.get("result") != hex(SEPOLIA):
        sw = await cdp.eth_request(sid, "wallet_switchEthereumChain", [{"chainId": hex(SEPOLIA)}])
        chain = await cdp.eth_request(sid, "eth_chainId", [])
        log(f"wallet_switchEthereumChain -> {json.dumps(sw)}; eth_chainId -> {json.dumps(chain)}")
    if chain.get("result") != hex(SEPOLIA):
        log("FAIL: wallet is not on Sepolia")
        return False
    message = f"ENG-4948 browser-use headless Sepolia signature {WALLET_NAME} {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}"
    log(f">>> personal_sign pending: approver {DECIDER_TARGET}; message: {message}")
    sig = await cdp.eth_request(sid, "personal_sign", [message, address], timeout_s=150)
    log(f"personal_sign -> {json.dumps(sig)}")
    if not (sig.get("ok") and isinstance(sig.get("result"), str) and len(sig["result"]) == 132):
        return False
    signer = recover(message, sig["result"])
    log(f"ethers.verifyMessage -> {signer} (wallet {address})")
    return signer.lower() == address.lower()


async def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    wire_url = os.environ.get("WIRE_URL", "http://localhost:9800")
    sponsor_id, sponsor_key = os.environ.get("AGENT_ID"), os.environ.get("AGENT_PRIVATE_KEY")
    if not sponsor_id or not sponsor_key:
        print("AGENT_ID / AGENT_PRIVATE_KEY required (the sponsor identity)")
        return 2
    log(f"out dir {OUT}; wallet name {WALLET_NAME}; approver {DECIDER_TARGET}")
    h = await launch_with_extension(headless="new")
    try:
        version = await h.cdp.call("Browser.getVersion")
        log(f"browser {version.get('product')} | {version.get('userAgent')}")
        ident = await provision_vault_identity(h.cdp, h.extension_id, VAULT_ID, decider_target=DECIDER_TARGET)
        reg = sponsor_register(wire_url, sponsor_id, sponsor_key, VAULT_ID, derive_pubkey_b64(ident["privateKeyB64"]),
                               "Wallet Vault (e2e)", force_rotate=True)
        assert reg["status"] in (200, 201), f"sponsor_register failed: {reg}"
        await h.cdp.seed_storage(h.extension_id, {WIRE_URL_KEY: wire_url})
        log(f">>> wallet_create pending: name '{WALLET_NAME}', vault_id '{VAULT_ID}', chain {SEPOLIA}")
        address = None
        for _ in range(600):
            wallets = get_directory(wire_url, VAULT_ID)
            address = next((a for a, m in wallets.items() if (m or {}).get("name") == WALLET_NAME), None)
            if address:
                break
            await asyncio.sleep(0.5)
        if not address:
            log(f"FAIL: wallet '{WALLET_NAME}' never appeared in {VAULT_ID}")
            return 1
        for _ in range(60):
            vault = (await h.cdp.read_storage(h.extension_id, [VAULT_KEY])).get(VAULT_KEY) or []
            keep = [w for w in vault if str(w.get("address", "")).lower() == address.lower()]
            if keep:
                await h.cdp.seed_storage(h.extension_id, {VAULT_KEY: keep})
                break
            await asyncio.sleep(0.5)
        else:
            log(f"FAIL: wallet {address} never landed in the extension vault")
            return 1
        log(f"wallet {address} pinned as the only vault wallet")

        ok_login = await login(h, address)
        print(f"VERDICT login: {'PASS' if ok_login else 'FAIL'} ({SITE}, {address})", flush=True)
        ok_sign = await sepolia_sign(h, address)
        print(f"VERDICT sepolia-sign: {'PASS' if ok_sign else 'FAIL'} ({address})", flush=True)
        return 0 if ok_login and ok_sign else 1
    finally:
        await h.cdp.close()
        await h.session.stop()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
