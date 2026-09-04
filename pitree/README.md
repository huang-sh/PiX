# pitree — pi session tree 并行分支工具

基于 pi session JSONL 的树机制（每行一个 entry，`id`/`parentId` 链接，**加载时 active leaf = 文件最后一行**），实现：

```
split → 在独立文件里并行运行 clone → 把 delta 行 append 回原文件 → 重开 session
```

合并语义（树的原生语义，非 git 式线性合并）：

```
             ┌─ ○ 原分支后续（保留为兄弟分支，/tree 可跳回）
A ─ B ─ C ─ D ─ ● clone 的工作（挂在 fork 点，成为新 active 分支）
```

## 命令

```bash
# 1. 到达分叉点后退出 pi，然后从当前 leaf 创建 N 个 clone
node pitree.mjs split <session.jsonl> [-n 2] [-o 输出目录]

# 2. 独立运行 clone（可多终端并行；也可用 explore 一条龙）
node pitree.mjs run <clone.jsonl> "<prompt>" [--model anthropic/claude-sonnet-4-5:high] [--cwd DIR]

# 3. 预览将被合并的 delta 行（纯文件操作，不依赖 SDK）
node pitree.mjs delta <原.jsonl> <clone.jsonl>

# 4. 备份 + 追加 delta；--label 在 fork 点打标记（/tree 里可见）
node pitree.mjs merge <原.jsonl> <clone.jsonl> [--label "merge:方案A"]

# 一条龙：split N 个 clone → 并行运行 → 逐个 merge（最后一个为新 leaf）
node pitree.mjs explore <session.jsonl> -p "方案A..." -p "方案B..." [--model M] [--no-merge]

# 5. 重开
pi --session <原.jsonl>   # 或 pi -c
```

## 安全规则

1. **merge 前确保没有 pi 进程在写原 session 文件**（双写会交错坏行）
2. merge 自动备份为 `<原文件>.bak-<时间戳>`，操作错误随时回滚
3. `delta` / `merge` 是纯文件操作，不加载 SDK；`split` / `run` / `explore` 需要 SDK
   （找不到包时设 `PI_PKG_DIR` 指向含 `@earendil-works/pi-coding-agent` 的 node_modules 目录）
4. merge 前自动校验 delta 的 `parentId` 链（防孤儿 entry），失败即中止
5. **并行 clone 共享同一工作目录**——并行修改文件请用 `git worktree` + `run --cwd` 隔离，
   或只让 clone 做只读/分析类任务

## 实现细节（为什么这样是对的）

- `createBranchedSession(leafId)` 复制路径到新文件且**保留 entry id** → delta 判定就是
  "id 不在原文件里的行"
- **label 是真实的链式树节点**（后续 entry 可能挂在它下面），split 时会以新 id 重建在路径末尾。
  因此 delta 只跳过"尾部且与原文件重复"的重建 label；中间的一律保留以维持 parent 链完整
- 直接 append 后 active leaf = 新最后一行 = clone 的结果，无需改任何 `parentId`

## 测试

```bash
node test/test.mjs   # 无 LLM 端到端：合成 session → split → 模拟运行 → delta → merge → 树结构断言
```
