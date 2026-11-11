# Assistant controller

The phone-side half of the assistant platform: a small Node.js server that runs in Termux,
serves a ChatGPT-style chat page to the phone's browser, keeps every conversation in a local
SQLite file, and talks to any OpenAI-compatible model endpoint (vLLM, llama.cpp, Ollama,
OpenRouter). It has no npm dependencies, so there is nothing to compile on Android.

## Status

Built and tested against a mock model:

- **Chat:** streaming replies, collapsed reasoning, stop, saved history, conversation list.
- **Agent:** the model can call tools over several steps. Every call is validated before
  it runs; a bad call is returned to the model as an error it can correct.
- **Approvals:** anything that changes your files waits for Allow or Decline in the chat.
- **Phone files:** list, read and write, limited to folders you list in Settings.
  Paths and symlinks that lead outside those folders are refused.
- **Memory:** `remember` and `recall` persist facts across conversations.

Not built yet: RunPod start/stop and spend cap, Backblaze B2, ComfyUI, Character and
Video studios, MCP extensions, key encryption and login. See `../docs/PLAN.md`.

Not yet tried on a real phone or with a real model.

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
reasoning separation, stop, reconnecting mid-reply, restart persistence, error reporting,
API-key handling, multi-step tool use, approvals, folder limits and memory.

## Layout

- `src/server.js`: HTTP API, per-conversation event stream, turn runner
- `src/model.js`: OpenAI-compatible streaming client, including tool calls
- `src/tools.js`: tool registry, argument validation, folder limits
- `src/db.js`: SQLite storage
- `public/`: the chat page (plain HTML, CSS and JS, no build step)

## Credit

The event-stream design and the OpenAI-compatible client approach are adapted from
[CodeOut](https://github.com/C9RE/codeout) (MIT, © 2026 C9RE). CodeOut's daemon itself is
not used: it depends on a native terminal library with no Android build.
