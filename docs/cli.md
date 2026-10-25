# PiX CLI 与共享 Host

GUI 与 CLI 都连接到独立的 PiX Host。Host 在同一台机器、同一 `PIX_HOME` 下只启动一份，管理多个项目和会话。CLI 不依赖 Electron，使用与 GUI 相同的 Agent、工具、配置和会话树。本版 CLI 命令针对本地项目；SSH/WSL 项目继续通过 GUI 连接远程 Host。

需要 Node.js 22.19 或更高版本。从仓库构建：

```sh
npm install
npm run build:cli
node bin/pix.mjs --help
node bin/pix.mjs run "检查项目中失败的测试"
```

`npm run cli -- <参数>` 也是源码入口。`npm link` 后可以直接使用 `pix`；该仓库的桌面开发依赖包括 Electron。

需要仅含 Node.js 依赖的安装包时：

```sh
npm run build:cli
npm pack ./server --pack-destination /tmp
npm install --global /tmp/pix-server-0.0.28.tgz
pix --help
```

这个包只包含编译后的 Node.js 代码、内置 skills 和服务器依赖，不包含 Electron 或 Vue。项目仍为 private，不会自动发布到 npm。桌面开发 `npm run dev` 会先构建共享 Host；修改核心代码后，需要在任务完成时执行 `pix host stop` 并重新连接才能加载新版后台；桌面发行包携带自己的同版本 Host 入口。

## 常用操作

```sh
pix --cwd /path/to/project new
pix --cwd /path/to/project sessions
pix run "解释这个项目" --model zai/glm-5.3
pix resume <会话ID或JSONL完整路径>
pix resume <会话ID或路径> "继续检查错误处理"
pix tree --session <会话ID或路径>
pix fork <节点ID> "尝试另一种方案" --session <会话ID或路径>
pix run "新的独立上下文" --session <会话ID或路径> --root
pix stop --session <会话ID或路径>
```

`run` 不指定会话时创建新会话；指定会话后默认从主分支当前节点继续。操作其他分支时使用 `--node` 或 `fork`，交互模式在每次回复后跟随本次任务实际所在的分支。会话选择限定于 `--cwd` 指定的项目，支持完整会话 ID 或完整路径。

无命令时进入逐行交互模式。`/tree` 显示树，`/node <节点ID>` 切换后续输入的分叉点，`/exit` 退出客户端。其他 slash 命令交给 Pi 扩展执行。不提供依赖 Pi 自定义 TUI 组件的扩展界面。

树直接读取 PiX 的 `GraphRuntime` 快照，保留主干、嵌套分叉、继承关系与运行状态。主文件是 Pi v3 JSONL，子分支保存于相邻的 `<session>.pix-tree/`。备份时两者必须一起保存；CLI 不创建另一种会话格式。

## 并发与生命周期

可以在多个终端、多个 GUI 中同时查看和操作一棵树。每个客户端独立选择项目与会话，执行命令明确定位到其会话；底层注册表与会话锁由 Host 统一拥有。默认每棵树最多同时运行 8 路，可用 `PIX_MAX_PARALLEL_RUNS=1..64` 调整。启动已有 Host 时使用的是该 Host 启动时的环境。

```sh
pix fork <节点ID> "检查性能" --session <会话> --json --detach
pix fork <节点ID> "检查错误处理" --session <会话> --json --detach
pix tree --session <会话>
pix stop --session <会话> --branch <branchId> --run-id <runId>
```

默认等待所提交的任务完成；`--detach` 在接受任务后退出。关闭 GUI、退出终端或客户端意外断开不会取消已接受的任务。等待过程中 Ctrl+C 只停止该 CLI 提交的 run；`--timeout <秒>` 只停止等待，任务继续执行。

分支会话历史独立，但项目文件与 Git 工作目录共享。需要同时修改互不影响的代码时，请使用不同目录或 Git worktree。

Host 没有客户端连接、没有任务和远程连接时，默认空闲 10 分钟退出，`PIX_HOST_LINGER_MS` 可调整。`pix host status` 显示状态；`pix host stop` 在没有任务及远程连接时关闭 Host。版本不兼容时拒绝连接，需用原版本在任务完成后关闭旧 Host，再启动新版。

仅本机回环地址开放 WebSocket，使用私有 profile 中的随机 token 验证连接；浏览器 Origin 请求被拒绝。后台地址和启动日志在 `~/.pix/run/`，运行诊断沿用 `~/.pix/log/main.log`。Host 使用 Node.js 网络栈，代理通过 PiX 的 `httpProxy` 设置或标准代理环境变量配置；不使用 Chromium 的系统 PAC 解析。不要让外部 Pi CLI 绕过 Host 写入同一个源文件；现有整图独占锁继续生效。

## 脚本与输入请求

```sh
printf '检查 README 的拼写' | pix run --json
pix run "执行任务" --json --request-id job-123 --detach
```

`--json` 输出 NDJSON：`submitted` 包含 `session`、`requestId`、`branchId` 与 `runId`；`agent` 的 `event` 包含 SDK 事件；`result` 包含任务对应的 `nodeId` 和完整快照；`error` 表示失败并返回非零退出码。模型或工具的文字不会混入 JSON stdout；诊断使用 stderr。只有任务实际成功结束才输出 `result`。

同一会话中复用 `--request-id` 不会重新执行已记录的任务。仍在运行且可定位的请求会返回原 run；早先已完成、已被后续输入替代的请求可能只返回已保存提示，此时用 `tree` 检查记录。连接中断或超时时不会自动重放写操作。

GUI 与交互式 CLI 可以回答扩展的选择、确认和文本输入。无交互的 `run` 遇到本任务的输入请求会以错误退出，任务保持等待，可在 GUI 回答，或执行：

```sh
pix dialogs
pix respond <请求ID> "回答"
```

输入请求只允许完成一次。无交互客户端不会自动批准确认请求。

## 验证

```sh
npm run typecheck
npm test
npm run test:cli
npm run test:cli:package
PIX_REAL_PROVIDER=zai PIX_REAL_MODEL=glm-5.3 npm run test:cli:real
```

`test:cli` 使用真实 Pi SDK、真实文件工具、本机可控 HTTP 模型、多个 CLI 进程和真实 Electron GUI，验证并发启动、分支并行、上下文隔离、独立停止、退出存活、GUI 实时同步和重启恢复。需要允许本机监听和桌面应用运行。

`test:cli:package` 在仓库外的临时目录完成 npm 安装，确认没有 Electron/Vue 依赖，再启动 Host 并创建、读取会话；需要下载依赖。

`test:cli:real` 是显式选择的外部模型测试，会产生模型费用。它把指定 provider 的凭据复制到私有临时 profile，在独立工作目录验证真实读写、两个并发分支及输出值，结束后删除临时凭据。报告写入 `artifacts/cli-real-agent.json`，不包含凭据。

## 代码边界

- `src/host/`：Host 启动发现、本机协议、客户端和 Electron 适配。
- `src/cli/`：命令行解析、终端交互与运行等待。
- `MainController`：每个客户端独立的项目及会话视图。
- `SessionRegistry`：共享唯一运行集合，独立维护各客户端选择；离开客户端不释放运行。
- `GraphRuntime` / `PiRuntime` / `GraphFiles`：沿用原有会话树、Agent 和持久化实现。

GUI 通过现有 preload IPC 到 Electron，再经共享客户端到 Host；文件选择和系统打开操作通过连接上的平台回调留在 Electron。模型请求由 Host 执行，普通客户端连接不会替换模型代理。现有 SSH/WSL 项目仍通过远程 Host 协议访问。
