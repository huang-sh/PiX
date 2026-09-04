/**
 * pitree 无 LLM 端到端测试:
 * 构造合成 session → split → 模拟 clone 运行 → 模拟原分支继续 → delta 预览 → merge → 校验树结构
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert";

const { SessionManager } = await import("@earendil-works/pi-coding-agent");

const PItREE = path.resolve(import.meta.dirname, "../pitree.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pitree-test-"));
const sessionDir = path.join(tmp, "sessions");
fs.mkdirSync(sessionDir);

const run = (args) =>
  execFileSync(process.execPath, [PItREE, ...args], { encoding: "utf8" });

// ---------- 1. 构造原 session: A(user)-B(asst)-C(user)-D(asst), 并给 D 打 label ----------
const cwd = process.cwd();
const sm = SessionManager.create(cwd, sessionDir);
const idA = sm.appendMessage({ role: "user", content: "看看这个项目" });
const idB = sm.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "好的, 已了解结构" }],
});
const idC = sm.appendMessage({ role: "user", content: "考虑两种重构方案" });
sm.appendLabelChange(idC, "决策点"); // label 也是树 entry, 放在 D 前, 保持 leaf=D
const idD = sm.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "方案A: X; 方案B: Y" }],
});
const origPath = sm.getSessionFile();
assert.ok(fs.existsSync(origPath), "原 session 文件应已落盘");
console.log(`① 原 session: ${path.basename(origPath)} (leaf=${idD})`);

// ---------- 2. split: 从 leaf D 创建 clone ----------
const splitOut = run(["split", origPath]);
const clonePath = /] (.+\.jsonl)/.exec(splitOut)?.[1];
assert.ok(clonePath && fs.existsSync(clonePath), `clone 文件应存在\n${splitOut}`);
const forkId = /fork=(\S+)/.exec(splitOut)?.[1];
assert.strictEqual(forkId, idD, "fork 点应为原 leaf");
console.log(`② clone: ${path.basename(clonePath)} (fork=${forkId})`);

// ---------- 3. 未运行时 delta 应为 0 (split 重建的 label 被过滤) ----------
let d = run(["delta", origPath, clonePath]);
assert.match(d, /delta: 0 条/, `未运行时 delta 应为 0 (重建 label 被过滤):\n${d}`);
console.log("③ 空运行 delta=0 ✓ (重建 label 正确过滤)");

// ---------- 4. 模拟 clone 独立运行: E(user)-F(asst)-G(user)-H(asst) ----------
const smC = SessionManager.open(clonePath);
const idL = smC
  .getEntries()
  .find((e) => e.type === "label" && e.targetId === idC)?.id; // split 重建的 label 节点 (新 id)
assert.ok(idL, "clone 中应存在重建的 label 节点");
const idE = smC.appendMessage({ role: "user", content: "执行方案A" });
const idF = smC.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "方案A 完成, 改了 3 个文件" }],
});
const idG = smC.appendMessage({ role: "user", content: "跑下测试" });
const idH = smC.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "全部通过" }],
});
console.log(`④ clone 模拟运行: +4 entries (${idE}..${idH})`);

// ---------- 5. 模拟原分支同时也在继续: X(user)-Y(asst) ----------
const smO = SessionManager.open(origPath);
const idX = smO.appendMessage({ role: "user", content: "先修个bug" });
const idY = smO.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "bug 已修" }],
});
console.log(`⑤ 原分支并行继续: +2 entries (${idX}, ${idY})`);

// ---------- 6. delta 预览 ----------
d = run(["delta", origPath, clonePath]);
assert.match(d, new RegExp(`delta: 5 条`), `delta 应为 5 条 (含重建 label):
${d}`);
assert.match(d, new RegExp(`fork 点 \\(挂载位置\\): ${idD}`), "挂载点应为 D");
console.log("⑥ delta 预览: 5 条 (含重建 label), 挂在 fork 点 D ✓");

// ---------- 7. merge (带 label) ----------
const m = run(["merge", origPath, clonePath, "--label", "merge:方案A"]);
assert.match(m, /合并 5 条 entry/, m);
console.log("⑦ merge 完成 (带 label)");

// ---------- 8. 校验树结构 ----------
const mergedLines = fs
  .readFileSync(origPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const lastLine = mergedLines[mergedLines.length - 1];
assert.strictEqual(lastLine.type, "label", "--label 时文件最后一行应为 label entry");
assert.strictEqual(lastLine.parentId, idH, "label entry 应链接在 clone 最后一条后");
assert.strictEqual(lastLine.targetId, idD, "label 应标记 fork 点");

const smM = SessionManager.open(origPath);
assert.strictEqual(smM.getLeafId(), lastLine.id, "新 leaf 应为 merge label entry");

const activePath = smM.getBranch(idH).map((e) => e.id);
assert.ok(
  [idA, idB, idC, idD, idL, idE, idF, idG, idH].every((id) => activePath.includes(id)),
  `active path 应包含 前缀+重建label+clone delta: ${activePath.join(",")}`
);
assert.ok(
  !activePath.includes(idX) && !activePath.includes(idY),
  "原分支后续 (X,Y) 不在 active path, 作为兄弟分支保留"
);

const childrenOfD = smM.getChildren(idD).map((e) => e.id).sort();
assert.deepStrictEqual(
  childrenOfD,
  [idL, idX].sort(),
  `D 的孩子应为 {X(原分支), L(clone 重建label, delta 从它长出)}: ${childrenOfD}`
);

const backups = fs.readdirSync(sessionDir).filter((f) => f.includes(".bak-"));
assert.strictEqual(backups.length, 1, "应生成一个备份");

const ctx = smM.buildSessionContext();
assert.ok(ctx.messages.length >= 6, "LLM 上下文应完整");

console.log("⑧ 树结构校验通过:");
console.log(`     leaf=${smM.getLeafId()} (merge label entry → 父链到 clone 结果)`);
console.log(`     D 的孩子: ${childrenOfD.join(", ")} (兄弟分支并存)`);
console.log(`     备份: ${backups[0]}`);
console.log(`     LLM 上下文消息数: ${ctx.messages.length}`);

// ---------- 9. 重复 merge 幂等 ----------
const m2 = run(["merge", origPath, clonePath]);
assert.match(m2, /没有可合并的 delta/, m2);
console.log("⑨ 重复 merge 幂等 ✓");

console.log("\n✅ 全部测试通过");
console.log(`   测试数据: ${tmp}`);
