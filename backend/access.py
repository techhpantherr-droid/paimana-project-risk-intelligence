"""Shared-token access gate.

The site is safe to open on a public tunnel only if something stands in front of
it. This adds one gate: a single shared token, exchanged for a signed session
cookie, enforced by middleware on every route.

Deliberately simple, and deliberately not a user system. There are no accounts
and no roles, because the requirement is "do not publish every figure on the
internet by accident", not "manage identity". Two properties matter more than
features:

* the token is compared in constant time, so a wrong token cannot be discovered
  one character at a time by timing the response;
* the cookie is signed with its own secret, so forging a session does not
  require knowing the token at all, and the token itself never has to be stored
  anywhere the browser can read it.

Set PAIMANA_ACCESS_TOKEN to enable the gate. Unset, the app is open, which is
the right default for local work and the wrong one for a tunnel.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse, Response

COOKIE = "paimana_session"
# short enough that a leaked link stops working on its own, long enough that a
# normal reading session is never interrupted
SESSION_SECONDS = 8 * 60 * 60
MAX_ATTEMPTS = 10
LOCKOUT_SECONDS = 300

PUBLIC_PATHS = {"/api/login", "/api/logout", "/api/session", "/api/health"}


def token() -> str:
    return os.environ.get("PAIMANA_ACCESS_TOKEN", "").strip()


def enabled() -> bool:
    return bool(token())


def _secret() -> bytes:
    """The signing key. Kept beside the database so it survives a restart, since
    an ephemeral key would silently sign everyone out on every reload."""
    path = Path(__file__).resolve().parents[1] / "data" / ".session_secret"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(32), encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass  # not fatal on Windows
    return path.read_text(encoding="utf-8").strip().encode()


def _sign(expiry: int) -> str:
    payload = f"{expiry}"
    digest = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{digest}"


def verify_cookie(value: str | None) -> bool:
    if not value or "." not in value:
        return False
    payload, _, digest = value.rpartition(".")
    try:
        expiry = int(payload)
    except ValueError:
        return False
    if time.time() > expiry:
        return False
    expected = _sign(expiry)
    # both comparisons constant time: a mismatch anywhere means no session
    return hmac.compare_digest(expected, value)


def check_token(candidate: str) -> bool:
    return hmac.compare_digest(token(), candidate or "")


# crude in-process throttle. Enough to make online guessing tedious; a real
# deployment would use a shared store so the count survives restarts.
_attempts: dict[str, list[float]] = {}


def throttled(client: str) -> bool:
    now = time.time()
    hits = [t for t in _attempts.get(client, []) if now - t < LOCKOUT_SECONDS]
    _attempts[client] = hits
    return len(hits) >= MAX_ATTEMPTS


def record_failure(client: str) -> None:
    _attempts.setdefault(client, []).append(time.time())


def set_cookie(response: Response) -> None:
    response.set_cookie(
        COOKIE,
        _sign(int(time.time()) + SESSION_SECONDS),
        max_age=SESSION_SECONDS,
        httponly=True,
        samesite="lax",
        # sent over https to the tunnel, not over plain http to localhost
        secure=os.environ.get("PAIMANA_INSECURE_COOKIE", "") != "1",
    )


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE)


def client_of(request: Request) -> str:
    # behind ngrok the peer is the tunnel, so the forwarded header is what
    # identifies the caller. Spoofable when exposed directly, which only costs an
    # attacker their own throttle bucket.
    return (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (request.client.host if request.client else "unknown"))


def login_page(message: str = "") -> Response:
    """A standalone page, so the gate works even before the SPA bundle loads.

    The message is passed through unescaped on purpose: it is a fixed string this
    module produces, never anything derived from the request.
    """
    return _page(f'<p class="note">{message}</p>' if message else "")


def _page(note: str) -> Response:
    return Response(
        content=f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRAGATI-AI &middot; sign in</title>
<style>
  :root {{ color-scheme: light; }}
  body {{ margin:0; min-height:100vh; display:grid; place-items:center;
         background:#f4f6fa; font:15px/1.55 "Segoe UI",system-ui,sans-serif; color:#12203a; }}
  .box {{ width:min(400px,92vw); background:#fff; padding:32px; border-radius:10px;
          box-shadow:0 1px 3px rgba(18,32,58,.08),0 12px 32px rgba(18,32,58,.07);
          border:1px solid #e2e7f0; }}
  h1 {{ margin:0 0 4px; font-size:20px; letter-spacing:-.01em; }}
  h1 span {{ color:#0a3d9e; }}
  .sub {{ margin:0 0 22px; color:#5b6b85; font-size:13px; }}
  label {{ display:block; font-size:12px; font-weight:600; color:#41506b;
           text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }}
  input {{ width:100%; box-sizing:border-box; padding:11px 12px; font-size:15px;
           border:1px solid #cbd3e1; border-radius:6px; }}
  input:focus {{ outline:2px solid #0a3d9e33; border-color:#0a3d9e; }}
  button {{ margin-top:16px; width:100%; padding:11px 12px; font-size:15px; font-weight:600;
            color:#fff; background:#012677; border:0; border-radius:6px; cursor:pointer; }}
  button:hover {{ background:#0a3d9e; }}
  .note {{ margin:16px 0 0; padding:9px 11px; font-size:13px; border-radius:6px;
           background:#fdf1f1; color:#8c1d18; border:1px solid #f3d4d2; }}
  footer {{ margin-top:20px; font-size:11px; color:#7b8aa3; text-align:center; }}
</style></head>
<body><form class="box" method="post" action="/api/login">
  <h1>PRAGATI<span>-AI</span></h1>
  <p class="sub">Public Investment Infrastructure Monitoring System</p>
  <label for="t">Access token</label>
  <input id="t" name="token" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
  {note}
  <footer>Authorised access only. Figures are from the PAIMANA published extract.</footer>
</form></body></html>""",
        media_type="text/html",
    )