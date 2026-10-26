"""YouTube Watcher MCP server.

Run modes:
  python server.py            remote server over streamable HTTP (needs env vars below)
  python server.py --stdio    local server for Claude Code / Claude Desktop, no auth

Environment (HTTP mode):
  PUBLIC_URL       public https URL of this server (detected automatically on Railway and Render)
  ACCESS_PASSWORD  password typed on the sign-in page; also accepted as a bearer token
  SIGNING_KEY      random secret used to sign tokens (defaults to ACCESS_PASSWORD)
  PORT             port to listen on (default 8000)
"""

from __future__ import annotations

import logging
import os
import sys

import anyio
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.mcpserver.utilities.types import Image
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import JSONResponse

import watcher
from oauth import SCOPE, SingleUserOAuthProvider

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")

STDIO = "--stdio" in sys.argv
PUBLIC_URL = (
    os.environ.get("PUBLIC_URL")
    or (os.environ.get("RAILWAY_PUBLIC_DOMAIN") and f"https://{os.environ['RAILWAY_PUBLIC_DOMAIN']}")
    or os.environ.get("RENDER_EXTERNAL_URL")
    or "http://localhost:8000"
).rstrip("/")

provider = None
auth = None
if not STDIO:
    password = os.environ.get("ACCESS_PASSWORD", "")
    if len(password) < 16:
        sys.exit("Set ACCESS_PASSWORD to a random string of at least 16 characters.")
    provider = SingleUserOAuthProvider(password, os.environ.get("SIGNING_KEY") or password)
    auth = AuthSettings(
        issuer_url=PUBLIC_URL,
        resource_server_url=f"{PUBLIC_URL}/mcp",
        client_registration_options=ClientRegistrationOptions(
            enabled=True, valid_scopes=[SCOPE], default_scopes=[SCOPE]
        ),
        required_scopes=[SCOPE],
        validate_token_resource=False,
    )

mcp = MCPServer(
    name="youtube-watcher",
    title="YouTube Watcher",
    instructions=(
        "Use watch_youtube to 'watch' a YouTube video: it returns the title, channel, length, "
        "a timestamped transcript and still frames from the video."
    ),
    auth_server_provider=provider,
    auth=auth,
)


@mcp.tool(
    title="Watch a YouTube video",
    annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True),
    structured_output=False,
)
async def watch_youtube(url: str, frame_interval_seconds: float = 10, max_frames: int = 20) -> list:
    """Watch a YouTube video. Returns its title, channel and length, the full transcript
    with timestamps (YouTube captions, or speech-to-text when the video has none), and
    key frames as images taken every `frame_interval_seconds` (at most `max_frames`;
    for long videos the frames are spread evenly across the whole video instead).

    Args:
        url: YouTube video URL (youtube.com/watch, youtu.be, shorts) or video ID.
        frame_interval_seconds: Seconds between frames. Default 10.
        max_frames: Maximum number of frames to return (0 for transcript only, up to 100). Default 20.
    """
    try:
        result = await anyio.to_thread.run_sync(watcher.watch, url, frame_interval_seconds, max_frames)
    except ValueError as e:
        raise ToolError(str(e)) from e
    except Exception as e:
        logging.exception("watch_youtube failed")
        msg = str(e).removeprefix("ERROR: ")
        if "not a bot" in msg or "Sign in to confirm" in msg:
            msg = ("YouTube is blocking this server's IP address with a bot check. The server owner can fix "
                   "this by setting YT_COOKIES_FILE or YT_PROXY (see the README).")
        raise ToolError(msg) from e

    lines = [
        f"Title: {result.title}",
        f"Channel: {result.channel}",
        f"Length: {watcher.fmt_ts(result.duration)}",
        f"URL: {result.url}",
        f"Frames: {len(result.frames)} (each image is preceded by its timestamp)",
        *(f"Note: {n}" for n in result.notes),
        "",
        f"Transcript (source: {result.transcript_source}):",
    ]
    if result.transcript:
        lines += [f"[{watcher.fmt_ts(t)}] {text}" for t, text in result.transcript]
    else:
        lines.append("(no transcript available)")

    content: list = ["\n".join(lines)]
    for t, jpeg in result.frames:
        content.append(f"Frame at {watcher.fmt_ts(t)}")
        content.append(Image(data=jpeg, format="jpeg"))
    return content


@mcp.custom_route("/", methods=["GET"])
async def home(request: Request) -> JSONResponse:
    return JSONResponse({"name": "youtube-watcher", "mcp_endpoint": f"{PUBLIC_URL}/mcp"})


@mcp.custom_route("/health", methods=["GET"])
async def health(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


if provider is not None:
    mcp.custom_route("/login", methods=["GET", "POST"])(provider.login_page)


if __name__ == "__main__":
    if STDIO:
        mcp.run()
    else:
        import uvicorn

        app = mcp.streamable_http_app(
            stateless_http=True,
            json_response=True,
            transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
            host="0.0.0.0",
        )
        uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")),
                    proxy_headers=True, forwarded_allow_ips="*")
