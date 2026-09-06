# Graph Panel 分支切换优化

本方案按最终确认的范围实施：每个分支仍然是完整、独立的 Pi agent session；本轮只优化 PiX 的查看与渲染路径。没有修改 Pi SDK、默认工具或 session 执行架构。

## 已实现

1. **分页前移。** 先沿 SDK entry 父链截取当前页，再转换消息。默认只处理最近 40 轮，旧历史仍可继续加载。
2. **分支消息缓存。** 缓存最近 16 个历史窗口。相同内容跨 IPC 快照复用；后台分支变化不重新转换未变化的当前窗口。切换 session 或 host epoch 时清理。
3. **图数据复用。** 接收快照时复用相同节点、边和活动路径；Graph Panel 只监听影响图显示的字段。运行状态变化保留其他卡片对象，移除整卡 JSON 序列化比较。
4. **历史组件缓存。** Vue KeepAlive 保留最近 4 个历史视图，切回时复用 Markdown 组件。缓存只接收当前查看内容，不订阅后台 agent 输出。
5. **阅读位置恢复。** 按查看节点保存分页数、工具展开状态、滚动位置和是否跟随输出。用户滚动优先于尚未完成的恢复任务。
6. **切换调度。** 已完全可见的节点不重复居中；取消过期的居中任务，跨分支跳转不积压动画。滚动工作每帧合并，点击节点取消待展开的悬浮预览。

缓存均有数量上限。切换查看不调用 SDK open、fork 或 navigateTree，也不停止后台运行。

旧路径收尾已完成：删除无人使用的全量选中消息 getter 及祖先链投影辅助函数，相关 store 测试和性能基准迁移到现用消息窗口路径。保留兄弟分支隔离、待发送消息、发送失败、删除恢复和缓存复用的验证；清理后 129 项前端测试、13 项消息投影测试、类型检查和基准脚本通过。

## 验证

- 类型检查、Electron 构建通过。
- 前端全量回归：27 个文件、128 个测试通过。
- 200/1000 节点真实 Vue Flow 组件检查：选择不触发 setNodes；仅后台运行状态变化也不重设图；单节点变化复用其他节点。
- 2000 轮历史检查：仅转换请求窗口，窗口外消息不读取正文；缓存命中、可见正文改变和分页边界正确。
- 阅读位置、Markdown 挂载复用、快速选择和过期居中回调有回归覆盖。

## Electron 实测

使用真实 Pi SDK 和本地确定性流式模型：8 个独立子 session 同时输出，每 100ms 一个更新；每个分支预置 100 轮、每轮约 2KB 历史回答。图初始 801 个节点，运行后 809 个节点，在 3 个可见分支之间进行 24 次实际鼠标点击。

计时从 renderer 的 pointerdown 开始，到选中样式和分支标题提交后经过一次绘制机会结束。界面使用真实 Markdown 组件；不是仅测试 store 赋值。

最终构建在新测试实例上的实测：切换中位数约 20ms，缓存切回的 p95 约 26ms；包含首次打开的 p95 约 96ms，最大约 108ms。两次冷打开出现 80/92ms 长任务。此为本机合成场景，不能外推为所有历史、扩展或设备上的保证。

最终样本：artifacts/gui-parallel-223ac6b1-6dcd-4b46-b877-ee86fcaa6486/branch-switch-report.json。测试结束前验证 8 个 session 均仍在运行。

## 复现（PowerShell，两个终端）

### 运行中面板无响应：事件消费与实时渲染修复

用户反馈的是 chat/function 按钮无响应。此前在已完成历史节点间切换的测试没有覆盖这一场景。

本地 SDK session 在 Electron 主进程中运行；它们的上下文独立，但没有进程隔离。GUI renderer 是另一个进程，仍需消费主进程转发的事件。排查发现 PiX 每次 token 更新都 structuredClone 累积正文，并将同一正文通过 message 和 assistantMessageEvent 重复转发；renderer 的诊断日志再 stringify 完整 payload 后截断、向无上限的响应式数组头插入。chat 收起后仍挂载并渲染实时 Markdown，已收起的工具结果也生成全文 DOM。

这些路径增加克隆、IPC、GC 和 GUI 主线程工作。修改前的 8 session 合成压力场景出现 GUI 自动化超时，Electron 主进程堆约 3.3GB 后 OOM；原始记录在 artifacts/gui-parallel-6d4f6d3e-8507-4b33-b2c2-d843056b9f4b/electron.log。未做逐项消融分析，不能把全部内存增长归因于其中某一行。

已修改 PiX 层：

- 在复制前合并可替代的累计进度，按 50ms 周期转发；生命周期事件保持顺序，仍在 SDK 持久化调用栈结束后发送。停止订阅会清理待处理进度。
- 诊断日志跳过 token/tool partial，仅记录生命周期和快照摘要，最多保留 200 条。
- chat 收起时不渲染实时输出；运行中的长正文/思考/工具输出默认显示末尾 32768 字符，可点“查看更多”。完整 activity 和 SDK 文件不截断；收起的已完成工具结果按需创建正文 DOM。
- 实时 Markdown 标识按查看节点隔离。运行图标独立于预览正文，已有中间回答的运行节点也始终显示图标。

第一批事件修复后，面板恢复响应，但约数十万字符的实时正文仍造成约 1.2s 打开延迟；随后加入实时显示窗口和工具结果按需渲染。中间样本保留在 artifacts/gui-parallel-bab04fcf-a06c-40d9-8fb6-7dd09a27f51f/live-panels-report.json。该样本的 heap 字段来自浏览器粗粒度 performance.memory，不用作精确内存结论。

最终使用真实 SDK、默认 read 工具和本地确定性流式模型：8 个独立 session，每个分支 100 轮约 2KB 历史回答，3 次 read 调用后给出约 512KB 初始正文，每 20ms 继续输出。900/1280px 窗口下 24 次原生鼠标面板开关全部通过，打开约 63–106ms，关闭约 259–298ms（含原有 CSS 动画）。12 次可见运行节点之间的真实点击约 37–125ms，核对选中标题、对应 live 正文及运行图标；文件面板也正常打开。

另持续观察 60s，8 个 session 的 activity 合计约 795 万字符，日志保持 200 条。整个操作及观察区间记录 2 次 long task，最长 78ms；通过 CDP Runtime.getHeapUsage 读取的 renderer 已用堆在观察点约 67–161MB 波动。此为本机合成场景，不是所有扩展或历史数据的性能保证。最终完成后，8 个 SDK JSONL 各保存约 139–140 万字符的完整回答及结束标记，验证显示窗口没有截断存储内容。

最终报告和截图：artifacts/gui-parallel-91e778fb-65c2-4297-ae70-f355cb4f241f/live-panels-report.json、live-panels.png。

135 项前端测试、事件转发/SDK runtime/图运行/广播相关测试、类型检查通过。广播测试使用隔离 PIX_HOME，避免读写用户认证存储。Pi SDK 包和默认工具均未修改。已有运行窗口须重启才能加载新构建。

复现此场景时，在下方 fixture 环境变量基础上设置 PIX_GUI_STREAM_MS=20、PIX_GUI_STREAM_REPEAT=20、PIX_GUI_STREAM_LABEL=1、PIX_GUI_TOOL_ROUNDS=3、PIX_GUI_STREAM_PREFIX_BYTES=524288；另一个终端设置 PIX_GUI_SOAK_MS=60000，再执行 node scripts/gui-live-panels-check.mjs 对应调试端口。

### 2026-09-06 GUI 复测

重新构建，在两次全新隔离 Electron 实例中运行同一 8 session 场景；本次加入原生滚轮翻页、阅读位置恢复、正文与卡片对应、点击取消悬浮预览、画布位置保持、12 次连续点击和 renderer 异常检查。

| 样本 | 中位数 | p95 | 最大值 | 缓存切回 p95 |
| --- | ---: | ---: | ---: | ---: |
| 第一轮 | 22.6ms | 112.3ms | 136.8ms | 24.5ms |
| 修复居中后的新实例 | 18.4ms | 75.7ms | 78ms | 23.3ms |

第一轮超过 100ms 的断言明确失败，集中在首次挂载历史；第二轮通过不能证明冷切换稳定低于 100ms。热切换和上述阅读状态检查通过。第二轮连续点击检查通过，未捕获 renderer 异常。

GUI 另发现离屏节点回到中心偏移约 12px：初始尺寸事件可能早于 pane-ready，旧逻辑因无法 findNode 而丢失实际尺寸。已直接保存事件尺寸，并在离屏节点内容改变时保留尺寸及连接点缓存。修复后 801 节点的概览开关、点击导航、精确居中均通过；相关 12 项组件测试、类型检查和构建通过。

原始报告及截图保存在：

- artifacts/gui-parallel-35693aa5-23f5-48b5-914d-b45a5650cb29/branch-switch-report.json（第一轮，保留失败样本）
- artifacts/gui-parallel-048fe306-6290-46a1-a6ec-83d337af90a3/branch-switch-report.json（修复后）
- 同目录 branch-switch.png；第一轮另有 controls-failure.png。

### 执行命令

先执行 npm run build，再启动隔离测试实例：

    $env:PIX_GUI_BRANCHES='8'
    $env:PIX_GUI_TURNS='100'
    $env:PIX_GUI_REPLY_BYTES='2048'
    $env:PIX_GUI_STREAM_MS='100'
    $env:PIX_GUI_DEBUG_PORT='9837'
    node scripts/gui-parallel-fixture.mjs

另一个终端执行：

    node scripts/gui-branch-switch-check.mjs 9837

仅连接该隔离实例的调试端口。测试使用本地模型，不调用外部模型服务；完成后关闭测试实例。
