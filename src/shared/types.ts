import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ShortcutOverrides } from "./shortcuts.js";
import type { ThemePreference } from "./theme.js";

export type PromptImage = ImageContent;

export const CUSTOM_MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export interface CustomModelInput {
  provider: string;
  modelId: string;
  name?: string;
  baseUrl: string;
  api: typeof CUSTOM_MODEL_APIS[number];
  apiKey?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  imageInput: boolean;
}
export type BrokerModel = Pick<Model<Api>, "provider" | "id" | "name" | "api" | "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens" | "cost">;

export type PanelId = "navigator" | "chat" | "content";
export type UtilityTab = "terminal" | "output" | "git" | "events";
export interface ProjectInfo {
  name: string;
  path: string;
  sessionDir?: string;
  remote?:
    | { kind: "wsl"; distro: string }
    | { kind: "ssh"; host: string };
}
export interface ProjectHistory {
  id: string;
  project: ProjectInfo;
  sessions: SessionSummary[];
  lastOpened: string;
}
export interface ProjectGroup extends ProjectHistory {
  connected: boolean;
}
export function projectId(project: ProjectInfo) {
  const remote = project.remote;
  return remote
    ? `${remote.kind}:${remote.kind === "ssh" ? remote.host : remote.distro}:${project.path}`
    : `local:${project.path}`;
}
export interface WslDistribution {
  name: string;
  home: string;
}
export interface SessionSummary {
  id: string;
  path: string;
  name?: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  active?: boolean;
}
export interface RawSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}
export const NODE_FOOTER_CUSTOM_TYPE = "pix.node-footer";
export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
export interface NodeFooterState {
  contextUsage?: ContextUsageSnapshot;
  model: RuntimeModel | null;
  thinkingLevel: string;
}
export interface GraphNode {
  id: string;
  userEntryId: string;
  parentId: string | null;
  title: string;
  preview: string;
  timestamp: string;
  rawEntryIds: string[];
  leafEntryId: string;
  toolCallCount: number;
  hasError: boolean;
  depth: number;
  imageCount?: number;
  footer?: NodeFooterState;
  branchId?: string;
  running?: boolean;
  forkable?: boolean;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}
export interface BranchMessage {
  entryId: string;
  turnId: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  images?: PromptImage[];
  thinking?: string;
  timestamp: string;
  toolName?: string;
  toolInput?: string;
  isError?: boolean;
  errorMessage?: string;
}
export interface AgentActivityItem {
  id: string;
  kind: "assistant" | "tool";
  text: string;
  thinking?: string;
  title?: string;
  input?: string;
  timestamp: string;
  status: "running" | "complete" | "error";
  pass: number;
  errorMessage?: string;
}
export interface AgentActivity {
  /** The view joined mid-run; persisted history still contains its earlier output. */
  partial?: boolean;
  startedAt: string;
  pass: number;
  active: boolean;
  currentAssistantId?: string;
  items: AgentActivityItem[];
}
export interface SessionProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeBranchNodeIds: string[];
  activeBranchEntryIds: string[];
  messages: BranchMessage[];
  leafId: string | null;
  activeNodeId: string | null;
}
export interface RuntimeModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevels?: string[];
  input?: ("text" | "image")[];
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface RuntimeProvider {
  id: string;
  name: string;
  authTypes: Array<"api_key" | "oauth">;
  status?: { type: "api_key" | "oauth"; source?: string };
}
export interface RuntimeState {
  available: boolean;
  model: RuntimeModel | null;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  pendingMessageCount: number;
}
export interface SessionSnapshot {
  session: SessionSummary;
  entries: RawSessionEntry[];
  projection: SessionProjection;
  runtime: RuntimeState;
  graph?: {
    id: string;
    revision: number;
    epoch?: string;
    runs: Array<{
      branchId: string;
      runId: string;
      requestId?: string;
      nodeId: string | null;
      pending?: { text: string; parentNodeId: string | null; images?: PromptImage[] };
      status: "running" | "idle" | "interrupted";
      error?: string;
      runtime?: RuntimeState;
    }>;
    storageError?: string;
    recoveredInputs?: Array<{ requestId: string; text: string; nodeId?: string | null; images?: PromptImage[] }>;
  };
}
export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileNode[];
  size?: number;
  modified?: string;
}
export interface DirectoryListing {
  path: string;
  entries: FileNode[];
}
export interface FileDocument {
  path: string;
  name: string;
  content: string;
  dataUrl?: string;
  language: string;
  readonly: boolean;
  truncated: boolean;
}
export interface GitFileChange {
  path: string;
  status: string;
  staged: boolean;
}
export interface GitStatus {
  available: boolean;
  branch?: string;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  clean: boolean;
  error?: string;
}
export interface ShellResult {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
}
export interface TerminalSession {
  id: string;
  cancelled?: boolean;
}
export interface TerminalEvent {
  id: string;
  data?: string;
  exitCode?: number;
}
export interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  modelThinkingLevels?: Record<string, string>;
  theme?: string;
  defaultProjectTrust?: "ask" | "always" | "never";
  treeFilterMode?:
    | "default"
    | "no-tools"
    | "user-only"
    | "labeled-only"
    | "all";
  doubleEscapeAction?: "tree" | "fork" | "none";
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  transport?: "sse" | "websocket" | "websocket-cached" | "auto";
  httpIdleTimeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  httpProxy?: string;
  shellPath?: string;
  shellCommandPrefix?: string;
  externalEditor?: string;
  npmCommand?: string[];
  sessionDir?: string;
  enabledModels?: string[];
  defaultTools?: string[];
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  branchSummary?: { reserveTokens?: number; skipPrompt?: boolean };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    providerRetryTimeoutMs?: number;
    providerMaxRetries?: number;
  };
  images?: { autoResize?: boolean; blockImages?: boolean };
  markdown?: { mermaid?: string; codeBlockIndent?: string };
  terminal?: {
    showImages?: boolean;
    imageWidthCells?: number;
    clearOnShrink?: boolean;
    showTerminalProgress?: boolean;
    hyperlinks?: boolean | "auto";
    images?: "kitty" | "iterm2" | "auto" | false;
    trueColor?: boolean | "auto";
  };
  hideThinkingBlock?: boolean;
  showCacheMissNotices?: boolean;
  quietStartup?: boolean;
  collapseChangelog?: boolean;
  enableInstallTelemetry?: boolean;
  enableSkillCommands?: boolean;
  showHardwareCursor?: boolean;
  editorPaddingX?: number;
  outputPad?: number;
  autocompleteMaxVisible?: number;
  tuiMode?: "regular" | "fullscreen";
  fullscreenExitOutput?: "transcript" | "resume-hint";
  fullscreenScrollbar?: "auto" | "always" | "hidden";
  fullscreenCopyOnSelect?: boolean;
  warnings?: { anthropicExtraUsage?: boolean };
  [key: string]: unknown;
}
export interface AppSettings {
  keyboardShortcuts?: ShortcutOverrides;
  language: "system" | "zh-CN" | "en";
  theme: ThemePreference;
  density: "comfortable" | "compact";
  lastProject?: string;
  recentProjects?: ProjectHistory[];
  confirmDestructiveActions: boolean;
  browserHome: string;
  openLastSessionOnStartup: boolean;
  enterToSend: boolean;
  openLinksInApp: boolean;
  closeToTray: boolean;
}
export interface SettingsBundle {
  app: AppSettings;
  piGlobal: PiSettings;
  piProject: PiSettings;
  effective: PiSettings;
  paths: { app: string; global: string; project: string | null };
}
export interface LayoutState {
  version?: number;
  branchOrders?: Record<string, Array<[string, number]>>;
  /** Keep the projects and sessions navigator open instead of auto-hiding it. */
  navigatorPinned?: boolean;
  widths: { navigator: number; chat: number; content: number };
  collapsed: Record<PanelId, boolean>;
  minimap: boolean;
  composer: { open: boolean };
  utility: {
    open: boolean;
    collapsed: boolean;
    height: number;
    activeTab: UtilityTab;
  };
}
export interface RuntimeCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill" | "app";
}
export interface RuntimeSkill {
  name: string;
  description: string;
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  disableModelInvocation: boolean;
}
export interface RuntimeExtension {
  path: string;
  resolvedPath: string;
  source: string;
  scope: "user" | "project" | "temporary";
  /** Distribution hint for the UI; source and scope retain pi's metadata. */
  bundled?: boolean;
  tools: Array<{ name: string; label?: string; description?: string }>;
  commands: Array<{ name: string; description?: string }>;
}
export type AgentControl =
  | { action: "deleteNode"; nodeId: string; graphId: string }
  | { action: "promptAt"; requestId: string; nodeId: string | null; text: string; images?: PromptImage[]; provider?: string; modelId?: string; thinkingLevel?: string }
  | { action: "branchAbort"; branchId: string; runId: string }
  | { action: "prompt" | "steer" | "followUp"; text: string; images?: PromptImage[] }
  | {
      action:
        | "abort"
        | "clearQueue"
        | "getState"
        | "refreshModels"
        | "cycleModel"
        | "getThinkingLevels"
        | "cycleThinking"
        | "abortRetry"
        | "abortBash"
        | "abortCompaction"
        | "stats"
        | "commands"
        | "getTools"
        | "getProviders"
        | "getCustomModels"
        | "exportJsonl"
        | "newSession"
        | "clone"
        | "reload";
    }
  | { action: "getSkills"; reload?: boolean }
  | { action: "getModels"; broker?: boolean }
  | { action: "getExtensions"; reload?: boolean }
  | { action: "setModel"; provider: string; modelId: string; persist?: boolean }
  | { action: "setThinking"; level: string }
  | {
      action: "setQueueMode";
      kind: "steering" | "followUp";
      mode: "all" | "one-at-a-time";
    }
  | { action: "compact"; instructions?: string }
  | { action: "setAutoCompaction" | "setAutoRetry"; enabled: boolean }
  | { action: "bash"; command: string; excludeFromContext?: boolean }
  | { action: "exportHtml"; outputPath?: string }
  | { action: "setName"; name: string }
  | { action: "setTools"; names: string[] }
  | { action: "setBrokerProviders"; providers: string[]; models?: BrokerModel[] }
  | ({ action: "addCustomModel" | "updateCustomModel" } & CustomModelInput)
  | { action: "loginApiKey"; provider: string; apiKey: string }
  | { action: "loginOAuth"; provider: string; method: "browser" | "device-code" }
  | { action: "logout"; provider: string }
  | { action: "setLabel"; entryId: string; label?: string }
  | { action: "navigateTree" | "fork"; entryId: string };
export type DesktopRoute =
  | "app.bootstrap"
  | "app.pickProject"
  | "app.openProject"
  | "app.forgetProject"
  | "app.openExternal"
  | "app.quit"
  | "wsl.list"
  | "wsl.names"
  | "wsl.connect"
  | "wsl.disconnect"
  | "ssh.list"
  | "ssh.connect"
  | "remote.disconnect"
  | "remote.cancel"
  | "remote.directories"
  | "remote.openProject"
  | "session.list"
  | "session.snapshot"
  | "session.open"
  | "session.import"
  | "session.rename"
  | "session.delete"
  | "agent.control"
  | "workspace.tree"
  | "workspace.directories"
  | "workspace.open"
  | "workspace.read"
  | "workspace.write"
  | "git.status"
  | "git.diff"
  | "shell.run"
  | "shell.abort"
  | "terminal.create"
  | "terminal.write"
  | "terminal.resize"
  | "terminal.kill"
  | "settings.get"
  | "settings.update"
  | "settings.reset"
  | "layout.save";
export interface DesktopEvent {
  type: "agent" | "shell" | "terminal" | "sessions" | "notice" | "remote.progress" | "remote.connection";
  payload: unknown;
}
export type RemoteConnectStage = "checking" | "runtime" | "upload" | "install" | "starting" | "handshake" | "loading";
export interface DesktopApi {
  initialTheme?: ThemePreference;
  invoke<T = unknown>(route: DesktopRoute, input?: unknown): Promise<T>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
  filePath(file: File): string;
}
