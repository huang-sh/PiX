#!/usr/bin/env node
/**
 * pitree — pi session tree 并行分支工具
 *
 * 核心思路（基于 pi session JSONL 的树结构: 每行一个 entry, id/parentId 链接, 加载时 leaf=最后一行）:
 *   split  : 从当前 leaf 把 active 分支复制成独立 clone 文件 (entry id 保留)
 *   run    : 用 pi SDK 在 clone 文件上独立运行 agent (可与原 session 并行, 互不干扰)
 *   delta  : dry-run, 预览 clone 中哪些行会被合并 (id 不在原文件里的行 = delta)
 *   merge  : 备份原文件后把 delta 行追加到原 jsonl 末尾
 *            → clone 的工作挂回 fork 点成为兄弟分支, 重开后 active leaf = clone 的结果
 *
 * 用法:
 *   node pitree.mjs split   <session.jsonl> [-n 数量] [-o 输出目录]
 *   node pitree.mjs run     <clone.jsonl> <prompt...> [--model provider/id:level] [--cwd DIR] [--quiet]
 *   node pitree.mjs delta   <original.jsonl> <clone.jsonl>
 *   node pitree.mjs merge   <original.jsonl> <clone.jsonl> [--label 名称] [--no-backup]
 *   node pitree.mjs explore <session.jsonl> -p "提示词A" -p "提示词B" [--model M] [--no-merge]
 *
 * 环境变量:
 *   PI_PKG_DIR  当脚本不在 pi 包的 node_modules 目录树下时, 指向包含
 *               @earendil-works/pi-coding-agent 的 node_modules 目录 (split/run 需要;
 *               delta/merge 是纯文件操作, 不依赖 SDK)
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// ---------- SDK 加载 (仅 split/run/explore 需要) ----------

let _sdk;
async function loadSdk() {
  if (_sdk) return _sdk;
  // 优先 PI_PKG_DIR 显式覆盖 (直接指向包入口文件, 绕过 exports 解析)
  if (process.env.PI_PKG_DIR) {
    const entry = path.join(
      process.env.PI_PKG_DIR,
      "@earendil-works/pi-coding-agent/dist/index.js"
    );
    if (fs.existsSync(entry)) {
      _sdk = await import(pathToFileURL(entry).href);
      return _sdk;
    }
  }
  try {
    _sdk = await import("@earendil-works/pi-coding-agent");
    return _sdk;
  } catch (e) {
    throw new Error(
      `无法加载 @earendil-works/pi-coding-agent (ESM 包, 最后错误: ${e.message})。\n` +
        `请设置 PI_PKG_DIR 指向包含该包的 node_modules 目录。delta/merge 子命令不依赖 SDK, 可直接使用。`
    );
  }
}

// ---------- JSONL 读取 / delta 计算 / 校验 ----------

function readJsonl(file) {
  const text = fs.readFileSync(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${file}: 存在无法解析的行: ${l.slice(0, 80)}`);
      }
    });
}

function treeEntries(entries) {
  return entries.filter((e) => e.type !== "session"); // 排除 header
}

/**
 * delta = clone 中 id 不在原文件里的 entry (即 clone 独立运行产生的新内容)。
 *
 * 注意 label 是真实的链式树节点 (后续 entry 可能挂在它下面), 不能无条件剔除,
 * 否则会产生孤儿 entry。只有“尾部”且与原文件重复的 label (split 时重建、其后
 * 无实质内容) 才跳过。session_info 等其它类型一律保留以维持 parent 链完整。
 */
function computeDelta(origEntries, cloneEntries) {
  const origIds = new Set(treeEntries(origEntries).map((e) => e.id));
  const origLabels = new Set(
    treeEntries(origEntries)
      .filter((e) => e.type === "label" && e.label)
      .map((e) => `${e.targetId}\u0000${e.label}`)
  );
  const tree = treeEntries(cloneEntries);
  let end = tree.length;
  while (end > 0) {
    const e = tree[end - 1];
    if (
      e.type === "label" &&
      e.label &&
      origLabels.has(`${e.targetId}\u0000${e.label}`)
    )
      end--; // 尾部的重建 label, 且其后没有实质内容 → 跳过
    else break;
  }
  const delta = [];
  for (const e of tree.slice(0, end)) if (!origIds.has(e.id)) delta.push(e);
  return delta;
}

/** 校验 delta 的 parentId 链: 每条 entry 的父节点必须存在于 原文件 ∪ 前序 delta */
function validateDelta(origEntries, delta) {
  if (delta.length === 0) return { ok: true, fork: null };
  const valid = new Set(treeEntries(origEntries).map((e) => e.id));
  for (let i = 0; i < delta.length; i++) {
    const e = delta[i];
    if (!e.parentId || !valid.has(e.parentId)) {
      return {
        ok: false,
        error:
          `第 ${i + 1} 条 delta (id=${e.id}, type=${e.type}) 的 parentId=${e.parentId} ` +
          `在原文件及前序 delta 中不存在 → 孤儿 entry, 中止合并`,
      };
    }
    valid.add(e.id);
  }
  return { ok: true, fork: delta[0].parentId };
}

function genId(existingIds) {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) return id;
  }
  return randomUUID();
}

function summarizeDelta(delta) {
  const byType = {};
  for (const e of delta) {
    const key =
      e.type === "message" ? `message:${e.message?.role ?? "?"}` : e.type;
    byType[key] = (byType[key] ?? 0) + 1;
  }
  return Object.entries(byType)
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
}

// ---------- 子命令 ----------

async function cmdSplit(origPath, flags) {
  const { SessionManager } = await loadSdk();
  const n = Number(flags.n ?? 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    // 每次都 fresh open: createBranchedSession 会把当前 sm 原地变成新 session
    const sm = SessionManager.open(origPath);
    const forkId = sm.getLeafId();
    const clonePath = sm.createBranchedSession(forkId);
    if (!clonePath || !fs.existsSync(clonePath)) {
      console.error(
        `! clone #${i + 1}: 文件未落盘 (分支内无 assistant 消息时 pi 会延迟写文件), 已跳过`
      );
      continue;
    }
    if (flags.o) {
      const dest = path.join(flags.o, path.basename(clonePath));
      fs.copyFileSync(clonePath, dest);
      fs.rmSync(clonePath);
      out.push({ path: dest, fork: forkId });
    } else {
      out.push({ path: clonePath, fork: forkId });
    }
  }
  if (out.length === 0) process.exit(1);
  console.log(`✓ 已从 leaf (fork 点) 创建 ${out.length} 个 clone:`);
  for (const [i, c] of out.entries())
    console.log(`  [${String.fromCharCode(65 + i)}] ${c.path}\n      fork=${c.fork}`);
  console.log(`\n运行: node pitree.mjs run <clone> "<prompt>"`);
  console.log(`合并: node pitree.mjs delta ${origPath} <clone>  # 先预览`);
  return out;
}

async function cmdRun(clonePath, prompts, flags) {
  const sdk = await loadSdk();
  const modelRuntime = await sdk.ModelRuntime.create();
  const sm = sdk.SessionManager.open(clonePath);
  const cwd = flags.cwd || sm.getCwd();
  const opts = { sessionManager: sm, modelRuntime, cwd };

  if (flags.model) {
    const r = sdk.resolveCliModel({ cliModel: flags.model, modelRuntime });
    if (r.error) throw new Error(r.error);
    if (r.warning) console.warn(r.warning);
    if (r.model) opts.model = r.model;
    if (r.thinkingLevel) opts.thinkingLevel = r.thinkingLevel;
  }

  const { session, modelFallbackMessage } = await sdk.createAgentSession(opts);
  if (modelFallbackMessage) console.warn(modelFallbackMessage);
  console.error(`# clone 运行中 (cwd=${cwd}, model=${session.model?.id ?? "默认"})`);

  if (!flags.quiet) {
    session.subscribe((ev) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent.type === "text_delta"
      ) {
        process.stdout.write(ev.assistantMessageEvent.delta);
      } else if (ev.type === "tool_execution_start") {
        process.stdout.write(`\x1b[2m[${ev.toolName}]\x1b[0m `);
      }
    });
  }

  for (const p of prompts) await session.prompt(p);
  session.dispose();

  const finalSm = sdk.SessionManager.open(clonePath);
  const leaf = finalSm.getLeafEntry();
  console.error(`\n✓ 运行完成: ${clonePath} (leaf=${leaf?.id})`);
}

function cmdDelta(origPath, clonePath) {
  const orig = readJsonl(origPath);
  const clone = readJsonl(clonePath);
  const delta = computeDelta(orig, clone);
  const v = validateDelta(orig, delta);
  console.log(`原文件 entry: ${treeEntries(orig).length}  clone entry: ${treeEntries(clone).length}`);
  if (delta.length === 0) {
    console.log("delta: 0 条 (clone 未产生新内容, 或已合并过)");
    return;
  }
  console.log(`delta: ${delta.length} 条 (${summarizeDelta(delta)})`);
  console.log(`fork 点 (挂载位置): ${v.fork ?? "-"}`);
  if (!v.ok) {
    console.error(`✗ 校验失败: ${v.error}`);
    process.exit(1);
  }
  for (const e of delta) {
    const role = e.type === "message" ? ` ${e.message?.role}` : "";
    const text = e.type === "message"
      ? typeof e.message?.content === "string"
        ? e.message.content.slice(0, 60)
        : (e.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text.slice(0, 60)).join(" ")
      : e.type === "label" ? `label="${e.label}" → ${e.targetId}` : "";
    console.log(`  ${e.id} ← ${e.parentId}  ${e.type}${role}  ${text}`);
  }
}

async function cmdMerge(origPath, clonePath, flags) {
  const orig = readJsonl(origPath);
  const clone = readJsonl(clonePath);
  const delta = computeDelta(orig, clone);
  const v = validateDelta(orig, delta);
  if (!v.ok) {
    console.error(`✗ 校验失败: ${v.error}`);
    process.exit(1);
  }
  if (delta.length === 0) {
    console.log("没有可合并的 delta");
    return;
  }

  let backupPath;
  if (!flags["no-backup"]) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    backupPath = `${origPath}.bak-${stamp}`;
    fs.copyFileSync(origPath, backupPath);
  }

  let text = fs.readFileSync(origPath, "utf8");
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";

  const lines = delta.map((e) => JSON.stringify(e));
  const lastId = delta[delta.length - 1].id;
  let labelId;
  if (flags.label) {
    const ids = new Set([
      ...treeEntries(orig).map((e) => e.id),
      ...delta.map((e) => e.id),
    ]);
    labelId = genId(ids);
    lines.push(
      JSON.stringify({
        type: "label",
        id: labelId,
        parentId: lastId,
        timestamp: new Date().toISOString(),
        targetId: v.fork,
        label: flags.label,
      })
    );
  }
  fs.writeFileSync(origPath, text + lines.join("\n") + "\n");

  console.log(`✓ 合并 ${delta.length} 条 entry (${summarizeDelta(delta)})`);
  if (delta.some((e) => e.type === "session_info"))
    console.log(`  ⚠ delta 含 session_info: clone 分支里改过的 session 名将一并生效`);
  console.log(`  fork 点: ${v.fork}  (clone 工作作为兄弟分支挂回此处)`);
  console.log(`  新 leaf: ${labelId ?? lastId}${flags.label ? ` (label entry, parent=${lastId})` : ""}`);
  if (backupPath) console.log(`  备份:   ${backupPath}`);
  console.log(`\n重开: pi --session "${origPath}"`);
  console.log(`注意: 确保没有正在运行的 pi 进程还在写这个 session 文件 (坑3)`);
}

async function cmdExplore(origPath, flags) {
  const prompts = flags.p;
  if (!Array.isArray(prompts) || prompts.length === 0) {
    console.error("explore 需要至少一个 -p <prompt>");
    process.exit(1);
  }
  const clones = await cmdSplit(origPath, { n: prompts.length, o: flags.o });
  if (clones.length !== prompts.length) {
    console.error("clone 创建数量与 prompt 数不一致, 中止");
    process.exit(1);
  }

  console.error(`\n# 并行运行 ${clones.length} 个 clone …\n`);
  const sdk = await loadSdk();
  const modelRuntime = await sdk.ModelRuntime.create();
  const results = await Promise.all(
    clones.map(async ({ path: clonePath }, i) => {
      const tag = `[${String.fromCharCode(65 + i)}]`;
      const sm = sdk.SessionManager.open(clonePath);
      const opts = { sessionManager: sm, modelRuntime, cwd: flags.cwd || sm.getCwd() };
      if (flags.model) {
        const r = sdk.resolveCliModel({ cliModel: flags.model, modelRuntime });
        if (r.error) throw new Error(r.error);
        if (r.model) opts.model = r.model;
        if (r.thinkingLevel) opts.thinkingLevel = r.thinkingLevel;
      }
      const { session } = await sdk.createAgentSession(opts);
      session.subscribe((ev) => {
        if (ev.type === "agent_start") console.error(`${tag} 开始: ${prompts[i].slice(0, 50)}`);
        else if (ev.type === "tool_execution_start") console.error(`${tag}   ${ev.toolName}`);
        else if (ev.type === "agent_end") console.error(`${tag} 完成`);
      });
      try {
        await session.prompt(prompts[i]);
        return { ok: true, clonePath };
      } catch (e) {
        console.error(`${tag} 失败: ${e.message}`);
        return { ok: false, clonePath };
      } finally {
        session.dispose();
      }
    })
  );

  // 打印每个 clone 的最终回复摘要
  for (const [i, r] of results.entries()) {
    if (!r.ok) continue;
    const sm = sdk.SessionManager.open(r.clonePath);
    const entries = sm.getEntries();
    const lastAssistant = [...entries]
      .reverse()
      .find((e) => e.type === "message" && e.message.role === "assistant");
    const text = lastAssistant
      ? typeof lastAssistant.message.content === "string"
        ? lastAssistant.message.content
        : lastAssistant.message.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
      : "(无回复)";
    console.error(`\n[${String.fromCharCode(65 + i)}] 结果摘要: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
  }

  if (flags.merge === false) {
    console.error(`\n# 未自动合并。手动选择合并:\n  node pitree.mjs merge ${origPath} <clone路径>`);
    return;
  }
  console.error(`\n# 按顺序合并全部 clone (每个挂回 fork 点成为兄弟分支, 最后一个为新 leaf) …`);
  for (const [i, r] of results.entries()) {
    if (!r.ok) continue;
    const label = `explore-${String.fromCharCode(65 + i)}: ${prompts[i].slice(0, 24)}`;
    await cmdMerge(origPath, r.clonePath, { label });
  }
}

// ---------- 参数解析 / 入口 ----------

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const boolFlags = new Set(["quiet", "no-backup", "no-merge", "help"]);
  const repeatFlags = new Set(["-p"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" ) { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("-") && a.length >= 2 && !/^-\d/.test(a)) {
      const key = a.replace(/^--?/, "");
      if (boolFlags.has(key)) flags[key] = true;
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`缺少参数值: ${a}`);
        if (repeatFlags.has(a)) (flags[key] ??= []).push(v);
        else flags[key] = v;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const HELP = `pitree — pi session tree 并行分支工具

用法:
  pitree split   <session.jsonl> [-n N] [-o 目录]        从当前 leaf 创建 N 个 clone
  pitree run     <clone.jsonl> <prompt...> [--model M]    在 clone 上独立运行 agent
               [--cwd DIR] [--quiet]
  pitree delta   <original.jsonl> <clone.jsonl>           预览将被合并的 delta 行
  pitree merge   <original.jsonl> <clone.jsonl>           备份 + 追加 delta 到原文件
               [--label 名称] [--no-backup]
  pitree explore <session.jsonl> -p "A" -p "B" [...]      split → 并行 run → 逐个 merge
               [--model M] [--no-merge]

典型流程:
  1. 在 pi 中到达分叉点, 退出 (避免双写)
  2. pitree split ~/.pi/agent/sessions/.../xxx.jsonl -n 2
  3. pitree run <cloneA> "实现方案A..."   (可开两个终端并行)
  4. pitree delta 原.jsonl <cloneA>       # 预览
  5. pitree merge 原.jsonl <cloneA> --label "方案A"
  6. pi --session 原.jsonl 继续, /tree 里可看到全部分支

安全规则:
  - merge 前确保没有 pi 进程在写原 session 文件
  - merge 自动备份为 .bak-<时间戳>; delta/merge 不依赖 SDK, 纯文件操作
  - 并行 clone 共享同一工作目录, 并行改文件请用 git worktree + --cwd 隔离`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  switch (cmd) {
    case "split":
      return cmdSplit(pos[0], flags);
    case "run":
      return cmdRun(pos[0], pos.slice(1), flags);
    case "delta":
      return cmdDelta(pos[0], pos[1]);
    case "merge":
      return cmdMerge(pos[0], pos[1], flags);
    case "explore":
      return cmdExplore(pos[0], flags);
    default:
      console.log(HELP);
      process.exit(cmd && cmd !== "help" ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
