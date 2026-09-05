import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBundledExtension, resolveBuiltinPackages } from "../src/main/builtin-packages.js";

const PACKAGE_NAME = "@injaneity/pi-computer-use";

function packageMarker(dir: string, name = PACKAGE_NAME): string {
  const packageDir = join(dir, name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), "{}");
  return packageDir;
}

test("finds the bundled package in the packaged app layout", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-"));
  try {
    // Mirrors electron-builder extraResources "pi-builtin" which nests the
    // package under a node_modules-style directory.
    const packageDir = packageMarker(
      join(root, "resources", "pi-builtin", "node_modules"),
    );
    const moduleDir = join(root, "resources", "app.asar", "out", "main");
    assert.deepEqual(resolveBuiltinPackages(moduleDir), [packageDir]);
    assert.equal(isBundledExtension(moduleDir, join(packageDir, "extensions", "computer-use.ts")), true);
    assert.equal(isBundledExtension(moduleDir, join(`${packageDir}-other`, "index.ts")), false);
    assert.equal(isBundledExtension(moduleDir, join(root, "user-extension.ts")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds the bundled package in the dev and server layouts via node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-"));
  try {
    const packageDir = packageMarker(join(root, "node_modules"));
    for (const moduleDir of [
      join(root, "out", "main"), // dev Electron run
      join(root, "dist", "main"), // remote server host
    ]) {
      assert.deepEqual(resolveBuiltinPackages(moduleDir), [packageDir]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefers the packaged layout over node_modules when both exist", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-"));
  try {
    const packaged = packageMarker(
      join(root, "resources", "pi-builtin", "node_modules"),
    );
    packageMarker(join(root, "node_modules"));
    const moduleDir = join(root, "resources", "app.asar", "out", "main");
    assert.deepEqual(resolveBuiltinPackages(moduleDir), [packaged]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns empty when no bundled package exists on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-"));
  try {
    assert.deepEqual(resolveBuiltinPackages(join(root, "out", "main")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a user-installed npm source in any scope suppresses the bundled copy", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-"));
  try {
    packageMarker(join(root, "node_modules"));
    const moduleDir = join(root, "out", "main");
    const forms = [
      [`npm:${PACKAGE_NAME}`],
      [`npm:${PACKAGE_NAME}@0.4.0`],
      [{ source: `npm:${PACKAGE_NAME}@0.5.1` }],
      [{ source: `npm:${PACKAGE_NAME}`, autoload: false }],
    ];
    for (const packages of forms) {
      const settings = { getPackages: () => packages };
      assert.deepEqual(
        resolveBuiltinPackages(moduleDir, settings),
        [],
        `expected suppression for ${JSON.stringify(packages)}`,
      );
    }
    // A project packages list replaces the user-level list in the merged
    // getPackages() view; the user-level install must still suppress.
    const scoped = {
      getPackages: () => ["npm:other/project-package"],
      getGlobalSettings: () => ({ packages: [`npm:${PACKAGE_NAME}`] }),
      getProjectSettings: () => ({ packages: ["npm:other/project-package"] }),
    };
    assert.deepEqual(resolveBuiltinPackages(moduleDir, scoped), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unrelated or same-prefix packages do not suppress the bundled copy", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-"));
  try {
    const packageDir = packageMarker(join(root, "node_modules"));
    const moduleDir = join(root, "out", "main");
    for (const packages of [
      [],
      ["npm:@injaneity/pi-computer"],
      [{ source: "npm:@injaneity/other" }],
      ["git:github.com/injaneity/pi-computer-use"],
      ["/local/path/extensions"],
    ]) {
      const settings = { getPackages: () => packages };
      assert.deepEqual(resolveBuiltinPackages(moduleDir, settings), [packageDir]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled packages are discovered and user installs suppress only their own copy", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-"));
  try {
    for (const [modules, moduleDir] of [
      [join(root, "node_modules"), join(root, "out", "main")],
      [join(root, "resources", "pi-builtin", "node_modules"), join(root, "resources", "app.asar", "out", "main")],
    ] as const) {
      const computer = packageMarker(modules);
      const fff = packageMarker(modules, "@ff-labs/pi-fff");
      const web = packageMarker(modules, "pi-web-access");
      assert.deepEqual(resolveBuiltinPackages(moduleDir), [computer, fff, web]);
      assert.equal(isBundledExtension(moduleDir, join(web, "index.ts")), true);
      for (const source of ["npm:pi-web-access", { source: "npm:pi-web-access@0.27.0", autoload: false }]) {
        assert.deepEqual(resolveBuiltinPackages(moduleDir, { getPackages: () => [source] }), [computer, fff]);
      }
      assert.equal(isBundledExtension(moduleDir, join(fff, "src", "index.ts")), true);
      for (const source of ["npm:@ff-labs/pi-fff", { source: "npm:@ff-labs/pi-fff@0.10.6", autoload: false }]) {
        assert.deepEqual(resolveBuiltinPackages(moduleDir, { getPackages: () => [source] }), [computer, web]);
      }
      assert.deepEqual(resolveBuiltinPackages(moduleDir, { getPackages: () => [`npm:${PACKAGE_NAME}`] }), [fff, web]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi loads the bundled packages and registers their tools and commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-agent-"));
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Keep the user's custom instructions.");
    const settingsManager = pi.SettingsManager.create(root, agentDir);
    const services = await pi.createAgentSessionServices({
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: resolveBuiltinPackages(
          dirname(fileURLToPath(import.meta.url)),
          settingsManager,
        ),
      },
    });
    const tools = new Set(
      services.resourceLoader
        .getExtensions()
        .extensions.flatMap((extension: { tools: Map<string, unknown> }) => [
          ...extension.tools.keys(),
        ]),
    );
    assert.ok(
      tools.has("observe_ui") && tools.has("act_ui"),
      `computer-use tools not registered, got: ${[...tools].join(", ")}`,
    );
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    assert.ok(tools.has("web_search") && tools.has("fetch_content"));
    assert.ok(services.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has("fff-mode")));
    const { session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager: pi.SessionManager.inMemory(root),
    });
    try {
      const tool = session.getAllTools().find((tool) => tool.name === "observe_ui");
      assert.ok(tool);
      assert.equal(tool.sourceInfo.source, "cli");
      assert.equal(tool.sourceInfo.scope, "temporary");
      assert.match(tool.sourceInfo.path, /computer-use/);
      assert.match(session.systemPrompt, /Keep the user's custom instructions\./);
      assert.deepEqual(services.resourceLoader.getAppendSystemPrompt(), ["Keep the user's custom instructions."]);
      await session.reload();
      assert.deepEqual(services.resourceLoader.getAppendSystemPrompt(), ["Keep the user's custom instructions."]);
    } finally {
      session.dispose();
    }
    assert.deepEqual(settingsManager.getPackages(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
