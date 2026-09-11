import { dirname, basename, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { agentEventForwarder } from "./agent-event-forwarder.js";
import { FileChangeTracker } from "./file-changes.js";
import { FILE_CHANGE_CUSTOM_TYPE } from "../shared/file-changes.js";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getSupportedThinkingLevels, type ModelsRefreshResult } from "@earendil-works/pi-ai";
import {
  detectWindowsBash,
  memoizeOnce,
  withDetectedBashShell,
} from "./bash-resolution.js";
import { isBundledExtension, resolveBuiltinPackages } from "./builtin-packages.js";
import { applyBuiltinSkillOverrides, isBundledSkillPath, resolveBuiltinSkills, setBuiltinSkillManualOnly } from "./builtin-skills.js";
import {
  SKILL_BODY_MESSAGES,
  SKILL_DESCRIPTION_MESSAGES,
  SKILL_NAME_MESSAGES,
  assertEditableSkillPath,
  isEditableSkillPath,
  isPathInside,
  parseSkillDocument,
  serializeSkillDocument,
  skillRoots,
} from "./skill-files.js";
import { skillBodyError, skillDescriptionError, skillNameError, slugifySkillName } from "../shared/skills.js";
import { addCustomModel, getCustomModels } from "./custom-models.js";
import { validatePromptImages } from "../shared/images.js";
import { collectAgentCommands } from "../shared/commands.js";
import type {
  AgentControl,
  BrokerModel,
  RawSessionEntry,
  RuntimeModel,
  RuntimeExtension,
  RuntimeProvider,
  RuntimeSkill,
  RuntimeSkillDocument,
  RuntimeState,
  SessionSnapshot,
  SessionSummary,
} from "../shared/types.js";
import type { CreateAgentSessionServicesOptions, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { NODE_FOOTER_CUSTOM_TYPE } from "../shared/types.js";
import { projectSession, summarizeSession } from "../shared/session.js";

// One Git Bash probe per process; later sessions reuse the first result.
const detectBash = memoizeOnce(detectWindowsBash);

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
  agentDir(pi: any) {
    return process.env.PIX_HOME
      ? join(process.env.PIX_HOME, ".pi", "agent")
      : pi.getAgentDir();
  }
  /** Skill roots PiX may create or rewrite for the active project. */
  private async skillFileRoots() {
    const pi = await this.pi();
    return skillRoots(this.agentDir(pi), this.cwd ?? homedir(), pi.CONFIG_DIR_NAME, homedir());
  }
  /**
   * Reloads discovery after a skill file changes so the settings list and the
   * /skill:name commands (expanded against the live loader) agree with disk.
   * The active session's system prompt is deliberately left alone: it is the
   * prompt-cache prefix, and rebuilding it would reprocess the entire history.
   * The <available_skills> advertisement only refreshes in a new or reloaded
   * session, the same trade-off Pi's own CLI makes.
   */
  private async reloadSkills() {
    const loader = this.runtime?.session?.resourceLoader;
    if (loader) {
      await loader.reload();
      return;
    }
    await this.modelRuntime();
    await this.modelServices?.resourceLoader?.reload();
  }
  private async skillTarget(path: string) {
    const roots = await this.skillFileRoots();
    return { roots, file: assertEditableSkillPath(path, roots.editable) };
  }
  private async skillRoot(scope: "user" | "project") {
    if (scope === "project" && !this.cwd) throw new Error("Open a project first");
    const { user, project } = await this.skillFileRoots();
    return resolve(scope === "project" ? project : user);
  }
  /** Validates the editable fields shared by create, import, and update. */
  private assertSkillFields(name: string, description: string, body: string) {
    const nameError = skillNameError(name);
    if (nameError) throw new Error(SKILL_NAME_MESSAGES[nameError]);
    const descriptionError = skillDescriptionError(description);
    if (descriptionError) throw new Error(SKILL_DESCRIPTION_MESSAGES[descriptionError]);
    const bodyError = skillBodyError(body);
    if (bodyError) throw new Error(SKILL_BODY_MESSAGES[bodyError]);
  }
  private skillFile(root: string, name: string) {
    const slug = slugifySkillName(name);
    const file = join(root, slug, "SKILL.md");
    if (existsSync(file) || existsSync(join(root, `${slug}.md`)))
      throw new Error(`A skill named "${name}" already exists`);
    return file;
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
    const modelRuntime = await this.modelRuntime();
    const next = new Set(providers);
    for (const provider of this.brokerProviders)
      if (!next.has(provider)) {
        await modelRuntime.removeRuntimeApiKey(provider);
        modelRuntime.unregisterProvider(provider);
      }
    this.brokerProviders = next;
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
    const agentDir = this.agentDir(pi);
    // Pi's bash tool otherwise only finds Git Bash under Program Files or
    // directly on PATH; derive it from git.exe so custom install roots
    // (e.g. D:\software\Git) get a POSIX shell without user setup.
    const settingsManager = withDetectedBashShell(
      pi.SettingsManager.create(cwd, agentDir),
      detectBash(),
    );
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
        extensionFactories: [{ name: "pix-file-changes", factory: this.fileChangesExtension() }] as InlineExtension[],
        additionalExtensionPaths: resolveBuiltinPackages(
          dirname(fileURLToPath(import.meta.url)),
          settingsManager,
        ),
        // Built-in skills load as plain markdown via the same layout
        // resolution (extraResources skills/ beside the app or server);
        // pi ranks them below user skills, so same-named user copies win.
        additionalSkillPaths: resolveBuiltinSkills(
          dirname(fileURLToPath(import.meta.url)),
        ),
        // The manual-only overrides for those read-only files are applied
        // here. Re-read on every invocation: reload() and new loaders call
        // this closure again, so a toggled built-in takes effect without
        // recreating services.
        skillsOverride: (base) =>
          applyBuiltinSkillOverrides(dirname(fileURLToPath(import.meta.url)), base),
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
  private fileChangesExtension(): ExtensionFactory {
    return async pi => {
      const tracker = new FileChangeTracker();
      // Match the installed SDK's path rules, including Windows shell paths, ~ and @ prefixes.
      const paths = await import(new URL("./core/tools/path-utils.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
      pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "edit" && event.toolName !== "write") return;
        const input = event.input as Record<string, unknown>;
        if (typeof input.path !== "string") return;
        // Nothing here may throw past the catch: a failed snapshot must never
        // block the tool the user asked for.
        try {
          // Graph workers are opened through the graph owner's factory, so this
          // extension belongs to that owner: snapshots must live next to the
          // session whose entries reference them, not next to an executing worker.
          const session = this.runtime?.session.sessionManager.getSessionFile();
          if (!session) return;
          await tracker.before(event.toolCallId, paths.resolveToCwd(input.path, ctx.cwd), ctx.cwd, session, ctx.sessionManager.getBranch() as RawSessionEntry[]);
        } catch (error) { ctx.ui.notify(`File change tracking: ${String(error)}`, "warning"); }
      });
      pi.on("tool_result", async (event, ctx) => {
        try {
          const path = typeof event.input.path === "string" ? paths.resolveToCwd(event.input.path, ctx.cwd) : "";
          const change = await tracker.after(event.toolCallId, path, event.isError);
          if (change) pi.appendEntry(FILE_CHANGE_CUSTOM_TYPE, change);
        } catch (error) { ctx.ui.notify(`File change tracking: ${String(error)}`, "warning"); }
      });
      pi.on("agent_settled", () => tracker.clear());
      pi.on("session_shutdown", () => tracker.clear());
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
      } catch {}
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
      cwd: this.cwd, agentDir: this.agentDir(pi), sessionManager: manager,
    });
    this.bind();
  }
  async list(): Promise<SessionSummary[]> {
    const pi = await this.pi(),
      all = await pi.SessionManager.list(this.cwd, this.dir);
    return all.map((s: any) => ({
      id: s.id,
      path: s.path,
      name: s.name,
      cwd: s.cwd || this.cwd,
      created: new Date(s.created).toISOString(),
      modified: new Date(s.modified).toISOString(),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
    }));
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
        agentDir: this.agentDir(pi),
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
        agentDir: this.agentDir(pi),
        sessionManager: manager,
      });
    }
    this.bind();
    return this.snapshot();
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
        ...summarizeSession(s.sessionFile ?? "", m.getHeader?.() ?? null, entries, new Date().toISOString()),
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
    const modelAction = [
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
      "loginApiKey",
      "loginOAuth",
      "logout",
      "setBrokerProviders",
    ].includes(input.action);
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
        const pi = await this.pi();
        return getCustomModels(join(this.agentDir(pi), "models.json"));
      }
      case "addCustomModel":
      case "updateCustomModel": {
        const update = input.action === "updateCustomModel";
        if (update && s?.isStreaming) throw new Error("Wait for the current response to finish before editing model settings.");
        const pi = await this.pi();
        const modelRuntime = await this.modelRuntime();
        if (!update && modelRuntime.getModel(input.provider, input.modelId))
          throw new Error("This provider/model ID already exists. Use a different model or provider ID.");
        if (!update && modelRuntime.getError()) throw new Error(modelRuntime.getError());
        addCustomModel(join(this.agentDir(pi), "models.json"), input, update);
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
      case "getSkills": {
        if (!s) await this.modelRuntime();
        const loader = s?.resourceLoader ?? this.modelServices.resourceLoader;
        if (input.reload) await loader.reload();
        const { editable } = await this.skillFileRoots();
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        const { skills: loaded, diagnostics } = loader.getSkills();
        // A user copy hiding a bundled skill of the same name leaves the
        // bundled row simply absent; badge the winner so the list explains
        // itself. Pi reports these as collision diagnostics.
        const shadowsBuiltin = new Map<string, string>();
        for (const diagnostic of (diagnostics ?? []) as any[]) {
          const collision = diagnostic?.collision;
          if (collision?.resourceType !== "skill") continue;
          const loser = String(collision.loserPath ?? "");
          if (isBundledSkillPath(moduleDir, loser))
            shadowsBuiltin.set(String(collision.winnerPath ?? ""), loser);
        }
        return loaded.map(
          (skill: any): RuntimeSkill => ({
            name: String(skill.name),
            description: String(skill.description),
            path: String(skill.filePath),
            source: String(skill.sourceInfo?.source ?? "local"),
            // Bundled skills carry no pi scope of their own; show them as a
            // read-only category instead of a misleading "project" badge.
            scope: isBundledSkillPath(moduleDir, String(skill.filePath))
              ? "builtin"
              : skill.sourceInfo?.scope ?? "project",
            disableModelInvocation: Boolean(skill.disableModelInvocation),
            editable: isEditableSkillPath(String(skill.filePath), editable),
            ...(shadowsBuiltin.has(String(skill.filePath))
              ? { shadowsBuiltin: shadowsBuiltin.get(String(skill.filePath)) }
              : {}),
          }),
        );
      }
      case "getSkill": {
        // Reading follows the loaded list: anything the settings page shows
        // can be opened in the read-only viewer, packaged skills included.
        // Writes (and paths the loader never listed) stay behind the
        // editable-roots assertion in skillTarget. The listed entry also
        // supplies the effective invocation flag, which for a bundled skill
        // is the override table's value rather than the file's frontmatter.
        if (!s) await this.modelRuntime();
        const loader = s?.resourceLoader ?? this.modelServices.resourceLoader;
        const requested = resolve(input.path);
        const listed = loader
          .getSkills()
          .skills.find((skill: any) => resolve(String(skill.filePath)) === requested);
        const file = listed || isBundledSkillPath(dirname(fileURLToPath(import.meta.url)), requested)
          ? requested
          : (await this.skillTarget(input.path)).file;
        const document = parseSkillDocument(await readFile(file, "utf8"));
        // A skill file may omit the frontmatter name. Pi then falls back to the
        // containing folder for a SKILL.md, or to the file name for a root .md
        // (case-insensitive, matching the editable-path check), so the editor
        // starts from the same name the list shows.
        const fallback = basename(file).toLowerCase() === "skill.md"
          ? basename(dirname(file))
          : basename(file).replace(/\.md$/i, "");
        return {
          path: file,
          name: document.name || fallback,
          description: document.description,
          body: document.body,
          // The loader's value is the effective one (post override table).
          disableModelInvocation: listed
            ? Boolean(listed.disableModelInvocation)
            : document.disableModelInvocation,
        } satisfies RuntimeSkillDocument;
      }
      case "createSkill": {
        const root = await this.skillRoot(input.scope);
        this.assertSkillFields(input.name, input.description, input.body);
        const target = this.skillFile(root, input.name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, serializeSkillDocument({
          name: input.name.trim(),
          description: input.description.trim(),
          body: input.body,
          disableModelInvocation: input.disableModelInvocation,
          extra: {},
        }), "utf8");
        await this.reloadSkills();
        return { path: target };
      }
      case "importSkill": {
        const root = await this.skillRoot(input.scope);
        const document = parseSkillDocument(input.content);
        // Pi tolerates a name that breaks the spec, but PiX only manages
        // spec-valid skills, so an import normalizes whatever it finds into a
        // slug instead of refusing a document Pi would happily load.
        const name = slugifySkillName(document.name || input.name);
        if (!name) throw new Error("Skill name must contain at least one letter or number");
        this.assertSkillFields(name, document.description, document.body);
        const target = this.skillFile(root, name);
        await mkdir(dirname(target), { recursive: true });
        // Rewriting through the parser normalizes the document so Pi is
        // guaranteed to load it, while unmanaged frontmatter survives.
        await writeFile(target, serializeSkillDocument({
          ...document,
          name,
          description: document.description.trim(),
        }), "utf8");
        await this.reloadSkills();
        return { path: target };
      }
      case "updateSkill": {
        const { file } = await this.skillTarget(input.path);
        this.assertSkillFields(input.name, input.description, input.body);
        const existing = parseSkillDocument(await readFile(file, "utf8"));
        await writeFile(file, serializeSkillDocument({
          ...existing,
          name: input.name.trim(),
          description: input.description.trim(),
          body: input.body,
          disableModelInvocation: input.disableModelInvocation,
        }), "utf8");
        await this.reloadSkills();
        return { path: file };
      }
      case "deleteSkill": {
        const { roots, file } = await this.skillTarget(input.path);
        const directory = dirname(file);
        const ownsDirectory = basename(file).toLowerCase() === "skill.md" &&
          roots.editable.some((root) => resolve(root) !== directory && isPathInside(root, directory));
        if (ownsDirectory) await rm(directory, { recursive: true, force: true });
        else await rm(file, { force: true });
        await this.reloadSkills();
        return { ok: true };
      }
      case "setSkillManualOnly": {
        // A bundled skill's file is read-only (replaced on upgrade, possibly
        // unwritable), so its manual-only preference goes to the override
        // table that skillsOverride applies at load time. Only paths inside
        // the bundled roots take this branch; everything else still has to
        // be an editable skill file.
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        const requested = resolve(input.path);
        if (isBundledSkillPath(moduleDir, requested)) {
          const document = parseSkillDocument(await readFile(requested, "utf8"));
          const fallback = basename(requested).toLowerCase() === "skill.md"
            ? basename(dirname(requested))
            : basename(requested).replace(/\.md$/i, "");
          setBuiltinSkillManualOnly(document.name || fallback, input.manualOnly);
          await this.reloadSkills();
          return { ok: true };
        }
        const { file } = await this.skillTarget(input.path);
        const document = parseSkillDocument(await readFile(file, "utf8"));
        await writeFile(file, serializeSkillDocument({
          ...document,
          disableModelInvocation: input.manualOnly,
        }), "utf8");
        await this.reloadSkills();
        return { ok: true };
      }
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
