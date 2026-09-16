# Contributing

Thanks for your interest in contributing to PiX.

## Development Setup

```bash
npm install
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
npm run test
```

For larger changes, run `npm run verify` for full verification.

Also:

- One PR addresses one problem.
- Before submitting, review your changes with different AI models over several rounds and refine accordingly.
- GUI changes must be personally inspected in the running app by the author; passing tests alone is not enough.

## Guidelines

- Keep pi itself responsible for agent behavior, tools, sessions, model calls, and context management; PiX integrates through the embedded pi-server RPC instead of reimplementing pi internals.
- Sessions are real Pi sessions and the graph is derived from their parent links; do not invent new formats or mutate session JSONL files directly.
- The renderer has no Node access; IPC goes through the isolated preload with narrow, typed contracts defined in `src/shared`.
- User-facing strings live in `src/renderer/i18n/` (one domain file per feature area, each holding both locales) and must be updated in both Chinese and English. A new domain file also has to be registered — add it to `DomainModules` and to the seed object in `index.ts`, both enforced by the type checker — and end with `acceptDomainUpdate(en)` like its siblings so it hot-updates itself.
- Follow [AGENTS.md](AGENTS.md): fix root causes, and remove obsolete code and outdated comments.

## Testing Notes

### VueFlow viewport animations in jsdom

jsdom has no layout engine, so the graph pane reports a zero `clientWidth`/`clientHeight`. d3-zoom derives its extent from those values, and an animated transform (`setCenter`/`setViewport` with `duration > 0`) recovers its per-frame scale as `w / l[2]` — with a zero-sized extent this is `0 / 0`, and the viewport turns `{NaN, NaN, NaN}` mid-animation. Instant transforms (`duration: 0`) bypass the tween and are unaffected, and the real app always has a non-zero pane.

Existing graph tests avoid this by spying on the store (`vi.spyOn(flow, "setCenter").mockResolvedValue(true)`). To exercise a real animation in jsdom, stub the pane's client size instead — setting the store's `dimensions` ref does not help, because the tween reads the DOM element:

```ts
const pane = wrapper.element.querySelector(".vue-flow__viewport");
Object.defineProperty(pane!, "clientWidth", { value: 1200, configurable: true });
Object.defineProperty(pane!, "clientHeight", { value: 600, configurable: true });
```

## Commit Style

Use clear, conventional-style commits where possible:

```txt
fix: scope each chat column's composer expansion to its own column
docs: prune stale composer comments and codify the comment rule
```
