"""
Minimal Wire admin used by the e2e harness: derive an Ed25519 public key and
SPONSOR-register a new agent id.

A freshly-launched browser-use wallet instance registers under its own vault id
(e.g. "wallet-vault-e2e"). A brand-new id needs a sponsor (any already-registered
agent) or operator to enroll it — the extension's own self-register can't
bootstrap a never-seen id (wire server requireAgentOrOperator). The orchestrating
agent (which already has a Wire identity) sponsors it here, so no operator step is
needed.

JWT format mirrors @agiterra/wire-tools crypto.ts exactly:
  header  = base64url({"alg":"EdDSA","typ":"JWT"})
  payload = base64url({"iss":<id>,"iat":<unix s>,"body_hash":<sha256 hex of body>})
  sig     = Ed25519(header "." payload)
The server recomputes sha256 over the raw received body, so body_hash just has to
match the exact bytes we POST (key order is irrelevant).
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


# Cap every Wire HTTP call so a hung server can't block the harness indefinitely.
_HTTP_TIMEOUT_S = 10


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _load_priv(pkcs8_b64: str) -> Ed25519PrivateKey:
    key = serialization.load_der_private_key(base64.b64decode(pkcs8_b64), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError("expected an Ed25519 PKCS8 private key")
    return key


def derive_pubkey_b64(priv_pkcs8_b64: str) -> str:
    """base64(raw 32-byte Ed25519 public key) — matches wire-tools derivePublicKeyB64."""
    raw = _load_priv(priv_pkcs8_b64).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return base64.b64encode(raw).decode()


_JWT_HEADER_B64 = _b64url(json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode())


def make_jwt(agent_id: str, priv_pkcs8_b64: str, body: str) -> str:
    claims = {"iss": agent_id, "iat": int(time.time()), "body_hash": hashlib.sha256(body.encode()).hexdigest()}
    payload_b64 = _b64url(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{_JWT_HEADER_B64}.{payload_b64}"
    sig = _load_priv(priv_pkcs8_b64).sign(signing_input.encode())
    return f"{signing_input}.{_b64url(sig)}"


def sponsor_register(
    wire_url: str,
    sponsor_id: str,
    sponsor_priv_pkcs8_b64: str,
    new_id: str,
    new_pubkey_b64: str,
    display_name: str,
    kind: str = "integration",
    force_rotate: bool = False,
) -> dict:
    """Register `new_id`/`new_pubkey_b64`, signing as `sponsor_id`. Re-registering
    the same id+pubkey is accepted; a different pubkey → 409 unless
    `force_rotate=True`. Each fresh browser-use launch mints a new keypair, so an
    ephemeral e2e instance (whose predecessor is already gone) should rotate."""
    payload: dict = {"id": new_id, "display_name": display_name, "pubkey": new_pubkey_b64, "kind": kind}
    if force_rotate:
        payload["force_rotate"] = True
    body = json.dumps(payload)
    jwt = make_jwt(sponsor_id, sponsor_priv_pkcs8_b64, body)
    req = urllib.request.Request(
        f"{wire_url.rstrip('/')}/agents/register",
        data=body.encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {jwt}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S) as r:
            return {"status": r.status, "body": r.read().decode()}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": e.read().decode()}


def is_registered(wire_url: str, agent_id: str) -> bool:
    """Unauthenticated existence probe (GET /peers/agents/:id → 200/404).
    Returns False on 404 OR an unreachable Wire (URLError) — never raises."""
    try:
        # HTTPError (incl. 404) is a subclass of URLError, caught below
        with urllib.request.urlopen(f"{wire_url.rstrip('/')}/peers/agents/{agent_id}", timeout=_HTTP_TIMEOUT_S) as r:
            return r.status == 200
    except urllib.error.URLError:
        return False


def publish(wire_url: str, agent_id: str, priv_pkcs8_b64: str, dest: str, topic: str, payload: dict) -> dict:
    """POST a JWT-signed message to /webhooks/<dest>/<topic> (same path the
    wallet MCP uses). Lets the harness drive wallet_create / wallet_use /
    wallet_approve directly over Wire — no MCP round-trip — so the per-tab
    binding flow runs end-to-end and repeatably. An HTTPError returns its status;
    a URLError (Wire unreachable / timeout) is intentionally NOT caught — a
    publish failure should fail the harness loudly, not silently retry forever."""
    body = json.dumps(payload)
    jwt = make_jwt(agent_id, priv_pkcs8_b64, body)
    req = urllib.request.Request(
        f"{wire_url.rstrip('/')}/webhooks/{dest}/{topic}",
        data=body.encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {jwt}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S) as r:
            return {"status": r.status, "body": r.read().decode()}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": e.read().decode()}


def wallet_create(wire_url, agent_id, priv, vault_id, request_id, name, chain_id=None) -> dict:
    p = {"request_id": request_id, "name": name}
    if chain_id is not None:
        p["chain_id"] = chain_id
    return publish(wire_url, agent_id, priv, vault_id, "wallet.vault.create_request", p)


def wallet_use(wire_url, agent_id, priv, vault_id, tab_id, wallet_address) -> dict:
    return publish(wire_url, agent_id, priv, vault_id, "wallet.vault.tab_claim",
                   {"tab_id": str(tab_id), "wallet_address": wallet_address})


def wallet_approve(wire_url, agent_id, priv, vault_id, request_id) -> dict:
    return publish(wire_url, agent_id, priv, vault_id, "wallet.sign.response",
                   {"request_id": request_id, "action": "approve"})


_WALLET_KEY_PREFIX = "wallet:"
_WALLETS_LEGACY_KEY = "wallets"
_ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")


def _is_wallet_meta(v) -> bool:
    """Structural check — mirrors wallet-tools isWalletMeta (directory.ts)."""
    if not isinstance(v, dict):
        return False
    access = v.get("access")
    return (
        isinstance(v.get("name"), str)
        and isinstance(v.get("creator"), str)
        and isinstance(v.get("chain_id"), (int, float))
        and isinstance(access, dict)
        and isinstance(access.get("mode"), str)
        and isinstance(access.get("agents"), list)
    )


def merge_wallet_directory(settings: dict) -> dict:
    """Python port of wallet-tools mergeWalletDirectory (ENG-3313 dual-read):
    the legacy `wallets` blob seeds the result; per-key `wallet:<addr>` entries
    overwrite per address. Malformed values and unrelated keys are skipped."""
    out: dict = {}
    legacy = settings.get(_WALLETS_LEGACY_KEY)
    if isinstance(legacy, dict):
        for addr, meta in legacy.items():
            if _is_wallet_meta(meta):
                out[addr.lower()] = meta
    for key, value in settings.items():
        if key.startswith(_WALLET_KEY_PREFIX):
            addr = key[len(_WALLET_KEY_PREFIX):].lower()
            if _ADDR_RE.match(addr) and _is_wallet_meta(value):
                out[addr] = value
    return out


def get_directory(wire_url: str, namespace: str) -> dict:
    """Read a vault's wallet directory via the whole-namespace listing
    (GET /plugin_settings/<namespace> → {key: value}) and dual-read merge the
    legacy `wallets` blob with per-key `wallet:<addr>` entries (per-key wins).
    The GET is unauthenticated (any reader); returns {address: meta, ...} or {}.
    Returns {} on 404 or a transient connection error (so poll loops keep going);
    re-raises a non-404 HTTP error."""
    try:
        with urllib.request.urlopen(f"{wire_url.rstrip('/')}/plugin_settings/{namespace}", timeout=_HTTP_TIMEOUT_S) as r:
            settings = json.loads(r.read().decode())
            return merge_wallet_directory(settings if isinstance(settings, dict) else {})
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise
    except urllib.error.URLError:
        return {}
