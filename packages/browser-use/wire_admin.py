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
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


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
        with urllib.request.urlopen(req) as r:
            return {"status": r.status, "body": r.read().decode()}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": e.read().decode()}


def is_registered(wire_url: str, agent_id: str) -> bool:
    """Unauthenticated existence probe (GET /peers/agents/:id → 200/404)."""
    try:
        with urllib.request.urlopen(f"{wire_url.rstrip('/')}/peers/agents/{agent_id}") as r:
            return r.status == 200
    except urllib.error.HTTPError:
        return False


def get_directory(wire_url: str, namespace: str) -> dict:
    """Read a vault's wallet directory (plugin_settings <namespace>/wallets).
    The GET is unauthenticated (any reader); returns {address: meta, ...} or {}."""
    try:
        with urllib.request.urlopen(f"{wire_url.rstrip('/')}/plugin_settings/{namespace}/wallets") as r:
            body = json.loads(r.read().decode())
            return body.get("value") or {}
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise
