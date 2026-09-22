import type {
  CustomModelInput,
  DesktopRoute,
  LayoutState,
  PanelId,
} from "./types.js";
import { CUSTOM_MODEL_APIS, PANEL_IDS, UTILITY_TABS } from "./types.js";
import { INSTALLABLE_PACKAGE_SOURCES } from "./extensions.js";
import { validatePromptImages } from "./images.js";
import { MAX_SKILL_BYTES } from "./skills.js";
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object payload");
  return value as Record<string, unknown>;
};
const str = (
  value: unknown,
  name: string,
  optional = false,
): string | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || (!optional && !value.trim()))
    throw new Error(`${name} must be a non-empty string`);
  return value;
};
const externalUrl = (value: unknown) => {
  const url = new URL(str(value, "url")!);
  if (!["https:", "http:", "mailto:"].includes(url.protocol))
    throw new Error(`External protocol is not allowed: ${url.protocol}`);
  return url.href;
};
const integer = (value: unknown, name: string, min: number, max: number) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value as number;
};
const numberField = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a finite number`);
  return value;
};
const booleanField = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
};
const objectField = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};

/** Validates a custom model form submission; shared by the agent.control
 *  route and models.json writes in custom-models.ts. */
export function customModelInput(value: unknown): CustomModelInput {
  const v = obj(value);
  const provider = str(v.provider, "provider")!.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider) || ["__proto__", "constructor", "prototype"].includes(provider))
    throw new Error("Invalid provider ID");
  const baseUrl = str(v.baseUrl, "baseUrl")!.trim();
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Model endpoint must be an HTTP(S) URL without embedded credentials");
  const api = CUSTOM_MODEL_APIS.find((candidate) => candidate === v.api);
  if (!api) throw new Error("Unsupported model API");
  return {
    provider,
    baseUrl,
    api,
    modelId: str(v.modelId, "modelId")!.trim(),
    name: str(v.name, "name", true)?.trim(),
    apiKey: str(v.apiKey, "apiKey", true)?.trim(),
    contextWindow: integer(v.contextWindow, "contextWindow", 1, Number.MAX_SAFE_INTEGER),
    maxTokens: integer(v.maxTokens, "maxTokens", 1, Number.MAX_SAFE_INTEGER),
    reasoning: v.reasoning === true,
    imageInput: v.imageInput === true,
  };
}

/** The persisted workbench layout arrives as one opaque renderer object;
 *  validate its whole shape before it is merged into app settings. PANEL_IDS
 *  and UTILITY_TABS come from types.ts, where the unions are derived from
 *  them, so validation and typing share one list. */
const layoutState = (value: unknown): LayoutState => {
  const v = obj(value);
  const widths = objectField(v.widths, "widths");
  const collapsed = objectField(v.collapsed, "collapsed");
  const utility = objectField(v.utility, "utility");
  const activeTab = UTILITY_TABS.find((tab) => tab === utility.activeTab);
  if (!activeTab) throw new Error("utility.activeTab is not a utility tab");
  const collapsedState = {} as Record<PanelId, boolean>;
  for (const panel of PANEL_IDS)
    collapsedState[panel] = booleanField(collapsed[panel], `collapsed.${panel}`);
  const layout: LayoutState = {
    widths: {
      navigator: numberField(widths.navigator, "widths.navigator"),
      chat: numberField(widths.chat, "widths.chat"),
      content: numberField(widths.content, "widths.content"),
      settings: numberField(widths.settings, "widths.settings"),
    },
    collapsed: collapsedState,
    minimap: booleanField(v.minimap, "minimap"),
    utility: {
      open: booleanField(utility.open, "utility.open"),
      collapsed: booleanField(utility.collapsed, "utility.collapsed"),
      height: numberField(utility.height, "utility.height"),
      activeTab,
    },
  };
  if (v.version !== undefined) layout.version = numberField(v.version, "version");
  if (v.navigatorPinned !== undefined)
    layout.navigatorPinned = booleanField(v.navigatorPinned, "navigatorPinned");
  if (v.chatPinWidth !== undefined) {
    const chatPinWidth = objectField(v.chatPinWidth, "chatPinWidth");
    layout.chatPinWidth = {
      from: numberField(chatPinWidth.from, "chatPinWidth.from"),
      to: numberField(chatPinWidth.to, "chatPinWidth.to"),
    };
  }
  if (v.branchOrders !== undefined) {
    const orders = objectField(v.branchOrders, "branchOrders");
    for (const [branch, entries] of Object.entries(orders)) {
      if (!Array.isArray(entries))
        throw new Error(`branchOrders.${branch} must be an array of [nodeId, order] pairs`);
      layout.branchOrders ??= {};
      layout.branchOrders[branch] = entries.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2 ||
            typeof entry[0] !== "string" || !Number.isFinite(entry[1]))
          throw new Error(`branchOrders.${branch} must contain [nodeId, order] pairs`);
        return [entry[0], entry[1] as number];
      });
    }
  }
  return layout;
};
export function validateRouteInput(
  route: DesktopRoute,
  input: unknown,
): Record<string, unknown> {
  const v = input === undefined ? {} : obj(input);
  switch (route) {
    case "wsl.connect":
      return {
        distro: str(v.distro, "distro"),
        cwd: v.browse === true ? str(v.cwd, "cwd", true) ?? "" : str(v.cwd, "cwd"),
        ...(v.browse === true ? { browse: true } : {}),
      };
    case "ssh.connect":
      return {
        host: str(v.host, "host"),
        cwd: str(v.cwd, "cwd"),
        ...(v.browse === true ? { browse: true } : {}),
      };
    case "remote.openProject":
    case "remote.directories":
    case "workspace.directories":
    case "workspace.open":
      return { path: str(v.path, "path") };
    case "app.openExternal":
      return { url: externalUrl(v.url) };
    case "app.revealSession":
      return { id: str(v.id, "id"), path: str(v.path, "path") };
    case "app.openProject":
      return { id: str(v.id, "id") };
    case "app.revealLogs":
      return {};
    case "app.forgetProject":
      return { id: str(v.id, "id") };
    case "session.open":
      return { path: str(v.path, "path") };
    case "session.stop":
      return { path: str(v.path, "path"),
        ...(v.projectId === undefined ? {} : { projectId: str(v.projectId, "projectId") }),
      };
    case "session.import":
      return {};
    case "session.rename":
      return { path: str(v.path, "path"), name: str(v.name, "name") };
    case "session.delete":
      return {
        path: str(v.path, "path"),
        // Set when the renderer already collected an in-app confirmation.
        ...(v.confirmed === true ? { confirmed: true } : {}),
        // Set by undo of "create session": refuse to unlink a file that
        // grew message entries behind the journal's back.
        ...(v.pristineOnly === true ? { pristineOnly: true } : {}),
      };
    case "library.pin":
      return { path: str(v.path, "path"), pinned: v.pinned === true };
    case "library.archiveSession":
      return { path: str(v.path, "path"), archived: v.archived === true };
    case "library.archiveProject":
      return { id: str(v.id, "id"), archived: v.archived === true };
    case "workspace.read":
      return { path: str(v.path, "path") };
    case "workspace.tree":
      return { path: str(v.path, "path", true) ?? "" };
    case "workspace.write":
      return {
        path: str(v.path, "path"),
        content: str(v.content, "content", true) ?? "",
      };
    case "git.diff":
      return { path: str(v.path, "path", true), staged: v.staged === true };
    case "git.switch":
      return { branch: str(v.branch, "branch"), cwd: str(v.cwd, "cwd") };
    case "changes.read":
      return { session: str(v.session, "session"), ref: str(v.ref, "ref") };
    case "shell.run":
      return { command: str(v.command, "command") };
    case "shell.abort":
      return { id: str(v.id, "id") };
    case "terminal.create":
      return {
        cols: integer(v.cols, "cols", 2, 500),
        rows: integer(v.rows, "rows", 1, 200),
      };
    case "terminal.write":
      return {
        id: str(v.id, "id"),
        data: str(v.data, "data", true) ?? "",
      };
    case "terminal.resize":
      return {
        id: str(v.id, "id"),
        cols: integer(v.cols, "cols", 2, 500),
        rows: integer(v.rows, "rows", 1, 200),
      };
    case "terminal.kill":
      return { id: str(v.id, "id") };
    case "settings.update": {
      const patch = obj(v.patch);
      if (v.scope !== "project" && v.scope !== "global" && Object.hasOwn(patch, "theme") &&
          patch.theme !== "light" && patch.theme !== "dark" && patch.theme !== "system" && patch.theme !== "teal" && patch.theme !== "peach")
        throw new Error("theme must be light, dark, teal, peach or system");
      return {
        scope:
          v.scope === "project"
            ? "project"
            : v.scope === "global"
              ? "global"
              : "app",
        patch,
      };
    }
    case "settings.reset":
      return {
        scope:
          v.scope === "project"
            ? "project"
            : v.scope === "global"
              ? "global"
              : "app",
      };
    case "layout.save":
      return { layout: layoutState(v.layout) };
    case "agent.control": {
      const action = str(v.action, "action")!;
      if (action === "deleteNode")
        return { action, nodeId: str(v.nodeId, "nodeId"), graphId: str(v.graphId, "graphId") };
      if (action === "exportBranchSession")
        return { action, nodeId: str(v.nodeId, "nodeId"), graphId: str(v.graphId, "graphId") };
      if (action === "promptAt") {
        const requestId = str(v.requestId, "requestId")!;
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw new Error("Invalid request ID");
        const images = v.images === undefined ? undefined : validatePromptImages(v.images);
        return { action, requestId, nodeId: v.nodeId === null ? null : str(v.nodeId, "nodeId"),
          text: str(v.text, "text", !!images?.length) ?? "", ...(images?.length ? { images } : {}),
          provider: str(v.provider, "provider", true), modelId: str(v.modelId, "modelId", true),
          thinkingLevel: str(v.thinkingLevel, "thinkingLevel", true) };
      }
      if (action === "branchAbort") return { action, branchId: str(v.branchId, "branchId"), runId: str(v.runId, "runId") };
      if (["prompt", "steer", "followUp"].includes(action)) {
        const images = v.images === undefined ? undefined : validatePromptImages(v.images);
        return { action, text: str(v.text, "text", !!images?.length) ?? "", ...(images?.length ? { images } : {}) };
      }
      if (action === "setModel")
        return {
          action,
          provider: str(v.provider, "provider"),
          modelId: str(v.modelId, "modelId"),
          persist: v.persist === true,
        };
      if (action === "addCustomModel" || action === "updateCustomModel")
        return { action, ...customModelInput(v) };
      if (action === "setThinking")
        return { action, level: str(v.level, "level") };
      if (action === "setQueueMode")
        return {
          action,
          kind: v.kind === "followUp" ? "followUp" : "steering",
          mode: v.mode === "all" ? "all" : "one-at-a-time",
        };
      if (action === "compact")
        return {
          action,
          instructions: str(v.instructions, "instructions", true),
        };
      if (action === "setAutoCompaction" || action === "setAutoRetry")
        return { action, enabled: v.enabled === true };
      if (action === "bash")
        return {
          action,
          command: str(v.command, "command"),
          excludeFromContext: v.excludeFromContext === true,
        };
      if (action === "exportHtml")
        return { action, outputPath: str(v.outputPath, "outputPath", true) };
      if (action === "setName") return { action, name: str(v.name, "name") };
      if (action === "setTools")
        return {
          action,
          names: Array.isArray(v.names)
            ? v.names.filter((x) => typeof x === "string")
            : [],
        };
      if (action === "getSkills" || action === "getExtensions")
        return { action, reload: v.reload === true };
      if (action === "installExtension" || action === "removeExtension") {
        const source = str(v.source, "source")!;
        if (!INSTALLABLE_PACKAGE_SOURCES.includes(source))
          throw new Error("Source is not an installable recommended extension");
        return { action, source };
      }
      if (action === "getSkill" || action === "deleteSkill")
        return { action, path: str(v.path, "path") };
      if (action === "setSkillManualOnly")
        return { action, path: str(v.path, "path"), manualOnly: v.manualOnly === true };
      if (action === "createSkill" || action === "updateSkill") {
        const body = str(v.body, "body")!;
        if (new TextEncoder().encode(body).length > MAX_SKILL_BYTES)
          throw new Error("body exceeds the skill size limit");
        const skill = {
          action,
          name: str(v.name, "name")!,
          description: str(v.description, "description")!,
          body,
          disableModelInvocation: v.disableModelInvocation === true,
        };
        return action === "createSkill"
          ? { ...skill, scope: v.scope === "project" ? "project" : "user" }
          : { ...skill, path: str(v.path, "path")! };
      }
      if (action === "importSkill") {
        const content = str(v.content, "content")!;
        if (new TextEncoder().encode(content).length > MAX_SKILL_BYTES)
          throw new Error("content exceeds the skill size limit");
        return {
          action,
          scope: v.scope === "project" ? "project" : "user",
          name: str(v.name, "name")!,
          content,
        };
      }
      if (action === "loginApiKey")
        return {
          action,
          provider: str(v.provider, "provider"),
          apiKey: str(v.apiKey, "apiKey"),
        };
      if (action === "loginOAuth")
        return {
          action,
          provider: str(v.provider, "provider"),
          method: v.method === "device-code" ? "device-code" : "browser",
        };
      if (action === "logout")
        return { action, provider: str(v.provider, "provider") };
      if (action === "setBrokerProviders")
        return {
          action,
          providers: Array.isArray(v.providers)
            ? v.providers.map((x) => str(x, "provider"))
            : [],
          ...(Array.isArray(v.models) ? { models: v.models.map((value) => {
            const m = obj(value);
            return {
              provider: str(m.provider, "provider"), id: str(m.id, "id"),
              name: str(m.name, "name"), api: str(m.api, "api"),
              reasoning: m.reasoning === true,
              thinkingLevelMap: m.thinkingLevelMap === undefined ? undefined : obj(m.thinkingLevelMap),
              input: Array.isArray(m.input) && m.input.includes("image") ? ["text", "image"] : ["text"],
              contextWindow: integer(m.contextWindow, "contextWindow", 1, Number.MAX_SAFE_INTEGER),
              maxTokens: integer(m.maxTokens, "maxTokens", 1, Number.MAX_SAFE_INTEGER),
              cost: obj(m.cost),
            };
          }) } : {}),
        };
      if (action === "setLabel")
        return {
          action,
          entryId: str(v.entryId, "entryId"),
          label: str(v.label, "label", true),
        };
      if (action === "navigateTree" || action === "fork")
        return { action, entryId: str(v.entryId, "entryId") };
      return { action };
    }
    default:
      return v;
  }
}
