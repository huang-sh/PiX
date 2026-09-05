<script setup lang="ts">
import { ArrowLeft, Bot, Box, Check, ChevronDown, CircleAlert, Folder, History, KeyRound, Palette, Puzzle, RefreshCw, Save, Search, SlidersHorizontal, Sparkles, Terminal, Wrench, X } from "@lucide/vue";
import { computed, reactive, ref, toRaw, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RuntimeExtension, RuntimeModel, RuntimeProvider, RuntimeSkill, SettingsBundle } from "../../../shared/types";
import Button from "../../components/ui/Button.vue";
import { desktop } from "../../api";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";

type Scope = "app" | "global" | "project";
interface Row {
  path: string;
  label: string;
  scope: Scope;
  type?: "text" | "number" | "check" | "select";
  options?: string[];
  fallback?: unknown;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}

const layout = useLayoutStore();
const workspace = useWorkspaceStore();
const session = useSessionStore();
const { locale, t, te } = useI18n();
const draft = ref<SettingsBundle>();
// The model catalog lives in the session store so every consumer (settings,
// graph, branch context) reads one list; this page only reloads it.
const models = computed(() => session.models);
const providers = ref<RuntimeProvider[]>([]);
const modelQuery = ref("");
const providerFilter = ref<"all" | "configured" | "other">("all");
const selectedModel = ref("");
const expandedProvider = ref("");
const editingProvider = ref("");
const keyDrafts = reactive<Record<string, string>>({});
const runtimeBusy = ref(false);
const providerBusy = ref("");
const saving = ref(false);
const runtimeError = ref("");
const skills = ref<RuntimeSkill[]>([]);
const skillQuery = ref("");
const skillBusy = ref(false);
const skillError = ref("");
const extensions = ref<RuntimeExtension[]>([]);
const extensionQuery = ref("");
const extensionScope = ref<"all" | RuntimeExtension["scope"]>("all");
const extensionBusy = ref(false);
const extensionError = ref("");
const categories = computed(() => [
  ["general", t("settings.categories.general"), SlidersHorizontal],
  ["appearance", t("settings.categories.appearance"), Palette],
  ["models", t("settings.categories.models"), Box],
  ["sessions", t("settings.categories.sessions"), History],
  ["agent", t("settings.categories.agent"), Bot],
  ["tools", t("settings.categories.tools"), Wrench],
  ["skills", t("settings.categories.skills"), Sparkles],
  ["extensions", t("settings.categories.extensions"), Puzzle],
  ["shell", t("settings.categories.shell"), Terminal],
] as const);

function optionLabel(option: string) {
  const key = `options.${option}`;
  return te(key) ? t(key) : option;
}

function rowHint(row: Row) {
  return row.description
    ? t(row.description)
    : t("settings.storedIn", { scope: t(`settings.scope.${row.scope}`) });
}

watch(
  () => layout.settings,
  (settings) => void (draft.value = settings ? structuredClone(toRaw(settings)) : undefined),
  { immediate: true },
);

const rows = computed<Row[]>(() => {
  switch (layout.settingsCategory) {
    case "general":
      return [
        { path: "language", label: "settings.rows.language", scope: "app", type: "select", options: ["system", "zh-CN", "en"] },
        { path: "enterToSend", label: "settings.rows.enterToSend", scope: "app", type: "check", fallback: true, description: "settings.rows.enterToSendDesc" },
        { path: "openLinksInApp", label: "settings.rows.openLinksInApp", scope: "app", type: "check", fallback: true, description: "settings.rows.openLinksInAppDesc" },
        { path: "defaultProjectTrust", label: "settings.rows.defaultProjectTrust", scope: "global", type: "select", options: ["ask", "always", "never"], fallback: "ask", description: "settings.rows.defaultProjectTrustDesc" },
        { path: "enableInstallTelemetry", label: "settings.rows.installTelemetry", scope: "global", type: "check", fallback: true, description: "settings.rows.installTelemetryDesc" },
        { path: "warnings.anthropicExtraUsage", label: "settings.rows.anthropicWarnings", scope: "global", type: "check", fallback: true },
        { path: "confirmDestructiveActions", label: "settings.rows.confirmDestructive", scope: "app", type: "check", description: "settings.rows.confirmDestructiveDesc" },
        { path: "openLastSessionOnStartup", label: "settings.rows.openLastSession", scope: "app", type: "check", fallback: false, description: "settings.rows.openLastSessionDesc" },
        { path: "closeToTray", label: "settings.rows.closeToTray", scope: "app", type: "check", fallback: true, description: "settings.rows.closeToTrayDesc" },
      ];
    case "appearance":
      return [
        { path: "theme", label: "settings.rows.theme", scope: "app", type: "select", options: ["system", "light", "dark"] },
        { path: "density", label: "settings.rows.density", scope: "app", type: "select", options: ["comfortable", "compact"] },
      ];
    case "models":
      return [
        { path: "defaultThinkingLevel", label: "settings.rows.defaultThinkingLevel", scope: "global", type: "select", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fallback: "medium", description: "settings.rows.defaultThinkingLevelDesc" },
        { path: "enabledModels", label: "settings.rows.enabledModels", scope: "global", fallback: [], placeholder: "openai/*, anthropic/claude-*", description: "settings.rows.enabledModelsDesc" },
      ];
    case "sessions":
      return [
        { path: "sessionDir", label: "settings.rows.sessionDir", scope: "project", fallback: ".pi/sessions" },
        { path: "compaction.enabled", label: "settings.rows.autoCompaction", scope: "global", type: "check", fallback: true },
        { path: "compaction.reserveTokens", label: "settings.rows.reserveTokens", scope: "global", type: "number", fallback: 16384 },
        { path: "compaction.keepRecentTokens", label: "settings.rows.keepRecentTokens", scope: "global", type: "number", fallback: 20000 },
        { path: "branchSummary.reserveTokens", label: "settings.rows.branchSummaryReserve", scope: "global", type: "number", fallback: 16384 },
        { path: "branchSummary.skipPrompt", label: "settings.rows.skipBranchSummary", scope: "global", type: "check", fallback: false },
      ];
    case "agent":
      return [
        { path: "steeringMode", label: "settings.rows.steeringDelivery", scope: "global", type: "select", options: ["one-at-a-time", "all"], fallback: "one-at-a-time" },
        { path: "followUpMode", label: "settings.rows.followUpDelivery", scope: "global", type: "select", options: ["one-at-a-time", "all"], fallback: "one-at-a-time" },
        { path: "transport", label: "settings.rows.transport", scope: "global", type: "select", options: ["auto", "sse", "websocket", "websocket-cached"], fallback: "auto" },
        { path: "httpIdleTimeoutMs", label: "settings.rows.httpIdleTimeout", scope: "global", type: "select", options: ["30000", "60000", "120000", "300000", "0"], fallback: 300000 },
        { path: "retry.enabled", label: "settings.rows.autoRetry", scope: "global", type: "check", fallback: true },
        { path: "retry.maxRetries", label: "settings.rows.maxRetries", scope: "global", type: "number", fallback: 3 },
        { path: "retry.baseDelayMs", label: "settings.rows.retryBaseDelay", scope: "global", type: "number", fallback: 1000 },
        { path: "retry.maxDelayMs", label: "settings.rows.retryMaxDelay", scope: "global", type: "number", fallback: 60000 },
        { path: "retry.providerRetryTimeoutMs", label: "settings.rows.providerRetryTimeout", scope: "global", type: "number", fallback: 120000 },
        { path: "retry.providerMaxRetries", label: "settings.rows.providerMaxRetries", scope: "global", type: "number", fallback: 5 },
      ];
    case "tools":
      return [
        { path: "defaultTools", label: "settings.rows.defaultTools", scope: "project", fallback: ["read", "bash", "edit", "write"] },
        { path: "images.autoResize", label: "settings.rows.resizeImages", scope: "global", type: "check", fallback: true },
        { path: "images.blockImages", label: "settings.rows.blockImages", scope: "global", type: "check", fallback: false },
        { path: "enableSkillCommands", label: "settings.rows.skillCommands", scope: "global", type: "check", fallback: true, description: "settings.rows.skillCommandsDesc" },
      ];
    case "shell":
      return [
        { path: "shellPath", label: "settings.rows.shellPath", scope: "global" },
        { path: "shellCommandPrefix", label: "settings.rows.commandPrefix", scope: "global" },
        { path: "externalEditor", label: "settings.rows.externalEditor", scope: "global", placeholder: "code --wait" },
        { path: "npmCommand", label: "settings.rows.packageCommand", scope: "global", fallback: [], placeholder: "pnpm, dlx", description: "settings.rows.packageCommandDesc" },
        { path: "httpProxy", label: "settings.rows.httpProxy", scope: "global" },
        { path: "websocketConnectTimeoutMs", label: "settings.rows.websocketTimeout", scope: "global", type: "number", fallback: 10000 },
      ];
    default:
      return [];
  }
});

const providerFilters = computed(() => [
  { id: "all", count: providers.value.length },
  { id: "configured", count: providers.value.filter((provider) => provider.status).length },
  { id: "other", count: providers.value.filter((provider) => !provider.status).length },
] as const);
const filteredProviders = computed(() => {
  const query = modelQuery.value.trim().toLowerCase();
  return providers.value.filter((provider) => providerFilter.value === "all" || (providerFilter.value === "configured" ? !!provider.status : !provider.status)).filter((provider) =>
    !query ||
    `${provider.name} ${provider.id}`.toLowerCase().includes(query) ||
    models.value.some((model) =>
      model.provider === provider.id &&
      `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query),
    )
  );
});
const providerSections = computed(() => [
  {
    id: "configured",
    label: t("settings.configuredProviders"),
    providers: filteredProviders.value.filter((provider) => provider.status),
  },
  {
    id: "other",
    label: t("settings.otherProviders"),
    providers: filteredProviders.value.filter((provider) => !provider.status),
  },
].filter((section) => section.providers.length));
const defaultModel = computed(() => draft.value?.effective.defaultProvider && draft.value.effective.defaultModel
  ? `${draft.value.effective.defaultProvider}\0${draft.value.effective.defaultModel}`
  : "");
const currentModel = computed(() => session.current?.runtime.model
  ? `${session.current.runtime.model.provider}\0${session.current.runtime.model.id}`
  : "");
const selectedRuntimeModel = computed(() =>
  models.value.find((model) => modelKey(model) === selectedModel.value),
);
const selectedThinkingLevels = computed(() =>
  selectedRuntimeModel.value?.reasoning === false
    ? ["off"]
    : ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
);
const filteredSkills = computed(() => {
  const query = skillQuery.value.trim().toLowerCase();
  return skills.value
    .filter((skill) => !query || `${skill.name} ${skill.description} ${skill.path} ${skill.source}`.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
});
const skillSections = computed(() => (["project", "user", "temporary"] as const)
  .map((scope) => ({
    scope,
    label: t(`settings.skillScopes.${scope}`),
    skills: filteredSkills.value.filter((skill) => skill.scope === scope),
  }))
  .filter((section) => section.skills.length));
const filteredExtensions = computed(() => {
  const query = extensionQuery.value.trim().toLowerCase();
  return extensions.value
    .filter((extension) => extensionScope.value === "all" || extension.scope === extensionScope.value)
    .filter((extension) => !query || [
      extensionName(extension.path),
      extension.path,
      extension.source,
      ...extension.tools.flatMap((tool) => [tool.name, tool.label, tool.description]),
      ...extension.commands.flatMap((command) => [command.name, command.description]),
    ].join(" ").toLowerCase().includes(query))
    .sort((a, b) => extensionName(a.path).localeCompare(extensionName(b.path)));
});
const extensionFilters = computed(() => (["all", "project", "user", "temporary"] as const)
  .map((scope) => ({ scope, count: extensions.value.filter((extension) => scope === "all" || extension.scope === scope).length })));
const extensionTotals = computed(() => ({
  tools: extensions.value.reduce((total, extension) => total + extension.tools.length, 0),
  commands: extensions.value.reduce((total, extension) => total + extension.commands.length, 0),
}));

function extensionName(path: string) {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0)
    return parts[modules + 1]?.startsWith("@")
      ? `${parts[modules + 1]}/${parts[modules + 2]}`
      : parts[modules + 1] ?? path;
  const name = (parts.pop() ?? path).replace(/\.[^.]+$/, "");
  return name === "index" ? parts.pop() ?? name : name;
}

function modelKey(model: RuntimeModel) {
  return `${model.provider}\0${model.id}`;
}

function providerModels(provider: RuntimeProvider) {
  const query = modelQuery.value.trim().toLowerCase();
  const providerMatches = `${provider.name} ${provider.id}`.toLowerCase().includes(query);
  return models.value
    .filter((model) =>
      model.provider === provider.id &&
      (!query || providerMatches || `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query)),
    )
    .sort((a, b) =>
      Number(modelKey(b) === currentModel.value) - Number(modelKey(a) === currentModel.value) ||
      Number(modelKey(b) === defaultModel.value) - Number(modelKey(a) === defaultModel.value) ||
      a.id.localeCompare(b.id),
    );
}

function toggleProvider(provider: RuntimeProvider) {
  editingProvider.value = "";
  if (expandedProvider.value === provider.id) {
    expandedProvider.value = "";
    return;
  }
  expandedProvider.value = provider.id;
  const available = providerModels(provider);
  if (!available.some((model) => modelKey(model) === selectedModel.value))
    selectedModel.value = modelKey(available[0] ?? { provider: "", id: "" });
}

function toggleProviderSetup(provider: RuntimeProvider) {
  expandedProvider.value = "";
  editingProvider.value = editingProvider.value === provider.id ? "" : provider.id;
}

// Keeps the settings selection pointing at a real model after the catalog
// changes (login can add models, logout can remove the selected one); a valid
// pick always wins so reloading never stomps an explicit choice.
function normalizeSelectedModel() {
  if (selectedModel.value && models.value.some((model) => modelKey(model) === selectedModel.value)) return;
  const preferred = currentModel.value || defaultModel.value;
  selectedModel.value = models.value.some((model) => modelKey(model) === preferred)
    ? preferred
    : modelKey(models.value[0] ?? { provider: "", id: "" });
}

// Reloads the catalog pair shown here and, through the store, everywhere else
// (graph draft picker, branch-context composer). Used after any action that can
// change which models are available.
async function loadRuntimeCatalog() {
  const [, providerList] = await Promise.all([
    session.loadModels(),
    session.control<RuntimeProvider[]>({ action: "getProviders" }),
  ]);
  providers.value = providerList;
  normalizeSelectedModel();
}

async function loadRuntime(refresh = false) {
  if (layout.settingsCategory !== "models" || runtimeBusy.value) return;
  runtimeBusy.value = true;
  runtimeError.value = "";
  try {
    if (refresh) await session.control({ action: "refreshModels" });
    await loadRuntimeCatalog();
    if (refresh) layout.showNotice(t("settings.modelCatalogRefreshed"));
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    runtimeBusy.value = false;
  }
}

async function loadSkills(reload = false) {
  if (layout.settingsCategory !== "skills" || skillBusy.value) return;
  skillBusy.value = true;
  skillError.value = "";
  try {
    skills.value = await session.control<RuntimeSkill[]>({ action: "getSkills", reload });
  } catch (error) {
    skillError.value = error instanceof Error ? error.message : String(error);
  } finally {
    skillBusy.value = false;
  }
}

async function loadExtensions(reload = false) {
  if (layout.settingsCategory !== "extensions" || extensionBusy.value) return;
  extensionBusy.value = true;
  extensionError.value = "";
  try {
    extensions.value = await session.control<RuntimeExtension[]>({ action: "getExtensions", reload });
  } catch (error) {
    extensionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    extensionBusy.value = false;
  }
}

watch(
  [() => layout.settingsCategory, () => session.current?.session.id],
  () => {
    void loadRuntime();
    void loadSkills();
    void loadExtensions();
  },
  { immediate: true },
);

function rootFor(row: Row): Record<string, unknown> | undefined {
  if (!draft.value) return undefined;
  return (row.scope === "app"
    ? draft.value.app
    : row.scope === "global"
      ? draft.value.piGlobal
      : draft.value.piProject) as unknown as Record<string, unknown>;
}

function value(row: Row): unknown {
  let current: unknown = rootFor(row);
  for (const key of row.path.split("."))
    current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  current ??= row.fallback ?? "";
  return Array.isArray(current) ? current.join(", ") : current;
}

function setValue(row: Row, event: Event) {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  let next: unknown = target instanceof HTMLInputElement && target.type === "checkbox"
    ? target.checked
    : target instanceof HTMLInputElement && target.type === "number"
      ? Number(target.value)
      : target.value;
  if (row.type === "select" && typeof row.fallback === "number") next = Number(next);
  if (["enabledModels", "defaultTools", "npmCommand"].includes(row.path))
    next = String(next).split(",").map((item) => item.trim()).filter(Boolean);
  const parts = row.path.split(".");
  let current = rootFor(row);
  if (!current) return;
  parts.forEach((key, index) => {
    if (index === parts.length - 1) current![key] = next;
    else {
      if (!current![key] || typeof current![key] !== "object") current![key] = {};
      current = current![key] as Record<string, unknown>;
    }
  });
  if (row.scope === "app" && row.path === "theme")
    document.documentElement.dataset.theme = String(next);
  if (row.scope === "app" && row.path === "density")
    document.documentElement.dataset.density = String(next);
}

function modelSettingsKey(model: RuntimeModel) {
  return `${model.provider}/${model.id}`;
}

function cyclingEnabled(model: RuntimeModel) {
  const patterns = draft.value?.piGlobal.enabledModels;
  if (patterns === undefined) return true;
  const id = modelSettingsKey(model);
  return patterns.some((pattern) => {
    const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${source}$`).test(id);
  });
}

function toggleCycling(model: RuntimeModel) {
  if (!draft.value) return;
  const enabled = models.value.filter(cyclingEnabled).map(modelSettingsKey);
  const id = modelSettingsKey(model);
  const next = cyclingEnabled(model)
    ? enabled.filter((item) => item !== id)
    : [...new Set([...enabled, id])];
  draft.value.piGlobal.enabledModels = next.length === models.value.length ? undefined : next;
}

function setAllCycling(enabled: boolean) {
  if (!draft.value) return;
  draft.value.piGlobal.enabledModels = enabled ? undefined : [];
}

function modelThinkingOverride() {
  const model = selectedRuntimeModel.value;
  if (!model) return "";
  return draft.value?.piGlobal.modelThinkingLevels?.[modelSettingsKey(model)] ?? "";
}

function setModelThinkingOverride(event: Event) {
  if (!draft.value || !selectedRuntimeModel.value) return;
  const key = modelSettingsKey(selectedRuntimeModel.value);
  const level = (event.target as HTMLSelectElement).value;
  const overrides = draft.value.piGlobal.modelThinkingLevels ??= {};
  if (level) overrides[key] = level;
  else delete overrides[key];
}

async function save() {
  if (!draft.value || saving.value) return;
  saving.value = true;
  try {
    const scopes = new Set(rows.value.map((row) => row.scope));
    let settings = layout.settings!;
    for (const scope of scopes) {
      // The draft is a deeply reactive proxy graph; Electron's IPC serializer
      // rejects proxies, so clone down to plain values before crossing it.
      // The draft is a deeply reactive proxy graph; Electron's IPC serializer
      // rejects proxies, so clone down to plain values before crossing it.
      const patch = structuredClone(toRaw(
        scope === "app" ? draft.value.app : scope === "global" ? draft.value.piGlobal : draft.value.piProject,
      ));
      settings = await desktop.invoke<SettingsBundle>("settings.update", { scope, patch, replace: true });
    }
    layout.hydrate(settings, layout.layout);
    locale.value = settings.app.language === "system"
      ? navigator.language === "zh-CN" ? "zh-CN" : "en"
      : settings.app.language;
    if (
      session.current &&
      [...scopes].some((scope) => scope !== "app") &&
      !session.current.runtime.isStreaming &&
      !session.current.runtime.isCompacting
    ) {
      await session.control({ action: "reload" });
    }
    layout.showNotice(t("settings.saved"));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    saving.value = false;
  }
}

// Model changes belong to draft input only; settings just record the default
// used by new sessions.
async function applyModel() {
  const model = models.value.find((item) => modelKey(item) === selectedModel.value);
  if (!model) return;
  try {
    const settings = await desktop.invoke<SettingsBundle>("settings.update", {
      scope: "global",
      patch: { defaultProvider: model.provider, defaultModel: model.id },
    });
    layout.hydrate(settings, layout.layout);
    layout.showNotice(t("settings.defaultModelSet", { model: `${model.provider}/${model.id}` }));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

async function saveApiKey(provider: RuntimeProvider) {
  const apiKey = keyDrafts[provider.id]?.trim();
  if (!apiKey) return;
  providerBusy.value = provider.id;
  try {
    await session.control({ action: "loginApiKey", provider: provider.id, apiKey });
    keyDrafts[provider.id] = "";
    editingProvider.value = "";
    await loadRuntimeCatalog();
    layout.showNotice(t("settings.apiKeySaved", { name: provider.name }));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    providerBusy.value = "";
  }
}

async function loginOAuth(provider: RuntimeProvider, method: "browser" | "device-code") {
  providerBusy.value = provider.id;
  try {
    await session.control({ action: "loginOAuth", provider: provider.id, method });
    await loadRuntimeCatalog();
    if (!providers.value.find((item) => item.id === provider.id)?.status)
      throw new Error(`${provider.name} login did not produce a usable credential.`);
    editingProvider.value = "";
    layout.showNotice(t("settings.signedIn", { name: provider.name }));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    providerBusy.value = "";
  }
}

async function logout(provider: RuntimeProvider) {
  providerBusy.value = provider.id;
  try {
    await session.control({ action: "logout", provider: provider.id });
    editingProvider.value = "";
    await loadRuntimeCatalog();
    layout.showNotice(t("settings.credentialsRemoved", { name: provider.name }));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    providerBusy.value = "";
  }
}

</script>

<template>
  <div class="settings-page" v-if="draft">
    <aside>
      <Button variant="ghost" class="justify-start" @click="layout.screen = 'workbench'">
        <ArrowLeft :size="16" />{{ t("settings.back") }}
      </Button>
      <nav>
        <button
          v-for="category in categories"
          :key="category[0]"
          type="button"
          :data-settings-category="category[0]"
          :class="{ active: layout.settingsCategory === category[0] }"
          @click="layout.settingsCategory = category[0]"
        >
          <component :is="category[2]" :size="17" aria-hidden="true" />
          {{ category[1] }}
        </button>
      </nav>
      <footer><strong>{{ workspace.project?.name }}</strong><small>{{ workspace.project?.path }}</small></footer>
    </aside>

    <main>
      <header>
        <div>
          <small>{{ t("settings.preferences") }}</small>
          <h1>{{ categories.find((item) => item[0] === layout.settingsCategory)?.[1] }}</h1>
          <p v-if="layout.settingsCategory === 'models'">{{ t("settings.modelsDescription") }}</p>
          <p v-else-if="layout.settingsCategory === 'skills'">{{ t("settings.skillsDescription", { n: skills.length }) }}</p>
          <p v-else-if="layout.settingsCategory === 'extensions'">{{ t("settings.extensionsDescription", { n: extensions.length }) }}</p>
        </div>
        <nav v-if="!['models', 'skills', 'extensions'].includes(layout.settingsCategory)">
          <Button :disabled="saving" @click="save"><Save :size="15" />{{ saving ? t("settings.saving") : t("settings.saveChanges") }}</Button>
        </nav>
      </header>

      <div v-if="layout.settingsCategory === 'models'" class="model-workspace">
        <section class="model-overview" :aria-label="t('settings.modelOverview')">
          <div class="model-default-summary">
            <span class="model-overview-icon"><Box :size="25" aria-hidden="true" /></span>
            <div>
              <span class="model-eyebrow">{{ t("settings.defaultModelLabel") }}</span>
              <h2 data-default-model>{{ draft.effective.defaultModel || t("settings.noDefaultModel") }}</h2>
              <span v-if="draft.effective.defaultProvider" class="model-summary-provider">{{ draft.effective.defaultProvider }}</span>
              <p>{{ t("settings.defaultModelHint") }}</p>
            </div>
          </div>
          <div class="model-session-summary">
            <span class="model-eyebrow"><Bot :size="14" />{{ t("settings.sessionModelLabel") }}</span>
            <strong>{{ session.current?.runtime.model?.id || t("settings.noSessionModel") }}</strong>
            <span v-if="session.current?.runtime.model" class="model-summary-provider">{{ session.current.runtime.model.provider }}</span>
            <p>{{ t("settings.sessionModelHint") }}</p>
          </div>
          <div class="model-overview-footer">
            <span><Check :size="14" />{{ t("settings.connectedProviderCount", { n: providerFilters[1].count }) }}</span>
            <span><Box :size="14" />{{ t("settings.availableModelCount", { n: models.length }) }}</span>
            <a href="#model-preferences"><SlidersHorizontal :size="13" />{{ t("settings.modelPreferences") }}<ChevronDown :size="13" /></a>
          </div>
        </section>
        <section class="provider-card model-card" :aria-busy="runtimeBusy">
          <div class="settings-toolbar model-toolbar">
            <label class="settings-search">
              <Search :size="16" aria-hidden="true" />
              <input v-model="modelQuery" data-model-search :aria-label="t('settings.searchModels')" :placeholder="t('settings.searchModels')" />
              <button v-if="modelQuery" type="button" class="model-search-clear" :aria-label="t('settings.modelClearSearch')" @click="modelQuery = ''"><X :size="14" /></button>
            </label>
            <Button variant="outline" :disabled="runtimeBusy || !!providerBusy" data-model-refresh :title="t('settings.refreshModelsHint')" @click="loadRuntime(true)"><RefreshCw :size="15" :class="{ spin: runtimeBusy }" />{{ t(runtimeBusy ? "settings.refreshingModels" : "settings.refreshModels") }}</Button>
          </div>
          <div class="model-filter-bar">
            <div class="model-filters" role="group" :aria-label="t('settings.providerFilterLabel')">
              <button v-for="filter in providerFilters" :key="filter.id" type="button" :data-provider-filter="filter.id" :aria-pressed="providerFilter === filter.id" @click="providerFilter = filter.id">{{ t(`settings.providerFilters.${filter.id}`) }}<span>{{ filter.count }}</span></button>
            </div>
            <span class="model-result-count" role="status">{{ t("settings.providerResults", { n: filteredProviders.length }) }}</span>
          </div>
          <div v-if="runtimeError" class="model-feedback" role="alert"><CircleAlert :size="18" /><div><strong>{{ t("settings.modelLoadError") }}</strong><p>{{ runtimeError }}</p></div></div>
          <div v-if="runtimeBusy && !providers.length" class="model-empty" role="status"><RefreshCw :size="26" class="spin" /><strong>{{ t("settings.loadingProviders") }}</strong></div>
          <div v-else-if="!filteredProviders.length && !runtimeError" class="model-empty">
            <Search :size="28" /><strong>{{ t("settings.noMatchingModels") }}</strong><p>{{ t("settings.modelSearchHint") }}</p>
            <Button v-if="modelQuery || providerFilter !== 'all'" variant="outline" @click="modelQuery = ''; providerFilter = 'all'">{{ t("settings.modelResetFilters") }}</Button>
          </div>
          <template v-else-if="filteredProviders.length">
          <template v-for="section in providerSections" :key="section.id">
          <header class="provider-section-title" :data-provider-section="section.id">
            <div><h2>{{ section.label }}<span>{{ section.providers.length }}</span></h2><p>{{ t(`settings.providerSectionHints.${section.id}`) }}</p></div>
          </header>
          <div class="provider-section-grid" :data-provider-section-grid="section.id">
          <section v-for="provider in section.providers" :key="provider.id" class="provider-group" :class="{ configured: !!provider.status, expanded: expandedProvider === provider.id || editingProvider === provider.id }" :data-provider="provider.id">
            <div class="provider-row">
              <div class="provider-identity">
                <span class="provider-icon" aria-hidden="true">{{ provider.name.slice(0, 1).toUpperCase() }}</span>
                <span class="provider-name">
                  <strong>{{ provider.name }}</strong>
                  <small>{{ provider.id }}</small>
                </span>
              </div>
              <div v-if="provider.status" class="provider-status configured" :title="provider.status.source">
                <Check :size="13" />{{ t("settings.connected") }}
              </div>
              <div v-else class="provider-status">{{ t("settings.notConfigured") }}</div>
            </div>
            <div class="provider-card-footer">
              <span class="provider-auth-type"><KeyRound :size="13" />{{ provider.authTypes.map(type => t(`settings.providerAuthTypes.${type}`)).join(' / ') || t('settings.providerAuthTypes.custom') }}</span>
              <div class="provider-actions">
                <button v-if="providerModels(provider).length" type="button" class="provider-model-toggle" :aria-expanded="expandedProvider === provider.id" @click="toggleProvider(provider)">
                  {{ t(providerModels(provider).length === 1 ? "settings.oneModel" : "settings.models", { n: providerModels(provider).length }) }}
                  <ChevronDown :size="14" :class="{ open: expandedProvider === provider.id }" />
                </button>
                <Button variant="outline" size="sm" :data-provider-configure="provider.id" :aria-expanded="editingProvider === provider.id" @click="toggleProviderSetup(provider)">
                  {{ t(editingProvider === provider.id ? "settings.closeProviderSetup" : provider.status ? "settings.manageProvider" : "settings.configureProvider") }}
                </Button>
              </div>
            </div>

            <div v-if="editingProvider === provider.id" class="provider-setup" :data-provider-setup="provider.id">
              <div class="provider-setup-heading"><strong>{{ t("settings.providerSetupTitle", { name: provider.name }) }}</strong><small>{{ t(provider.authTypes.includes('api_key') ? 'settings.providerKeyHint' : 'settings.providerLoginHint') }}</small></div>
              <form v-if="provider.authTypes.includes('api_key')" class="provider-auth" @submit.prevent="saveApiKey(provider)">
                <label>
                  <KeyRound :size="14" />
                  <input v-model="keyDrafts[provider.id]" type="password" autocomplete="off" :aria-label="t('settings.providerApiKeyLabel', { name: provider.name })" :data-provider-api-key="provider.id" :placeholder="provider.status?.type === 'api_key' ? t('settings.replaceApiKey') : t('settings.enterApiKey')" />
                </label>
                <Button size="sm" class="model-primary-button" :disabled="providerBusy === provider.id || !keyDrafts[provider.id]?.trim()">{{ t("settings.saveKey") }}</Button>
              </form>
              <div v-else-if="provider.authTypes.includes('oauth')" class="provider-auth">
                <Button variant="outline" size="sm" :data-provider-oauth="provider.id" data-oauth-method="browser" :disabled="providerBusy === provider.id" @click="loginOAuth(provider, 'browser')">
                  {{ providerBusy === provider.id ? t("settings.waitingSignIn") : t("settings.browser") }}
                </Button>
                <Button variant="outline" size="sm" :data-provider-oauth="provider.id" data-oauth-method="device-code" :disabled="providerBusy === provider.id" @click="loginOAuth(provider, 'device-code')">
                  {{ t("settings.deviceCode") }}
                </Button>
              </div>
              <small v-else class="provider-auth-note">{{ t("settings.providerSetupNote") }}</small>
              <Button v-if="provider.status" variant="ghost" size="sm" class="provider-remove" :disabled="providerBusy === provider.id" @click="logout(provider)">{{ t("settings.removeProviderCredentials") }}</Button>
            </div>

            <div v-if="expandedProvider === provider.id" class="provider-model-list" :data-provider-models="provider.id">
              <div class="provider-model-heading"><strong>{{ t("settings.chooseModel") }}</strong><span>{{ t("settings.chooseModelHint") }}</span></div>
              <p v-if="!providerModels(provider).length" class="settings-empty">{{ t("settings.noModels") }}</p>
              <article v-for="model in providerModels(provider)" :key="modelKey(model)" class="model-row" :class="{ selected: selectedModel === modelKey(model) }" :data-model="`${model.provider}/${model.id}`">
                <button type="button" class="model-select" :aria-pressed="selectedModel === modelKey(model)" @click="selectedModel = modelKey(model)">
                  <span class="model-selection-mark" aria-hidden="true"><Check v-if="selectedModel === modelKey(model)" :size="12" /></span>
                  <span><strong>{{ model.id }}</strong><small>{{ model.name || model.provider }}</small><span v-if="model.contextWindow || model.reasoning" class="model-specs"><span v-if="model.contextWindow">{{ t("settings.modelContext", { n: model.contextWindow.toLocaleString(locale) }) }}</span><span v-if="model.reasoning"><Sparkles :size="11" />{{ t("settings.modelReasoning") }}</span></span></span>
                </button>
                <span class="model-meta">
                  <em v-if="currentModel === modelKey(model)" class="active">{{ t("settings.badgeCurrent") }}</em>
                  <em v-if="defaultModel === modelKey(model)" class="default">{{ t("settings.badgeDefault") }}</em>
                  <em v-if="draft.piGlobal.modelThinkingLevels?.[modelSettingsKey(model)]" class="default">{{ t("settings.badgeThinking") }}</em>
                  <label class="model-cycle" :title="t('settings.cycleTitle')"><input type="checkbox" :checked="cyclingEnabled(model)" @change="toggleCycling(model)" />{{ t("settings.cycle") }}</label>
                </span>
              </article>
              <footer class="model-actions">
                <span><small>{{ t("settings.selectedModelLabel") }}</small><strong>{{ selectedRuntimeModel?.id || '—' }}</strong></span>
                <Button class="model-primary-button" data-model-action="default" :disabled="!selectedModel || selectedModel === defaultModel" @click="applyModel">{{ t(selectedModel === defaultModel ? "settings.alreadyDefault" : "settings.setDefault") }}</Button>
              </footer>
            </div>
          </section>
          </div>
          </template>
          </template>
          <details class="credential-note">
            <summary><KeyRound :size="14" />{{ t("settings.credentialStorage") }}<ChevronDown :size="13" /></summary>
            <span>{{ t("settings.apiKeysNotePrefix") }}<code>~/.pi/agent/auth.json</code>{{ t("settings.apiKeysNoteSuffix") }}</span>
          </details>
        </section>
        <section id="model-preferences" class="settings-card model-options">
          <header class="model-options-header">
            <span class="model-preferences-title"><SlidersHorizontal :size="19" /><span><strong>{{ t("settings.modelPreferences") }}</strong><small>{{ t("settings.modelPreferencesHint") }}</small></span></span>
            <Button class="model-primary-button" :disabled="saving" @click="save"><Save :size="15" />{{ saving ? t("settings.saving") : t("settings.savePreferences") }}</Button>
          </header>
          <label v-if="selectedRuntimeModel" class="setting-row" data-setting-path="modelThinkingLevels">
            <span>
              <strong>{{ t("settings.thinkingFor", { id: selectedRuntimeModel.id }) }}</strong>
              <small>{{ t("settings.thinkingOverrideHint") }}</small>
            </span>
            <select :value="modelThinkingOverride()" @change="setModelThinkingOverride">
              <option value="">{{ t("settings.inheritDefault") }}</option>
              <option v-for="level in selectedThinkingLevels" :key="level" :value="level">{{ optionLabel(level) }}</option>
            </select>
          </label>
          <label v-for="row in rows" :key="`${row.scope}:${row.path}`" class="setting-row" :data-setting-path="row.path">
            <span><strong>{{ t(row.label) }}</strong><small>{{ rowHint(row) }}</small></span>
            <input v-if="row.type === 'check'" class="switch" type="checkbox" :checked="Boolean(value(row))" @change="setValue(row, $event)" />
            <select v-if="row.type === 'select'" :value="String(value(row))" @change="setValue(row, $event)">
              <option v-for="option in row.options" :key="option" :value="option">{{ optionLabel(option) }}</option>
            </select>
            <input v-else-if="row.type !== 'check'" :type="row.type ?? 'text'" :value="String(value(row))" :placeholder="row.placeholder" :min="row.min" :max="row.max" @input="setValue(row, $event)" />
          </label>
          <footer class="model-cycle-actions"><span>{{ t("settings.cyclePreferencesHint") }}</span><Button variant="ghost" size="sm" @click="setAllCycling(true)">{{ t("settings.cycleAll") }}</Button><Button variant="ghost" size="sm" @click="setAllCycling(false)">{{ t("settings.clearCycle") }}</Button></footer>
        </section>
      </div>
      <section v-else-if="layout.settingsCategory === 'skills'" class="settings-card skill-card">
        <div class="settings-toolbar">
          <label class="settings-search">
            <Search :size="15" />
            <input v-model="skillQuery" data-skill-search :placeholder="t('settings.searchSkills')" />
          </label>
          <Button variant="outline" size="icon" :title="t('settings.refreshSkills')" :disabled="skillBusy" @click="loadSkills(true)">
            <RefreshCw :size="15" :class="{ spin: skillBusy }" />
          </Button>
        </div>
        <p v-if="skillError" class="settings-error">{{ skillError }}</p>
        <p v-else-if="skillBusy && !skills.length" class="settings-empty">{{ t("settings.loadingSkills") }}</p>
        <p v-else-if="!skills.length" class="settings-empty">{{ t("settings.noSkills") }}</p>
        <p v-else-if="!filteredSkills.length" class="settings-empty">{{ t("settings.noMatchingSkills") }}</p>
        <template v-else>
          <section v-for="section in skillSections" :key="section.scope" class="resource-section">
            <header class="provider-section-title">
              <strong>{{ section.label }}</strong><span>{{ section.skills.length }}</span>
            </header>
            <div class="resource-list">
              <article v-for="skill in section.skills" :key="skill.path" class="resource-row" :data-skill="skill.name" :title="skill.path">
                <span class="resource-icon"><Sparkles :size="17" /></span>
                <span class="resource-info">
                  <strong>{{ skill.name }}</strong>
                  <small>{{ skill.description }}</small>
                </span>
                <span class="resource-badges">
                  <em>{{ skill.source }}</em>
                  <em v-if="skill.disableModelInvocation">{{ t("settings.manualSkill") }}</em>
                </span>
              </article>
            </div>
          </section>
        </template>
      </section>
      <section v-else-if="layout.settingsCategory === 'extensions'" class="extension-card" :aria-busy="extensionBusy">
        <div class="extension-overview">
          <div class="extension-intro">
            <span class="extension-intro-icon"><Puzzle :size="25" aria-hidden="true" /></span>
            <div><h2>{{ t("settings.extensionLibrary") }}</h2><p>{{ t("settings.extensionLibraryHint") }}</p></div>
          </div>
          <dl class="extension-stats">
            <div><dt><Puzzle :size="14" />{{ t("settings.extensionDetected") }}</dt><dd>{{ extensionBusy && !extensions.length ? '—' : extensions.length }}</dd></div>
            <div><dt><Wrench :size="14" />{{ t("settings.extensionToolLabel") }}</dt><dd>{{ extensionBusy && !extensions.length ? '—' : extensionTotals.tools }}</dd></div>
            <div><dt><Terminal :size="14" />{{ t("settings.extensionCommandLabel") }}</dt><dd>{{ extensionBusy && !extensions.length ? '—' : extensionTotals.commands }}</dd></div>
          </dl>
        </div>
        <div class="extension-controls">
          <div class="settings-toolbar">
            <label class="settings-search">
              <Search :size="16" aria-hidden="true" />
              <input v-model="extensionQuery" data-extension-search :aria-label="t('settings.searchExtensions')" :placeholder="t('settings.searchExtensions')" />
              <button v-if="extensionQuery" type="button" :aria-label="t('settings.extensionClearSearch')" @click="extensionQuery = ''"><X :size="14" /></button>
            </label>
            <Button variant="outline" :title="t('settings.refreshExtensions')" :disabled="extensionBusy" @click="loadExtensions(true)">
              <RefreshCw :size="15" :class="{ spin: extensionBusy }" aria-hidden="true" />{{ t(extensionBusy ? "settings.extensionRefreshing" : "settings.refreshExtensions") }}
            </Button>
          </div>
          <div class="extension-filter-bar">
            <div class="extension-filters" role="group" :aria-label="t('settings.extensionFilterLabel')">
              <button v-for="filter in extensionFilters" :key="filter.scope" type="button" :data-extension-scope="filter.scope" :aria-pressed="extensionScope === filter.scope" @click="extensionScope = filter.scope">
                {{ t(`settings.extensionFilters.${filter.scope}`) }}<span>{{ filter.count }}</span>
              </button>
            </div>
            <span class="extension-result-count" role="status">{{ t("settings.extensionResults", { n: filteredExtensions.length }) }}</span>
          </div>
        </div>
        <div v-if="extensionError" class="extension-feedback extension-error" role="alert"><CircleAlert :size="19" /><div><strong>{{ t("settings.extensionLoadError") }}</strong><p>{{ extensionError }}</p></div></div>
        <div v-if="extensionBusy && !extensions.length" class="extension-empty" role="status"><RefreshCw :size="26" class="spin" /><h3>{{ t("settings.loadingExtensions") }}</h3></div>
        <div v-else-if="!extensions.length && !extensionError" class="extension-empty">
          <span class="extension-empty-icon"><Puzzle :size="28" /></span><h3>{{ t("settings.noExtensions") }}</h3><p>{{ t("settings.extensionEmptyHint") }}</p>
        </div>
        <div v-else-if="extensions.length && !filteredExtensions.length" class="extension-empty">
          <span class="extension-empty-icon"><Search :size="26" /></span><h3>{{ t("settings.noMatchingExtensions") }}</h3><p>{{ t("settings.extensionSearchHint") }}</p>
          <Button variant="outline" @click="extensionQuery = ''; extensionScope = 'all'">{{ t("settings.extensionResetFilters") }}</Button>
        </div>
        <div v-else-if="filteredExtensions.length" class="extension-grid">
          <article v-for="extension in filteredExtensions" :key="extension.resolvedPath" class="extension-item" :data-extension="extensionName(extension.path)" :data-scope="extension.scope">
            <header class="extension-item-header">
              <span class="extension-item-icon"><Puzzle :size="22" aria-hidden="true" /></span>
              <div class="extension-identity"><h3 :title="extensionName(extension.path)">{{ extensionName(extension.path) }}</h3><span>{{ extension.source }}</span></div>
              <span class="extension-scope-badge">{{ t(`settings.extensionFilters.${extension.scope}`) }}</span>
            </header>
            <div class="extension-item-body">
              <p class="extension-summary">{{ extension.tools.find(tool => tool.description)?.description || extension.commands.find(command => command.description)?.description || t("settings.extensionNoDescription") }}</p>
              <div class="extension-metrics"><span><Wrench :size="13" />{{ t("settings.extensionTools", { n: extension.tools.length }) }}</span><span><Terminal :size="13" />{{ t("settings.extensionCommands", { n: extension.commands.length }) }}</span></div>
            </div>
            <details class="extension-details">
              <summary>{{ t("settings.extensionDetails") }}<ChevronDown :size="15" /></summary>
              <div class="extension-detail-body">
                <div class="extension-path"><strong><Folder :size="13" />{{ t("settings.extensionLocation") }}</strong><code>{{ extension.resolvedPath }}</code></div>
                <div v-if="extension.tools.length || extension.commands.length" class="extension-capabilities">
                  <section v-if="extension.tools.length"><strong>{{ t("settings.extensionTools", { n: extension.tools.length }) }}</strong><div v-for="tool in extension.tools" :key="tool.name" class="extension-capability"><code>{{ tool.name }}</code><p v-if="tool.description">{{ tool.description }}</p></div></section>
                  <section v-if="extension.commands.length"><strong>{{ t("settings.extensionCommands", { n: extension.commands.length }) }}</strong><div v-for="command in extension.commands" :key="command.name" class="extension-capability"><code>/{{ command.name }}</code><p v-if="command.description">{{ command.description }}</p></div></section>
                </div>
                <p v-else class="extension-no-capabilities">{{ t("settings.extensionNoCapabilities") }}</p>
              </div>
            </details>
          </article>
        </div>
        <p class="extension-footnote"><Folder :size="14" aria-hidden="true" />{{ t("settings.extensionDiscoveryNote") }}</p>
      </section>
      <section v-else class="settings-card">
        <label v-for="row in rows" :key="`${row.scope}:${row.path}`" class="setting-row" :data-setting-path="row.path">
          <span><strong>{{ t(row.label) }}</strong><small>{{ rowHint(row) }}</small></span>
          <input
            v-if="row.type === 'check'"
            class="switch"
            type="checkbox"
            :checked="Boolean(value(row))"
            @change="setValue(row, $event)"
          />
          <select v-else-if="row.type === 'select'" :value="String(value(row))" @change="setValue(row, $event)">
            <option v-for="option in row.options" :key="option" :value="option">{{ optionLabel(option) }}</option>
          </select>
          <input v-else :type="row.type ?? 'text'" :value="String(value(row))" :placeholder="row.placeholder" :min="row.min" :max="row.max" @input="setValue(row, $event)" />
        </label>
      </section>
    </main>
  </div>
</template>
