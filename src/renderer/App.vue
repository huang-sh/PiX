<script setup lang="ts">
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  DesktopEvent,
  DirectoryListing,
  LayoutState,
  ProjectGroup,
  ProjectInfo,
  SessionSnapshot,
  SessionSummary,
  SettingsBundle,
  WslDistribution,
} from "../shared/types";
import type { AppCommandName } from "../shared/commands";
import { desktop } from "./api";
import Button from "./components/ui/Button.vue";
import CommandPalette from "./features/commands/CommandPalette.vue";
import SettingsPage from "./features/settings/SettingsPage.vue";
import AppTitlebar from "./features/workbench/AppTitlebar.vue";
import WelcomeScreen from "./features/workbench/WelcomeScreen.vue";
import WslConnectDialog from "./features/workbench/WslConnectDialog.vue";
import Workbench from "./features/workbench/Workbench.vue";
import { useLayoutStore } from "./stores/layout";
import { useSessionStore } from "./stores/session";
import { useWorkspaceStore } from "./stores/workspace";

interface BootstrapData {
  project: ProjectInfo | null;
  sessions: SessionSummary[];
  projects: ProjectGroup[];
  settings: SettingsBundle;
  layout: LayoutState;
  current?: SessionSnapshot;
}

const session = useSessionStore();
const workspace = useWorkspaceStore();
const layout = useLayoutStore();
const { locale, t } = useI18n();
let unsubscribe: (() => void) | undefined;
const wslOpen = ref(false);
const wslBusy = ref(false);
const wslError = ref("");
const wslDistributions = ref<WslDistribution[]>([]);
const wslNamesLoading = ref(false);
const wslHomeCache = new Map<string, string>();
let wslHomesProbe: Promise<void> | null = null;
const sshHosts = ref<string[]>([]);
const sshLoading = ref(false);
const remoteBrowseRoot = ref("");
const remoteDirectories = ref<DirectoryListing["entries"]>([]);
const remoteDirectoryBusy = ref(false);
const renameOpen = ref(false);
const renamePath = ref("");
const renameName = ref("");
const renameInput = ref<HTMLInputElement>();
const deleteOpen = ref(false);
const deleteTarget = ref<{ record: ProjectGroup; path: string; name: string } | null>(null);

// The custom titlebar needs platform knowledge only for the macOS traffic
// lights (see .platform-darwin in app.css); the sandboxed renderer gets it
// from the user agent instead of a preload addition.
const isDarwin = /Macintosh/i.test(navigator.userAgent);

function applyLanguage(settings: SettingsBundle) {
  locale.value = settings.app.language === "system"
    ? navigator.language === "zh-CN" ? "zh-CN" : "en"
    : settings.app.language;
}

// Opening or switching a project never auto-opens a session — the user
// lands in the project's empty state and picks or starts a session. The
// only auto-open left is the opt-in "open last session on startup".
async function hydrate(data: BootstrapData, openFirst = false) {
  workspace.hydrate(data.project, data.settings.app.browserHome);
  layout.hydrate(data.settings, data.layout);
  applyLanguage(data.settings);
  session.hydrate(data.project, data.sessions ?? [], data.projects ?? [], data.current);
  await workspace.load();
  if (openFirst && !session.current && session.sessions[0])
    await session.open(session.sessions[0].path);
  await session.loadCommands();
  session.loading = false;
}

async function bootstrap() {
  try {
    const data = await desktop.invoke<BootstrapData>("app.bootstrap");
    await hydrate(data, data.settings.app.openLastSessionOnStartup);
  } catch (error) {
    session.loading = false;
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

async function pickProject() {
  const data = await desktop.invoke<BootstrapData | null>("app.pickProject");
  if (data) await hydrate(data);
}

// wsl.exe can stall for its full timeout while the WSL service cold-starts,
// so neither list may gate the other — each renders as soon as it arrives.
function openRemote() {
  wslOpen.value = true;
  wslBusy.value = false;
  wslError.value = "";
  remoteBrowseRoot.value = "";
  remoteDirectories.value = [];
  sshLoading.value = true;
  wslNamesLoading.value = true;
  desktop
    .invoke<string[]>("ssh.list")
    .then((hosts) => (sshHosts.value = hosts))
    .catch(() => {})
    .finally(() => (sshLoading.value = false));
  desktop
    .invoke<string[]>("wsl.names")
    .then((names) => {
      wslDistributions.value = names.map((name) => ({
        name,
        home: wslHomeCache.get(name) ?? "",
      }));
    })
    .catch(() => {})
    .finally(() => (wslNamesLoading.value = false));
}

// Per-distro home probing boots the whole WSL VM, so it only runs once the
// user actually picks the WSL branch, and its result is cached per distro.
function probeWslHomes() {
  if (wslDistributions.value.every((item) => wslHomeCache.has(item.name)))
    return Promise.resolve();
  wslHomesProbe ??= (async () => {
    try {
      const probed = await desktop
        .invoke<WslDistribution[]>("wsl.list")
        .catch(() => []);
      for (const item of probed) wslHomeCache.set(item.name, item.home);
      wslDistributions.value = wslDistributions.value.map((item) => ({
        name: item.name,
        home: wslHomeCache.get(item.name) ?? "",
      }));
    } finally {
      wslHomesProbe = null;
    }
  })();
  return wslHomesProbe;
}

async function connectSsh(input: { host: string; cwd: string; browse?: boolean }) {
  if (!input.browse && input.cwd === remoteBrowseRoot.value) {
    remoteBrowseRoot.value = "";
    wslOpen.value = false;
    return;
  }
  wslBusy.value = true;
  wslError.value = "";
  try {
    const data = await desktop.invoke<BootstrapData | { project: ProjectInfo }>("ssh.connect", input);
    if (input.browse && data.project) await browseRemoteDirectory(data.project.path);
    else {
      await hydrate(data as BootstrapData);
      remoteBrowseRoot.value = "";
      wslOpen.value = false;
      layout.showNotice(t("notice.connectedTo", { name: input.host }));
    }
  } catch (error) {
    remoteBrowseRoot.value = "";
    remoteDirectories.value = [];
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    wslBusy.value = false;
  }
}

async function connectWsl(input: { distro: string; cwd: string; browse?: boolean }) {
  if (!input.browse && input.cwd === remoteBrowseRoot.value) {
    remoteBrowseRoot.value = "";
    wslOpen.value = false;
    return;
  }
  wslBusy.value = true;
  wslError.value = "";
  try {
    if (!input.cwd) {
      await probeWslHomes();
      input = { ...input, cwd: wslHomeCache.get(input.distro) ?? "" };
      if (!input.cwd) throw new Error(t("remote.wslHomeUnavailable"));
    }
    const data = await desktop.invoke<BootstrapData | { project: ProjectInfo }>("wsl.connect", input);
    if (input.browse && data.project) await browseRemoteDirectory(data.project.path);
    else {
      await hydrate(data as BootstrapData);
      remoteBrowseRoot.value = "";
      wslOpen.value = false;
      layout.showNotice(t("notice.connectedTo", { name: input.distro }));
    }
  } catch (error) {
    remoteBrowseRoot.value = "";
    remoteDirectories.value = [];
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    wslBusy.value = false;
  }
}

async function browseRemoteDirectory(path: string) {
  remoteDirectoryBusy.value = true;
  wslError.value = "";
  try {
    const listing = await desktop.invoke<DirectoryListing>("workspace.directories", { path });
    remoteBrowseRoot.value = listing.path;
    remoteDirectories.value = listing.entries;
  } catch (error) {
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    remoteDirectoryBusy.value = false;
  }
}

async function openRemoteDirectory(path: string) {
  wslBusy.value = true;
  wslError.value = "";
  try {
    await hydrate(await desktop.invoke<BootstrapData>("remote.openProject", { path }));
    remoteBrowseRoot.value = "";
    remoteDirectories.value = [];
    wslOpen.value = false;
    layout.showNotice(t("notice.opened", { path }));
  } catch (error) {
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    wslBusy.value = false;
  }
}

async function resetRemoteConnection() {
  wslBusy.value = true;
  wslError.value = "";
  try {
    await hydrate(await desktop.invoke<BootstrapData>("remote.disconnect"));
    remoteBrowseRoot.value = "";
    remoteDirectories.value = [];
  } catch (error) {
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    wslBusy.value = false;
  }
}

async function closeRemoteDialog() {
  if (remoteBrowseRoot.value) await resetRemoteConnection();
  wslOpen.value = false;
}

async function disconnectRemote() {
  try {
    await hydrate(await desktop.invoke<BootstrapData>("remote.disconnect"));
    layout.showNotice(t("notice.disconnectedRemote"));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

async function activateProject(record: ProjectGroup) {
  if (record.id === session.activeProjectId) return true;
  session.loading = true;
  try {
    const remote = record.project.remote;
    const data = remote?.kind === "wsl"
      ? await desktop.invoke<BootstrapData>("wsl.connect", {
          distro: remote.distro,
          cwd: record.project.path,
        })
      : remote?.kind === "ssh"
        ? await desktop.invoke<BootstrapData>("ssh.connect", {
            host: remote.host,
            cwd: record.project.path,
          })
        : await desktop.invoke<BootstrapData>("app.openProject", { id: record.id });
    await hydrate(data);
    return true;
  } catch (error) {
    try {
      await hydrate(await desktop.invoke<BootstrapData>("app.bootstrap"));
    } catch {}
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
    return false;
  } finally {
    session.loading = false;
  }
}

async function inProject(record: ProjectGroup, action: () => Promise<void>) {
  if (!(await activateProject(record))) return;
  try {
    await action();
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

async function createProjectSession(record: ProjectGroup) {
  await inProject(record, () => session.create());
}

async function openProjectSession(record: ProjectGroup, path: string) {
  await inProject(record, () => session.open(path));
}

async function renameProjectSession(record: ProjectGroup, path: string, current: string) {
  await inProject(record, () => requestRename(path, current));
}

async function removeProjectSession(record: ProjectGroup, path: string) {
  const item = record.sessions.find((session) => session.path === path);
  const name = item?.name || item?.firstMessage || path;
  // The in-app dialog replaces the native OS prompt; deleting without any
  // confirmation remains reserved for users who turned the setting off.
  if (!layout.settings?.app.confirmDestructiveActions) {
    await inProject(record, () => session.remove(path, true));
    return;
  }
  deleteTarget.value = { record, path, name };
  deleteOpen.value = true;
}

async function submitDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  deleteOpen.value = false;
  deleteTarget.value = null;
  await inProject(target.record, () => session.remove(target.path, true));
}

async function forgetProject(record: ProjectGroup) {
  try {
    session.projects = await desktop.invoke<ProjectGroup[]>("app.forgetProject", { id: record.id });
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

async function requestRename(path: string, current: string) {
  renamePath.value = path;
  renameName.value = current;
  renameOpen.value = true;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}

async function submitRename() {
  const name = renameName.value.trim();
  if (!name) return;
  try {
    await session.rename(renamePath.value, name);
    renameOpen.value = false;
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

type CommandHandler = () => void | Promise<void>;

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
  tree: () => void (layout.screen = "workbench"),
  thinking: () => openSettings("models"),
  "scoped-models": () => openSettings("models"),
  export: exportSession,
  import: () => session.importSession(),
  share: exportSession,
  copy: async () => {
    const text = [...(session.current?.projection.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant")?.text;
    if (!text) return;
    if (window.pix?.copy) await window.pix.copy(text);
    else await navigator.clipboard.writeText(text);
    layout.showNotice(t("notice.copiedLast"));
  },
  name: async () => {
    const current = session.current;
    if (current) await requestRename(current.session.path, current.session.name ?? "");
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
    workspace.openBrowser("https://github.com/earendil-works/pi/releases/tag/v0.84.4");
    await layout.openTool("browser");
  },
  hotkeys: async () => {
    workspace.utilityOutput = t("hotkeys.body");
    await layout.openTool("output");
  },
  fork: async () => {
    const node = session.selectedNode;
    if (node) await session.control({ action: "fork", entryId: node.userEntryId });
  },
  clone: async () => {
    await session.control({ action: "clone" });
    await session.refresh();
  },
  trust: () => openSettings("general"),
  login: () => openSettings("models"),
  logout: () => openSettings("models"),
  new: () => session.create(),
  compact: async () => {
    await session.control({
      action: "compact",
      instructions: window.prompt(t("compactPrompt"), "") || undefined,
    });
  },
  resume: () => layout.setCollapsed("navigator", false),
  reload: async () => {
    await session.control({ action: "reload" });
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
    else await session.control({ action: "prompt", text: `/${name}` });
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

function onEvent(event: DesktopEvent) {
  workspace.record(event);
  if (event.type === "agent") {
    session.onAgentEvent(event.payload);
  } else if (event.type === "notice") {
    const payload = event.payload as { level?: string; message?: string };
    if (payload.message) layout.showNotice(payload.message, payload.level);
  } else if (event.type === "sessions") {
    const payload = event.payload as { current?: SessionSnapshot };
    if (payload.current) session.applySnapshot(payload.current);
  }
}

function keydown(event: KeyboardEvent) {
  const command = event.ctrlKey || event.metaKey;
  if (command && event.altKey && event.key.toLowerCase() === "b") {
    event.preventDefault();
    void layout.toggle("content");
  } else if (command && event.key.toLowerCase() === "b") {
    event.preventDefault();
    void layout.toggle("navigator");
  } else if (command && (event.key.toLowerCase() === "k" || (event.shiftKey && event.key.toLowerCase() === "p"))) {
    event.preventDefault();
    layout.commandOpen = true;
  } else if (command && event.key === "`") {
    event.preventDefault();
    void layout.openTool("terminal");
  } else if (event.key === "Escape" && layout.screen === "settings") layout.screen = "workbench";
}

onMounted(() => {
  unsubscribe = desktop.onEvent(onEvent);
  window.addEventListener("keydown", keydown);
  Object.assign(window, {
    __pixTest: {
      state: () => JSON.parse(JSON.stringify({
        loading: session.loading,
        project: workspace.project,
        welcome: !workspace.project,
        sessions: session.sessions,
        current: session.current,
        focusedNode: session.focusedNode,
        layout: layout.layout,
        contentSection: layout.contentSection,
        contentTabs: layout.contentTabs,
        remoteBrowseRoot: remoteBrowseRoot.value,
      })),
      openSession: session.open,
      selectNode: session.selectNode,
      toggle: (panel: "navigator" | "chat" | "content") => layout.toggle(panel),
      settings: () => void (layout.screen = "settings"),
    },
  });
  void bootstrap();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  window.removeEventListener("keydown", keydown);
});
</script>

<template>
  <div class="app-frame" :class="{ 'platform-darwin': isDarwin }">
    <AppTitlebar
      @pick-project="pickProject"
      @connect-remote="openRemote"
      @disconnect-remote="disconnectRemote"
    />
    <div class="app-content">
      <SettingsPage v-if="layout.screen === 'settings'" />
      <KeepAlive>
        <Workbench
          v-if="layout.hydrated && layout.screen === 'workbench'"
          @settings="layout.screen = 'settings'"
          @pick-project="pickProject"
          @new-session="session.create"
          @activate-project="activateProject"
          @create-project-session="createProjectSession"
          @open-project-session="openProjectSession"
          @rename="renameProjectSession"
          @remove-project-session="removeProjectSession"
          @forget-project="forgetProject"
        />
      </KeepAlive>
      <WelcomeScreen
        v-if="layout.screen === 'workbench' && !workspace.project"
        @open-project="pickProject"
      />
    </div>
  </div>
  <CommandPalette @run="runCommand" />
  <DialogRoot :open="renameOpen" @update:open="renameOpen = $event">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="rename-dialog" data-rename-dialog>
        <DialogTitle>{{ t("renameDialog.title") }}</DialogTitle>
        <form @submit.prevent="submitRename">
          <input ref="renameInput" v-model="renameName" data-session-name :aria-label="t('renameDialog.label')" />
          <footer>
            <Button data-action="rename-cancel" type="button" variant="ghost" @click="renameOpen = false">{{ t("common.cancel") }}</Button>
            <Button type="submit" :disabled="!renameName.trim()">{{ t("renameDialog.rename") }}</Button>
          </footer>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <DialogRoot :open="deleteOpen" @update:open="deleteOpen = $event">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="rename-dialog confirm-dialog" data-delete-dialog>
        <DialogTitle>{{ t("deleteDialog.title") }}</DialogTitle>
        <p class="confirm-body">{{ t("deleteDialog.body", { name: deleteTarget?.name ?? "" }) }}</p>
        <p v-if="deleteTarget" class="confirm-detail">{{ deleteTarget.path }}</p>
        <footer>
          <Button data-action="delete-cancel" type="button" variant="ghost" @click="deleteOpen = false">{{ t("common.cancel") }}</Button>
          <Button data-action="delete-confirm" type="button" variant="danger" @click="submitDelete">{{ t("deleteDialog.delete") }}</Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <WslConnectDialog
    :open="wslOpen"
    :distributions="wslDistributions"
    :distributions-loading="wslNamesLoading"
    :ssh-hosts="sshHosts"
    :ssh-loading="sshLoading"
    :connected-path="remoteBrowseRoot"
    :directories="remoteDirectories"
    :directory-busy="remoteDirectoryBusy"
    :busy="wslBusy"
    :error="wslError"
    @close="closeRemoteDialog"
    @back="resetRemoteConnection"
    @browse-directory="browseRemoteDirectory"
    @open-directory="openRemoteDirectory"
    @connect-wsl="connectWsl"
    @connect-ssh="connectSsh"
    @probe-wsl="probeWslHomes"
  />
  <button v-if="layout.notice" class="toast" :class="layout.notice.level" @click="layout.notice = undefined">
    {{ layout.notice.message }} ×
  </button>
  <div v-if="session.loading" class="loading-bar" />
</template>
