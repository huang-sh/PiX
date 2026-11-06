---
name: canvas-view
description: Adjust PiX node selection, panels, labels, search, filters and layout when the person asks to change the canvas presentation.
---

# Canvas presentation

Loading this skill enables its independent tools for this turn. Use `canvas_inspect({include:["layout"]})` to obtain the current context, exact node IDs and existing view state. Every tool below requires that context. Reuse returned context; refresh after switching sessions. Presentation changes do not require creating a session or starting an agent.

| Tool | Arguments besides context | Behavior |
| --- | --- | --- |
| canvas_select | nodeId | Select the node and show its conversation. |
| canvas_highlight | nodeId | Highlight without changing the conversation. |
| canvas_open_panel | nodeId | Open the branch in a side-by-side chat column. |
| canvas_close_panel | nodeId | Close its column. |
| canvas_label | nodeId, text | Set a label; empty text clears it. Requires an idle, writable branch. |
| canvas_search | text | Search node contents; empty text closes search. |
| canvas_filter | filter | One of all, labeled, running, errors. |
| canvas_move | nodeId, x, y; optional branch | Canvas coordinates; branch:true also moves descendants. |
| canvas_viewport | optional x, y, zoom | Pan/zoom; zoom is 0.25–1.6. Omitted values are preserved. |
| canvas_center | optional nodeId | Center at a readable zoom. |
| canvas_tidy | — | Restore automatic layout and center the selected node. |
| canvas_minimap | enabled | Show or hide the minimap. |

For example, after inspecting context C and node N, call `canvas_label({"context":"C","nodeId":"N","text":"Reviewed"})` and `canvas_center({"context":"C","nodeId":"N"})`. C and N illustrate returned identifiers, not literal values to reuse.

Inspect actual state before reporting the result. Tool replies contain only the operation result, not a full canvas snapshot. Inspect again only when you need additional state. Do not repeat a selection or toggle that is already in the requested state.
