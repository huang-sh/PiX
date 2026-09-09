# Architecture and delivery notes

## Canonical session model

`projectSession(entries, leafId)` follows raw Pi parent links. It aggregates one
user turn with its assistant/tool/summary entries, creates graph edges between
nearest user ancestors, and derives branch chat from the selected leaf path.
`entryAnchorForNode()` returns the raw entry belonging to that node on the
currently active branch, avoiding cross-branch navigation mistakes.

## Desktop authority

```text
Renderer -> isolated preload -> MainController
                                |- PiRuntime
                                |- WorkspaceService
                                |- GitService
                                |- ShellService
                                |- SettingsService
                                `- WikiService
```

Routes are runtime-validated before dispatch. Workspace paths are confined to
the active project. Browser content uses an isolated webview partition.

## Session wiki

Each graph owns a derived wiki under `<session>.jsonl.pix-tree/wiki`:
`branches/<id>.md` summaries, program-generated `sources/<id>.md` evidence
exports, `tree.md`/`index.md`, and `manifest.json` receipts (the inclusion
watermark used for restart recovery). Source sessions are read-only to the
wiki; `wiki-compiler.ts` holds the deterministic layer ported from the offline
demo script, and `wiki-service.ts` owns queueing (per-branch serial tasks,
merging turns that arrive mid-run, retry with backoff, a token budget, and
cancellation on session deletion). Branch summaries come from standalone
background model calls (`streamSimple`, no tools, never the chat runtime's
session); before publishing, every result is re-verified against the read
range, the page hash, and the session identity so stale output cannot
overwrite newer summaries or manual edits. Auto-update is opt-in
(`~/.pix/settings.json` under `app.wiki`: `enabled`, `provider`/`modelId`,
`budgetTokens`) and remote (WSL/SSH) sessions are explicitly disabled.

## Settings precedence

PiX reads:

1. `~/.pi/agent/settings.json`
2. `<project>/.pi/settings.json`

Project settings override global settings. PiX-specific layout and appearance
are stored in `~/.pix/settings.json`.

## Session fixture provenance

`scripts/install-fixtures.mjs` looks for the two uploaded session UUIDs. When an
uploaded JSONL is visible, it copies that complete session and only rebinds the
header `cwd` to the validation workspace. When attachment bytes are unavailable,
it creates a documented Pi v3 fallback session with the same ID and a branched
entry tree. `artifacts/session-manifest.json` records the actual source, SHA-256,
size, and entry count used by the verification run.
