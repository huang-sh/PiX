# Pi Durable migration probe

This is an isolated evaluation of `@earendil-works/pi-durable@1.0.0`. It is not loaded or packaged by PiX. PiX continues to use the coding-agent SDK and its v3 JSONL sessions.

```sh
cd experimental/pi-durable
npm ci
npm test
```

The probe uses a local fake model, a temporary SQLite database and a separate Node process. No credentials or model API calls are needed. It exits the worker during a tool call without closing the harness, reopens storage, and checks:

- A `replay: "safe"` tool runs again; an unmarked tool reports an interrupted result without repeating its side effect.
- Resubmitting the same `requestId` keeps one user message and one submission.
- Forking a recovered answer preserves its history; replying on the fork does not change the parent.

This verifies process-crash recovery, not power-loss guarantees. One process owns a database; the probe does not test concurrent writers.

Before a production migration, PiX still needs an explicit importer/projection for Durable's conversation, entry and task records; equivalents for its coding-agent extensions and settings; task ownership and abort mapping; and reconnect/watch tests over its remote protocol. Durable JSONL is a separate storage format, not a replacement file for existing Pi sessions. The coding tools also lack image reading in 1.0.

References: [Pi Durable introduction](https://earendil.com/posts/pi-durable/), [1.0 API and limitations](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md).
