"""A small, single-user OAuth server for claude.ai custom connectors.

The only "account" is the server owner, who proves themselves by typing
ACCESS_PASSWORD on a login page. Client IDs, access tokens and refresh tokens
are HMAC-signed blobs rather than database rows, so nothing is lost when the
server restarts or redeploys and no database is needed.

The same password also works directly as a bearer token
(`Authorization: Bearer <ACCESS_PASSWORD>`), which is how Claude Code connects.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import secrets
import time

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

ACCESS_TOKEN_TTL = 24 * 3600
REFRESH_TOKEN_TTL = 90 * 24 * 3600
CODE_TTL = 300
LOGIN_TTL = 900
SCOPE = "youtube"


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class SingleUserOAuthProvider:
    def __init__(self, password: str, signing_key: str, login_path: str = "/login"):
        self.password = password
        self.key = hashlib.sha256(("ytw-signing:" + signing_key).encode()).digest()
        self.login_path = login_path
        self.codes: dict[str, AuthorizationCode] = {}
        self.failed_logins: list[float] = []

    # --- signing helpers ---------------------------------------------------

    def _sign(self, kind: str, payload: dict) -> str:
        body = _b64e(json.dumps({"k": kind, **payload}, separators=(",", ":")).encode())
        sig = _b64e(hmac.new(self.key, body.encode(), hashlib.sha256).digest()[:24])
        return f"{body}.{sig}"

    def _unsign(self, kind: str, token: str) -> dict | None:
        try:
            body, sig = token.rsplit(".", 1)
            want = _b64e(hmac.new(self.key, body.encode(), hashlib.sha256).digest()[:24])
            if not hmac.compare_digest(sig, want):
                return None
            data = json.loads(_b64d(body))
        except Exception:
            return None
        if data.get("k") != kind:
            return None
        if "exp" in data and data["exp"] < time.time():
            return None
        return data

    def _issue(self, client_id: str, scopes: list[str], resource: str | None) -> OAuthToken:
        now = int(time.time())
        common = {"c": client_id, "s": scopes, "r": resource, "n": secrets.token_hex(8)}
        return OAuthToken(
            access_token=self._sign("at", {**common, "exp": now + ACCESS_TOKEN_TTL}),
            refresh_token=self._sign("rt", {**common, "exp": now + REFRESH_TOKEN_TTL}),
            expires_in=ACCESS_TOKEN_TTL,
            scope=" ".join(scopes),
        )

    # --- client registration ------------------------------------------------

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if not client_info.redirect_uris:
            raise RegistrationError("invalid_redirect_uri", "redirect_uris is required")
        # Public clients only (PKCE protects the code exchange).
        client_info.token_endpoint_auth_method = "none"
        client_info.client_secret = None
        client_info.scope = SCOPE
        meta = {"u": [str(u) for u in client_info.redirect_uris], "n": client_info.client_name}
        client_info.client_id = "ytw." + self._sign("cl", meta)

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        if not client_id.startswith("ytw."):
            return None
        data = self._unsign("cl", client_id[4:])
        if data is None:
            return None
        return OAuthClientInformationFull(
            client_id=client_id,
            redirect_uris=data["u"],
            client_name=data.get("n"),
            scope=SCOPE,
            token_endpoint_auth_method="none",
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
        )

    # --- authorization ------------------------------------------------------

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        pending = self._sign("lg", {
            "exp": int(time.time()) + LOGIN_TTL,
            "c": client.client_id,
            "n": client.client_name,
            "ru": str(params.redirect_uri),
            "rx": params.redirect_uri_provided_explicitly,
            "st": params.state,
            "cc": params.code_challenge,
            "s": params.scopes or [SCOPE],
            "r": params.resource,
        })
        return f"{self.login_path}?req={pending}"

    async def login_page(self, request: Request) -> Response:
        if request.method == "GET":
            req = request.query_params.get("req", "")
            data = self._unsign("lg", req)
            if data is None:
                return HTMLResponse(_page("This sign-in link has expired. Go back to Claude and try connecting again."), 400)
            return HTMLResponse(_login_form(req, data.get("n") or "Claude", error=None))

        form = await request.form()
        req = str(form.get("req", ""))
        data = self._unsign("lg", req)
        if data is None:
            return HTMLResponse(_page("This sign-in link has expired. Go back to Claude and try connecting again."), 400)

        now = time.time()
        self.failed_logins = [t for t in self.failed_logins if now - t < 600]
        if len(self.failed_logins) >= 10:
            return HTMLResponse(_page("Too many wrong passwords. Wait 10 minutes and try again."), 429)
        if not hmac.compare_digest(str(form.get("password", "")).encode(), self.password.encode()):
            self.failed_logins.append(now)
            return HTMLResponse(_login_form(req, data.get("n") or "Claude", error="Wrong password."), 401)

        code = secrets.token_urlsafe(32)
        self.codes = {k: v for k, v in self.codes.items() if v.expires_at > now}
        self.codes[code] = AuthorizationCode(
            code=code,
            scopes=data["s"],
            expires_at=now + CODE_TTL,
            client_id=data["c"],
            code_challenge=data["cc"],
            redirect_uri=data["ru"],
            redirect_uri_provided_explicitly=data["rx"],
            resource=data.get("r"),
            subject="owner",
        )
        return RedirectResponse(construct_redirect_uri(data["ru"], code=code, state=data.get("st")), 302)

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str):
        code = self.codes.get(authorization_code)
        if code and code.client_id == client.client_id and code.expires_at > time.time():
            return code
        return None

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code) -> OAuthToken:
        if self.codes.pop(authorization_code.code, None) is None:
            raise TokenError("invalid_grant", "authorization code already used")
        return self._issue(client.client_id, authorization_code.scopes, authorization_code.resource)

    # --- tokens -------------------------------------------------------------

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str):
        data = self._unsign("rt", refresh_token)
        if data is None or data["c"] != client.client_id:
            return None
        return RefreshToken(token=refresh_token, client_id=data["c"], scopes=data["s"],
                            expires_at=data["exp"], resource=data.get("r"), subject="owner")

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token, scopes: list[str]) -> OAuthToken:
        return self._issue(client.client_id, scopes or refresh_token.scopes, refresh_token.resource)

    async def load_access_token(self, token: str) -> AccessToken | None:
        if hmac.compare_digest(token.encode(), self.password.encode()):
            return AccessToken(token=token, client_id="direct", scopes=[SCOPE], subject="owner")
        data = self._unsign("at", token)
        if data is None:
            return None
        return AccessToken(token=token, client_id=data["c"], scopes=data["s"],
                           expires_at=data["exp"], resource=data.get("r"), subject="owner")

    async def revoke_token(self, token) -> None:
        # Tokens are stateless; to cut off every client, change SIGNING_KEY.
        return None

    async def exchange_identity_assertion(self, client, params) -> OAuthToken:
        raise TokenError("unsupported_grant_type")


def _page(body_html: str) -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YouTube Watcher</title>
<style>
body{{font-family:system-ui,sans-serif;background:#f6f6f4;color:#222;display:flex;justify-content:center;padding:48px 16px;margin:0}}
.card{{background:#fff;max-width:380px;width:100%;padding:28px;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}}
h1{{font-size:20px;margin:0 0 8px}} p{{color:#555;line-height:1.5}}
input{{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px;margin:8px 0 16px}}
button{{width:100%;padding:11px;font-size:16px;border:0;border-radius:8px;background:#c4302b;color:#fff;cursor:pointer}}
.err{{color:#c4302b}}
</style></head><body><div class="card">{body_html}</div></body></html>"""


def _login_form(req: str, client_name: str, error: str | None) -> str:
    err = f'<p class="err">{html.escape(error)}</p>' if error else ""
    return _page(f"""<h1>YouTube Watcher</h1>
<p><b>{html.escape(client_name)}</b> wants to use your YouTube Watcher. Enter your access password to allow it.</p>
{err}<form method="post">
<input type="hidden" name="req" value="{html.escape(req)}">
<input type="password" name="password" placeholder="Access password" autofocus required>
<button type="submit">Allow</button></form>""")
