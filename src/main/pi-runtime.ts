import { join } from "node:path";
import { homedir } from "node:os";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  detectWindowsBash,
  memoizeOnce,
  withDetectedBashShell,
} from "./bash-resolution.js";
import type {
  AgentControl,
  RawSessionEntry,
  RuntimeModel,
  RuntimeExtension,
  RuntimeProvider,
  RuntimeSkill,
  RuntimeState,
  SessionSnapshot,
  SessionSummary,
} from "../shared/types.js";
import { NODE_FOOTER_CUSTOM_TYPE } from "../shared/types.js";
import { projectSession } from "../shared/session.js";

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
  modelBroker?: (model: any, context: any, options: any) => any;
  openExternal: (url: string) => Promise<void>;
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
  agentDir(pi: any) {
    return process.env.PIX_HOME
      ? join(process.env.PIX_HOME, ".pi", "agent")
      : pi.getAgentDir();
  }
  async modelRuntime() {
    if (this.runtime?.session?.modelRuntime)
      return this.runtime.session.modelRuntime;
    const pi = await this.pi();
    // Project-less model actions (settings, login) still need a real cwd for
    // the agent services; the home directory carries no project state.
    this.modelServices ??= await pi.createAgentSessionServices({
      cwd: this.cwd ?? homedir(),
      agentDir: this.agentDir(pi),
    });
    return this.modelServices.modelRuntime;
  }
  setModelBroker(broker?: (model: any, context: any, options: any) => any) {
    this.modelBroker = broker;
  }

  async configuredProviderIds() {
    const modelRuntime = await this.modelRuntime();
    return [...new Set((await modelRuntime.getAvailable()).map((model: any) => String(model.provider)))];
  }

  async configureBrokerProviders(providers: string[]) {
    const modelRuntime = await this.modelRuntime();
    const next = new Set(providers);
    for (const provider of this.brokerProviders)
      if (!next.has(provider)) await modelRuntime.removeRuntimeApiKey(provider);
    this.brokerProviders = next;
    await this.applyModelBroker(modelRuntime);
  }

  async applyModelBroker(modelRuntime: any) {
    for (const provider of this.brokerProviders)
      await modelRuntime.setRuntimeApiKey(provider, "pix-desktop-broker");
    if (!this.modelBroker) return;
    const broker = this.modelBroker;
    modelRuntime.stream = (model: any, context: any, options: any) =>
      broker(model, context, options);
    modelRuntime.streamSimple = (model: any, context: any, options: any) =>
      broker(model, context, options);
  }
  factory(pi: any) {
    return async ({ cwd, sessionManager, sessionStartEvent }: any) => {
      const agentDir = this.agentDir(pi);
      const services = await pi.createAgentSessionServices({
        cwd,
        agentDir,
        // Pi's bash tool otherwise only finds Git Bash under Program Files or
        // directly on PATH; derive it from git.exe so custom install roots
        // (e.g. D:\software\Git) get a POSIX shell without user setup.
        settingsManager: withDetectedBashShell(
          pi.SettingsManager.create(cwd, agentDir),
          detectBash(),
        ),
      });
      await this.applyModelBroker(services.modelRuntime);
      const created = await pi.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
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
    this.unsubscribe = this.runtime.session.subscribe((payload: unknown) =>
      this.emit({ type: "agent", payload }),
    );
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
    return {
      session: {
        id: s.sessionId,
        path: s.sessionFile ?? "",
        name: m.getSessionName?.(),
        cwd: m.getCwd(),
        created: String(m.getHeader?.()?.timestamp ?? new Date().toISOString()),
        modified: new Date().toISOString(),
        messageCount: entries.filter((e) => e.type === "message").length,
        firstMessage: "",
      },
      entries,
      projection: projectSession(entries, leaf),
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
  async control(input: AgentControl): Promise<unknown> {
    const s = this.runtime?.session;
    const modelAction = [
      "getModels",
      "getProviders",
      "getSkills",
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
    switch (input.action) {
      case "prompt": {
        // prompt() also resolves without a turn for handled extension
        // commands and throws before appending anything (busy, no model, no
        // auth) — the footer may only be recorded when this call created one.
        const before = s.sessionManager.getEntries().length;
        try {
          await s.prompt(input.text, { source: "interactive" });
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
                  }
                : null,
              thinkingLevel: String(s.thinkingLevel ?? "off"),
            });
        }
        break;
      }
      case "steer":
        await s.steer(input.text);
        break;
      case "followUp":
        await s.followUp(input.text);
        break;
      case "abort":
        await s.abort();
        break;
      case "clearQueue":
        await s.clearQueue();
        break;
      case "getState":
        return this.state();
      case "getModels": {
        const modelRuntime = await this.modelRuntime();
        return (await modelRuntime.getAvailable()).map(
          (m: any): RuntimeModel => ({
            provider: String(m.provider),
            id: String(m.id),
            name: m.name,
            contextWindow: m.contextWindow,
            reasoning: Boolean(m.reasoning),
            thinkingLevels: getSupportedThinkingLevels(m),
          }),
        );
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
        return (s.getCommands?.() ?? []).map((c: any) => ({
          name: c.name,
          description: c.description,
          source: c.source,
        }));
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
        return loader.getSkills().skills.map(
          (skill: any): RuntimeSkill => ({
            name: String(skill.name),
            description: String(skill.description),
            path: String(skill.filePath),
            source: String(skill.sourceInfo?.source ?? "local"),
            scope: skill.sourceInfo?.scope ?? "project",
            disableModelInvocation: Boolean(skill.disableModelInvocation),
          }),
        );
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
        await this.configureBrokerProviders(input.providers);
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
  dispose() {
    this.unsubscribe?.();
    this.runtime?.session?.dispose?.();
    this.runtime = undefined;
  }
}
