import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, defineExtension, defineTool, UserEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const job = { type: "input", content: "Run the probe", requestId: "pix-request-1" };
async function open(directory, replay, crash = false) {
  const faux = fauxProvider();
  faux.setResponses(crash
    ? [fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" })]
    : [fauxAssistantMessage("Recovered")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "probe", tools: [defineTool({
    name: "probe", description: "Observe recovery", parameters: Type.Object({}),
    ...(replay === "safe" ? { replay: "safe" } : {}),
    execute: async () => {
      // Test-only counter: distinguishes a replay from an interrupted unsafe call.
      appendFileSync(join(directory, "calls"), "called\n");
      if (crash) process.exit(75); // No Harness.close(): leave the tool task unfinished.
      return { content: [{ type: "text", text: "tool recovered" }] };
    },
  })] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, context);
  return { harness, faux };
}

if (process.argv[2] === "--crash") {
  const { harness } = await open(process.argv[4], process.argv[3], true);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  await (await root.submit(job, context)).wait(context);
  throw new Error("Expected the tool to terminate the worker");
} else {
  for (const replay of ["safe", "unsafe"]) {
    test(`${replay} tool crash recovery, request deduplication and independent fork`, { timeout: 30000 }, async () => {
      const directory = mkdtempSync(join(tmpdir(), "pix-durable-"));
      let harness;
      try {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--crash", replay, directory],
          { encoding: "utf8", timeout: 15000, windowsHide: true });
        assert.equal(child.status, 75, child.stderr || String(child.error));
        const opened = await open(directory, replay);
        harness = opened.harness;
        const root = await harness.root(context);
        harness.resume();
        const submission = await root.submit(job, context);
        assert.equal((await root.submit(job, context)).id, submission.id);
        const settled = await submission.wait(context);
        assert.equal(settled.status, "done");
        assert.equal(readFileSync(join(directory, "calls"), "utf8"), "called\n".repeat(replay === "safe" ? 2 : 1));
        const entries = (await root.context(context)).entries;
        assert.equal(entries.filter(entry => UserEntry.is(entry)).length, 1);
        const result = entries.find(entry => ToolResultEntry.is(entry));
        assert.equal(Boolean(result?.model?.[0]?.isError), replay === "unsafe");
        const fork = await root.fork(settled.answer, { ownership: { kind: "ownerless" } }, context);
        opened.faux.setResponses([fauxAssistantMessage("Fork answer")]);
        await (await fork.submit({ type: "input", content: "Follow the fork" }, context)).wait(context);
        assert.equal((await root.context(context)).entries.length, entries.length);
        assert.equal((await fork.context(context)).entries.filter(entry => UserEntry.is(entry)).length, 2);
      } finally {
        await harness?.close(context);
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
}
