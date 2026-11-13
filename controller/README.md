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
- **Attachments:** a + button in the message box attaches photos, videos and files (up to
  10 per message, 2 GB each), with upload progress and previews. The model is told each
  file's name, type and saved location and can read attached text files; it does not yet
  look inside images or videos.
- **Characters page:** image sessions with Krea 2 Turbo, a style LoRA and the same-face
  method, following the recipe worked out by hand on 11 November 2026 (8 steps, cfg 1,
  euler/simple; face reference shrunk to 0.14 megapixels through the ostris edit nodes
  with the krea2-reid LoRA). A session rents one GPU, loads LoRAs from the `loras/` folder
  of your Backblaze bucket through one-hour links (keys never leave the phone), and stays
  up for picture after picture until idle. Results are saved on the phone and can be used
  as the face to keep or as the character in the Video Studio. **Tested against mocks
  only so far.**
- **Video Studio (Video page):** character replacement. Pick a clip and a picture of the
  character, confirm you may use the footage, see the worst-case price, and the app rents
  a GPU, installs the video engine (ComfyUI with Wan 2.2 Animate), runs the job, saves the
  result to the phone and deletes the pod. Clips are trimmed to 10 seconds for now. Style
  transfer is not built. **Tested only against a mock engine so far**: the pod setup and
  the workflow have not yet run on a real GPU, and the time and price figures are estimates.
- **Body editor (Body page, from Characters):** a 3D mannequin, female or male base, that
  reshapes live as you drag: vertical sliders for height, neck, torso, leg and arm length;
  horizontal sliders for head, neck width, shoulders, chest, bust, waist, hips, glutes,
  thighs, calves and arm thickness; body-type presets, head shapes, and saved bodies. "Use
  this body" renders it at the picture's size and the next pictures start from that shape,
  partly repainted ("Follow shape" sets how tightly). Proportions carry over closely, not
  exactly. Uses three.js (MIT), included in `public/vendor/three`.
- **Model picker:** a chip in the message box shows which model will answer. Tapping it
  lists the free everyday models from the Settings endpoint and four private models; a
  private model shows its worst-case price and wakes only on a second tap.
- **GPU control (System page):** rents a RunPod pod only after showing the worst-case
  price, refuses anything over the real RunPod balance (or your optional cap) or the per-pod time limit, allows one
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

Proven for real on 12 November 2026 (realme RMX3834, Android 15, Ubuntu proot in Termux):

- All tests pass on the phone and the page loads in Chrome.
- A real pod started through the app deleted itself 7 minutes after creation with the app
  switched off, so the self-delete timer works with the key RunPod injects.
- The private brain (Qwen 3.6 35B on llama.cpp) became ready 5 minutes after creation and
  answered four chats in 4 to 12 seconds each, using file and memory tools correctly.
- The balance read matches RunPod's own figure exactly.

Still unproven: whether Android leaves the app running for hours in the background, how the
ledger compares with RunPod's final bill, and the other three private models.

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

## Keep it running

Android may stop Termux in the background (some phones do this aggressively). Two scripts
make the app come back by itself:

- `bin/keep-running.sh` (inside Ubuntu) restarts the app within seconds whenever it stops,
  and records each stop in `~/.assistant-controller/restarts.log`.
- `bin/termux-start.sh` (copied to Termux's home) starts the above if the app is not
  answering. Run it from `~/.bashrc` so opening Termux starts the app, and from
  `~/.termux/boot/` (Termux:Boot app) so it starts when the phone does.

To restart for an update without cutting anything off, create
`~/.assistant-controller/restart-when-idle`: the app exits once no GPU, job or reply is
running, and `keep-running.sh` starts the new version.

If the engine is down anyway, the page shows "The assistant is not running" with an
Open Termux button instead of a browser error, and reloads by itself when it is back.

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
- `src/images.js`, `src/image-recipe.js`, `src/b2.js`: Characters page engine, its pod setup
  and ComfyUI graph, and Backblaze links
- `src/video.js`, `src/video-recipe.js`, `src/comfy.js`: Video Studio job runner, the pod
  setup and workflow it uses, and the client for the video engine's API
- `src/db.js`: SQLite storage
- `public/`: the chat page (plain HTML, CSS and JS, no build step)

## Video engine sources

The Video Studio's pod setup follows the Dockerfile of
[wlsdml1114/Wan_Animate_Runpod_hub](https://github.com/wlsdml1114/Wan_Animate_Runpod_hub),
and its workflow file is downloaded from that project at a pinned commit (it is not copied
into this repository, because that project states no licence). The setup installs
third-party ComfyUI add-ons and models on the rented pod only; nothing from them runs on
the phone. The pod's address is not password-protected while a job runs.

## Credit

The event-stream design and the OpenAI-compatible client approach are adapted from
[CodeOut](https://github.com/C9RE/codeout) (MIT, © 2026 C9RE). CodeOut's daemon itself is
not used: it depends on a native terminal library with no Android build.
