import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { agentEventForwarder } from "./agent-event-forwarder.js";
import { debugLog } from "./debug-log.js";
import { pixFileChangesExtension } from "./extensions/file-changes.js";
import { pixGitBranchExtension } from "./extensions/git-branch.js";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { appendOutputStyle, isOutputStyleFile, type OutputStyleSkill } from "./output-style.js";
import { getSupportedThinkingLevels, type ModelsRefreshResult } from "@earendil-works/pi-ai";
import {
  detectWindowsBash,
  memoizeOnce,
  withDefaultPowershellTool,
  withDetectedBashShell,
} from "./bash-resolution.js";
import { isBundledExtension, resolveBuiltinPackages } from "./builtin-packages.js";
import { applyBuiltinSkillOverrides, resolveBuiltinSkills } from "./builtin-skills.js";
import { SkillControls } from "./skill-controls.js";
import { canonicalPath, pixAgentDir } from "./paths.js";
import { addCustomModel, getCustomModels } from "./custom-models.js";
import { durableWrite, encodeSession, sessionModifiedAt } from "./graph-files.js";
import { validatePromptImages } from "../shared/images.js";
import { collectAgentCommands } from "../shared/commands.js";
import type {
  AgentControl,
  BrokerModel,
  RawSessionEntry,
  RuntimeModel,
  RuntimeExtension,
  RuntimeProvider,
  RuntimeState,
  SessionSnapshot,
  SessionSummary,
} from "../shared/types.js";
import type { CreateAgentSessionServicesOptions, InlineExtension } from "@earendil-works/pi-coding-agent";
import { NODE_FOOTER_CUSTOM_TYPE } from "../shared/types.js";
import { projectSession, summarizeSession } from "../shared/session.js";
import {
  aggregateUsage,
  dedupeUsageRecords,
  estimateUsageCosts,
  usageAmount,
  type UsageOverview,
  type UsageProjectRef,
  type UsageRange,
  type UsageRecord,
  type UsageSessionInput,
} from "../shared/usage.js";
import { loadPricingTable, pricingResolver } from "./usage-pricing.js";
import { usageScanCache } from "./usage-scan-cache.js";

// One Git Bash probe per process; later sessions reuse the first result.
const detectBash = memoizeOnce(detectWindowsBash);

/** Control actions that need no open session; everything else is session-scoped. */
export const MODEL_ACTIONS = [
  "getModels",
  "refreshModels",
  "addCustomModel",
  "updateCustomModel",
  "getCustomModels",
  "getProviders",
  "getSkills",
  "getSkill",
  "createSkill",
  "importSkill",
  "updateSkill",
  "deleteSkill",
  "setSkillManualOnly",
  "getExtensions",
  "installExtension",
  "removeExtension",
  "loginApiKey",
  "loginOAuth",
  "logout",
  "setBrokerProviders",
] as const satisfies readonly AgentControl["action"][];

/** The SDK's settings surface the settings service writes through. */
export interface PiSettingsSdk {
  FileSettingsStorage: new (cwd: string, agentDir: string) => {
    withLock: (
      scope: "global" | "project",
      fn: (current: string | undefined) => string | undefined,
    ) => void;
  };
  SettingsManager: {
    create: (cwd: string, agentDir: string) => {
      drainErrors: () => Array<{
        scope: "global" | "project";
        path?: string;
        error: Error;
      }>;
    };
  };
}
/**
 * The SDK's settings storage, for the settings service to write pi settings
 * with the SDK's locking and its corrupt-file freeze. The SDK stays behind
 * this adapter (the architecture test pins its import to this file);
 * FileSettingsStorage is not re-exported by the package entry, hence the
 * same version-specific deep import as exportSnapshotHtml.
 */
export async function piSettingsSdk(): Promise<PiSettingsSdk> {
  const moduleUrl = new URL("./core/settings-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  return import(moduleUrl.href);
}

/** Usage that no single model reply owns (summaries, tool-side billing). */
const UNATTRIBUTED_USAGE_MODEL = "Tools/summaries";

/**
 * One billed event per assistant reply, auxiliary usage entry, and summary
 * generation, attributing each the way the SDK's own accounting does
 * (getUsageCostBreakdown): replies to their reporting model, everything else
 * into the shared tools bucket.
 */
function usageRecordsOf(entries: any[]): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const entry of entries) {
    let model: string | undefined;
    let usage: any;
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const message = entry.message;
      model = `${message.provider}/${message.responseModel ?? message.model}`;
      usage = message.usage;
    } else if (entry.type === "usage") {
      model = `${entry.provider}/${entry.model}`;
      usage = entry.usage;
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      model = UNATTRIBUTED_USAGE_MODEL;
      usage = entry.usage;
    } else if (entry.type === "message" && entry.message?.role === "toolResult") {
      model = UNATTRIBUTED_USAGE_MODEL;
      usage = entry.message.usage;
    }
    if (!model || !usage) continue;
    records.push({
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      model,
      usage: usageAmount(usage),
      ...(typeof entry.id === "string" ? { entryId: entry.id } : {}),
    });
  }
  return records;
}

const usageMessageText = (message: any): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join(" ")
    : "";
};

/** Reduces one open session manager to the identity + billed events aggregateUsage takes. */
function sessionUsage(
  manager: any,
  path: string,
  modified: string,
  project?: UsageProjectRef,
): UsageSessionInput {
  const header = manager.getHeader(),
    entries = manager.getEntries();
  const firstUser = usageMessageText(
    entries.find((e: any) => e.type === "message" && e.message?.role === "user")?.message,
  );
  const name = manager.getSessionName();
  const clip = (s: string, n: number) => {
    const c = s.replace(/\s+/g, " ").trim();
    return c.length > n ? `${c.slice(0, n - 1)}…` : c;
  };
  return {
    id: String(header?.id ?? basename(path)),
    path,
    ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    created: String(header?.timestamp ?? entries[0]?.timestamp ?? modified),
    modified,
    messageCount: entries.filter((e: any) => e.type === "message").length,
    firstMessage: clip(firstUser, 120),
    records: usageRecordsOf(entries),
    ...(project ? { project } : {}),
  };
}

/** Safety valve for pathological trees; real projects stay far below this. */
const MAX_SESSION_FILES_PER_DIR = 5000;

/** Every .jsonl under a session directory, top level first, sidecars after. */
function sessionFilesUnder(root: string): string[] {
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length && files.length < MAX_SESSION_FILES_PER_DIR) {
    const dir = queue.shift()!;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      try {
        if (statSync(path).isDirectory()) queue.push(path);
        else if (name.endsWith(".jsonl")) files.push(path);
      } catch { /* vanished between listing and stat */ }
    }
  }
  return files;
}

/**
 * One session file's parsed usage, served from the persistent scan cache
 * (mtime + size validation, clones on every hand-out) and reduced through the
 * SDK on a miss.
 */
function cachedSessionUsage(
  pi: any,
  path: string,
  dir: string,
  cwd: string,
  project: UsageProjectRef | undefined,
): UsageSessionInput {
  const stat = statSync(path);
  const cached = usageScanCache.get(path, stat, project);
  if (cached) return cached;
  usageScanCache.set(
    path,
    stat,
    sessionUsage(pi.SessionManager.open(path, dir, cwd), path, stat.mtime.toISOString(), project),
  );
  return usageScanCache.get(path, stat, project)!;
}

export class PiRuntime {
  mod: any;
  runtime: any;
  cwd: string | null;
  dir: string | null;
  emit: (e: unknown) => void;
  unsubscribe?: () => void;
  modelServices: any;
  brokerProviders = new Set<string>();
  brokerModels: BrokerModel[] = [];
  modelBroker?: (model: any, context: any, options: any) => any;
  openExternal: (url: string) => Promise<void>;
  private closing = false;
  private pendingControls = new Set<Promise<unknown>>();
  private closeTask?: Promise<void>;
  private projectionCache?: { manager: any; count: number; leaf: string | null; projection: SessionSnapshot["projection"] };
  eventScope?: { graphId: string; branchId: string; runId: string };
  /** The settings page's skill management; every SDK touch stays behind live accessors. */
  readonly skillControls = new SkillControls({
    pi: () => this.pi(),
    agentDir: () => this.agentDir(),
    cwd: () => this.cwd,
    session: () => this.runtime?.session,
    modelServices: () => this.modelServices,
    ensureModelServices: async () => { await this.modelRuntime(); },
  });
  constructor(
    cwd: string | null,
    dir: string | null,
    emit: (e: unknown) => void,
    openExternal: (url: string) => Promise<void>,
  ) {
    this.cwd = cwd;
    this.dir = dir;
    this.emit = emit;
    this.openExternal = openExternal;
  }
  setProject(cwd: string | null, dir: string | null) {
    this.dispose();
    this.modelServices = undefined;
    this.cwd = cwd;
    this.dir = dir;
  }
  async pi() {
    return (this.mod ??= await import("@earendil-works/pi-coding-agent"));
  }
  async exportSnapshotHtml(manager: any, outputPath: string): Promise<string> {
    // Pi's standalone HTML exporter is not re-exported by its package entry.
    // Keep this version-specific adapter here; no agent or extension is started.
    const moduleUrl = new URL("./core/export-html/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
    const exporter = await import(moduleUrl.href);
    return exporter.exportSessionToHtml(manager, undefined, { outputPath });
  }
  agentDir() {
    return pixAgentDir();
  }
  async modelRuntime() {
    if (this.runtime?.session?.modelRuntime)
      return this.runtime.session.modelRuntime;
    const pi = await this.pi();
    // Project-less model actions (settings, login) still need a real cwd for
    // the agent services; the home directory carries no project state. The
    // services' resource loader also backs the settings page's skills and
    // extensions lists before any session opens, so bundled packages load
    // here too.
    this.modelServices ??= await pi.createAgentSessionServices(
      this.sessionServicesOptions(pi, this.cwd ?? homedir()),
    );
    return this.modelServices.modelRuntime;
  }
  setModelBroker(broker?: (model: any, context: any, options: any) => any) {
    this.modelBroker = broker;
  }

  async configuredProviderIds() {
    const modelRuntime = await this.modelRuntime();
    return [...new Set((await modelRuntime.getAvailable()).map((model: any) => String(model.provider)))];
  }

  async configureBrokerProviders(providers: string[], models: BrokerModel[] = []) {
    await this.replaceBrokerCatalog(await this.modelRuntime(), new Set(providers), models);
  }

  /**
   * Re-points this runtime at another runtime's broker catalog. Remote hosts
   * hand every catalog change to the project runtime, while an open session
   * holds its own copy — without this it would never see a newly added model.
   */
  async adoptBroker(source: PiRuntime) {
    this.modelBroker = source.modelBroker;
    const modelRuntime = this.runtime?.session?.modelRuntime;
    if (!modelRuntime) {
      this.brokerProviders = new Set(source.brokerProviders);
      this.brokerModels = [...source.brokerModels];
      return;
    }
    await this.replaceBrokerCatalog(modelRuntime, new Set(source.brokerProviders), [...source.brokerModels]);
  }

  /**
   * Pulls a catalog or credential change another runtime already applied into
   * this one. Every runtime's model catalog is its own in-memory copy, so an
   * open session never sees a model added, updated, or logged in elsewhere
   * until it re-reads it. A session running the updated model adopts the new
   * definition; a streaming one keeps it for its current response only.
   */
  async adoptCatalog(input: AgentControl) {
    const modelRuntime = await this.modelRuntime();
    await modelRuntime.refresh({ allowNetwork: false });
    const s = this.runtime?.session;
    if (input.action === "updateCustomModel" && s?.model && !s.isStreaming
      && s.model.provider === input.provider && s.model.id === input.modelId)
      await s.setModel(modelRuntime.getModel(input.provider, input.modelId));
  }

  /** Switches one model runtime over to a catalog, dropping the providers that left it. */
  private async replaceBrokerCatalog(modelRuntime: any, providers: Set<string>, models: BrokerModel[]) {
    for (const provider of this.brokerProviders)
      if (!providers.has(provider)) {
        await modelRuntime.removeRuntimeApiKey(provider);
        modelRuntime.unregisterProvider(provider);
      }
    this.brokerProviders = providers;
    this.brokerModels = models;
    await this.applyModelBroker(modelRuntime);
  }

  async applyModelBroker(modelRuntime: any) {
    for (const provider of this.brokerProviders) {
      const models = this.brokerModels.filter((model) => model.provider === provider);
      if (models.length) modelRuntime.registerProvider(provider, {
        baseUrl: "http://pix-desktop-broker.invalid",
        models,
      });
    }
    for (const provider of this.brokerProviders)
      await modelRuntime.setRuntimeApiKey(provider, "pix-desktop-broker");
    if (!this.modelBroker) return;
    const broker = this.modelBroker;
    modelRuntime.stream = (model: any, context: any, options: any) =>
      broker(model, context, options);
    modelRuntime.streamSimple = (model: any, context: any, options: any) =>
      broker(model, context, options);
  }
  /**
   * Options shared by every createAgentSessionServices call, so session and
   * session-less services behave the same.
   */
  private sessionServicesOptions(pi: any, cwd: string): CreateAgentSessionServicesOptions {
    const agentDir = this.agentDir();
    // Pi's bash tool otherwise only finds Git Bash under Program Files or
    // directly on PATH; derive it from git.exe so custom install roots
    // (e.g. D:\software\Git) get a POSIX shell without user setup. The
    // powershell tool joins the active default set the same way — PiX's own
    // or a migrated pi CLI config — on Windows only; Pi resolves the
    // executable itself when the tool runs.
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const settingsManager = withDefaultPowershellTool(
      withDetectedBashShell(
        pi.SettingsManager.create(cwd, agentDir),
        detectBash(),
      ),
    );
    // One loader pass resolves skills before the append-system prompt, so
    // this holder already holds the opted-in list when the output style
    // injection reads it. Fresh per services instance, so session and
    // session-less services never share stale skills.
    const outputStyleSkills: OutputStyleSkill[] = [];
    return {
      cwd,
      agentDir,
      settingsManager,
      // Bundled pi packages (computer-use) load alongside user extensions;
      // resolveBuiltinPackages skips any package the user installed
      // themselves. Paths are relative to this module's location so the
      // same resolution works for dev runs, the packaged app (extraResources
      // pi-builtin/), and remote server hosts (server npm dependencies).
      resourceLoaderOptions: {
        extensionFactories: [
          pixFileChangesExtension(() => this.runtime?.session.sessionManager.getSessionFile()),
          pixGitBranchExtension,
        ] as InlineExtension[],
        additionalExtensionPaths: resolveBuiltinPackages(
          moduleDir,
          settingsManager,
        ),
        // Built-in skills load as plain markdown via the same layout
        // resolution (extraResources skills/ beside the app or server);
        // pi ranks them below user skills, so same-named user copies win.
        additionalSkillPaths: resolveBuiltinSkills(moduleDir),
        // The manual-only overrides for those read-only files are applied
        // here. Re-read on every invocation: reload() and new loaders call
        // this closure again, so a toggled built-in takes effect without
        // recreating services.
        skillsOverride: (base) => {
          const resolved = applyBuiltinSkillOverrides(moduleDir, base);
          outputStyleSkills.length = 0;
          outputStyleSkills.push(
            ...resolved.skills.filter((skill) => isOutputStyleFile(String(skill.filePath))),
          );
          return resolved;
        },
        // The outputStyle setting names a skill; the name joins the
        // append-system prompt sections after the user's own file, and the
        // model resolves it against <available_skills>. Reload re-runs both
        // closures, so a saved switch takes effect on the next reload like
        // the other pi settings.
        appendSystemPromptOverride: (base: string[]) =>
          appendOutputStyle(base, outputStyleSkills, settingsManager),
      },
    };
  }
  factory(pi: any) {
    return async ({ cwd, sessionManager, sessionStartEvent }: any) => {
      const services = await pi.createAgentSessionServices(
        this.sessionServicesOptions(pi, cwd),
      );
      await this.applyModelBroker(services.modelRuntime);
      const created = await pi.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      });
      const notify = (message: string, level = "info") =>
        this.emit({ type: "notice", payload: { message, level, source: "extension" } });
      const unsupported = async () => {
        throw new Error("This command requires a Pi terminal dialog, which PiX does not support yet.");
      };
      await created.session.bindExtensions({
        mode: "rpc",
        uiContext: {
          ...created.session.extensionRunner.getUIContext(),
          notify,
          select: unsupported,
          confirm: unsupported,
          input: unsupported,
          editor: unsupported,
          custom: unsupported,
        },
        onError: (error: { extensionPath: string; error: string }) =>
          notify(`${error.extensionPath}: ${error.error}`, "error"),
      });
      return {
        ...created,
        services,
        diagnostics: services.diagnostics ?? [],
      };
    };
  }
  bind() {
    this.unsubscribe?.();
    const forwarder = agentEventForwarder(payload => this.emit({ type: "agent", payload }));
    const unsubscribe = this.runtime.session.subscribe((payload: unknown) => {
      // SDK emits message_end BEFORE persisting it. A UI listener must never
      // throw into that call stack, or the message would not be saved.
      try {
        forwarder.push({ ...(payload as object), ...this.eventScope });
      } catch (e) { debugLog("pi-runtime: event push", e); }
    });
    this.unsubscribe = () => { unsubscribe(); forwarder.dispose(); };
  }
  async waitForWrites() {
    await this.runtime?.session.waitForIdle?.();
    await Promise.allSettled([...this.pendingControls]);
    if (this.runtime?.session.isBashRunning) throw new Error("Session bash is still running");
  }
  async openAt(path: string, leafId: string | null) {
    const pi = await this.pi();
    const manager = pi.SessionManager.open(path, this.dir, this.cwd);
    if (leafId === null) manager.resetLeaf();
    else manager.branch(leafId);
    this.runtime = await pi.createAgentSessionRuntime(this.factory(pi), {
      cwd: this.cwd, agentDir: this.agentDir(), sessionManager: manager,
    });
    this.bind();
  }
  async list(): Promise<SessionSummary[]> {
    const { cwd, dir } = this;
    const pi = await this.pi(),
      all = await pi.SessionManager.list(cwd, dir);
    // Registry entries key on the canonical file, so rows have to spell it the
    // same way or a running marker would never match its own session. The
    // listing comes from one directory of plain session files, so
    // canonicalizing that directory once spells every row without a realpath
    // per file.
    const root = all.length ? canonicalPath(dirname(String(all[0].path))) : "";
    // The SDK lists sessions in creation order; the panel's contract is newest
    // modification first, matching the SessionFiles fallback list(). Modified
    // is the mtime side of the session tree (branch sidecars included), so a
    // branch run floats its session here too.
    return all
      .map((s: any) => {
        const path = root ? join(root, basename(String(s.path))) : String(s.path);
        return {
          id: s.id,
          path,
          name: s.name,
          cwd: s.cwd || cwd,
          created: new Date(s.created).toISOString(),
          modified: sessionModifiedAt(path, new Date(s.modified).toISOString()),
          messageCount: s.messageCount,
          firstMessage: s.firstMessage,
        };
      })
      .sort((a: SessionSummary, b: SessionSummary) => b.modified.localeCompare(a.modified));
  }
  /**
   * Aggregated usage across session files, for the settings page's usage
   * panel. Read-only: each file is opened through the SDK's SessionManager
   * (cached by mtime) and reduced in place; an unreadable file is skipped
   * like the session list skips it. Costs the provider did not report are
   * estimated from the cached public price table while the scan runs;
   * subscription-billed providers the user marked cost nothing. Scans default
   * to this runtime's project; the controller passes one entry per local
   * project for the all-projects scope.
   */
  async usageOverview(
    range: UsageRange,
    unbilledProviders: readonly string[] = [],
    scans?: Array<{ project?: UsageProjectRef; dir: string }>,
  ): Promise<UsageOverview> {
    const { cwd, dir } = this;
    if (!cwd || !dir) throw new Error("Open a project first");
    const pi = await this.pi();
    const pricing = loadPricingTable();
    const targets = scans?.length ? scans : [{ dir }];
    const sessions: UsageSessionInput[] = [];
    for (const target of targets) {
      const root = canonicalPath(target.dir);
      if (!existsSync(root)) continue;
      // The graph model gives every branch and worker its own session file
      // under .pix-graph/.pix-tree sidecar directories, so the scan walks the
      // whole tree — copied prefixes are deduped by entry id afterwards.
      for (const path of sessionFilesUnder(root)) {
        try {
          sessions.push(cachedSessionUsage(pi, path, target.dir, cwd, target.project));
        } catch (e) { debugLog("pi-runtime: usage scan", e); }
      }
    }
    const table = await pricing;
    // Forks, branch exports, and imports copy entries between files with ids
    // intact; the copies would bill twice without this pass.
    dedupeUsageRecords(sessions);
    estimateUsageCosts(sessions, pricingResolver(table), new Set(unbilledProviders));
    return aggregateUsage(sessions, range);
  }
  async open(path: string) {
    if (this.closing) throw new Error("Session is closing");
    const pi = await this.pi();
    if (this.runtime)
      await this.runtime.switchSession(path, { cwdOverride: this.cwd });
    else {
      const manager = pi.SessionManager.open(path, this.dir, this.cwd);
      this.runtime = await pi.createAgentSessionRuntime(this.factory(pi), {
        cwd: this.cwd,
        agentDir: this.agentDir(),
        sessionManager: manager,
      });
    }
    this.bind();
    return this.snapshot();
  }
  async create() {
    if (this.closing) throw new Error("Session is closing");
    const pi = await this.pi();
    if (this.runtime) await this.runtime.newSession();
    else {
      const manager = pi.SessionManager.create(this.cwd, this.dir);
      this.runtime = await pi.createAgentSessionRuntime(this.factory(pi), {
        cwd: this.cwd,
        agentDir: this.agentDir(),
        sessionManager: manager,
      });
    }
    this.bind();
    return this.snapshot();
  }
  /**
   * Creates an empty session file without holding any runtime on it, so the
   * registry can hand the file to a runtime of its own choosing.
   */
  async createSessionFile(): Promise<string> {
    const { cwd, dir } = this;
    const pi = await this.pi();
    const manager = pi.SessionManager.create(cwd, dir);
    const path = manager.getSessionFile();
    // Open an explicitly persisted header: SDK otherwise defers the first user input.
    durableWrite(path, encodeSession({ header: manager.getHeader(), entries: [] }));
    return path;
  }
  state(): RuntimeState {
    const s = this.runtime?.session;
    if (!s)
      return {
        available: true,
        model: null,
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        isStreaming: false,
        isCompacting: false,
        isRetrying: false,
        autoCompactionEnabled: true,
        autoRetryEnabled: true,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        pendingMessageCount: 0,
      };
    return {
      available: true,
      model: s.model
        ? {
            provider: String(s.model.provider),
            id: String(s.model.id),
            name: s.model.name,
            contextWindow: s.model.contextWindow,
            reasoning: Boolean(s.model.reasoning),
            ...(s.model.input ? { input: s.model.input } : {}),
            thinkingLevels: s.getAvailableThinkingLevels?.() ?? getSupportedThinkingLevels(s.model),
          }
        : null,
      thinkingLevel: String(s.thinkingLevel ?? "off"),
      availableThinkingLevels: s.getAvailableThinkingLevels?.() ?? ["off"],
      isStreaming: Boolean(s.isStreaming),
      isCompacting: Boolean(s.isCompacting),
      isRetrying: Boolean(s.isRetrying),
      sessionId: s.sessionId,
      sessionFile: s.sessionFile,
      sessionName: s.sessionName,
      autoCompactionEnabled: Boolean(s.autoCompactionEnabled),
      autoRetryEnabled: Boolean(s.autoRetryEnabled),
      steeringMode: s.steeringMode ?? "one-at-a-time",
      followUpMode: s.followUpMode ?? "one-at-a-time",
      pendingMessageCount: Number(s.pendingMessageCount ?? 0),
    };
  }
  snapshot(): SessionSnapshot {
    const s = this.runtime?.session;
    if (!s) throw new Error("No Pi session open");
    const m = s.sessionManager,
      entries = m.getEntries() as RawSessionEntry[],
      leaf = m.getLeafId();
    if (!this.projectionCache || this.projectionCache.manager !== m || this.projectionCache.count !== entries.length || this.projectionCache.leaf !== leaf)
      this.projectionCache = { manager: m, count: entries.length, leaf, projection: projectSession(entries, leaf) };
    return {
      session: {
        ...summarizeSession(
          s.sessionFile ?? "",
          m.getHeader?.() ?? null,
          entries,
          sessionModifiedAt(s.sessionFile ?? "", String(entries.at(-1)?.timestamp ?? new Date().toISOString())),
        ),
        id: s.sessionId,
        name: m.getSessionName?.(),
        cwd: m.getCwd(),
      },
      entries,
      projection: this.projectionCache.projection,
      runtime: this.state(),
    };
  }
  async validate(path: string) {
    const pi = await this.pi();
    pi.SessionManager.open(path, undefined, this.cwd).getTree();
  }
  async rename(path: string, name: string) {
    const pi = await this.pi();
    pi.SessionManager.open(path, this.dir, this.cwd).appendSessionInfo(name);
  }
  control(input: AgentControl): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Session is closing"));
    const pending = this.runControl(input);
    this.pendingControls.add(pending);
    return pending.finally(() => this.pendingControls.delete(pending));
  }
  private async runControl(input: AgentControl): Promise<unknown> {
    const s = this.runtime?.session;
    const modelAction = (MODEL_ACTIONS as readonly string[]).includes(input.action);
    if (!this.cwd && !modelAction)
      throw new Error("Open a project first");
    if (!s && input.action !== "newSession" && !modelAction)
      throw new Error("Open a session first");
    // Broker updates can replace a model while the remote session still holds its old definition.
    if (input.action === "prompt" && s?.model && this.brokerProviders.has(s.model.provider) && !s.isStreaming) {
      const latest = s.modelRuntime.getModel(s.model.provider, s.model.id);
      if (latest && !isDeepStrictEqual(latest, s.model)) await s.setModel(latest);
    }
    if ((input.action === "prompt" || input.action === "steer" || input.action === "followUp") && input.images?.length) {
      input = { ...input, images: validatePromptImages(input.images) };
      if (!s.model?.input?.includes("image"))
        throw new Error("This model does not support image input. Choose a model that supports images or remove the attachments.");
    }
    switch (input.action) {
      case "prompt": {
        // prompt() also resolves without a turn for handled extension
        // commands and throws before appending anything (busy, no model, no
        // auth) — the footer may only be recorded when this call created one.
        const before = s.sessionManager.getEntries().length;
        try {
          await s.prompt(input.text, { source: "interactive", ...(input.images?.length ? { images: input.images } : {}) });
        } finally {
          const createdTurn = s.sessionManager
            .getEntries()
            .slice(before)
            .some(
              (e: RawSessionEntry) =>
                e.type === "message" &&
                (e.message as { role?: string } | undefined)?.role === "user",
            );
          if (createdTurn)
            s.sessionManager.appendCustomEntry(NODE_FOOTER_CUSTOM_TYPE, {
              contextUsage: s.getContextUsage() ?? null,
              model: s.model
                ? {
                    provider: String(s.model.provider),
                    id: String(s.model.id),
                    name: s.model.name,
                    contextWindow: s.model.contextWindow,
                    reasoning: Boolean(s.model.reasoning),
                    ...(s.model.input ? { input: s.model.input } : {}),
                  }
                : null,
              thinkingLevel: String(s.thinkingLevel ?? "off"),
            });
        }
        break;
      }
      case "steer":
        await s.steer(input.text, input.images);
        break;
      case "followUp":
        await s.followUp(input.text, input.images);
        break;
      case "abort":
        await s.abort();
        break;
      case "clearQueue":
        await s.clearQueue();
        break;
      case "getState":
        return this.state();
      case "refreshModels": {
        const signal = AbortSignal.timeout(15_000);
        const modelRuntime = await this.modelRuntime();
        const result: ModelsRefreshResult = await modelRuntime.refresh({
          allowNetwork: true,
          force: true,
          signal,
        });
        if (result.aborted || signal.aborted)
          throw new Error("Model catalog refresh timed out. Please try again.");
        if (result.errors.size) {
          const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
          throw new Error(`Could not refresh model catalogs: ${details}`);
        }
        return { ok: true };
      }
      case "getModels": {
        const modelRuntime = await this.modelRuntime();
        if (input.broker) return (await modelRuntime.getAvailable()).map((m: any): BrokerModel => ({
          provider: m.provider, id: m.id, name: m.name, api: m.api,
          reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap,
          input: m.input, contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost,
        }));
        return (await modelRuntime.getAvailable()).map(
          (m: any): RuntimeModel => ({
            provider: String(m.provider),
            id: String(m.id),
            name: m.name,
            contextWindow: m.contextWindow,
            reasoning: Boolean(m.reasoning),
            ...(m.input ? { input: m.input } : {}),
            thinkingLevels: getSupportedThinkingLevels(m),
          }),
        );
      }
      case "getCustomModels": {
        return getCustomModels(join(this.agentDir(), "models.json"));
      }
      case "addCustomModel":
      case "updateCustomModel": {
        const update = input.action === "updateCustomModel";
        if (update && s?.isStreaming) throw new Error("Wait for the current response to finish before editing model settings.");
        const modelRuntime = await this.modelRuntime();
        if (!update && modelRuntime.getModel(input.provider, input.modelId))
          throw new Error("This provider/model ID already exists. Use a different model or provider ID.");
        if (!update && modelRuntime.getError()) throw new Error(modelRuntime.getError());
        addCustomModel(join(this.agentDir(), "models.json"), input, update);
        await modelRuntime.refresh({ allowNetwork: false });
        if (modelRuntime.getError()) throw new Error(modelRuntime.getError());
        if (input.apiKey?.trim()) {
          await modelRuntime.login(input.provider, "api_key", {
            prompt: async (prompt: { type: string }) => {
              if (prompt.type !== "secret") throw new Error("Model saved. Configure this provider's credentials using Pi /login.");
              return input.apiKey!.trim();
            },
            notify: () => undefined,
          }).catch((error: unknown) => {
            throw new Error(`Model saved, but credential setup failed. Configure this provider in settings: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        if (update && s?.model?.provider === input.provider && s.model.id === input.modelId) {
          await s.setModel(modelRuntime.getModel(input.provider, input.modelId));
          return this.snapshot();
        }
        return { ok: true };
      }
      case "setModel": {
        const m = s.modelRuntime.getModel(input.provider, input.modelId);
        if (!m) throw new Error("Model not found");
        // A switch belongs to this session's transcript, like the TUI's /model;
        // only an explicit "set as default" writes the profile defaults.
        await s.setModel(m, { persist: input.persist });
        break;
      }
      case "cycleModel":
        await s.cycleModel();
        break;
      case "getThinkingLevels":
        return s.getAvailableThinkingLevels();
      case "setThinking":
        s.setThinkingLevel(input.level);
        break;
      case "cycleThinking":
        await s.cycleThinkingLevel();
        break;
      case "setQueueMode":
        input.kind === "steering"
          ? s.setSteeringMode(input.mode)
          : s.setFollowUpMode(input.mode);
        break;
      case "compact":
        await s.compact(input.instructions);
        break;
      case "setAutoCompaction":
        s.setAutoCompactionEnabled(input.enabled);
        break;
      case "setAutoRetry":
        s.setAutoRetryEnabled(input.enabled);
        break;
      case "abortRetry":
        s.abortRetry();
        break;
      case "abortCompaction":
        s.abortCompaction();
        break;
      case "bash":
        await s.executeBash(input.command, undefined, {
          excludeFromContext: input.excludeFromContext,
        });
        break;
      case "abortBash":
        s.abortBash();
        break;
      case "stats":
        return s.getSessionStats();
      case "exportJsonl":
        return { path: s.exportToJsonl() };
      case "exportHtml":
        return { path: await s.exportToHtml(input.outputPath) };
      case "setName":
        s.setSessionName(input.name);
        break;
      case "commands":
        return collectAgentCommands(s);
      case "getTools":
        return { active: s.getActiveToolNames(), all: s.getAllTools() };
      case "setTools":
        s.setActiveToolsByName(input.names);
        break;
      case "getProviders": {
        const modelRuntime = await this.modelRuntime();
        return Promise.all(
          modelRuntime
            .getProviders()
            .map(async (p: any): Promise<RuntimeProvider> => ({
              id: p.id,
              name: p.name,
              authTypes: [
                ...(p.auth?.apiKey?.login ? ["api_key" as const] : []),
                ...(p.auth?.oauth?.login ? ["oauth" as const] : []),
              ],
              status: await modelRuntime.checkAuth(p.id),
            })),
        );
      }
      case "getSkills":
      case "getSkill":
      case "createSkill":
      case "importSkill":
      case "updateSkill":
      case "deleteSkill":
      case "setSkillManualOnly":
        return this.skillControls.run(input);
      case "getExtensions": {
        if (!s) await this.modelRuntime();
        const loader = s?.resourceLoader ?? this.modelServices.resourceLoader;
        if (input.reload) await loader.reload();
        return loader.getExtensions().extensions
          .filter((extension: any) => !extension.hidden)
          .map(
            (extension: any): RuntimeExtension => ({
              path: String(extension.path),
              resolvedPath: String(extension.resolvedPath),
              source: String(extension.sourceInfo?.source ?? "local"),
              scope: extension.sourceInfo?.scope ?? "project",
              bundled: isBundledExtension(dirname(fileURLToPath(import.meta.url)), extension.path),
              tools: Array.from(extension.tools?.entries?.() ?? [], ([name, tool]: [string, any]) => ({
                name,
                label: String(tool.definition?.label ?? name),
                description: String(tool.definition?.description ?? ""),
              })).sort((a, b) => a.name.localeCompare(b.name)),
              commands: Array.from(extension.commands?.entries?.() ?? [], ([name, command]: [string, any]) => ({
                name,
                description: String(command.description ?? ""),
              })).sort((a, b) => a.name.localeCompare(b.name)),
            }),
          );
      }
      case "installExtension":
      case "removeExtension": {
        // User scope (no --local), so the package lands in PiX's agentDir and
        // pi list / pi update / pi remove manage it from here on. Runs on
        // whichever host owns this session; remote hosts npm-install there.
        const pi = await this.pi();
        const cwd = this.cwd ?? homedir();
        const packageManager = new pi.DefaultPackageManager({
          cwd,
          agentDir: this.agentDir(),
          settingsManager: pi.SettingsManager.create(cwd, this.agentDir()),
        });
        if (input.action === "installExtension") {
          await packageManager.installAndPersist(input.source);
        } else if (!(await packageManager.removeAndPersist(input.source))) {
          // The button only manages user scope; a project-scoped install
          // (pi install -l) must report instead of silently no-op.
          throw new Error("Not installed in user scope; remove the project-scoped copy with pi remove");
        }
        return { ok: true };
      }
      case "loginApiKey": {
        const modelRuntime = await this.modelRuntime();
        await modelRuntime.login(input.provider, "api_key", {
          prompt: async (prompt: { type: string }) => {
            if (prompt.type !== "secret")
              throw new Error("This provider needs additional setup; configure it with Pi /login.");
            return input.apiKey;
          },
          notify: () => undefined,
        });
        return { ok: true };
      }
      case "loginOAuth": {
        const modelRuntime = await this.modelRuntime();
        await modelRuntime.login(input.provider, "oauth", {
          prompt: async (prompt: any) => {
            if (prompt.type === "select") {
              const selected = prompt.options.find((option: any) => option.id === input.method);
              if (selected) return selected.id;
              throw new Error(`OAuth method ${input.method} is not supported by this provider.`);
            }
            if (prompt.type === "manual_code" && prompt.signal)
              return new Promise<string>((_resolve, reject) => {
                const abort = () => reject(new Error("OAuth browser prompt closed"));
                if (prompt.signal.aborted) abort();
                else prompt.signal.addEventListener("abort", abort, { once: true });
              });
            throw new Error("This OAuth provider requires interactive Pi /login setup.");
          },
          notify: (event: any) => {
            const url = event.type === "auth_url" ? event.url : event.type === "device_code" ? event.verificationUri : undefined;
            if (url)
              void this.openExternal(url).catch((error) =>
                this.emit({ type: "notice", payload: { level: "error", message: String(error) } }),
              );
            const message = event.type === "device_code"
              ? `Enter code ${event.userCode} in the opened browser.`
              : event.type === "progress" ? event.message : event.instructions;
            if (message) this.emit({ type: "notice", payload: { message } });
          },
        });
        const status = await modelRuntime.checkAuth(input.provider);
        if (status?.type !== "oauth")
          throw new Error("OAuth completed without a usable credential");
        return { ok: true, status };
      }
      case "setBrokerProviders":
        await this.configureBrokerProviders(input.providers, input.models);
        return { ok: true };
      case "logout":
        await (await this.modelRuntime()).logout(input.provider);
        return { ok: true };
      case "setLabel":
        s.sessionManager.appendLabelChange(input.entryId, input.label);
        break;
      case "navigateTree":
        await s.navigateTree(input.entryId, { summarize: false });
        break;
      case "newSession":
        return this.create();
      case "fork":
        await this.runtime.fork(input.entryId, { position: "before" });
        this.bind();
        break;
      case "clone": {
        const leaf = s.sessionManager.getLeafId();
        if (!leaf) throw new Error("Empty session");
        await this.runtime.fork(leaf, { position: "at" });
        this.bind();
        break;
      }
      case "reload":
        await s.reload();
        break;
    }
    return this.snapshot();
  }
  close(): Promise<void> {
    return this.closeTask ??= this.closeRuntime().finally(() => { this.closeTask = undefined; });
  }
  private async closeRuntime() {
    const runtime = this.runtime;
    if (!runtime) return;
    this.closing = true;
    this.unsubscribe?.();
    try {
      runtime.session.abortBash();
      await runtime.session.abort();
      // A prompt can still be in preflight, or writing its footer after abort.
      // Drain controller calls before unlinking the session file.
      await Promise.allSettled([...this.pendingControls]);
      await runtime.dispose();
      if (this.runtime === runtime) this.runtime = undefined;
    } finally {
      this.closing = false;
    }
  }
  dispose() {
    this.unsubscribe?.();
    this.runtime?.session?.dispose?.();
    this.runtime = undefined;
  }
}
