import { computed, reactive, ref } from "vue";
import type { Ref } from "vue";
import { useI18n } from "vue-i18n";
import type { CustomModelInput, RuntimeModel, RuntimeProvider, SettingsBundle } from "../../../shared/types";
import { desktop } from "../../api";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import type { InspectorFocus } from "./inspector-focus";
import type { Scope } from "./use-settings-draft";

export function useModels(
  draft: Ref<SettingsBundle | undefined>,
  focus: InspectorFocus,
  closeDetailsPanel: () => void,
  save: (scope: Scope) => void,
) {
  const layout = useLayoutStore();
  const session = useSessionStore();
  const { t } = useI18n();

  // The model catalog lives in the session store so every consumer (settings,
  // graph, branch context) reads one list; this page only reloads it.
  const models = computed(() => session.models);
  const runtimeProviders = ref<RuntimeProvider[]>([]);
  const modelQuery = ref("");
  const addingCustomModel = ref(false);
  const customModels = ref<CustomModelInput[]>([]);
  const editingCustomModel = ref<CustomModelInput>();
  const providers = computed<RuntimeProvider[]>(() => [
    ...runtimeProviders.value,
    ...[...new Set(customModels.value.map((model) => model.provider))]
      .filter((id) => !runtimeProviders.value.some((provider) => provider.id === id))
      .map((id) => ({ id, name: id, authTypes: ["api_key" as const] })),
  ]);
  const providerFilter = ref<"all" | "configured" | "other">("all");
  const selectedModel = ref("");
  const expandedProvider = ref("");
  const editingProvider = ref("");
  const selectedProvider = computed(() => providers.value.find((provider) => provider.id === (editingProvider.value || expandedProvider.value)));
  const keyDrafts = reactive<Record<string, string>>({});
  const runtimeBusy = ref(false);
  const providerBusy = ref("");
  const runtimeError = ref("");

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
      ) || customModels.value.some((model) => model.provider === provider.id && `${model.modelId} ${model.name ?? ""}`.toLowerCase().includes(query))
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

  function toggleProvider(provider: RuntimeProvider, event: MouseEvent) {
    editingProvider.value = "";
    if (expandedProvider.value === provider.id) {
      closeDetailsPanel();
      return;
    }
    expandedProvider.value = provider.id;
    const available = providerModels(provider);
    if (!available.some((model) => modelKey(model) === selectedModel.value))
      selectedModel.value = modelKey(available[0] ?? { provider: "", id: "" });
    void focus.open(event);
  }

  function toggleProviderSetup(provider: RuntimeProvider, event: MouseEvent) {
    expandedProvider.value = "";
    editingProvider.value = editingProvider.value === provider.id ? "" : provider.id;
    if (editingProvider.value) void focus.open(event);
    else closeDetailsPanel();
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
    const [customResult, modelResult, providerResult] = await Promise.allSettled([
      session.control<CustomModelInput[]>({ action: "getCustomModels" }),
      session.loadModels(),
      session.control<RuntimeProvider[]>({ action: "getProviders" }),
    ]);
    if (customResult.status === "fulfilled") customModels.value = Array.isArray(customResult.value) ? customResult.value : [];
    if (providerResult.status === "fulfilled") runtimeProviders.value = Array.isArray(providerResult.value) ? providerResult.value : [];
    normalizeSelectedModel();
    const errors = [customResult, modelResult, providerResult].filter((result) => result.status === "rejected");
    if (errors.length) throw new Error(errors.map((result) => String(result.reason?.message ?? result.reason)).join("\n"));
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

  async function customModelSaved(provider: string) {
    const edited = !!editingCustomModel.value;
    addingCustomModel.value = false;
    editingCustomModel.value = undefined;
    try {
      await loadRuntimeCatalog();
      if (!edited) {
        const available = models.value.some((model) => model.provider === provider);
        editingProvider.value = available ? "" : provider;
        expandedProvider.value = available ? provider : "";
      }
      layout.showNotice(t(edited ? "settings.customModelUpdated" : "settings.customModelSaved"));
    } catch (error) {
      runtimeError.value = error instanceof Error ? error.message : String(error);
    }
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
    save("global");
  }

  function setAllCycling(enabled: boolean) {
    if (!draft.value) return;
    draft.value.piGlobal.enabledModels = enabled ? undefined : [];
    save("global");
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
    save("global");
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
      layout.applySettings(settings);
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

  return {
    models,
    modelQuery,
    addingCustomModel,
    customModels,
    editingCustomModel,
    providers,
    providerFilter,
    selectedModel,
    expandedProvider,
    editingProvider,
    selectedProvider,
    keyDrafts,
    runtimeBusy,
    providerBusy,
    runtimeError,
    providerFilters,
    filteredProviders,
    providerSections,
    defaultModel,
    currentModel,
    selectedRuntimeModel,
    selectedThinkingLevels,
    modelKey,
    providerModels,
    toggleProvider,
    toggleProviderSetup,
    loadRuntime,
    customModelSaved,
    modelSettingsKey,
    cyclingEnabled,
    toggleCycling,
    setAllCycling,
    modelThinkingOverride,
    setModelThinkingOverride,
    applyModel,
    saveApiKey,
    loginOAuth,
    logout,
  };
}
