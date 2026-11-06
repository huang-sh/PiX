---
name: canvas-queue
description: Edit, remove, promote or clear messages already queued on a running PiX branch.
---

# Existing queued messages

Loading this skill enables its independent tools for this turn. Use `canvas_inspect({include:["queue"]})` to find the current context, runs and their queuedMessages. Pass the queued message's id as queueId and the run's nodeId as nodeId (which can be a pending run ID). Queue operations require visible context and nodeId; they do not accept taskId.

- `canvas_edit_queued({context,nodeId,queueId,text})` replaces the queued message text.
- `canvas_remove_queued({context,nodeId,queueId})` removes that message.
- `canvas_steer_queued({context,nodeId,queueId})` promotes it to steering.
- `canvas_clear_queue({context,nodeId})` clears queued messages only on that running branch.

Mutation replies acknowledge the affected target. If the operation fails because the agent settled or consumed the message meanwhile, refresh once and report the actual state; do not replay the message as new work.

For a new message, the core `canvas_steer` redirects running work and `canvas_follow_up` queues the next step. For settled work, use `canvas_delegate`. Removing queued messages does not cancel a tracked delegation's automatic completion follow-up; use `canvas_update_task` for that.
