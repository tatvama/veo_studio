"""Signing MCP clients in.

Two ways, one token table (models.ApiToken):
- Personal access tokens, made on Settings → MCP access and pasted into Claude Code / Claude Desktop / Cursor.
- OAuth 2.1 (dynamic client registration + authorization code with PKCE), so claude.ai can add Tatvam as a custom
  connector: the client is sent to /oauth/consent in the web app, the signed-in user approves it, and the client
  receives an access token (8 h) and a refresh token (60 days). Every token is revocable on the Settings page.

OAuth needs an HTTPS public_base_url (localhost is allowed for testing); otherwise only personal tokens work.
"""
from __future__ import annotations

import secrets
import uuid
from datetime import timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import anyio
from mcp.server.auth.provider import (AccessToken, AuthorizationCode, AuthorizationParams, OAuthAuthorizationServerProvider,
                                      RefreshToken, TokenError, TokenVerifier, construct_redirect_uri)
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from ..config import get_settings
from ..db import SessionLocal, utcnow
from ..models import ApiToken, OAuthClient, OAuthRequest, User
from . import tokens

REQUEST_TTL = timedelta(minutes=15)  # time to sign in and approve on the consent page
CODE_TTL = timedelta(minutes=5)  # an approved code must be exchanged quickly


def _epoch(dt) -> int | None:
    return int(dt.replace(tzinfo=timezone.utc).timestamp()) if dt else None


def access_token_for(raw: str) -> AccessToken | None:
    """The SDK's view of a bearer token (personal or OAuth access token), or None when it is not valid."""
    with SessionLocal() as db:
        row = tokens.lookup(db, raw)
        if row is None:
            return None
        tokens.touch(db, row)
        return AccessToken(token=raw, client_id=row.client_id or f"pat-{row.id}", scopes=list(row.scopes or []),
                           expires_at=_epoch(row.expires_at), resource=row.resource or None, subject=str(row.user_id),
                           claims={"token_id": row.id, "project_ids": list(row.project_ids or [])})


class PersonalTokenVerifier(TokenVerifier):
    """Used when OAuth is off (public_base_url is plain HTTP on a non-local host): personal tokens only."""

    async def verify_token(self, token: str) -> AccessToken | None:
        return await anyio.to_thread.run_sync(access_token_for, token)


class TatvamOAuthProvider(OAuthAuthorizationServerProvider[AuthorizationCode, RefreshToken, AccessToken]):
    """Tatvam as its own OAuth authorization server for MCP clients. The database work runs in a thread."""

    # ── clients ──
    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        def run():
            with SessionLocal() as db:
                row = db.get(OAuthClient, client_id)
                return OAuthClientInformationFull.model_validate(row.info) if row else None
        return await anyio.to_thread.run_sync(run)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        def run():
            with SessionLocal() as db:
                info = client_info.model_dump(mode="json", exclude_none=True)
                row = db.get(OAuthClient, client_info.client_id)
                if row is None:
                    row = OAuthClient(client_id=client_info.client_id)
                    db.add(row)
                row.name, row.info = (client_info.client_name or "")[:200], info
                db.commit()
        await anyio.to_thread.run_sync(run)

    # ── authorization: hand the user to the consent page ──
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        def run() -> str:
            with SessionLocal() as db:
                rid = uuid.uuid4().hex
                db.add(OAuthRequest(id=rid, client_id=client.client_id, expires_at=utcnow() + REQUEST_TTL,
                                    params={"state": params.state, "scopes": params.scopes or [],
                                            "code_challenge": params.code_challenge, "redirect_uri": str(params.redirect_uri),
                                            "redirect_uri_provided_explicitly": params.redirect_uri_provided_explicitly,
                                            "resource": params.resource}))
                db.commit()
            return f"{get_settings().public_base_url.rstrip('/')}/oauth/consent?request={rid}"
        return await anyio.to_thread.run_sync(run)

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> AuthorizationCode | None:
        def run():
            with SessionLocal() as db:
                row = db.query(OAuthRequest).filter(OAuthRequest.code_hash == tokens.hash_token(authorization_code)).first()
                if row is None or row.status != "approved" or row.client_id != client.client_id or row.expires_at < utcnow():
                    return None
                p = row.params or {}
                return AuthorizationCode(code=authorization_code, scopes=list(row.scopes or []), expires_at=float(_epoch(row.expires_at)),
                                         client_id=row.client_id, code_challenge=p["code_challenge"], redirect_uri=p["redirect_uri"],
                                         redirect_uri_provided_explicitly=bool(p.get("redirect_uri_provided_explicitly")),
                                         resource=p.get("resource"), subject=str(row.user_id))
        return await anyio.to_thread.run_sync(run)

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode) -> OAuthToken:
        def run():
            with SessionLocal() as db:
                row = db.query(OAuthRequest).filter(OAuthRequest.code_hash == tokens.hash_token(authorization_code.code)).first()
                if row is None or row.status != "approved":
                    raise TokenError("invalid_grant", "authorization code already used or not approved")
                row.status = "used"
                user = db.get(User, row.user_id)
                if user is None or not user.active:
                    raise TokenError("invalid_grant", "user not found")
                name = f"{client.client_name or 'MCP client'} (OAuth)"
                acc, ref, _ = tokens.issue_pair(db, user, client.client_id or "", list(row.scopes or []),
                                                (row.params or {}).get("resource") or "", name)
                db.commit()
                return OAuthToken(access_token=acc, refresh_token=ref, expires_in=int(tokens.ACCESS_TTL.total_seconds()),
                                  scope=" ".join(row.scopes or []))
        return await anyio.to_thread.run_sync(run)

    # ── refresh & access ──
    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        def run():
            with SessionLocal() as db:
                row = tokens.lookup(db, refresh_token, kinds=("oauth_refresh",))
                if row is None or row.client_id != client.client_id:
                    return None
                return RefreshToken(token=refresh_token, client_id=row.client_id, scopes=list(row.scopes or []),
                                    expires_at=_epoch(row.expires_at), resource=row.resource or None, subject=str(row.user_id))
        return await anyio.to_thread.run_sync(run)

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken,
                                     scopes: list[str]) -> OAuthToken:
        def run():
            with SessionLocal() as db:
                row = tokens.lookup(db, refresh_token.token, kinds=("oauth_refresh",))
                if row is None:
                    raise TokenError("invalid_grant", "refresh token expired or revoked")
                granted = list(row.scopes or [])
                want = [s for s in (scopes or granted) if s in granted] or granted  # never more than first approved
                user = db.get(User, row.user_id)
                tokens.revoke_pair(db, row)  # rotate: the old access + refresh tokens stop working
                acc, ref, _ = tokens.issue_pair(db, user, row.client_id, want, row.resource, row.name)
                db.commit()
                return OAuthToken(access_token=acc, refresh_token=ref, expires_in=int(tokens.ACCESS_TTL.total_seconds()),
                                  scope=" ".join(tokens.clean_scopes(want)))
        return await anyio.to_thread.run_sync(run)

    async def load_access_token(self, token: str) -> AccessToken | None:
        return await anyio.to_thread.run_sync(access_token_for, token)

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        def run():
            with SessionLocal() as db:
                row = db.query(ApiToken).filter(ApiToken.token_hash == tokens.hash_token(token.token)).first()
                if row is not None:
                    tokens.revoke_pair(db, row)
        await anyio.to_thread.run_sync(run)


# ── the consent page's side (called by api/mcp_access.py with the signed-in user) ──

def consent_view(rid: str) -> dict[str, Any] | None:
    with SessionLocal() as db:
        row = db.get(OAuthRequest, rid)
        if row is None:
            return None
        client = db.get(OAuthClient, row.client_id)
        p = row.params or {}
        return {"id": row.id, "client": (client.name if client else "") or row.client_id,
                "redirect_host": urlparse(p.get("redirect_uri") or "").netloc,
                "scopes": tokens.clean_scopes(p.get("scopes")), "status": row.status,
                "expired": row.expires_at < utcnow()}


def decide(rid: str, user: User, approve: bool, scopes: list[str] | None = None) -> str:
    """Approve or deny a sign-in request. Returns the URL to send the browser back to (the client's redirect URI)."""
    with SessionLocal() as db:
        row = db.get(OAuthRequest, rid)
        if row is None or row.status != "pending" or row.expires_at < utcnow():
            raise ValueError("This sign-in request has expired or was already answered. Start again from the app.")
        p = row.params or {}
        if not approve:
            row.status = "denied"
            db.commit()
            return construct_redirect_uri(p["redirect_uri"], error="access_denied", error_description="The user said no",
                                          state=p.get("state"))
        asked = tokens.clean_scopes(p.get("scopes"))
        granted = tokens.clean_scopes([s for s in (scopes or asked) if s in tokens.SCOPES])
        code = secrets.token_urlsafe(32)
        row.status, row.user_id, row.scopes = "approved", user.id, granted
        row.code_hash, row.expires_at = tokens.hash_token(code), utcnow() + CODE_TTL
        db.commit()
        return construct_redirect_uri(p["redirect_uri"], code=code, state=p.get("state"))


# ── settings for the SDK ──

def oauth_possible() -> bool:
    u = urlparse(get_settings().public_base_url)
    return u.scheme == "https" or u.hostname in ("localhost", "127.0.0.1", "::1")


def build_auth() -> tuple[AuthSettings, TatvamOAuthProvider | None, TokenVerifier | None]:
    base = get_settings().public_base_url.rstrip("/")
    oauth = oauth_possible()
    auth = AuthSettings(
        issuer_url=base, resource_server_url=f"{base}/mcp", validate_token_resource=False, required_scopes=["read"],
        client_registration_options=ClientRegistrationOptions(enabled=True, valid_scopes=list(tokens.SCOPES),
                                                              default_scopes=list(tokens.DEFAULT_SCOPES)) if oauth else None,
        revocation_options=RevocationOptions(enabled=True) if oauth else None)
    return (auth, TatvamOAuthProvider(), None) if oauth else (auth, None, PersonalTokenVerifier())
