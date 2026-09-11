# Installing zotero-cli

`zotero-cli` ships inside the Python package `zotero-mcp-server`
(github.com/54yyyu/zotero-mcp, Python 3.10+); it shares its configuration
with the `zotero-mcp` server, but no MCP client is needed to use the CLI.
Confirm it is really missing before installing anything:

```bash
zotero-cli config
```

Install with one of (uv keeps it isolated and on PATH). The commands include
the `pdf` extra so `outline` and page-range reading work out of the box:

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

Verify again with `zotero-cli config`.

## Connecting to a library

**Local mode (Zotero 7+ desktop, read-only, no keys).** In Zotero open
Settings → Advanced and enable "Allow other applications on this computer
to communicate with Zotero", then keep Zotero running.

**Web mode (no desktop app needed, read-write).** Create a key at
zotero.org/settings/security and export the key plus your numeric user ID:

```bash
export ZOTERO_API_KEY=<your key>
export ZOTERO_LIBRARY_ID=<your numeric user ID>
```

Setting both the local toggle and the web credentials gives hybrid mode:
fast local reads, writes through the web API. `zotero-cli config` prints
the resolved settings — trust it over assumptions.
