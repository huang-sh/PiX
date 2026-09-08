<p align="center">
  <img src="resources/icon.png" width="180" alt="PiX logo">
</p>

<h1 align="center">PiX</h1>

<p align="center">A non-linear AI agent workbench — sessions are graphs: branch anytime, and context follows the branch</p>

<p align="center">English · <a href="README.md">中文</a></p>

---

<p align="center">
  <img src="pix-session-tree.png" alt="PiX session graph with branches growing left to right">
</p>

A PiX session is not a line — it is a graph that keeps growing: every conversation turn is a node, and any node can sprout a new branch at any time.

## Non-linear sessions

A traditional AI chat is a single timeline: to change direction you either start over or keep piling questions onto the same thread until the context becomes a mess.

PiX organizes a session as a graph that grows left to right:

- Every turn (your prompt plus the assistant's reply and tool calls) is a node on the graph.
- Several directions can live on the same graph — switch to another branch at any time and keep going, without interference.
- When a path works out, keep going deeper; dead ends stay on the graph, and you can always come back and try another route.
- Sessions are real Pi sessions — no new format — so they remain usable outside PiX.

## Branch anytime

Branching is an everyday action in PiX, not something you have to plan ahead:

- **Fork from any user message**: unhappy with an answer? Fork a new branch from that turn with a different prompt or approach — the original branch stays untouched.
- **Continue from a turn**: select any earlier node on the graph and pick up the conversation from that moment.
- **Clone the active branch**: clone the current branch as a save point and experiment freely. Every branch stays visible on the graph, ready to switch back to at any time.

## Context follows the branch

Switching branches never means re-setting up context — context is part of the branch:

- The **branch chat panel** shows only the messages of the active branch. Switch to another branch and the chat switches with it.
- Select any node on the graph and the active branch changes; the chat panel and branch context panel align to that node.
- The **branch context panel** follows the selected node and shows how that turn went: thinking, tool calls, duration, and step count — and you can reply to the selected node right from there.

## Workbench

```text
Navigator | Session Graph | Branch Chat | Content Workspace
          |---------- resizable Utility Dock ----------|
```

- **Navigator** lists your real Pi sessions with search, rename, and import.
- **Session Graph** is the primary panel: the whole session laid out left to right, active branch highlighted, with a minimap.
- **Branch Chat** shows only the active branch.
- **Content Workspace** opens project files, Git changes, and web pages.
- Every panel can be collapsed, restored, and resized; connect to a remote Linux workspace over SSH or WSL and it works just like local.

## Remote Node runtime

SSH and WSL share one installer. A working selected Node stays in use; fresh installations prefer Linux Node from PATH or the interactive login environment (such as nvm), with a minimum version of 22.19.0. Dependencies, server startup, WebSocket connectivity and a real terminal must pass checks before the current installation changes.

Only when no compatible runtime is available does PiX use its fixed-version private Node, independent of the desktop's Node patch version. Launches use a fixed executable path and recheck changed Node versions; reconnecting can repair a missing or incompatible runtime. System Node, older installations and shared runtimes are not modified or automatically removed.

Developer checks: `node --test test/remote-runtime.test.mjs` (Windows defaults to Ubuntu-24.04; override with `PIX_TEST_WSL_DISTRO`). After building the server, run `node test/runtime-live-test.mjs --ssh HOST` or `--wsl DISTRO` to verify real Node reuse in an isolated temporary directory without switching the main installation.

## Custom models

Both graph and chat composers support selecting, pasting and dropping images, with previews, removal and image-only prompts. Select an image-capable model. PNG, JPEG, WebP and GIF are supported, up to 8 images, 5 MB each and 10 MB total per prompt. Images remain in the Pi session and appear in chat history and node previews.

Open **Settings → Models → Add custom model**, enter a provider ID, API base URL and model ID, then choose OpenAI Chat Completions / Responses, Anthropic Messages or Google Generative AI. Configure context size, output limits, reasoning and image input as needed. For local servers such as Ollama, select “This endpoint does not require an API key”.

Models use [Pi SDK's models.json format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md) in `~/.pi/agent/models.json`. Pi stores API keys in the local `auth.json`. Saving refreshes the model list immediately; providers without credentials can be configured afterward. WSL/SSH sessions call these models through the desktop broker without copying keys. Edit `models.json` and refresh for advanced compatibility settings.

## Download

PiX includes `@injaneity/pi-computer-use`, `@ff-labs/pi-fff`, and `pi-web-access`, loaded through Pi's extension mechanism. The extensions and their runtime dependencies ship with the app. No separate install is needed; an npm copy you installed through Pi takes precedence. Web search services still use your own configuration and credentials.

Grab the installer for your platform from [GitHub Releases](https://github.com/huang-sh/PiX/releases):

- **Windows**: `PiX-Setup-x.y.z.exe` (installer) or `PiX-Portable-x.y.z.exe` (portable), x64.
- **macOS**: `PiX-x.y.z-arm64.dmg` or `PiX-x.y.z-x64.dmg`, zip archives also available.

Installers are unsigned: if Windows SmartScreen warns, choose "Run anyway"; on macOS, allow the app in System Settings → Privacy & Security on first launch.

<details>
<summary>Run from source</summary>

Requires Node.js 22.19 or newer.

```bash
npm install
npm run dev
```

`npm run verify` runs the full typecheck, test, and startup smoke suite.

`npm run test:fff` checks bundled file search; `npm run test:web` checks web dependency packaging and page fetching, both with isolated settings. On macOS, `npm run dist:mac` packages the current machine's architecture; CI builds on separate Apple Silicon and Intel runners to include the matching native libraries.

</details>
