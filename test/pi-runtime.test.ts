import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRuntime } from "../src/main/pi-runtime.js";
import type { AgentControl } from "../src/shared/types.js";

test("records SDK context usage once after a prompt finishes", async () => {
  const appended: unknown[] = [];
  const entries: unknown[] = [];
  let usageCalls = 0;
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = {
    session: {
      prompt: async () => {
        entries.push({ type: "message", message: { role: "user" } });
      },
      getContextUsage: () => {
        usageCalls++;
        return { tokens: 41_000, contextWindow: 128_000, percent: 32.03125 };
      },
      model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", contextWindow: 128_000, reasoning: true },
      thinkingLevel: "high",
      sessionManager: {
        getEntries: () => entries,
        appendCustomEntry: (...args: unknown[]) => appended.push(args),
      },
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

test("skips the node footer when the prompt created no turn", async () => {
  const appended: unknown[] = [];
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = {
    session: {
      // A handled extension command resolves without appending a user entry.
      prompt: async () => undefined,
      getContextUsage: () => {
        throw new Error("usage must not be recorded");
      },
      model: null,
      thinkingLevel: "off",
      sessionManager: {
        getEntries: () => [],
        appendCustomEntry: (...args: unknown[]) => appended.push(args),
      },
    },
  };
  runtime.snapshot = (() => ({ saved: true, projection: { nodes: [] } })) as unknown as typeof runtime.snapshot;

  const result = await runtime.control({ action: "prompt", text: "/handled-command" });

  assert.deepEqual(appended, []);
  assert.ok(result && typeof result === "object" && "projection" in result);
});

test("records the node footer when a prompt rejects mid-turn", async () => {
  const appended: unknown[] = [];
  const entries: unknown[] = [];
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = {
    session: {
      prompt: async () => {
        entries.push({ type: "message", message: { role: "user" } });
        throw new Error("mid-run failure");
      },
      getContextUsage: () => ({ tokens: 900, contextWindow: 128_000, percent: 0.7 }),
      model: { provider: "zai", id: "glm-5.3", name: "GLM-5.3", contextWindow: 128_000, reasoning: true },
      thinkingLevel: "low",
      sessionManager: {
        getEntries: () => entries,
        appendCustomEntry: (...args: unknown[]) => appended.push(args),
      },
    },
  };
  runtime.snapshot = (() => ({ saved: true })) as unknown as typeof runtime.snapshot;

  await assert.rejects(
    runtime.control({ action: "prompt", text: "hello" }),
    /mid-run failure/,
  );

  assert.equal(appended.length, 1);
  const [, data] = appended[0] as [string, { contextUsage: unknown }];
  assert.ok(data.contextUsage);
});

test("every mutating control action returns the refreshed snapshot", async () => {
  const calls: string[] = [];
  const track = (name: string) => () => {
    calls.push(name);
  };
  const session = {
    prompt: track("prompt"),
    steer: track("steer"),
    followUp: track("followUp"),
    abort: track("abort"),
    clearQueue: track("clearQueue"),
    cycleModel: track("cycleModel"),
    cycleThinkingLevel: track("cycleThinking"),
    compact: track("compact"),
    executeBash: track("bash"),
    abortBash: track("abortBash"),
    abortRetry: track("abortRetry"),
    abortCompaction: track("abortCompaction"),
    setModel: track("setModel"),
    setThinkingLevel: track("setThinking"),
    setSteeringMode: track("setSteeringMode"),
    setFollowUpMode: track("setFollowUpMode"),
    setAutoCompactionEnabled: track("setAutoCompaction"),
    setAutoRetryEnabled: track("setAutoRetry"),
    setSessionName: track("setName"),
    setActiveToolsByName: track("setTools"),
    navigateTree: track("navigateTree"),
    reload: track("reload"),
    subscribe: () => () => undefined,
    getContextUsage: () => undefined,
    model: null,
    thinkingLevel: "off",
    modelRuntime: { getModel: () => ({}) },
    sessionManager: {
      getEntries: () => [],
      getLeafId: () => "e1",
      appendCustomEntry: track("node-footer"),
      appendLabelChange: track("setLabel"),
    },
  };
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = { session, fork: track("fork") };
  const snap = { projection: { nodes: [] } };
  runtime.snapshot = (() => snap) as unknown as typeof runtime.snapshot;
  // keep a projection-bearing shape: control() must return it verbatim

  const actions: Record<string, Record<string, unknown>> = {
    prompt: { text: "hi" },
    steer: { text: "hi" },
    followUp: { text: "hi" },
    abort: {},
    clearQueue: {},
    cycleModel: {},
    cycleThinking: {},
    compact: {},
    bash: { command: "ls" },
    abortBash: {},
    abortRetry: {},
    abortCompaction: {},
    setModel: { provider: "zai", modelId: "glm-5.3" },
    setThinking: { level: "low" },
    setQueueMode: { kind: "steering", mode: "all" },
    setAutoCompaction: { enabled: true },
    setAutoRetry: { enabled: true },
    setName: { name: "renamed" },
    setTools: { names: ["read"] },
    setLabel: { entryId: "e1", label: "l" },
    navigateTree: { entryId: "e1" },
    fork: { entryId: "e1" },
    clone: {},
    reload: {},
  };
  for (const [action, input] of Object.entries(actions)) {
    calls.length = 0;
    const result = await runtime.control({ action, ...input } as AgentControl);
    assert.ok(
      result && typeof result === "object" && "projection" in result,
      `${action} must return the refreshed snapshot`,
    );
    assert.equal(calls.length, 1, `${action} must run its SDK effect`);
  }
});

test("forces an online model catalog refresh without opening a project or session", async (t) => {
  const runtime = new PiRuntime(null, null, () => assert.fail("must not emit session changes"), async () => undefined);
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 15_000);
    return controller.signal;
  });
  let refreshes = 0;
  runtime.modelServices = { modelRuntime: {
    refresh: async (options: unknown) => {
      assert.deepEqual(options, { allowNetwork: true, force: true, signal: controller.signal });
      refreshes++;
      return { aborted: false, errors: new Map() };
    },
    getAvailable: async () => [],
  } };
  await runtime.control({ action: "getModels" });
  assert.equal(refreshes, 0, "ordinary list reads must not force a refresh");
  assert.deepEqual(await runtime.control({ action: "refreshModels" }), { ok: true });
  assert.equal(refreshes, 1);
  assert.equal(runtime.runtime, undefined);
});

test("model refresh reports provider failures and timeouts without changing the active session", async () => {
  const runtime = new PiRuntime("/project", "/sessions", () => assert.fail("must not emit session changes"), async () => undefined);
  const activeModel = { provider: "openai", id: "current-model" };
  const session = { model: activeModel, modelRuntime: { refresh: async (): Promise<unknown> => ({
    aborted: false,
    errors: new Map([["openai", new Error("Network unavailable")]]),
  }) } };
  runtime.runtime = { session };
  await assert.rejects(runtime.control({ action: "refreshModels" }), /openai: Network unavailable/);
  session.modelRuntime.refresh = async () => ({ aborted: true, errors: new Map() });
  await assert.rejects(runtime.control({ action: "refreshModels" }), /timed out/);
  assert.equal(runtime.runtime.session, session);
  assert.equal(session.model, activeModel);
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
    bundled: false,
    tools: [{ name: "review", label: "Review", description: "Review changed files" }],
    commands: [{ name: "review", description: "Start a review" }],
  }]);
});

test("factory loads bundled packages as additional extension paths", async () => {
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  let servicesOptions: any;
  const packages = ["npm:@injaneity/pi-computer-use"];
  const fakePi = {
    getAgentDir: () => "/agent",
    SettingsManager: {
      create: () => ({ getPackages: () => packages, getShellPath: () => undefined }),
    },
    createAgentSessionServices: async (options: any) => {
      servicesOptions = options;
      return {};
    },
    createAgentSessionFromServices: async () => ({}),
  };
  const create = () =>
    runtime.factory(fakePi)({ cwd: "/project", sessionManager: {}, sessionStartEvent: undefined });

  // The user's own install suppresses the bundled copy.
  await create();
  assert.deepEqual(servicesOptions.resourceLoaderOptions, { additionalExtensionPaths: [] });

  // The bundled copy loads once no user install is configured. Factory
  // resolves relative to pi-runtime's compiled location (out-test/src/main),
  // so the package fixture lands next to that layout's node_modules root.
  packages.length = 0;
  const fixtureDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "@injaneity",
    "pi-computer-use",
  );
  mkdirSync(fixtureDir, { recursive: true });
  try {
    writeFileSync(join(fixtureDir, "package.json"), "{}");
    await create();
    const [builtinPath] = servicesOptions.resourceLoaderOptions.additionalExtensionPaths;
    assert.equal(builtinPath, fixtureDir);
    const extensionPath = join(fixtureDir, "extensions", "computer-use.ts");
    runtime.runtime = { session: { resourceLoader: { getExtensions: () => ({ extensions: [{
      path: extensionPath,
      resolvedPath: extensionPath,
      sourceInfo: { source: "cli", scope: "temporary" },
      tools: new Map(),
      commands: new Map(),
    }] }) } } };
    const [extension] = await runtime.control({ action: "getExtensions" }) as any[];
    assert.equal(extension.scope, "temporary");
    assert.equal(extension.source, "cli");
    assert.equal(extension.bundled, true);
  } finally {
    rmSync(join(dirname(fixtureDir), "@injaneity"), { recursive: true, force: true });
  }
});
