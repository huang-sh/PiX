# Installing zotero-cli

`zotero-cli` ships inside the Python package `zotero-mcp-server`
(github.com/54yyyu/zotero-mcp, Python 3.10+); it shares its configuration
with the `zotero-mcp` server, but no MCP client is needed to use the CLI.

If `command -v zotero-cli` finds nothing, install the package. Use whichever
installer the machine has (uv keeps the tool isolated and on PATH). The
commands include the `pdf` extra so `outline` and page-range reading work
out of the box:

```bash
uv tool install "zotero-mcp-server[pdf]"        # preferred
pipx install "zotero-mcp-server[pdf]"
pip install "zotero-mcp-server[pdf]"
```

`search --mode semantic` and the `db update` index need one more extra — add
it only when semantic search is wanted (it pulls ChromaDB and embeddings):

```bash
uv tool install "zotero-mcp-server[pdf,semantic]"
```

After installing, add the credentials as environment variables and verify
(local mode needs none — see "Connecting to a library" below):

```bash
export ZOTERO_API_KEY=<your key>
export ZOTERO_LIBRARY_ID=<your numeric user ID>
zotero-cli config
```

Persist the variables so future sessions inherit them: put the exports in
the shell profile (`~/.bashrc` and friends) on Linux/macOS, or on Windows
run `setx ZOTERO_API_KEY "<key>"` (same for the ID) once — `setx` writes
the user environment permanently. "Ways to configure the credentials"
below lists the alternatives.

## Connecting to a library

**Local mode (Zotero 7+ desktop, read-only, no keys).** In Zotero open
Settings → Advanced and enable "Allow other applications on this computer
to communicate with Zotero", then keep Zotero running.

**Web mode (no desktop app needed, read-write).** Create a key at
zotero.org/settings/security and note your numeric user ID from the same
site. The key and ID go into one of the configuration ways below — as
environment variables they look like:

```bash
export ZOTERO_API_KEY=<your key>
export ZOTERO_LIBRARY_ID=<your numeric user ID>
```

Setting both the local toggle and the web credentials gives hybrid mode:
fast local reads, writes through the web API. Configuration is per
machine: a remote host (WSL/SSH session) reads its own home, so run the
setup there too.

## Ways to configure the credentials

Pick one; `zotero-cli config` verifies whichever you chose by printing the
resolved settings.

1. **Interactive wizard — run it yourself (preferred).**

   ```bash
   zotero-mcp setup
   ```

   Asks for mode, key, and library ID, then writes
   `~/.config/zotero-mcp/config.json` — shared with the MCP server and
   preserved across updates.

2. **Environment variables (manual).** Documented, and they override the
   config file:

   ```bash
   export ZOTERO_API_KEY=<your key>
   export ZOTERO_LIBRARY_ID=<your numeric user ID>
   ```

   Put them in the shell profile (or system environment) to persist.

3. **Let the agent configure it for you.** Hand over the key and ID and it
   runs the non-interactive form:

   ```bash
   zotero-mcp setup --no-local --api-key <key> --library-id <id>
   ```

   Accept the trade-off described in the security notes below first.

4. **Hand-edit `~/.config/zotero-mcp/config.json` (last resort).**
   Credentials live under a generic `client_env` dict:

   ```json
   { "client_env": { "ZOTERO_API_KEY": "...", "ZOTERO_LIBRARY_ID": "..." } }
   ```

   This layout is inferred from the source, not a documented contract, and
   a malformed file silently falls back to defaults — always verify with
   `zotero-cli config` afterwards.

## Security notes

- The API key is a long-lived credential: anyone holding it can read — and
  with write scope, modify — the library. **Prefer configuring it
  yourself** (wizard or environment variables) over handing it to an agent
  or another person.
- When you do let an agent configure it, the key lands in the conversation
  history and in the process command line (shell history, `ps`). Use that
  path only if you accept where the secret ends up.
- Create the key at zotero.org with the least scope that suffices:
  read-only unless you really need writes.
- Keep the key out of files that get committed, shared, or screenshotted.
