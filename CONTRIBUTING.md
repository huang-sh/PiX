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
- User-facing strings live in `src/renderer/i18n.ts` and must be updated in both Chinese and English.
- Follow [AGENTS.md](AGENTS.md): fix root causes, and remove obsolete code and outdated comments.

## Commit Style

Use clear, conventional-style commits where possible:

```txt
fix: scope each chat column's composer expansion to its own column
docs: prune stale composer comments and codify the comment rule
```
