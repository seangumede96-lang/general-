# Assistant controller

The phone-side half of the assistant platform: a small Node.js server that runs in Termux,
serves a ChatGPT-style chat page to the phone's browser, keeps every conversation in a local
SQLite file, and talks to any OpenAI-compatible model endpoint (vLLM, llama.cpp, Ollama,
OpenRouter). It has no npm dependencies, so there is nothing to compile on Android.

## Status

Milestone 1 of 6 (chat foundation). Working: streaming replies, collapsed reasoning
(`<think>` tags or native reasoning deltas), stop, saved history, conversation list,
endpoint/key/model settings. A reply keeps generating and is saved if the phone sleeps or the
page reloads.

Not built yet: RunPod start/stop, Backblaze B2 model library, tools and approvals, MCP,
long-term memory, key encryption and login.

## Run it

Needs Node.js 22.13 or newer.

```sh
# Termux
pkg install nodejs git
git clone <this repo> && cd general-/controller
npm start
```

Open http://127.0.0.1:8400, go to Settings, enter the model endpoint, and press
**Test connection**.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8400` | Port to listen on |
| `HOST` | `127.0.0.1` | Listen address. There is no login yet, so leave this on localhost. |
| `ASSISTANT_DATA_DIR` | `~/.assistant-controller` | Where the database lives |

To try the UI without a real model, run `node test/mock-model.js` and use the address it
prints as the model endpoint.

## Test

```sh
npm test
```

The tests start the server against a scripted mock model and cover streaming, history,
reasoning separation, stop, reconnecting mid-reply, restart persistence, error reporting and
API-key handling.

## Layout

- `src/server.js`: HTTP API, per-conversation event stream, turn runner
- `src/model.js`: OpenAI-compatible streaming client
- `src/db.js`: SQLite storage
- `public/`: the chat page (plain HTML, CSS and JS, no build step)

## Credit

The event-stream design and the OpenAI-compatible client approach are adapted from
[CodeOut](https://github.com/C9RE/codeout) (MIT, © 2026 C9RE). CodeOut's daemon itself is
not used: it depends on a native terminal library with no Android build.
