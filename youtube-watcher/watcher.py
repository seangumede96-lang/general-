"""The YouTube work: metadata, transcript and key frames for one video."""

from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import yt_dlp
from PIL import Image as PILImage

log = logging.getLogger("youtube-watcher")

# Optional knobs, all set through environment variables.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
MAX_VIDEO_MINUTES = float(os.environ.get("MAX_VIDEO_MINUTES", "180"))
FRAME_WIDTH = int(os.environ.get("FRAME_WIDTH", "640"))
# Netscape-format cookies file and/or proxy URL, for hosts whose IP YouTube blocks.
YT_COOKIES_FILE = os.environ.get("YT_COOKIES_FILE") or None
if not YT_COOKIES_FILE and os.environ.get("YT_COOKIES"):
    # Cookies pasted straight into an environment variable.
    _fd, YT_COOKIES_FILE = tempfile.mkstemp(prefix="yt-cookies-", suffix=".txt")
    with os.fdopen(_fd, "w") as _f:
        _f.write(os.environ["YT_COOKIES"].replace("\\n", "\n"))
YT_PROXY = os.environ.get("YT_PROXY") or None

HARD_MAX_FRAMES = 100
MIN_INTERVAL_SECONDS = 1.0

_whisper_model = None


@dataclass
class VideoResult:
    title: str
    channel: str
    duration: float
    url: str
    transcript_source: str
    transcript: list[tuple[float, str]]
    frames: list[tuple[float, bytes]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _js_runtimes() -> dict:
    """yt-dlp needs a JavaScript runtime to solve YouTube's player challenges."""
    return {name: {} for name in ("deno", "node", "bun") if shutil.which(name)}


def _ydl_opts(**extra) -> dict:
    opts = {"quiet": True, "no_warnings": True, "noprogress": True, "noplaylist": True, "js_runtimes": _js_runtimes()}
    if YT_COOKIES_FILE:
        opts["cookiefile"] = YT_COOKIES_FILE
    if YT_PROXY:
        opts["proxy"] = YT_PROXY
    opts.update(extra)
    return opts


def fmt_ts(seconds: float) -> str:
    s = int(seconds)
    h, m, s = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def get_info(url: str) -> dict:
    with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist":
        raise ValueError("That link is a playlist. Please pass a single video URL.")
    return info


# --- Transcript -----------------------------------------------------------

def _captions_via_api(video_id: str) -> list[tuple[float, str]] | None:
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api.proxies import GenericProxyConfig

    proxy = GenericProxyConfig(http_url=YT_PROXY, https_url=YT_PROXY) if YT_PROXY else None
    api = YouTubeTranscriptApi(proxy_config=proxy)
    transcripts = api.list(video_id)
    # Prefer English, then any manual track, then anything at all.
    try:
        chosen = transcripts.find_transcript(["en", "en-US", "en-GB"])
    except Exception:
        chosen = next(iter(transcripts))
    return [(s.start, " ".join(s.text.split())) for s in chosen.fetch().snippets]


def _captions_via_ytdlp(info: dict) -> list[tuple[float, str]] | None:
    """Fallback that reads the caption track yt-dlp already found (works when the
    transcript API is blocked for the server's IP)."""
    for key in ("subtitles", "automatic_captions"):
        tracks = info.get(key) or {}
        if not tracks:
            continue
        lang = next((l for l in ("en", "en-US", "en-GB", "en-orig") if l in tracks), None)
        if lang is None:
            # For auto captions, pick the original-language track if it is marked.
            lang = next((l for l in tracks if l.endswith("-orig")), next(iter(tracks)))
        fmt = next((f for f in tracks[lang] if f.get("ext") == "json3"), None)
        if not fmt:
            continue
        with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:
            data = json.loads(ydl.urlopen(fmt["url"]).read())
        lines = []
        for ev in data.get("events", []):
            text = " ".join("".join(seg.get("utf8", "") for seg in ev.get("segs") or []).split())
            if text:
                lines.append((ev.get("tStartMs", 0) / 1000, text))
        if lines:
            return lines
    return None


def _transcribe_with_whisper(url: str, workdir: Path) -> list[tuple[float, str]]:
    global _whisper_model
    from faster_whisper import WhisperModel

    opts = _ydl_opts(format="bestaudio/best", outtmpl=str(workdir / "audio.%(ext)s"))
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    audio = next(workdir.glob("audio.*"))
    if _whisper_model is None:
        _whisper_model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    # Decode with ffmpeg ourselves (16 kHz mono float32) rather than through PyAV.
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(audio), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True, check=True,
    ).stdout
    samples = np.frombuffer(pcm, dtype=np.float32)
    # Voice detection skips silence, but it can also drop singing over music; retry without it.
    for vad in (True, False):
        segments, _ = _whisper_model.transcribe(samples, vad_filter=vad)
        lines = [(seg.start, seg.text.strip()) for seg in segments if seg.text.strip()]
        if lines:
            break
    return lines


def get_transcript(info: dict, workdir: Path, notes: list[str]) -> tuple[str, list[tuple[float, str]]]:
    try:
        lines = _captions_via_api(info["id"])
        if lines:
            return "YouTube captions", lines
    except Exception as e:
        log.info("transcript API failed: %s", type(e).__name__)
    try:
        lines = _captions_via_ytdlp(info)
        if lines:
            return "YouTube captions", lines
    except Exception as e:
        log.info("yt-dlp captions failed: %s", e)
    try:
        lines = _transcribe_with_whisper(info["webpage_url"], workdir)
        return f"speech-to-text (faster-whisper {WHISPER_MODEL})", lines
    except Exception as e:
        log.exception("whisper failed")
        notes.append(f"Could not transcribe audio: {e}")
        return "none", []


# --- Frames ---------------------------------------------------------------

def frame_times(duration: float, interval: float, max_frames: int) -> list[float]:
    """Timestamps every `interval` seconds; if that would exceed max_frames,
    spread max_frames evenly across the whole video instead."""
    if duration <= 0 or max_frames <= 0:
        return []
    interval = max(interval, MIN_INTERVAL_SECONDS)
    times = []
    t = 0.0
    while t < duration and len(times) <= max_frames:
        times.append(t)
        t += interval
    if len(times) > max_frames:
        step = duration / max_frames
        times = [i * step for i in range(max_frames)]
    return times


def _to_jpeg(img: PILImage.Image) -> bytes:
    img = img.convert("RGB")
    if img.width > FRAME_WIDTH:
        img = img.resize((FRAME_WIDTH, round(img.height * FRAME_WIDTH / img.width)), PILImage.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return buf.getvalue()


def grab_storyboard_frames(info: dict, times: list[float]) -> list[tuple[float, bytes]]:
    """Fallback: cut frames out of YouTube's seek-bar preview sprites. They are small
    (usually 320x180) but load even when YouTube refuses the video stream itself."""
    boards = [f for f in info.get("formats") or [] if f.get("format_note") == "storyboard" and f.get("fragments")]
    if not boards:
        return []
    sb = max(boards, key=lambda f: f.get("width") or 0)
    rows, cols, w, h = sb["rows"], sb["columns"], sb["width"], sb["height"]
    per_sheet = rows * cols
    # Each fragment (sprite sheet) covers `duration` seconds split evenly across its tiles.
    starts, t0 = [], 0.0
    for frag in sb["fragments"]:
        starts.append(t0)
        t0 += frag.get("duration") or 0
    sheets: dict[int, PILImage.Image] = {}
    frames = []
    with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:
        for t in times:
            i = max(k for k, start in enumerate(starts) if start <= t) if t >= starts[0] else 0
            frag = sb["fragments"][i]
            seconds_per_tile = (frag.get("duration") or 1) / per_sheet
            tile = min(int((t - starts[i]) / seconds_per_tile), per_sheet - 1)
            if i not in sheets:
                sheets[i] = PILImage.open(io.BytesIO(ydl.urlopen(frag["url"]).read()))
            sheet = sheets[i]
            r, c = divmod(tile, cols)
            if (r + 1) * h > sheet.height or (c + 1) * w > sheet.width:
                continue
            frames.append((t, _to_jpeg(sheet.crop((c * w, r * h, (c + 1) * w, (r + 1) * h)))))
    return frames


def grab_frames(url: str, times: list[float], workdir: Path) -> list[tuple[float, bytes]]:
    # A small video-only rendition is plenty for 640px stills and keeps downloads fast.
    opts = _ydl_opts(
        format="bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/wv*/w",
        outtmpl=str(workdir / "video.%(ext)s"),
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    video = next(workdir.glob("video.*"))

    frames = []
    for t in times:
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video),
             "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
            capture_output=True, timeout=60,
        )
        if proc.returncode != 0 or not proc.stdout:
            continue
        frames.append((t, _to_jpeg(PILImage.open(io.BytesIO(proc.stdout)))))
    return frames


# --- Entry point ----------------------------------------------------------

def watch(url: str, frame_interval_seconds: float = 10, max_frames: int = 20) -> VideoResult:
    url = url.strip()
    if not re.match(r"^https?://", url):
        url = f"https://www.youtube.com/watch?v={url}"
    max_frames = max(0, min(int(max_frames), HARD_MAX_FRAMES))

    info = get_info(url)
    duration = float(info.get("duration") or 0)
    if info.get("is_live"):
        raise ValueError("Live streams are not supported. Try again once the stream has ended.")
    if duration > MAX_VIDEO_MINUTES * 60:
        raise ValueError(
            f"Video is {fmt_ts(duration)} long; this server is limited to {MAX_VIDEO_MINUTES:g} minutes."
        )

    notes: list[str] = []
    with tempfile.TemporaryDirectory(prefix="ytw-") as tmp:
        workdir = Path(tmp)
        source, transcript = get_transcript(info, workdir, notes)
        frames = []
        times = frame_times(duration, float(frame_interval_seconds), max_frames)
        if times:
            try:
                frames = grab_frames(info["webpage_url"], times, workdir)
            except Exception as e:
                log.warning("video download failed, using storyboard frames: %s", e)
                try:
                    frames = grab_storyboard_frames(info, times)
                    if frames:
                        notes.append("YouTube refused the full video download from this server, so frames "
                                     "come from YouTube's low-resolution seek-bar previews.")
                    else:
                        notes.append("YouTube refused the full video download from this server and the "
                                     "video has no seek-bar previews, so no frames are available.")
                except Exception as e2:
                    log.exception("storyboard fallback failed")
                    notes.append(f"Could not grab frames: {e2}")

    return VideoResult(
        title=info.get("title") or "",
        channel=info.get("channel") or info.get("uploader") or "",
        duration=duration,
        url=info.get("webpage_url") or url,
        transcript_source=source,
        transcript=transcript,
        frames=frames,
        notes=notes,
    )
