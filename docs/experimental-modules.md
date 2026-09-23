# 实验模块（experimental modules)

实验功能在转正前以可开关模块的形式寄生在应用里：代码集中放置、默认关闭、关闭时完全惰性。当前唯一的实验模块是操作历史（`experimentalHistory`，位于 `src/renderer/experimental/history/`）。

## 约定

- 设置项一律带 `experimental` 前缀（如 `experimentalHistory`），默认关闭，在设置页「实验功能」分类下开关，保存即生效。
- 代码住在 `src/renderer/experimental/<name>/`，宿主只允许 import 它的 `index.ts` 门面。
- 关闭即惰性：不记录、不拦截按键、不渲染——对用户等价于功能不存在。已记录的条目和面板开关状态保留在内存中，重新开启后恢复；关闭只隐藏，不重置。
- 每个实验 flag 最终要么转正（目录挪进 `features/`、默认值翻转、删掉 flag），要么整个移除；不留陈年 flag。

## 门面职责

`index.ts` 是模块的唯一对外面：`track`/`trackEvent` 在开关关闭时直接返回（埋点调用处无需条件判断），快捷键处理直通事件（不 `preventDefault`），UI 挂载点以 `historyEnabled` 控制。快捷键 id 保留在注册表里（持久化的用户自定义引用 id），但设置页在关闭时滤掉该条目。
