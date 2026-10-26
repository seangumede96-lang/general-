# YouTube Watcher (MCP server)

Lets Claude "watch" a YouTube video. One tool:

**`watch_youtube(url, frame_interval_seconds=10, max_frames=20)`** returns

- title, channel and length
- the full transcript with timestamps. It tries YouTube's own captions first
  (`youtube-transcript-api`, then yt-dlp's caption track). If the video has no
  captions, it downloads the audio and transcribes it with `faster-whisper`.
- key frames as JPEG images (640 px wide), one every `frame_interval_seconds`.
  If that would be more than `max_frames` (max 100), the frames are spread
  evenly across the whole video instead. If YouTube refuses the video download,
  the server falls back to YouTube's small seek-bar preview images.

## Files

| File | What it does |
|---|---|
| `server.py` | MCP server: streamable HTTP with OAuth (remote) or stdio (local) |
| `watcher.py` | The YouTube work: metadata, transcript, frames |
| `oauth.py` | Single-user OAuth login (password page) for claude.ai connectors |
| `Dockerfile` | Image used for deployment (Python + ffmpeg + Node.js) |

## Security

The remote server is protected by OAuth. When you add it to claude.ai, a sign-in
page opens and asks for your **access password** (the `ACCESS_PASSWORD`
setting). Tokens are signed, so they survive restarts and redeploys. To log out
every client, set a new `SIGNING_KEY` (or change the password) and redeploy.

The password also works as a plain bearer token
(`Authorization: Bearer <ACCESS_PASSWORD>`), for clients like Claude Code.

## Deploy on Railway (about $5/month)

1. Go to <https://railway.com>, click **Login**, and choose **Login with GitHub**.
2. Choose the **Hobby** plan ($5/month, includes $5 of usage, which should
   cover this server).
3. Click **New Project** → **Deploy from GitHub repo**. If asked, let Railway's
   GitHub app see your `general-` repo. Pick that repo.
4. Open the new service → **Settings**:
   - **Source → Root Directory**: `/youtube-watcher`
   - **Networking → Generate Domain**. If it asks for a port, enter `8000`.
5. Open **Variables** and add two variables:
   - `ACCESS_PASSWORD` = a long random password (at least 16 characters)
   - `PORT` = `8000`
6. Railway redeploys. When it shows **Active**, open
   `https://<your-domain>/health` in a browser. It should say `{"ok":true}`.

Your connector URL is `https://<your-domain>/mcp`.

## Add it to claude.ai

1. claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Name: `YouTube Watcher`. URL: `https://<your-domain>/mcp`. Click **Add**.
3. Click **Connect**. A sign-in page opens. Type your access password and click **Allow**.
4. In a chat, open the **+ / tools** menu and make sure YouTube Watcher is on.
   Then ask something like "Watch https://youtu.be/... and summarize it."

## Use it in Claude Code

This repo's `.mcp.json` runs the server locally over stdio (needs `uv`, `ffmpeg`
and Node.js). To use the deployed server instead:

```
claude mcp add --transport http youtube-watcher https://<your-domain>/mcp \
  --header "Authorization: Bearer <ACCESS_PASSWORD>"
```

## Settings (environment variables)

| Name | Default | Meaning |
|---|---|---|
| `ACCESS_PASSWORD` | required | Password for the sign-in page; also a bearer token |
| `SIGNING_KEY` | = password | Secret that signs tokens |
| `PUBLIC_URL` | auto on Railway/Render | Public https URL of the server |
| `WHISPER_MODEL` | `base` | `tiny` is faster and uses less memory, `small` is more accurate |
| `MAX_VIDEO_MINUTES` | `180` | Longest video accepted |
| `YT_COOKIES` | none | Contents of a YouTube `cookies.txt`, if YouTube blocks the server |
| `YT_COOKIES_FILE` | none | Path to a `cookies.txt` instead |
| `YT_PROXY` | none | Proxy URL for YouTube requests, e.g. `http://user:pass@host:port` |

## If YouTube says "Sign in to confirm you're not a bot"

YouTube sometimes blocks cloud servers. Captions usually still work, but video
and audio downloads may fail. Fixes, simplest first:

1. **Redeploy** from Railway (Deployments → ⋮ → Redeploy). This also picks up
   the newest yt-dlp, which YouTube changes often break.
2. **Cookies**: in a private browser window, sign in to YouTube with a spare
   Google account (not your main one), export cookies with a "Get cookies.txt"
   extension, and paste the file's contents into a `YT_COOKIES` variable.
3. **Proxy**: set `YT_PROXY` to a residential proxy.

## Run locally

```
pip install -r requirements.txt     # plus ffmpeg and Node.js on your PATH
ACCESS_PASSWORD=some-long-password PUBLIC_URL=http://localhost:8000 python server.py
python server.py --stdio            # stdio mode, no auth
```
