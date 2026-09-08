import { inject, type InjectionKey } from "vue";
import { useI18n } from "vue-i18n";
import type { AppCommandName } from "../../../shared/commands";
import { desktop } from "../../api";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";

export type CommandHandler = () => void | Promise<void>;

// Behaviors the command handlers need that live on App.vue's local UI state.
export interface AppCommandDeps {
  requestRename(path: string, current: string): Promise<void>;
  requestCompact(): void;
  closeSettings(): void;
}

// Keep providers and remounted composers connected across Vite module reloads.
export const runCommandKey: InjectionKey<(name: string) => Promise<void>> = Symbol.for("pix.run-command");

// Optional by design: the composer (and isolated test mounts) work without a
// dispatcher and simply hide the builtin commands they could not run.
export function useRunCommand() {
  return inject(runCommandKey, undefined);
}

// Executes a command by name: builtin/app commands run client-side handlers;
// anything else is sent as literal "/name" text so the agent expands prompt
// templates, skills, and extension commands server-side (Pi TUI semantics).
export function createRunCommand(deps: AppCommandDeps) {
  const layout = useLayoutStore();
  const session = useSessionStore();
  const workspace = useWorkspaceStore();
  const { t } = useI18n();

  function openSettings(category?: string) {
    if (category) layout.settingsCategory = category;
    layout.screen = "settings";
  }

  async function exportSession() {
    const result = await session.control<{ path?: string }>({ action: "exportHtml" });
    if (result.path) layout.showNotice(t("notice.exportedTo", { path: result.path }));
  }

  const commandHandlers = {
    settings: () => openSettings(),
    model: () => openSettings("models"),
    tree: async () => {
      if (layout.screen === "settings") deps.closeSettings();
      await layout.setCollapsed("navigator", false);
    },
    thinking: () => openSettings("models"),
    "scoped-models": () => openSettings("models"),
    export: exportSession,
    import: () => session.importSession(),
    share: exportSession,
    copy: async () => {
      const text = [...(session.current?.projection.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant")?.text;
      if (!text) { layout.showNotice(t("notice.noAssistantMessage"), "warning"); return; }
      if (window.pix?.copy) await window.pix.copy(text);
      else await navigator.clipboard.writeText(text);
      layout.showNotice(t("notice.copiedLast"));
    },
    name: async () => {
      const current = session.current;
      if (current) await deps.requestRename(current.session.path, current.session.name ?? "");
    },
    session: async () => {
      workspace.utilityOutput = JSON.stringify(
        await session.control({ action: "stats" }),
        null,
        2,
      );
      await layout.openTool("output");
    },
    changelog: async () => {
      workspace.openBrowser("https://github.com/earendil-works/pi/releases");
      await layout.openTool("browser");
    },
    hotkeys: () => openSettings("shortcuts"),
    fork: async () => {
      const node = session.selectedNode;
      if (node) await session.control({ action: "fork", entryId: node.userEntryId });
      else layout.showNotice(t("branch.noNodeSelected"), "warning");
    },
    clone: async () => {
      await session.control({ action: "clone" });
      await session.refresh();
    },
    trust: () => openSettings("general"),
    login: () => openSettings("models"),
    logout: () => openSettings("models"),
    new: () => session.create(),
    compact: () => deps.requestCompact(),
    resume: () => layout.setCollapsed("navigator", false),
    reload: async () => {
      await session.control({ action: "reload" });
      // Reload swaps extensions, skills, and prompt templates — refresh the
      // command list so menus immediately reflect the new set.
      await session.loadCommands();
      layout.showNotice(t("notice.resourcesReloaded"));
    },
    quit: async () => {
      await desktop.invoke("app.quit");
    },
    terminal: () => layout.openTool("terminal"),
    files: () => layout.openTool("files"),
    browser: () => layout.openTool("browser"),
  } satisfies Record<AppCommandName, CommandHandler>;

  async function runCommand(name: string) {
    try {
      if (Object.hasOwn(commandHandlers, name))
        await commandHandlers[name as AppCommandName]();
      else {
        await layout.setCollapsed("chat", false);
        await session.promptAt(session.selectedNode?.id ?? null, `/${name}`);
      }
    } catch (error) {
      layout.showNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }

  return { runCommand, openSettings };
}
