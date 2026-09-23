# 日志（logger）设计

> **现状（已实现，2026-09）**：本节记录与下文计划的差异，下文保留为目标设计。
>
> - 模块是 `src/main/debug-log.ts`（约 50 行）：`debugLog(context, error?)` 写**人类可读单行**（ISO 时间 + `[上下文]` + 错误消息与堆栈，堆栈折成一行并截断 1 KiB），不是 §3 的 JSONL/四级 API。
> - 存储是 `~/.pix/log/main.log`（单文件，超 1 MiB 轮转一份 `main.log.old`），不是 §4 的按会话目录 + 保留 5 个。每次写入前 `statSync` 实测大小，不缓存状态。
> - 已接线 25 处（main 进程），含 §9 表中全部站点；无级别、无 §5 去重。
> - 远程宿主**不落盘**：`src/server/index.ts` 启动时 `setDebugLogEnabled(false)`，宿主继续只走 stderr（§1 非目标已满足）。
> - 用户入口：DesktopRoute `app.revealLogs` → `showItemInFolder(main.log)`，无日志时打开目录；设置 → 关于页按钮 + 中英文案（§8 已满足，文案为“显示日志目录 / Show log folder”）。
> - 测试：`test/debug-log.test.ts`（格式/截断/轮转/轮转失败容忍/多行折叠/PIX_HOME 切换/目录自愈/禁用不落盘）、`test/controller-logs.test.ts`（路由）、`test/gui-test.mjs`（按钮存在性，不点击）。
> - 启动失败：`index.ts` 记录日志 + `dialog.showErrorBox` + 退出（计划中的 §6 进程兜底仍未做）。
>
> **仍未实现（下文计划保留）**：§3 级别门槛、§3 JSONL、§4 按会话目录与保留策略、§5 风暴去重、§6 `uncaughtException`/`unhandledRejection` 兜底、§7 renderer 通道（renderer 尚有 2 处静默 catch：`App.vue:338`、`ToolPanel.vue:148`）、§10 架构防回归规则、§11 README 故障排查小节。

本文是 PiX 日志机制的专题设计：目标、API、存储策略、接线范围与防回归规则。动机：main 进程约 10 处、renderer 约 10 处 `catch {}` 静默吞错，其中 `controller.ts` 的事件刷新路径一旦持续抛异常，界面会"无声停更"且无任何诊断线索。

## 1. 目标与非目标

**目标**

- 让每个被吞掉的失败至少留下一行可 grep 的记录，"面板没反应"类问题从不可诊断变为可诊断。
- 零依赖：不引入 electron-log/pino 等，`appendFileSync` 在本量级足够。
- 日志自身绝不致命：写不进就降级为 stderr，任何情况下不允许 logger 抛异常炸掉宿主代码。
- 占用有硬上限，回答 design.md 对缓存的同款三问（上限多少、何时失效、何时清理）。

**非目标（明确不做）**

- 不做日志查看器 UI（v1 打开文件即可）。
- 不做运行中尺寸轮转、压缩、异步队列（按会话分目录 + 单文件停写已覆盖上限需求）。
- 不劫持 renderer 的 `console`。
- 不在远程宿主机上写日志文件（SSH/WSL 宿主是共享机器，design.md §7 要求不修改宿主环境）。
- 不替 pi 记录 agent 内部日志——那是 pi 的事；本 logger 只记 PiX 外壳自身的诊断事件。

## 2. 三个运行上下文，一份日志

| 上下文 | 通道 | 说明 |
| --- | --- | --- |
| Electron main | 直接写文件 | 唯一的落盘方，logger 本体在这里 |
| renderer（无 Node） | `ipcRenderer.send("pix:log", ...)` 单向 | 与既有 `pix:copy` 同类的专用通道，不走 `DesktopRoute` 白名单 |
| 远程宿主（SSH/WSL） | stderr 既有协议不变；连接建立后由桌面端把宿主 stderr 行转发进本地日志，scope 固定 `remote-host` | 宿主文件留在原地不动，桌面拥有日志文件 |

## 3. API 与记录格式

`src/main/log.ts`，一个模块，约 100 行：

```ts
export type LogLevel = "info" | "warn" | "error" | "debug";
export const log = {
  info(scope: string, event: string, detail?: unknown): void,
  warn(...): void, error(...): void, debug(...): void,
};
```

- scope 是模块名（`controller`、`graph-runtime`、`settings`……），event 是稳定的短横线短语（`session-refresh-failed`），detail 是任意可 JSON 序列化对象。
- 记录格式：**每行一个 JSON**（JSONL），不发明人类格式化，grep/jq 友好：

```jsonl
{"t":"2026-09-14T12:00:00.123Z","lvl":"error","scope":"controller","event":"session-refresh-failed","detail":{"event":"message_end","error":"..."}}
```

- 级别门槛：`error`/`warn`/`info` 恒写；`debug` 在以下任一条件成立时写：`PIX_DEBUG=1`、`~/.pix/logs/.debug` 标志文件存在（重启生效）、`!app.isPackaged`（开发态）。标志文件是低成本版 VS Code `Set Log Level`：支持人员让用户建一个空文件即可打开 debug，不必碰终端环境变量。开发态另将 `warn`/`error` 镜像到 stderr，保证 `electron-vite dev` 终端可见。
- `info` 只用于生命周期里程碑（启动版本信息、session 打开、远程连接/断开），每次运行个位数条。

## 4. 存储、上限与会话目录

布局取自 VS Code 的按会话日志目录模式（`logs/<时间戳>/`）；差异：PiX 不按进程分文件、无动态 logger，一个会话一份 `pix.jsonl`。

- 位置：`join(pixHome(), ".pix", "logs", <会话时间戳>)`。**必须走 `pixHome()`**——`PIX_HOME` 携带整个 profile，GUI 测试全部依赖这一点，日志跟随。时间戳用去符号化的 ISO UTC（如 `2026-09-14T12-00-01-123Z`），字典序即时间序，重名时追加序号。
- 启动时创建本会话目录，并修剪只保留最近 **5** 个会话目录（按目录名排序驱逐最旧）。运行中零轮转逻辑。
- 单文件硬顶 **8 MiB**：logger 自维护写入计数，超限即停写并补一行 `{"event":"log-truncated"}` 记录（风暴的第一层防线是 §5 的去重，硬顶是兜底）。总量上限 5 × 8 = 40 MiB，确定有界。
- 支持场景按会话天然分组："把昨天崩溃那次会话的目录发我"，无需从滚动文件拼时间线。
- 容忍目录不可写：捕获后置 `disabled = true`，仅 stderr 镜像。
- 全部写路径自带 try/catch——logger 的失败只能降级，不能上抛。

## 5. 风暴去重（针对本 bug 的形态）

动机场景是"每个事件都抛一次异常"，不设防会把日志刷爆。规则：

- key = `scope|event`（不含 detail，避免相似错误绕过）。同一 key 在 5 秒窗口内重复 → 只记第一条，计数器累加。
- 出现不同 key 或窗口结束时，补一行 `{"event":"...","+n":123}`。
- 退出时（`app.on("quit")`）冲刷未决计数。

## 6. 进程兜底

`src/main/index.ts` 安装 `uncaughtException` / `unhandledRejection`：`log.error("process", ...)` 后**异步重新抛出**，保持既有崩溃语义不变——打包后的 Windows 崩溃至少留下痕迹，而不是无迹可寻。

## 7. renderer 侧

- preload 暴露 `window.pix.log(level, scope, event, detail?)`，内部 `ipcRenderer.send("pix:log", ...)`，单向、不等待。
- main 侧 `ipcMain.on("pix:log")` 校验四元组形状后按普通记录写入（复用风暴去重）。
- renderer 包装 `src/renderer/log.ts`（约 20 行）：detail 先 `JSON.stringify` 并截断到 2 KiB 再发送，防止把整段消息体灌进日志。
- 不新增 `DesktopRoute`：日志是高频低价值小包，走白名单 invoke 会污染契约类型并制造往返开销；`pix:copy` 已确立"专用窄通道"先例。

## 8. 用户入口

- 设置 → About 页加"打开日志 / Open logs"按钮：新 DesktopRoute `app.revealLogs` → `shell.showItemInFolder(当前会话 pix.jsonl)`（`app.revealSession` 同款做法）。文案进 `i18n.ts`，中英同步（design.md §8）。
- README 故障排查小节指路 `~/.pix/logs/`。

## 9. 接线表（现状 catch 站点 → 级别）

| 站点 | 级别 | 理由 |
| --- | --- | --- |
| `controller.ts:125` 事件后快照刷新/推送失败 | **error** | 界面停更的元凶，必须最高可见 |
| `controller.ts:699` import 前 validate 失败 | debug | best-effort 预检，后续 import 自会报错 |
| `graph-runtime.ts:113` 分支事件 emit 失败 | warn | 监听器抛异常 = renderer bug 信号 |
| `graph-runtime.ts:50/117` notify/snapshot 刷新 | debug | best-effort 通知 |
| `graph-runtime.ts:395/424` worker 清理 | debug | 已失败路径上的收尾 |
| `graph-files.ts:346` 会话严格解析失败走恢复路径 | warn | 会话文件损坏，用户资产风险 |
| `graph-files.ts:109` `.bak` 写失败 | warn | 备份缺失但主写继续 |
| `graph-files.ts:386` 恢复尝试失败 | warn | 同 346 |
| `services.ts:124` 损坏设置隔离失败 | error | 用户设置可能丢失 |
| `ssh-host-installer.ts:54` 非法 host 行 | warn | 用户可自行修复的配置问题 |
| `pi-runtime.ts:320` 事件转发失败 | debug | 高频路径，仅 debug |
| `index.ts:241/250` 既有 console.error | 改走 log | 统一出口 |
| renderer 各站点（CopyButton、MarkdownRenderer、Navigator 等） | 逐个定级 | 外观类=debug，面板破坏类=warn |

接线原则：**只加日志行，不改控制流**——try/catch 保留原样（它们保护事件循环的本意不变），这是日志补丁不是行为变更。

## 10. 防回归：把一次清理变成不变量

在 `test/architecture.test.ts` 追加两条 grep 规则（与现有规则同款做法）：

1. **裸 `catch {}` 白名单**：`src/` 下允许空 catch 的文件仅限 `log.ts` 自身与测试夹具；新增空 catch 必须改为记日志，或到白名单里报到并给理由。
2. **`console.*` 只许出现在 `src/main/log.ts`**：防止新代码绕过 logger 直写 console。

这把"那 20 处"从待办变成架构约束——root cause 的防复发手段。

## 11. 测试计划

- `test/log.test.ts`（node:test，`PIX_HOME` 指向临时目录）：基本写入、debug 门控（env 与 `.debug` 标志文件两路）、会话目录创建与启动修剪（保留最近 5 个）、单文件 8 MiB 停写、风暴去重聚合计数、只读目录降级不抛异常、退出冲刷。
- architecture 两条新规则如上。
- "打开日志"按钮按 design.md §8 在运行的 app 里亲眼检查（GUI 约定），i18n 双语断言沿用现有 renderer 测试。

## 12. 落地切分（一个 PR 一个问题）

1. **PR 1**：`log.ts` + 进程兜底 + main 侧接线（第 9 节）+ architecture 规则 + `test/log.test.ts`。
2. **PR 2**：renderer 通道（preload/包装）+ renderer 接线 + About 按钮 + i18n + README。
3. **可选 PR 3**：远程宿主 stderr 转发进本地日志（scope `remote-host`）。

预计体量：PR 1 ≈ log.ts 100 行 + 接线 ~40 行改动 + 测试 ~120 行；PR 2 ≈ 60 行 + i18n。行为变化落地时同步更新 `docs/design.md`（新增一节指向本文）与 `docs.md` 文档地图。
