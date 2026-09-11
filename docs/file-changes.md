# Per-turn file changes

PiX records project files changed by Pi's `edit` and `write` tools, with or without
a Git repository. Each completed or interrupted conversation turn has a file card
below its answer. View diff opens the saved patch; Open opens the current file.
Repeated edits to a file are compared with its first observed content in that turn.
Returning to that content removes the file from the card. Empty new files still
appear with zero added lines.

The internal extension uses the SDK's awaited `tool_call` / `tool_result` hooks.
It does not replace the tools or modify the SDK. Snapshots are persisted before
execution and after each result, alongside the root session in
`<session>.file-changes/<uuid>.json`. Small `pix.file-change` custom entries reference
those snapshots without adding their contents to model context or session updates.
Each result has its own snapshot, so later edits cannot change historical diffs.
Graph workers share their root session's snapshot directory; UUIDs and branch-local
entries keep records separate. Remote hosts record and serve their own snapshots.

Coverage is limited to project-local `edit` / `write` calls. Shell commands, other
tools and paths outside the project are not tracked. Binary/non-UTF-8 files, files
over 2 MiB, and diffs that would store more text than the file itself show status
without line totals and keep no patch. Overlapping tools on the same host, or
unexpected disk changes between a turn's tools, mark the file as interleaved
rather than report misleading totals. This is detection, not a filesystem lock or
a guarantee against arbitrary external writes.

Snapshots remain available after restart. Copy the sidecar directory with a session
when moving it; importing only JSONL leaves the records without their saved
diffs. The sidecar is deleted with its session and is otherwise never pruned.
No undo is included in this version.

## Verifying

`test/file-changes.test.ts` drives the real SDK hooks through `edit` and `write`
tools: net totals, failed edits, reverts, binary/large files, interleaved writers,
restart and graph forks. `test/renderer/file-changes.test.ts` covers the card, the
diff parser and the tab lifecycle in jsdom.

The docking layout and the built app are only observable in a real window, so
`npm run test:gui:changes` builds the app, writes a turn with three files through a
faux provider and then checks the running app: the card's rows and totals, the
saved diff for one file, the wide and narrow dock layouts, and the card and diff
after a theme change and reload. It writes its screenshots to `artifacts/`.
