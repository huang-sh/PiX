import { acceptDomainUpdate } from "./registry";

export const en = {
  assistant: {
    title: "Pixie",
    placeholder: "Chat with the PiX assistant…",
    hint: "A conversation independent of the current graph",
    scope: "Local · not tied to the current project",
    preparing: "Preparing the assistant…",
    retryHint: "The assistant failed to start",
    newSession: "New conversation",
    collapse: "Collapse",
    retry: "Retry",
    configureModels: "Configure models",
    dragHint: "Drag to move",
    open: "Click to chat",
    menuOpen: "Open conversation",
    menuSettings: "Pixie settings",
    menuHide: "Hide floating companion",
    resize: "Resize",
  },
};

export const zhCN: typeof en = {
  assistant: {
    title: "精灵",
    placeholder: "和 PiX 助手聊聊……",
    hint: "独立于当前 graph 的对话",
    scope: "本机运行 · 不跟随当前项目",
    preparing: "正在准备助手…",
    retryHint: "助手启动失败",
    newSession: "新对话",
    collapse: "收起",
    retry: "重试",
    configureModels: "配置模型",
    dragHint: "拖动可移动位置",
    open: "点击开始对话",
    menuOpen: "打开对话",
    menuSettings: "精灵设置",
    menuHide: "隐藏悬浮精灵",
    resize: "调整大小",
  },
};

if (import.meta.hot) import.meta.hot.accept(acceptDomainUpdate(en));
