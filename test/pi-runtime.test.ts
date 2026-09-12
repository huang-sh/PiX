import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRuntime } from "../src/main/pi-runtime.js";
import { resolveBuiltinSkills } from "../src/main/builtin-skills.js";
import type { AgentControl, RuntimeSkill, RuntimeSkillDocument } from "../src/shared/types.js";

test("extension commands deliver notifications and errors before and after reload", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-slash-"));
  assert.equal(dirname(home), tmpdir());
  const events: any[] = [];
  const runtime = new PiRuntime(home, join(home, "sessions"), event => events.push(event), async () => {});
  runtime["sessionServicesOptions"] = (pi, cwd) => ({
    cwd, agentDir: home, settingsManager: pi.SettingsManager.inMemory({}),
    resourceLoaderOptions: { additionalExtensionPaths: [], noExtensions: true, extensionFactories: [
      (pi: any) => {
        let started = false;
        pi.on("session_start", () => { started = true; });
        pi.registerCommand("notify-test", { handler: (_args: string, ctx: any) => {
          assert.equal(started, true);
          ctx.ui.notify("command result\nsecond line", "warning");
        } });
        pi.registerCommand("fail-test", { handler: () => { throw new Error("command failure"); } });
        pi.registerCommand("dialog-test", { handler: (_args: string, ctx: any) => ctx.ui.select("Choose", ["one"]) });
      },
    ] },
  });
  try {
    await runtime.create();
    for (const reload of [false, true]) {
      if (reload) await runtime.control({ action: "reload" });
      events.length = 0;
      await runtime.control({ action: "prompt", text: "/notify-test" });
      await runtime.control({ action: "prompt", text: "/fail-test" });
      await runtime.control({ action: "prompt", text: "/dialog-test" });
      const notices = events.filter(event => event.type === "notice");
      assert.equal(notices.length, 3);
      assert.deepEqual(notices[0].payload, { message: "command result\nsecond line", level: "warning", source: "extension" });
      assert.match(notices[1].payload.message, /command failure/);
      assert.equal(notices[1].payload.level, "error");
      assert.match(notices[2].payload.message, /Pi terminal dialog/);
    }
  } finally {
    await runtime.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failing event consumer cannot throw into SDK message persistence", async () => {
  let listener!: (event: unknown) => void;
  let delivered = false;
  const runtime = new PiRuntime(null, null, () => { delivered = true; throw new Error("UI failed"); }, async () => {});
  runtime.runtime = { session: { subscribe: (handler: typeof listener) => { listener = handler; return () => {}; } } };
  runtime.bind();
  assert.doesNotThrow(() => listener({ type: "message_end", message: { role: "user", content: "saved" } }));
  assert.equal(delivered, false, "listener is deferred until after SDK can persist");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(delivered, true);
});

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
    editable: true,
  }]);
});

test("maps bundled skills as a read-only builtin category", async () => {
  const [builtinRoot] = resolveBuiltinSkills(dirname(fileURLToPath(import.meta.url)));
  assert.ok(builtinRoot, "bundled skills tree not found beside the test output");
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = {
    session: {
      resourceLoader: {
        reload: async () => undefined,
        getSkills: () => ({
          skills: [{
            name: "zotero-cli",
            description: "Read and write a Zotero library.",
            filePath: join(builtinRoot, "zotero-cli", "SKILL.md"),
            sourceInfo: { source: "local" },
            disableModelInvocation: false,
          }],
        }),
      },
    },
  };

  const [builtin] = await runtime.control({ action: "getSkills" }) as RuntimeSkill[];

  assert.ok(builtin);
  assert.equal(builtin.scope, "builtin");
  assert.equal(builtin.editable, false);
});

test("toggling a bundled skill's manual-only writes the override table, not the file", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-builtin-toggle-"));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  try {
    let reloads = 0;
    const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
    runtime.runtime = { session: { resourceLoader: { reload: async () => void reloads++ } } };
    const [builtinRoot] = resolveBuiltinSkills(dirname(fileURLToPath(import.meta.url)));
    assert.ok(builtinRoot, "bundled skills tree not found beside the test output");
    const skillPath = join(builtinRoot, "zotero-cli", "SKILL.md");
    assert.ok(existsSync(skillPath), "repo zotero-cli skill missing");
    const original = readFileSync(skillPath, "utf8");

    const result = await runtime.control({ action: "setSkillManualOnly", path: skillPath, manualOnly: true });

    assert.deepEqual(result, { ok: true });
    assert.equal(reloads, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(home, ".pix", "skill-overrides.json"), "utf8")),
      { "zotero-cli": true },
    );
    // The bundled file itself stays byte-for-byte untouched.
    assert.equal(readFileSync(skillPath, "utf8"), original);

    // A path outside every writable or bundled root still fails closed.
    await assert.rejects(
      runtime.control({ action: "setSkillManualOnly", path: join(home, "elsewhere", "x.md"), manualOnly: true }),
    );
  } finally {
    if (previous === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("viewing follows the loaded list: bundled and packaged skills read, strangers do not", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-skill-view-"));
  try {
    // A skill inside an installed package: listed by the loader, neither
    // editable nor bundled.
    const packaged = join(home, "node_modules", "some-pkg", ".agents", "skills", "packaged", "SKILL.md");
    mkdirSync(dirname(packaged), { recursive: true });
    writeFileSync(packaged, "---\nname: packaged\ndescription: From an installed package.\n---\nPackaged body.\n");
    const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
    runtime.runtime = {
      session: {
        // The listed flag is the effective one and may differ from the file
        // (an overridden bundled skill); the viewer must show the effective.
        resourceLoader: { getSkills: () => ({ skills: [{ name: "packaged", filePath: packaged, disableModelInvocation: true }] }) },
      },
    };
    const [builtinRoot] = resolveBuiltinSkills(dirname(fileURLToPath(import.meta.url)));
    assert.ok(builtinRoot, "bundled skills tree not found beside the test output");

    const packagedDocument = await runtime.control({ action: "getSkill", path: packaged }) as RuntimeSkillDocument;
    assert.equal(packagedDocument.name, "packaged");
    assert.match(packagedDocument.body, /Packaged body\./);
    assert.equal(packagedDocument.disableModelInvocation, true);

    const bundledDocument = await runtime.control({
      action: "getSkill",
      path: join(builtinRoot, "zotero-cli", "SKILL.md"),
    }) as RuntimeSkillDocument;
    assert.equal(bundledDocument.name, "zotero-cli");
    assert.match(bundledDocument.description, /Zotero/);

    // A path the loader never listed still requires an editable root.
    const stranger = join(home, "stranger.md");
    writeFileSync(stranger, "---\nname: stranger\ndescription: Not listed.\n---\nBody.\n");
    await assert.rejects(runtime.control({ action: "getSkill", path: stranger }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a user skill that shadows a bundled copy is badged with its path", async () => {
  const [builtinRoot] = resolveBuiltinSkills(dirname(fileURLToPath(import.meta.url)));
  assert.ok(builtinRoot, "bundled skills tree not found beside the test output");
  const winner = "/home/me/.pi/agent/skills/zotero-cli/SKILL.md";
  const runtime = new PiRuntime("/project", "/sessions", () => undefined, async () => undefined);
  runtime.runtime = {
    session: {
      resourceLoader: {
        reload: async () => undefined,
        getSkills: () => ({
          skills: [{
            name: "zotero-cli",
            description: "My own copy.",
            filePath: winner,
            sourceInfo: { source: "local", scope: "user" },
          }],
          diagnostics: [
            { type: "collision", collision: { resourceType: "skill", name: "zotero-cli", winnerPath: winner, loserPath: join(builtinRoot, "zotero-cli", "SKILL.md") } },
            // A shadowed non-bundled copy must not clobber the badge.
            { type: "collision", collision: { resourceType: "skill", name: "other", winnerPath: winner, loserPath: "/project/.pi/skills/other/SKILL.md" } },
          ],
        }),
      },
    },
  };

  const [skill] = await runtime.control({ action: "getSkills", reload: true }) as RuntimeSkill[];

  assert.ok(skill);
  assert.equal(skill.shadowsBuiltin, join(builtinRoot, "zotero-cli", "SKILL.md"));
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
    createAgentSessionFromServices: async () => ({ session: {
      bindExtensions: async () => {}, extensionRunner: { getUIContext: () => ({}) },
    } }),
  };
  const create = () =>
    runtime.factory(fakePi)({ cwd: "/project", sessionManager: {}, sessionStartEvent: undefined });

  // The user's own install suppresses the bundled copy.
  await create();
  assert.deepEqual(servicesOptions.resourceLoaderOptions.additionalExtensionPaths, []);
  assert.equal(servicesOptions.resourceLoaderOptions.extensionFactories[0].name, "pix-file-changes");
  assert.equal(typeof servicesOptions.resourceLoaderOptions.extensionFactories[0].factory, "function");

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
