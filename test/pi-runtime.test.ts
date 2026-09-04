import test from "node:test";
import assert from "node:assert/strict";
import { PiRuntime } from "../src/main/pi-runtime.js";

test("records SDK context usage once after a prompt finishes", async () => {
  const appended: unknown[] = [];
  let usageCalls = 0;
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = {
    session: {
      prompt: async () => undefined,
      getContextUsage: () => {
        usageCalls++;
        return { tokens: 41_000, contextWindow: 128_000, percent: 32.03125 };
      },
      model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", contextWindow: 128_000, reasoning: true },
      thinkingLevel: "high",
      sessionManager: { appendCustomEntry: (...args: unknown[]) => appended.push(args) },
    },
  };
  runtime.snapshot = (() => ({ saved: true })) as unknown as typeof runtime.snapshot;

  await runtime.control({ action: "prompt", text: "hello" });

  assert.equal(usageCalls, 1);
  assert.deepEqual(appended, [["pix.node-footer", {
    contextUsage: { tokens: 41_000, contextWindow: 128_000, percent: 32.03125 },
    model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", contextWindow: 128_000, reasoning: true },
    thinkingLevel: "high",
  }]]);
});

test("reports each model's supported thinking levels", async () => {
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.modelServices = { modelRuntime: { getAvailable: async () => [
    {
      provider: "openai",
      id: "reasoning-model",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null },
    },
    { provider: "local", id: "plain-model", reasoning: false },
  ] } };

  const models = await runtime.control({ action: "getModels" });

  assert.deepEqual(models, [
    {
      provider: "openai",
      id: "reasoning-model",
      name: undefined,
      contextWindow: undefined,
      reasoning: true,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
    },
    {
      provider: "local",
      id: "plain-model",
      name: undefined,
      contextWindow: undefined,
      reasoning: false,
      thinkingLevels: ["off"],
    },
  ]);
});

test("maps skills discovered by the SDK resource loader", async () => {
  let reloads = 0;
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = {
    session: {
      resourceLoader: {
        reload: async () => void reloads++,
        getSkills: () => ({
          skills: [{
            name: "review",
            description: "Review the project",
            filePath: "/project/.pi/skills/review/SKILL.md",
            sourceInfo: { source: "local", scope: "project" },
            disableModelInvocation: true,
          }],
        }),
      },
    },
  };

  const skills = await runtime.control({ action: "getSkills", reload: true });

  assert.equal(reloads, 1);
  assert.deepEqual(skills, [{
    name: "review",
    description: "Review the project",
    path: "/project/.pi/skills/review/SKILL.md",
    source: "local",
    scope: "project",
    disableModelInvocation: true,
  }]);
});

test("maps visible extensions discovered by the SDK resource loader", async () => {
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = {
    session: {
      resourceLoader: {
        reload: async () => undefined,
        getExtensions: () => ({
          extensions: [
            {
              path: "/project/.pi/extensions/review.ts",
              resolvedPath: "/project/.pi/extensions/review.ts",
              sourceInfo: { source: "local", scope: "project" },
              tools: new Map([["review", { definition: { label: "Review", description: "Review changed files" } }]]),
              commands: new Map([["review", { description: "Start a review" }]]),
            },
            {
              path: "<inline:internal>",
              resolvedPath: "<inline:internal>",
              sourceInfo: { source: "sdk", scope: "temporary" },
              tools: new Map(),
              commands: new Map(),
              hidden: true,
            },
          ],
        }),
      },
    },
  };

  const extensions = await runtime.control({ action: "getExtensions" });

  assert.deepEqual(extensions, [{
    path: "/project/.pi/extensions/review.ts",
    resolvedPath: "/project/.pi/extensions/review.ts",
    source: "local",
    scope: "project",
    tools: [{ name: "review", label: "Review", description: "Review changed files" }],
    commands: [{ name: "review", description: "Start a review" }],
  }]);
});
