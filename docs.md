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
                                `- SettingsService
```

Routes are runtime-validated before dispatch. Workspace paths are confined to
the active project. Browser content uses an isolated webview partition.

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
