import { acceptDomainUpdate } from "./registry";

// Domain of the experimental operation-history module
// (src/renderer/experimental/history); dormant while that module is disabled.
export const en = {
  history: {
    panel: {
      title: "History",
      meta: "{n} entries · {depth} undoable",
      empty: "No operations recorded yet.",
      currentPosition: "Current position",
      lockedBelow: "Actions below this point are locked",
      lockedTooltip: "This action is irreversible and locks earlier history",
      failedTooltip: "Last undo/redo attempt failed",
      footer: "⌘/Ctrl+Z Undo · ⌘/Ctrl+⇧+Z Redo · Esc Close",
    },
    locked: `"{label}" is irreversible; earlier actions are locked`,
    undone: "Undid: {label}",
    redone: "Redid: {label}",
    undoFailed: "Undo failed: {reason}",
    redoFailed: "Redo failed: {reason}",
    pin: `Pin "{name}"`,
    unpin: `Unpin "{name}"`,
    archiveSession: `Archive "{name}"`,
    restoreSession: `Restore "{name}"`,
    archiveDirectory: `Archive project "{name}"`,
    restoreDirectory: `Restore project "{name}"`,
    renameSession: `Rename "{name}" to "{newname}"`,
    createSession: `Create session "{name}"`,
    deleteSession: `Delete "{name}"`,
    removeDirectory: `Forget project "{name}"`,
    sendPrompt: `Send "{text}"`,
    deleteTurn: `Delete "{name}"`,
    abortRun: `Stop "{name}"`,
    abort: "Stop run",
    button: { title: "Operation history (⌘/Ctrl+Shift+H)" },
  },
};

export const zhCN: typeof en = {
  history: {
    panel: {
      title: "操作历史",
      meta: "{n} 条记录 · 可撤销 {depth} 步",
      empty: "暂无操作记录。",
      currentPosition: "当前位置",
      lockedBelow: "以下操作已锁定",
      lockedTooltip: "此操作不可撤销，且锁定了更早的历史",
      failedTooltip: "上次撤销/重做失败",
      footer: "⌘/Ctrl+Z 撤销 · ⌘/Ctrl+⇧+Z 重做 · Esc 关闭",
    },
    locked: "「{label}」不可撤销，更早的操作已被锁定",
    undone: "已撤销：{label}",
    redone: "已重做：{label}",
    undoFailed: "撤销失败：{reason}",
    redoFailed: "重做失败：{reason}",
    pin: "置顶「{name}」",
    unpin: "取消置顶「{name}」",
    archiveSession: "归档「{name}」",
    restoreSession: "还原「{name}」",
    archiveDirectory: "归档项目「{name}」",
    restoreDirectory: "还原项目「{name}」",
    renameSession: "将「{name}」重命名为「{newname}」",
    createSession: "创建会话「{name}」",
    deleteSession: "删除「{name}」",
    removeDirectory: "移除项目「{name}」",
    sendPrompt: "发送：「{text}」",
    deleteTurn: "删除「{name}」",
    abortRun: "停止「{name}」",
    abort: "停止运行",
    button: { title: "操作历史（⌘/Ctrl+Shift+H）" },
  },
};

if (import.meta.hot) import.meta.hot.accept(acceptDomainUpdate(en));
