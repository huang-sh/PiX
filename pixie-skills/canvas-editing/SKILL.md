---
name: canvas-editing
description: Prepare or edit PiX drafts, explicitly submit untracked work, reopen failed prompts or recover a session after a storage error.
---

# Drafts and direct session editing

Loading this skill enables its independent tools for this turn. Inspect the visible canvas first. Every tool here needs context. Use exact node IDs; omit nodeId or pass JSON null for a root. Never use the string "null".

For a draft without execution:

1. `canvas_compose({context,nodeId,text})` opens a draft after a node. Omit nodeId for a root; optional direction is up/down.
2. `canvas_draft({context,text})` changes the open draft.
3. `canvas_cancel_draft({context})` closes it without submitting.

Compose and draft also accept images, provider/modelId, thinkingLevel and promptOverride. Use `canvas_inspect({include:["models","personas","draft"]})` when you need available models, persona names or draft state. Omitted fields retain the current draft values.

`canvas_retry({context,nodeId})` reopens a failed node's original message as a draft; it does not execute. `canvas_recover({context})` reopens the current session after a storage error; use the returned context for subsequent operations.

Only when the person explicitly requests direct submission without automatic follow-up:

- `canvas_submit({context})` submits the open draft, optionally replacing text/images/model/thinking/persona.
- `canvas_send({context,nodeId,text})` creates and submits a draft in one call. Text or images are required; direction and model/persona are optional. Sending again from a node with children creates another branch.

Both start actual agents and are untracked. Use core `canvas_delegate` for ordinary task execution and follow-up. Never replace a failed or uncertain delegation with direct submission; check its task record first.
