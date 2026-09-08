import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)),
  workspace = join(root, "test", "workspace"),
  dest = join(workspace, ".pi", "sessions");
mkdirSync(dest, { recursive: true });
const ids = [
  "01a05820-0a00-73a4-a6cb-ac4ee5223f4b",
  "01a05c3c-8181-7527-9509-ff9d5358c3a0",
];
const usage = {
  input: 100,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 140,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const iso = (n) => new Date(Date.UTC(2026, 7, 31, 14, 1, n)).toISOString(),
  stamp = (n) => Date.parse(iso(n));
function generated(id, index) {
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: index ? "2026-09-01T09:11:04.322Z" : "2026-08-31T14:01:29.856Z",
    cwd: workspace,
  };
  const e = [];
  let seq = 0;
  const add = (value, parent) => {
    const entry = {
      ...value,
      id: (seq++).toString(16).padStart(8, "0"),
      parentId: parent,
      timestamp: iso(seq),
    };
    e.push(entry);
    return entry.id;
  };
  const user = (text, parent) =>
    add(
      {
        type: "message",
        message: { role: "user", content: text, timestamp: stamp(seq + 1) },
      },
      parent,
    );
  const assistant = (text, parent, tool) =>
    add(
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text },
            ...(tool
              ? [
                  {
                    type: "toolCall",
                    id: `call_${seq}`,
                    name: tool,
                    arguments: { path: "src/example.ts" },
                  },
                ]
              : []),
          ],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.6",
          usage,
          stopReason: tool ? "toolUse" : "stop",
          timestamp: stamp(seq + 1),
        },
      },
      parent,
    );
  const result = (name, text, parent) =>
    add(
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `call_${seq - 1}`,
          toolName: name,
          content: [{ type: "text", text }],
          isError: false,
          timestamp: stamp(seq + 1),
        },
      },
      parent,
    );
  // Mirrors the entry PiX appends after each finished turn so the GUI has
  // context-usage data to render on the node footer.
  const footer = (parent, tokens) =>
    add(
      {
        type: "custom",
        customType: "pix.node-footer",
        data: {
          contextUsage: {
            tokens,
            contextWindow: 128_000,
            percent: (tokens / 128_000) * 100,
          },
          model: {
            provider: "openai",
            id: "gpt-5.6",
            name: "GPT-5.6",
            contextWindow: 128_000,
            reasoning: true,
          },
          thinkingLevel: "high",
        },
      },
      parent,
    );
  let u1 = user(
      index
        ? "Review the workspace architecture and identify the smallest useful implementation."
        : "Design PiX as a graph-first workbench for Pi Agent sessions.",
      null,
    ),
    a1 = assistant(
      "I will inspect the project and preserve Pi's canonical session tree.",
      u1,
      "read",
    ),
    r1 = result("read", "Loaded src/example.ts and .pi/settings.json", a1),
    f1 = footer(r1, 4_200),
    u2 = user(
      "Implement a horizontal conversation graph and branch-only chat projection.",
      f1,
    ),
    a2 = assistant(
      "The graph now derives from stable id/parentId relationships.",
      u2,
      "write",
    ),
    r2 = result("write", "Updated graph projection and renderer", a2),
    f2 = footer(r2, 8_600),
    u3 = user("Add resizable panels and a collapsible utility dock.", f2),
    a3 = assistant(
      "Navigator, Chat, Content, and the bottom dock now have independent layout state.",
      u3,
    );
  footer(a3, 12_800);
  const alt = add(
      {
        type: "branch_summary",
        fromId: a3,
        summary:
          "The abandoned branch explored a fixed vertical graph and was rejected.",
      },
      r1,
    ),
    u4 = user("Use a left-to-right graph instead and keep the GUI clean.", alt),
    a4 = assistant(
      "Applied left-to-right layout with restrained mint accents and warm surfaces.",
      u4,
      "edit",
    ),
    r4 = result("edit", "Horizontal layout applied", a4);
  let leaf = footer(r4, 21_000);
  if (index === 0) {
    const mc = add(
        { type: "model_change", provider: "openai", modelId: "gpt-5.6" },
        leaf,
      ),
      th = add({ type: "thinking_level_change", thinkingLevel: "high" }, mc),
      u5 = user(
        "Integrate real file, Git, shell, browser, and settings surfaces.",
        th,
      ),
      a5 = assistant(
        "All desktop authority stays in Electron Main while the Renderer uses typed routes.",
        u5,
      );
    leaf = add(
      { type: "label", targetId: u5, label: "workbench-complete" },
      a5,
    );
    leaf = footer(leaf, 33_600);
  } else {
    const compact = add(
        {
          type: "compaction",
          summary:
            "PiX uses Pi SessionManager as canonical state; graph and chat are projections.",
          firstKeptEntryId: u4,
          tokensBefore: 42000,
        },
        leaf,
      ),
      u5 = user(
        "Validate this session through Pi's own parser and switch between both sessions.",
        compact,
      ),
      a5 = assistant(
        "The validation flow calls Pi RPC get_entries and get_tree, then runs GUI switching tests.",
        u5,
      );
    leaf = add(
      {
        type: "custom_message",
        customType: "pix-fixture",
        content: "Fixture context for GUI validation",
        display: true,
      },
      a5,
    );
    leaf = footer(leaf, 33_600);
  }
  add(
    {
      type: "session_info",
      name: index ? "Validate Pi session switching" : "Build the PiX workbench",
    },
    leaf,
  );
  return [header, ...e];
}
function candidates(id) {
  const roots = [
    "/mnt/data",
    join(root, "test", "fixtures"),
    "/mnt/data/PiX-input-sessions",
  ];
  const all = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const walk = (d, depth = 0) => {
      if (depth > 5) return;
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        let s;
        try {
          s = statSync(p);
        } catch {
          continue;
        }
        if (s.isDirectory()) {
          if (!p.startsWith(dest)) walk(p, depth + 1);
        } else if (
          n.endsWith(".jsonl") &&
          n.includes(id) &&
          !p.startsWith(dest)
        )
          all.push(p);
      }
    };
    walk(r);
  }
  return all.sort((a, b) => statSync(b).size - statSync(a).size);
}
const manifest = [];
for (const [id, index] of ids.map((x, i) => [x, i])) {
  const found = candidates(id)[0],
    name = `${index ? "2026-09-01T09-11-04-322Z" : "2026-08-31T14-01-29-856Z"}_${id}.jsonl`,
    target = join(dest, name);
  let lines, source;
  if (found) {
    lines = readFileSync(found, "utf8").split(/\r?\n/).filter(Boolean);
    source = "uploaded";
  } else {
    lines = generated(id, index).map(JSON.stringify);
    source = "generated-fallback";
  }
  const header = JSON.parse(lines[0]);
  header.cwd = workspace;
  header.id = id;
  header.version = 3;
  lines[0] = JSON.stringify(header);
  writeFileSync(target, lines.join("\n") + "\n");
  const raw = readFileSync(target);
  manifest.push({
    id,
    file: name,
    path: target,
    source,
    size: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
    entries: lines.length - 1,
  });
}
mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(
  join(root, "artifacts", "session-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
// src/example.ts lives only in the nested git baseline (the outer repo ignores
// it), so a fresh clone needs it on disk before the baseline commit below.
if (!existsSync(join(workspace, "src", "example.ts"))) {
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "example.ts"),
    'export const greeting = "Hello from the PiX workspace";\n',
  );
}
const git = (args) =>
  spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
if (!existsSync(join(workspace, ".git"))) {
  git(["init", "-q"]);
  git(["config", "user.email", "pix@example.invalid"]);
  git(["config", "user.name", "PiX Test"]);
  git(["add", "."]);
  git(["commit", "-qm", "fixture baseline"]);
}
writeFileSync(
  join(workspace, "src", "example.ts"),
  'export const greeting = "Hello from the edited PiX workspace";\n',
);
writeFileSync(
  join(workspace, "src", "new-file.ts"),
  "export const createdByPiX = true;\n",
);
console.log(JSON.stringify(manifest, null, 2));
