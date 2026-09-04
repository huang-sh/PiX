<p align="center">
  <img src="resources/icon.png" width="180" alt="PiX logo">
</p>

<h1 align="center">PiX</h1>

<p align="center">A non-linear AI agent workbench — sessions are graphs: branch anytime, and context follows the branch</p>

<p align="center">English · <a href="README.md">中文</a></p>

---

A PiX session is not a line — it is a graph that keeps growing: every conversation turn is a node, and any node can sprout a new branch at any time.

## Non-linear sessions

A traditional AI chat is a single timeline: to change direction you either start over or keep piling questions onto the same thread until the context becomes a mess.

PiX organizes a session as a graph that grows left to right:

- Every turn (your prompt plus the assistant's reply and tool calls) is a node on the graph.
- You can keep several directions alive in parallel without them interfering.
- When a path works out, keep going deeper; dead ends stay on the graph, and you can always come back and try another route.
- Sessions are real Pi sessions — no new format — so they remain usable outside PiX.

## Branch anytime

Branching is an everyday action in PiX, not something you have to plan ahead:

- **Fork from any user message**: unhappy with an answer? Fork a new branch from that turn with a different prompt or approach — the original branch stays untouched.
- **Continue from a turn**: select any earlier node on the graph and pick up the conversation from that moment.
- **Clone the active branch**: before a big change, clone the current branch as a save point and experiment freely.

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

## Run

Requires Node.js 22.19 or newer.

```bash
npm install
npm run dev
```

`npm run verify` runs the full typecheck, test, and startup smoke suite.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/Cmd+K | Command palette |
| Ctrl/Cmd+Shift+P | Command palette |
| Ctrl/Cmd+B | Toggle navigator |
| Ctrl/Cmd+` | Toggle Utility Dock |
| Ctrl/Cmd+Alt+B | Toggle tools panel |
| Escape | Close overlay |
