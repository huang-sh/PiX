# Windows 窗口不显示事故（v0.0.20）

> 2026-09-17，v0.0.20 发布当天 Windows 用户「启动不了」：进程活着、渲染完成，窗口永不显示。记录根因与防线，避免同类事故再溜出去。

## 现象与定位

- 安装包启动后没有任何窗口；任务管理器里 4 个进程全部存活且响应。
- 渲染进程完全正常：页面加载完成、DOM 挂载、rAF 循环活跃、CDP 可查询——应用"活着但隐形"。
- 主进程卡点：窗口以 `show: false` 创建，只靠 `ready-to-show` 触发 `show()`，而该事件在 electron 44.4.1 / Windows 上永远不来。

## 根因

electron 44.4.0 起的 Windows 回归：**`show: false` 且带 `titleBarOverlay` 的窗口不触发 `ready-to-show`**。PiX 的自定义标题栏在 Windows 上正是 `titleBarStyle: "hidden"` + `titleBarOverlay`，全部命中。

版本二分（同代码同构建，仅换 electron）——引入点为 **44.4.0**，且 44.3.0 与 44.4.0 用同一 Chromium 却行为相反，说明回归在 Electron 自身补丁而非 Chromium；44.4.0 中把 WCO 几何改动 [#53639](https://github.com/electron/electron/pull/53639) 回移的 [#53812](https://github.com/electron/electron/pull/53812) 即触发点。

| electron | Chromium | ready-to-show |
|---|---|---|
| 44.1.1 / 44.2.0 / 44.3.0 | .65 / .76 / .78 | ✅ 触发 |
| 44.4.0 / 44.4.1 / 44.4.2 / 44.4.3 | .78 / .78 / .130 / .130 | ❌ 不触发（去掉 `titleBarOverlay` 即恢复） |
| 44.4.4 | .130 | ✅ 触发（上游修复） |

最小复现与上游跟踪：[electron/electron#54025](https://github.com/electron/electron/issues/54025)。

## 上游修复与升级验证（2026-09-22，electron ^44.4.4）

修复 [#54090](https://github.com/electron/electron/pull/54090)（回移 [#54118](https://github.com/electron/electron/pull/54118)）：`RenderWidgetHostViewAura::DidNavigate` 只看 view 就把隐藏窗口的 widget 判为休眠并作废 LocalSurfaceId；44.4.0 起 WCO 几何在 `DidFinishNavigation` 即推送（[#53812](https://github.com/electron/electron/pull/53812)），首帧未确认时到达的 VisualProperties 没有表面 id 可用，渲染器于是推迟所有主帧直到 `show()`——窗口"活着但隐形"。修复让 `disable_hidden.patch` 改按宿主可见性判定，隐藏窗口跨导航持续产帧。同 PR 还修复了首帧前调用 `setZoomFactor` 触发同类冻结的 [#51972](https://github.com/electron/electron/issues/51972)；[#42409](https://github.com/electron/electron/issues/42409)（28.x 起间歇性同症状）同根因，机制上同愈，无需另行跟进。

升级按「规矩」在 Windows 11 10.0.26200 x64（受影响平台）完成全链路验证，复现脚本固化为 `test/ready-to-show-check.mjs`：

- **最小复现**：44.1.1 ✅ / 44.4.3 ❌（`ready-to-show=false did-finish-load=true`，正是事故签名）/ 44.4.4 ✅。
- **gui 冒烟**（`npm run test:gui`）：44.4.4 上窗口可见性断言通过（`document.visibilityState`，即 v0.0.20 事故的直接检测点）。套件尾部的"图草稿居中"断言失败，但换回 44.1.1 同样失败——dev 既有问题，与本次升级无关，另行跟进。
- **打包产物**（`npm run dist` + `test:packaged`）：44.4.4 通过。另在 44.4.3 上打包实测过一次——靠 200ms 兜底通过，证明 v0.0.20 重发的防线在打包形态上真实有效。

## 为什么每道防线都失明

- 本地测试（vitest/node）不启动真窗口；`npm run dev` 走 `loadURL`（http），与打包的 `loadFile` 路径不同。
- CI gui 冒烟在 Linux 上跑、走 CDP 断言 DOM 状态、跑的是未打包构建——"活着但隐形"恰在断言盲区。
- 发布验证停在 CI 绿灯，没人双击过真实安装包。

## 防线（已随修复落地）

1. electron `^44.4.4`（含上游修复；package.json 与 lockfile 一致）。
2. 窗口显示兜底：`did-finish-load` 后 200ms 若仍未显示则强制 `show()`——`ready-to-show` 单点故障被永久消除（在 44.4.3 打包产物上实测可救回）。
3. 渲染进程崩溃写入持久化调试日志（`~/.pix/log/main.log`）。
4. gui 冒烟与打包冒烟均断言：`document.visibilityState` 必须变为 `visible`——隐藏窗口上报 `hidden`，"隐形应用"从此测试失败。

## 规矩

electron 的 patch 升级捆绑 Chromium 点更新与原生改动，属于**必须跑打包产物冒烟**的依赖类别：升级或发布前，在目标 OS 上安装真实安装包并确认窗口出现。
