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
- **GPU control (System page):** rents a RunPod pod only after showing the worst-case
  price, refuses anything over the remaining budget or the per-pod time limit, allows one
  pod at a time, and deletes it when idle, when its time is up, or on request. Each pod
  also carries its own timer to delete itself if the phone goes offline. Every pod is
  recorded in a cost ledger; RunPod's actual bill replaces the estimate when available.
  Pods on the account that this app did not start are flagged.
- **Private brain (System page):** starts a pod running llama.cpp with a GGUF model from
  Hugging Face, locked with a random key. Chat switches to it when the model has loaded
  and falls back to the Settings endpoint when it is off. Chatting counts as activity;
  ten quiet minutes shut it down.

Not built yet: ComfyUI on the pod, Backblaze B2, Character
and Video studios, MCP extensions, key encryption and login. See `../docs/PLAN.md`.

Tried on a real phone (realme RMX3834, Android 15, Ubuntu proot inside Termux): all tests
pass and the page loads in Chrome. Not yet tried with a real model or the real RunPod
API. To confirm with real pods: that the pod's own self-delete timer works with the key
RunPod injects, that the ledger matches RunPod's billing, and that the llama.cpp image
starts with the command used here and the default model name resolves.

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
API-key handling, multi-step tool use, approvals, folder limits, memory, and the pod
lifecycle (budget refusals, idle and deadline shutdown, billing reconciliation) against a
mock RunPod API.

## Layout

- `src/server.js`: HTTP API, per-conversation event stream, turn runner
- `src/model.js`: OpenAI-compatible streaming client, including tool calls
- `src/tools.js`: tool registry, argument validation, folder limits
- `src/gpu.js`: RunPod pod lifecycle, budget checks, cost ledger (REST API v2)
- `src/db.js`: SQLite storage
- `public/`: the chat page (plain HTML, CSS and JS, no build step)

## Credit

The event-stream design and the OpenAI-compatible client approach are adapted from
[CodeOut](https://github.com/C9RE/codeout) (MIT, © 2026 C9RE). CodeOut's daemon itself is
not used: it depends on a native terminal library with no Android build.
