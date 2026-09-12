import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(process.cwd(), "src");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n: string) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
test("Pi SDK is isolated to the main runtime adapter and its internal extensions", () => {
  const hits = walk(root).filter((p) =>
    readFileSync(p, "utf8").includes("@earendil-works/pi-coding-agent"),
  );
  assert.deepEqual(
    hits.map((p) => p.replace(root, "").replaceAll("\\", "/")),
    ["/main/extensions/file-changes.ts", "/main/pi-runtime.ts"],
  );
});
test("renderer has no Node, Electron, or Pi authority", () => {
  const text = walk(join(root, "renderer"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    text,
    /(?:node:fs|node:child_process|from\s*["']electron["']|pi-coding-agent)/,
  );
});
test("sessions are dynamic and no demo session array is embedded", () => {
  const text = readFileSync(join(root, "renderer", "stores", "session.ts"), "utf8");
  assert.equal(text.includes("demoEntries"), false);
  assert.match(text, /session\.list|app\.bootstrap/);
});
test("Vue renderer owns four feature panels and a Vue Flow graph", () => {
  const renderer = join(root, "renderer");
  const files = [
    "features/navigator/SessionNavigator.vue",
    "features/graph/GraphPanel.vue",
    "features/graph/PromptNode.vue",
    "features/graph/DraftNode.vue",
    "features/branch-context/BranchContextPanel.vue",
    "features/tools/ToolPanel.vue",
    "features/workbench/Workbench.vue",
  ];
  for (const file of files) assert.ok(exists(join(renderer, file)), file);
  const graph = readFileSync(join(renderer, "features/graph/GraphPanel.vue"), "utf8");
  const workbench = readFileSync(join(renderer, "features/workbench/Workbench.vue"), "utf8");
  const app = readFileSync(join(renderer, "App.vue"), "utf8");
  assert.match(graph, /VueFlow/);
  assert.match(workbench, /SplitterGroup/);
  assert.match(app, /<KeepAlive>[\s\S]*<Workbench/);
  assert.equal(exists(join(renderer, "app.ts")), false);
});
function exists(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
