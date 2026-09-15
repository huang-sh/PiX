import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { isNpmPackageExtension } from "../../../shared/extensions";
import type { RuntimeExtension } from "../../../shared/types";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import type { InspectorFocus } from "./inspector-focus";

export function useExtensions(focus: InspectorFocus) {
  const layout = useLayoutStore();
  const session = useSessionStore();
  const { t, te } = useI18n();

  const extensions = ref<RuntimeExtension[]>([]);
  const extensionQuery = ref("");
  const extensionScope = ref<"all" | RuntimeExtension["scope"]>("all");
  const extensionBusy = ref(false);
  const extensionError = ref("");
  const selectedExtensionPath = ref("");
  const selectedExtension = computed(() => extensions.value.find((extension) => extension.resolvedPath === selectedExtensionPath.value));
  const packageBusySource = ref("");
  const packageError = ref<{ source: string; message: string } | undefined>();

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

  function extensionName(path: string) {
    // pi identifies inline (factory-registered) extensions by a synthetic
    // <inline:name> pseudo-path; the card shows the bare name.
    const inline = /^<inline:(.+)>$/.exec(path);
    if (inline) return inline[1]!;
    const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
    const modules = parts.lastIndexOf("node_modules");
    if (modules >= 0)
      return parts[modules + 1]?.startsWith("@")
        ? `${parts[modules + 1]}/${parts[modules + 2]}`
        : parts[modules + 1] ?? path;
    const name = (parts.pop() ?? path).replace(/\.[^.]+$/, "");
    return name === "index" ? parts.pop() ?? name : name;
  }

  /** Inline extensions carry no tool or command descriptions; use their own copy. */
  function extensionSummary(extension: RuntimeExtension) {
    if (extension.path.startsWith("<inline:")) {
      const key = `settings.internalExtensions.${extensionName(extension.path)}.description`;
      if (te(key)) return t(key);
    }
    return extension.tools.find(tool => tool.description)?.description
      || extension.commands.find(command => command.description)?.description
      || t("settings.extensionNoDescription");
  }

  function openExtensionDetails(extension: RuntimeExtension, event: MouseEvent) {
    selectedExtensionPath.value = extension.resolvedPath;
    void focus.open(event);
  }

  /** Unconditional fetch; also used after installs so a category switch or an
   *  in-flight refresh can never leave the card's state stale. */
  async function refreshExtensions(reload: boolean) {
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

  async function loadExtensions(reload = false) {
    if (layout.settingsCategory !== "extensions" || extensionBusy.value) return;
    await refreshExtensions(reload);
  }

  function extensionInstalled(name: string) {
    return extensions.value.some((extension) => isNpmPackageExtension(extension, name));
  }

  async function runPackageAction(source: string, action: "installExtension" | "removeExtension") {
    if (packageBusySource.value) return;
    packageBusySource.value = source;
    packageError.value = undefined;
    try {
      await session.control({ action, source });
      await refreshExtensions(true);
    } catch (error) {
      packageError.value = { source, message: error instanceof Error ? error.message : String(error) };
    } finally {
      packageBusySource.value = "";
    }
  }

  return {
    extensions,
    extensionQuery,
    extensionScope,
    extensionBusy,
    extensionError,
    selectedExtensionPath,
    selectedExtension,
    packageBusySource,
    packageError,
    filteredExtensions,
    extensionFilters,
    extensionName,
    extensionSummary,
    openExtensionDetails,
    loadExtensions,
    extensionInstalled,
    runPackageAction,
  };
}
