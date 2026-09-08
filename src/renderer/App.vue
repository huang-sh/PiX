<script setup lang="ts">
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { sessionEventDecoder } from "../shared/session-updates";
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
  RemoteConnectStage,
} from "../shared/types";
import { desktop } from "./api";
import Button from "./components/ui/Button.vue";
import CommandPalette from "./features/commands/CommandPalette.vue";
import { createRunCommand, runCommandKey } from "./features/commands/runCommand";
import ImagePreview from "./components/ImagePreview.vue";
import SettingsPage from "./features/settings/SettingsPage.vue";
import { shortcutForEvent, shortcutsBlocked } from "./keyboard-shortcuts";
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

const settingsPage = ref<InstanceType<typeof SettingsPage>>();
function closeSettings() { settingsPage.value?.close(); }

const session = useSessionStore();
const workspace = useWorkspaceStore();
const layout = useLayoutStore();
const { locale, t } = useI18n();
let unsubscribe: (() => void) | undefined;
const wslOpen = ref(false);
const wslBusy = ref(false);
const wslError = ref("");
const remoteStages = ref<RemoteConnectStage[]>([]);
const remoteDisconnected = ref(false);
let remoteUiAttempt = 0;
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
const compactOpen = ref(false);
const compactInstructions = ref("");
const compactBusy = ref(false);
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
  remoteDisconnected.value = Boolean(data.project?.remote &&
    !data.projects?.find((record) => record.id === session.activeProjectId)?.connected);
  if (remoteDisconnected.value) {
    session.loading = false;
    return;
  }
  // Re-seed active streams after hydrate cleared local state, even if the model
  // is currently paused and will not send another token for a while.
  if (data.current) await desktop.invoke("session.snapshot");
  await workspace.load();
  if (openFirst && !session.current && session.sessions[0])
    await session.open(session.sessions[0].path);
  await Promise.all([session.loadCommands(), session.loadModels().catch(() => {})]);
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
  remoteStages.value = [];
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
  const attempt = ++remoteUiAttempt;
  remoteStages.value = [];
  wslBusy.value = true;
  wslError.value = "";
  try {
    const data = await desktop.invoke<BootstrapData | { project: ProjectInfo }>("ssh.connect", input);
    if (attempt !== remoteUiAttempt) return;
    if (input.browse && data.project) await browseRemoteDirectory(data.project.path);
    else {
      await hydrate(data as BootstrapData);
      remoteBrowseRoot.value = "";
      wslOpen.value = false;
      layout.showNotice(t("notice.connectedTo", { name: input.host }));
    }
  } catch (error) {
    if (attempt !== remoteUiAttempt) return;
    remoteBrowseRoot.value = "";
    remoteDirectories.value = [];
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (attempt === remoteUiAttempt) wslBusy.value = false;
  }
}

async function connectWsl(input: { distro: string; cwd: string; browse?: boolean }) {
  const attempt = ++remoteUiAttempt;
  remoteStages.value = [];
  wslBusy.value = true;
  wslError.value = "";
  try {
    const data = await desktop.invoke<BootstrapData | { project: ProjectInfo }>("wsl.connect", input);
    if (attempt !== remoteUiAttempt) return;
    if (input.browse && data.project) await browseRemoteDirectory(data.project.path);
    else {
      await hydrate(data as BootstrapData);
      remoteBrowseRoot.value = "";
      wslOpen.value = false;
      layout.showNotice(t("notice.connectedTo", { name: input.distro }));
    }
  } catch (error) {
    if (attempt !== remoteUiAttempt) return;
    remoteBrowseRoot.value = "";
    remoteDirectories.value = [];
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (attempt === remoteUiAttempt) wslBusy.value = false;
  }
}

async function browseRemoteDirectory(path: string) {
  const attempt = remoteUiAttempt;
  remoteDirectoryBusy.value = true;
  wslError.value = "";
  try {
    const listing = await desktop.invoke<DirectoryListing>("remote.directories", { path });
    if (attempt !== remoteUiAttempt) return;
    remoteBrowseRoot.value = listing.path;
    remoteDirectories.value = listing.entries;
  } catch (error) {
    if (attempt !== remoteUiAttempt) return;
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (attempt === remoteUiAttempt) remoteDirectoryBusy.value = false;
  }
}

async function openRemoteDirectory(path: string) {
  const attempt = remoteUiAttempt;
  wslBusy.value = true;
  wslError.value = "";
  try {
    const data = await desktop.invoke<BootstrapData>("remote.openProject", { path });
    // The backend may have committed just before Cancel was received. Always
    // hydrate a successful commit so the visible workspace matches routing.
    await hydrate(data);
    remoteBrowseRoot.value = "";
    remoteDirectories.value = [];
    wslOpen.value = false;
    layout.showNotice(t("notice.opened", { path }));
  } catch (error) {
    if (attempt !== remoteUiAttempt) return;
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (attempt === remoteUiAttempt) wslBusy.value = false;
  }
}

async function resetRemoteConnection() {
  ++remoteUiAttempt;
  wslBusy.value = true;
  wslError.value = "";
  try {
    await desktop.invoke("remote.cancel");
    remoteBrowseRoot.value = "";
    remoteDirectories.value = [];
    remoteDirectoryBusy.value = false;
    remoteStages.value = [];
  } catch (error) {
    wslError.value = error instanceof Error ? error.message : String(error);
  } finally {
    wslBusy.value = false;
  }
}

async function closeRemoteDialog() {
  wslOpen.value = false;
  await resetRemoteConnection();
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
  if (record.id === session.activeProjectId && record.connected) return true;
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
    // A failed remote preparation leaves the old workspace and session intact.
    if (!record.project.remote) {
      try { await hydrate(await desktop.invoke<BootstrapData>("app.bootstrap")); }
      catch {}
    }
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
    return false;
  } finally {
    session.loading = false;
  }
}

async function reconnectRemote() {
  const record = session.projects.find((item) => item.id === session.activeProjectId);
  if (!record || session.loading) return;
  const path = session.current?.session.path;
  if (await activateProject(record)) {
    if (path) {
      try { await session.open(path); }
      catch (error) { layout.showNotice(String(error), "error"); }
    }
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

async function submitCompact() {
  if (compactBusy.value) return;
  compactBusy.value = true;
  try {
    await session.control({ action: "compact", instructions: compactInstructions.value.trim() || undefined });
    compactOpen.value = false;
    layout.showNotice(t("notice.contextCompacted"));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally { compactBusy.value = false; }
}

const { runCommand, openSettings } = createRunCommand({ requestRename, closeSettings,
  requestCompact: () => { compactInstructions.value = ""; compactOpen.value = true; },
});
provide(runCommandKey, runCommand);

// The runtime flips available some time after the session opens (or reconnects);
// loadCommands at open-time races that transition and would stick empty.
watch(
  () => session.current?.runtime.available,
  (available, was) => {
    if (available && !was) void session.loadCommands();
  },
);

const decodeSessionEvent = sessionEventDecoder(() => desktop.invoke("session.snapshot"));
function onEvent(wireEvent: DesktopEvent) {
  const event = decodeSessionEvent(wireEvent);
  if (!event) return;
  if (event.type === "remote.progress") {
    if (wslOpen.value && wslBusy.value) {
      const { stage } = event.payload as { stage: RemoteConnectStage };
      if (remoteStages.value.at(-1) !== stage) remoteStages.value.push(stage);
    }
    return;
  }
  if (event.type === "remote.connection") {
    const payload = event.payload as { projectId: string; connected: boolean; message?: string };
    if (!payload.connected) {
      session.disconnected(payload.projectId);
      if (payload.projectId === session.activeProjectId) {
        remoteDisconnected.value = true;
        layout.showNotice(t("remote.connectionLost"), "error");
      }
    }
    return;
  }
  workspace.record(event);
  if (event.type === "agent") {
    session.onAgentEvent(event.payload);
  } else if (event.type === "notice") {
    const payload = event.payload as { level?: string; message?: string };
    if (payload.message) layout.showNotice(payload.message, payload.level);
  } else if (event.type === "sessions") {
    const payload = event.payload as { current?: SessionSnapshot; deletedPath?: string; sessions?: SessionSummary[] };
    if (payload.deletedPath && payload.sessions)
      session.applyDeletion(payload.deletedPath, payload.sessions);
    else if (payload.current) session.applySnapshot(payload.current);
  }
}

function keydown(event: KeyboardEvent) {
  if (shortcutsBlocked(event)) return;
  const action = shortcutForEvent(event, layout.settings?.app.keyboardShortcuts);
  if (action) {
    event.preventDefault();
    switch (action) {
      case "commands": layout.commandOpen = true; break;
      case "terminal": void layout.openTool("terminal"); break;
      case "navigator": void layout.toggle("navigator"); break;
      case "tools": void layout.toggle("content"); break;
      case "settings": openSettings(); break;
    }
  } else if (event.key === "Escape" && layout.screen === "settings") closeSettings();
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
        commands: session.commands,
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
      <SettingsPage v-if="layout.screen === 'settings'" ref="settingsPage" />
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
  <div v-if="remoteDisconnected" class="remote-disconnected" role="alert">
    <span>{{ t("remote.connectionLost") }}</span>
    <Button data-action="remote-reconnect" variant="outline" :disabled="session.loading" @click="reconnectRemote">
      {{ session.loading ? t("remote.connecting") : t("remote.reconnect") }}
    </Button>
  </div>
  <ImagePreview />
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
  <DialogRoot :open="compactOpen" @update:open="compactOpen = $event">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="rename-dialog" data-compact-dialog>
        <DialogTitle>{{ t("command.compact") }}</DialogTitle>
        <form @submit.prevent="submitCompact">
          <input v-model="compactInstructions" :placeholder="t('compactPrompt')" :aria-label="t('compactPrompt')" :disabled="compactBusy" />
          <footer>
            <Button type="button" variant="ghost" :disabled="compactBusy" @click="compactOpen = false">{{ t("common.cancel") }}</Button>
            <Button type="submit" :disabled="compactBusy">{{ t(compactBusy ? "draft.working" : "command.compact") }}</Button>
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
    :stages="remoteStages"
    @close="closeRemoteDialog"
    @back="resetRemoteConnection"
    @browse-directory="browseRemoteDirectory"
    @open-directory="openRemoteDirectory"
    @connect-wsl="connectWsl"
    @connect-ssh="connectSsh"
    @probe-wsl="probeWslHomes"
  />
  <button
    v-if="layout.notice"
    class="toast"
    :class="layout.notice.level"
    :role="layout.notice.level === 'error' ? 'alert' : 'status'"
    @click="layout.dismissNotice()"
  >
    {{ layout.notice.message }} ×
  </button>
  <div v-if="session.loading" class="loading-bar" />
</template>
