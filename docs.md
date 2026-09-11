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

PiX keeps its own profile under `~/.pix` — separate from the pi CLI's `~/.pi`.
On first launch an existing `~/.pi/agent` (logins, custom models, skills) is
copied into `~/.pix/agent` once; afterwards the two profiles evolve
independently. PiX reads:

1. `~/.pix/agent/settings.json`
2. `<project>/.pi/settings.json`

Project settings override global settings. PiX-specific layout and appearance
are stored in `~/.pix/gui.settings.json`.

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
