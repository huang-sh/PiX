<p align="center">
  <img src="resources/icon.png" width="180" alt="PiX logo">
</p>

<h1 align="center">PiX</h1>

<p align="center">A non-linear AI agent workbench — sessions are graphs: branch anytime, and context follows the branch</p>

<p align="center">English · <a href="README.md">中文</a></p>

---

<p align="center">
  <img src="assets/images/pix-session-tree.png" alt="PiX session graph with branches growing left to right">
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
- A single click highlights a node on the graph without touching any panel (graph commands such as /fork act on the highlighted node); a double-click aligns the primary chat panel to that node.
- Double-click a node on the graph to open its conversation in the primary chat panel. Ctrl+double-click (or the right-click menu's "Open in chat panel") pins that branch to a second or third side-by-side chat column — up to 3 columns at once for comparing branches. Each branch keeps a single panel: opening another node of an already-pinned branch retargets that column. Every column scrolls and replies independently. Replying from a pinned column grows that branch in place: the column follows the newly created node, and the primary column keeps the current selection. Closing the last pinned column — or the next start — restores the chat width.
- The **branch context panel** follows the selected node and shows how that turn went: thinking, tool calls, duration, and step count — and you can reply to the selected node right from there.

<p align="center">
  <img src="assets/images/pix-multi-chat-panels.png" alt="Multi chat panels: Ctrl+double-click nodes on different branches to pin up to three side-by-side chat columns for comparison">
</p>

## Built-in extensions

PiX ships two built-in extensions, both loaded through Pi's extension mechanism. They carry native binaries, so they and their runtime dependencies ship with the installer — no separate install needed, and an npm copy you installed through Pi takes precedence.

- **`@ff-labs/pi-fff` — fast file and content search**: replaces the built-in `find` / `grep` tools with FFF (Rust-native, SIMD-accelerated): `fffind` fuzzy file-name search, `ffgrep` content search, and `fff-multi-grep` multi-pattern search. Files are pre-indexed in the background at session start so searches return instantly; results are frecency-ranked (frequently used files first) and boosted for git-modified and untracked files.
- **`@injaneity/pi-computer-use` — desktop app control**: lets the agent observe and operate desktop apps on macOS, Windows, and Linux: find open apps and windows, read the text and controls on screen, click, type, scroll, and wait for the UI to change. Useful when an app has no API and the on-screen interface is all there is (the macOS helper requires macOS 14 or newer).

`pi-web-access` does not ship with the installer: install it with one click on the Settings → Extensions page and keep it current with `pi update`. It gives the agent web search, URL fetching, PDF extraction, and GitHub research; web search services still use your own configuration and credentials.

PiX itself also adds one internal `file-changes` extension (not removable): it snapshots files before and after the agent edits or writes them to power the "Changes" panel.

## Run

Requires Node.js 22.19 or newer. PiX is a local web UI: Node hosts the backend, and the frontend opens in your browser.

```bash
npm install
npm run dev
```

The browser opens `http://127.0.0.1:5173/`. For a production build:

```bash
npm run build
npm start
```

PiX includes `@injaneity/pi-computer-use` and `@ff-labs/pi-fff`, loaded through Pi's extension mechanism. Install `pi-web-access` from Settings → Extensions and keep it current with `pi update`.

`npm run verify` runs the full typecheck and test suite. `npm run test:fff` checks bundled file search; `npm run test:web` checks the web extension's installed layout (a real npm install, needs network) and page fetching.

## Community

Join our WeChat group:

<p>
  <img src="assets/images/Weixin.png" width="220" alt="PiX WeChat group QR code">
</p>

## Contributors

Thanks to everyone who has contributed to PiX:

<!-- CONTRIBUTORS:START -->
<a href="https://github.com/huang-sh"><img src="https://avatars.githubusercontent.com/u/24741118?v=4&s=80" width="80" height="80" alt="huang-sh"></a>
<a href="https://github.com/mugpeng"><img src="https://avatars.githubusercontent.com/u/52995448?v=4&s=80" width="80" height="80" alt="mugpeng"></a>
<a href="https://github.com/github-actions[bot]"><img src="https://avatars.githubusercontent.com/in/15368?v=4&s=80" width="80" height="80" alt="github-actions[bot]"></a>
<a href="https://github.com/kindredzhang"><img src="https://avatars.githubusercontent.com/u/120791467?v=4&s=80" width="80" height="80" alt="kindredzhang"></a>
<a href="https://github.com/xxnuo"><img src="https://avatars.githubusercontent.com/u/54252779?v=4&s=80" width="80" height="80" alt="xxnuo"></a>
<a href="https://github.com/jinjianghao"><img src="https://avatars.githubusercontent.com/u/147498917?v=4&s=80" width="80" height="80" alt="jinjianghao"></a>
<!-- CONTRIBUTORS:END -->

Contributions are welcome: open an [issue](https://github.com/huang-sh/PiX/issues) for bugs and ideas, or send a pull request.
