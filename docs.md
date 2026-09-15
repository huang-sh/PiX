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
                                |- PiRuntime (project: models, skills, login)
                                |- SessionRegistry -> one GraphRuntime per open session
                                |- RemoteSlot pool (WSL/SSH hosts, keyed by project)
                                |- WorkspaceService
                                |- GitService
                                |- ShellService
                                `- SettingsService
```

Routes are runtime-validated before dispatch. Workspace paths are confined to
the active project. Browser content uses an isolated webview partition.

## Session lifecycle and the remote pool

Opening a session switches the view; it never closes another session's
runtime. `SessionRegistry` (`src/main/session-registry.ts`) keeps one
`GraphRuntime` per session file, keyed by the canonical (realpath'd) session
path, and survives project switches — `configure()` only repoints the view at
the entered project's remembered session. Every listing (`PiRuntime.list`,
`SessionFiles.list`) spells that same canonical path, so rows, history, and
registry keys agree even when the project is reached through a junction or
symlink. Only four things close an entry:
idle LRU eviction (`PIX_MAX_LIVE_SESSIONS`, default 4; running entries are
never evicted, and each victim is re-read for liveness and view ownership
right before it is disposed, so a project switch during the pass keeps its
entry), the
project's session directory changing, explicit deletion, and quitting. Every
disposal drains the in-flight operations it races first — cold opens, creates
still writing their file, and the reopen of an entry whose cached runtime
died — refuses new opens for the disposed path or project until the caller's
destructive step finishes, rejects any snapshot an open tries to serve from
inside that window, and a coalesced
background refresh scheduled for an entry that has since been disposed
publishes nothing, so a late open or a late timer cannot outlive the disposal.
Deleting a session drains its in-flight open the same way and unlinks inside
the blocked window, so the late open cannot resurrect the deleted file.

Selection follows request order, not completion order. The registry, desktop
controller, and renderer invalidate older selection requests when another
session or project is chosen. A late load may populate the background cache,
but cannot change the active session, its project's remembered selection, or
the current loading state. Creating a session and opening a read-only fallback
follow the same rule; pending file operations retain their original directory.

**Event routing.** Only the session in view drives `current` snapshots and
token streams. Background local sessions update their project's history and push
decorated project groups (`{type:"sessions", payload:{projects}}`), coalesced
to one write per 500 ms burst; their token events are stamped with the
session's graph id and recorded — never forwarded — so switching back replays
the in-flight text through the `session.snapshot` resync path; their notices are
dropped the same way a pooled host's are — an invisible workspace must not
toast, and a failed run's state stays on its row and in the session when it is
reopened. A restarted
session (new graph epoch) invalidates only its own progress baselines.
Remote events and delayed replies retain their owning slot's project; both
the project and its selected session must match before a snapshot reaches the
view, and the selection moves both for `session.open` and for the actions that
migrate the runtime to a new file (`newSession`, `fork`, `clone`).
Remote background progress is replayed by its host. List events are
translated into desktop project groups, retaining only the slot's workspace.
Running markers use local registry liveness or the connected remote project's
latest state; foreground snapshots update the row and stop menu immediately.

**Guards.** Deleting a session with work in flight is refused until it is
stopped; the `session.stop` route aborts a session's runs from any project.
Navigator requests include `projectId` so identical paths on different hosts
resolve to the correct owner before dispatch; path-only callers remain supported.
Removing a project from the list is refused while any of its sessions run,
whether they live in the local registry or on a pooled remote host; otherwise
the removal disposes that project's pooled host and live entries together, so
neither can write the removed project back into the history. Renames go through
the owning runtime so a static append cannot race the session's own writes.
Local cross-project stop, rename, and delete resolve paths against the owning entry's
session directory (`registry.resolve`), never a directory traversal hole.

**Remote pool.** Each remote workspace's host connection lives in a pool keyed
by project id. Switching projects parks the previous client instead of
disposing it, and reconnecting to a pooled project adopts its slot — a second
host would trip the graph ownership lock the pooled one still holds. The
desktop broker catalog is cloned into each session runtime as it is created,
and a later `setBrokerProviders` is pushed into every settled entry, so a
login or a new custom model reaches sessions that were already open. Idle
recycling disposes only quiet hosts: never the workspace in view, never a
host whose `session.list` still reports running work, bounded by
`PIX_MAX_REMOTE_CONNECTIONS` (default 2) and `PIX_REMOTE_IDLE_MS` (default
5 min). Recycling a host also closes its remote terminals and shell runs —
`slotBusy` only weighs session runs, so a shell-only workspace recycles when
its idle window passes. Disconnects keep the slot until replaced so the
degraded bootstrap can present remembered rows and a reconnect banner.

**Shutdown.** Quitting flushes pending background history writes, aborts
every local run (settling as `interrupted` with recovered inputs — this is
in-process continuation, not persisted resumption), releases the graph
ownership files, and disposes every pooled host. Per-graph parallelism stays
capped by `PIX_MAX_PARALLEL_RUNS` (default 8); nothing bounds how many
sessions may run at once beyond the user starting them, which is why the
navigator's running markers are the visibility surface for it.

## Settings precedence

PiX keeps its own profile under `~/.pix` — separate from the pi CLI's `~/.pi`.
On first launch an existing `~/.pi/agent` (logins, custom models, skills) is
copied into `~/.pix/agent` once; afterwards the two profiles evolve
independently. PiX reads:

1. `~/.pix/agent/settings.json`
2. `<project>/.pi/settings.json`

Project settings override global settings. PiX-specific layout and appearance
are stored in `~/.pix/gui.settings.json`.

Model choice resolves in two scopes. Inside a session a draft inherits the model
of the node it branches from (`node.footer.model`), falling back to the session's
current model, so a node runs on its predecessor's model and only a deliberate
pick changes it. Any pick in a model menu is that "last set" model: it writes the
profile defaults (`defaultProvider`/`defaultModel`; Settings → Default model
writes the same keys), so the next new session starts from it, while the open
session keeps its own transcript model — the TUI's split between switching a model
and setting one as the default. Inheriting a model never writes anything, so a
run on an inherited model leaves the default untouched. Every new session resolves
its model like a fresh Pi session: transcript model on resume, then
`defaultProvider`/`defaultModel`, then the first model with configured
credentials.

## Built-in skills

Skills that ship with PiX live in `skills/<name>/SKILL.md` at the repo root,
one folder per skill with auxiliary files beside `SKILL.md`. They are plain
markdown — no npm install, the same tree ships everywhere.

- **Distribution.** electron-builder copies the tree to `<resources>/skills`
  outside the asar; the SSH/WSL installer uploads it beside the server bundle
  (`~/.pix/server/current/skills`); dev runs read the repo directory directly.
  `src/main/builtin-skills.ts` resolves all three layouts from the module
  location, and `checkPackagedSkills` (afterPack hook) fails a package whose
  tree went missing.
- **Discovery and precedence.** The tree is injected through
  `resourceLoaderOptions.additionalSkillPaths`, which pi ranks below every
  user-discovered skill: a same-named user or project skill always wins. The
  bundled row is then absent from the list, and the winning row carries a
  "shadows built-in" badge (fed by pi's collision diagnostics) so the list
  explains itself.
- **Read-only by design.** Bundled files are never written — install dirs are
  replaced on upgrade and may not be writable at all. The settings page shows
  them under their own "built-in" category with a lock badge and a read-only
  viewer. `getSkill` reads anything the loader lists; every write path stays
  behind the editable-roots assertion in `skill-files.ts`.
- **Manual-only toggle.** The per-skill "manual only" switch records a runtime
  override in `~/.pix/skill-overrides.json` — per machine, so a remote host
  keeps its own — which the `skillsOverride` hook applies at load time. The
  preference survives upgrades without touching the bundled files.
- **Adding one.** Drop a folder with a spec-valid `SKILL.md` into `skills/`.
  `test/builtin-skills.test.ts` validates every entry, and the packaged smoke
  test exercises list/view/toggle against a real build. Note that a host only
  refreshes its bundled skills when `PIX_HOST_VERSION` changes.

## Session fixture provenance

`scripts/install-fixtures.mjs` looks for the two uploaded session UUIDs. When an
uploaded JSONL is visible, it copies that complete session and only rebinds the
header `cwd` to the validation workspace. When attachment bytes are unavailable,
it creates a documented Pi v3 fallback session with the same ID and a branched
entry tree. `artifacts/session-manifest.json` records the actual source, SHA-256,
size, and entry count used by the verification run.

## Running multiple development worktrees

Use a separate terminal in each worktree. Give each process its own PiX profile
and Electron user-data directory to keep settings, sessions and browser storage
independent. The Vite renderer selects another port if its default is occupied.

```powershell
$env:PIX_HOME = Join-Path $PWD 'artifacts/dev-profile'
$env:PI_CODING_AGENT_DIR = Join-Path $env:PIX_HOME '.pix/agent'
$env:PIX_PROJECT = $PWD.Path
npm run dev -- -- --user-data-dir="$env:PIX_HOME/electron"
```

A new profile needs its own model credentials/configuration. Install dependencies
with `npm ci` in a fresh worktree; run `npm run fixtures` before the full test suite.
