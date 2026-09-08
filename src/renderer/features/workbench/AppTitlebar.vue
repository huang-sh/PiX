<script setup lang="ts">
import { ChevronDown, Folder, MessageSquare, MonitorUp, PanelLeft, PanelRight, Pin, Unplug } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import { useLayoutStore } from "../../stores/layout";
import { useWorkspaceStore } from "../../stores/workspace";
import { formatShortcut, shortcutBindings, type ShortcutId } from "../../../shared/shortcuts";
import { isMac } from "../../keyboard-shortcuts";

const emit = defineEmits<{ pickProject: []; connectRemote: []; disconnectRemote: [] }>();

const layout = useLayoutStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();
const workspaceMenuOpen = ref(false);
function shortcutTitle(label: string, id: ShortcutId) {
  const keys = shortcutBindings(id, layout.settings?.app.keyboardShortcuts).map((binding) => formatShortcut(binding, isMac())).join(" / ");
  return keys ? `${t(label)} (${keys})` : t(label);
}

function chooseLocal() {
  workspaceMenuOpen.value = false;
  emit("pickProject");
}

function chooseRemote() {
  workspaceMenuOpen.value = false;
  emit("connectRemote");
}

function disconnectRemote() {
  workspaceMenuOpen.value = false;
  emit("disconnectRemote");
}
</script>

<template>
  <header class="app-titlebar">
    <div class="app-titlebar-side app-titlebar-left">
      <span class="window-controls-spacer left" />
      <Button
        v-if="layout.screen === 'workbench'"
        data-action="navigator-panel"
        :class="`navigator-toggle${layout.layout.collapsed.navigator ? '' : ' active'}${layout.layout.navigatorPinned ? ' pinned' : ''}`"
        variant="ghost"
        size="icon"
        :title="shortcutTitle(layout.layout.navigatorPinned ? 'titlebar.navigatorPinned' : 'titlebar.navigatorAutoHide', 'navigator')"
        :aria-label="t('titlebar.toggleNavigator')"
        :aria-expanded="!layout.layout.collapsed.navigator"
        aria-controls="navigator-panel"
        @click="layout.toggle('navigator')"
      >
        <PanelLeft :size="17" />
        <Pin v-if="layout.layout.navigatorPinned" class="navigator-pin-badge" :size="10" aria-hidden="true" />
      </Button>
      <span class="app-titlebar-brand"><img src="/icon.png" alt="" /></span>
    </div>

    <div class="app-titlebar-workspace">
      <button
        class="app-titlebar-project"
        data-action="workspace-picker"
        type="button"
        :title="workspace.project?.path"
        :aria-expanded="workspaceMenuOpen"
        @click="workspaceMenuOpen = !workspaceMenuOpen"
      >
        <Folder :size="16" />
        <span>{{ workspace.project?.name ?? t("titlebar.chooseWorkspace") }}</span>
        <em v-if="workspace.project?.remote?.kind === 'wsl'">WSL · {{ workspace.project.remote.distro }}</em>
        <em v-else-if="workspace.project?.remote?.kind === 'ssh'">SSH · {{ workspace.project.remote.host }}</em>
        <ChevronDown class="app-titlebar-project-chevron" :size="14" />
      </button>

      <button
        v-if="workspaceMenuOpen"
        class="workspace-picker-backdrop"
        type="button"
        :aria-label="t('titlebar.closeMenu')"
        @click="workspaceMenuOpen = false"
      />
      <div v-if="workspaceMenuOpen" class="workspace-picker" data-workspace-picker role="menu">
        <div class="workspace-picker-current">
          <Folder :size="18" />
          <div>
            <strong>{{ workspace.project?.name ?? t("titlebar.noWorkspace") }}</strong>
            <span>{{ workspace.project?.path ?? t("titlebar.chooseHint") }}</span>
          </div>
        </div>
        <div class="workspace-picker-options">
          <button data-action="open-local-project" type="button" role="menuitem" @click="chooseLocal">
            <Folder :size="18" />
            <span><strong>{{ t("titlebar.localFolder") }}</strong><small>{{ t("titlebar.localFolderHint") }}</small></span>
          </button>
          <button data-action="connect-wsl" type="button" role="menuitem" @click="chooseRemote">
            <MonitorUp :size="18" />
            <span><strong>{{ workspace.project?.remote ? t("titlebar.changeRemote") : t("titlebar.remoteWorkspace") }}</strong><small>{{ t("titlebar.remoteHint") }}</small></span>
          </button>
        </div>
        <button
          v-if="workspace.project?.remote"
          class="workspace-picker-disconnect"
          data-action="disconnect-wsl"
          type="button"
          role="menuitem"
          @click="disconnectRemote"
        >
          <Unplug :size="16" />
          {{ t("titlebar.disconnect", { kind: workspace.project.remote.kind.toUpperCase() }) }}
        </button>
      </div>
    </div>

    <div class="app-titlebar-side app-titlebar-right">
      <template v-if="layout.screen === 'workbench'">
        <Button
          data-action="chat-panel"
          :class="!layout.layout.collapsed.chat ? 'active' : ''"
          variant="ghost"
          size="icon"
          :title="t('titlebar.toggleBranchContext')"
          :aria-expanded="!layout.layout.collapsed.chat"
          @click="layout.toggle('chat')"
        >
          <MessageSquare :size="17" />
        </Button>
        <Button
          data-action="tool-panel"
          :class="!layout.layout.collapsed.content ? 'active' : ''"
          variant="ghost"
          size="icon"
          :title="shortcutTitle('titlebar.toggleTools', 'tools')"
          :aria-expanded="!layout.layout.collapsed.content"
          @click="layout.toggle('content')"
        >
          <PanelRight :size="17" />
        </Button>
      </template>
      <span class="window-controls-spacer right" />
    </div>
  </header>
</template>
