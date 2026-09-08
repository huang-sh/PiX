<script setup lang="ts">
import {
  Folder,
  FolderOpen,
  FolderSync,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquarePen,
  Upload,
} from "@lucide/vue";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "reka-ui";
import { useI18n } from "vue-i18n";
import { ref, watch } from "vue";
import type { ProjectGroup } from "../../../shared/types";
import Button from "../../components/ui/Button.vue";
import NavigatorMenu from "./NavigatorMenu.vue";
import { useSessionStore } from "../../stores/session";
import { useLayoutStore } from "../../stores/layout";
import { desktop } from "../../api";

const emit = defineEmits<{
  pickProject: [];
  activateProject: [record: ProjectGroup];
  createProjectSession: [record: ProjectGroup];
  openProjectSession: [record: ProjectGroup, path: string];
  rename: [record: ProjectGroup, path: string, current: string];
  removeProjectSession: [record: ProjectGroup, path: string];
  forgetProject: [record: ProjectGroup];
  settings: [];
  menuOpenChange: [open: boolean];
}>();
const session = useSessionStore();
const layout = useLayoutStore();
const { t } = useI18n();
const expanded = ref(new Set<string>());
const collapsed = ref(new Set<string>());
const previewCount = 5;

// Project session lists start collapsed; each one expands on demand and stays
// in whatever state the user last left it for the rest of the session.
const seen = new Set<string>();
watch(
  () => session.filteredProjects,
  (projects) => {
    const fresh = projects.filter((record) => !seen.has(record.id));
    if (!fresh.length) return;
    for (const record of fresh) seen.add(record.id);
    collapsed.value = new Set([...collapsed.value, ...fresh.map((record) => record.id)]);
  },
  { immediate: true },
);

function relative(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return t("time.now");
  if (elapsed < 3_600_000) return t("time.minutes", { n: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t("time.hours", { n: Math.floor(elapsed / 3_600_000) });
  return t("time.days", { n: Math.floor(elapsed / 86_400_000) });
}

function visible(record: ProjectGroup) {
  return session.query || expanded.value.has(record.id)
    ? record.sessions
    : record.sessions.slice(0, previewCount);
}

function showAll(id: string) {
  expanded.value = new Set(expanded.value).add(id);
}

function toggleProject(id: string) {
  const next = new Set(collapsed.value);
  next.has(id) ? next.delete(id) : next.add(id);
  collapsed.value = next;
}

function remoteLabel(record: ProjectGroup) {
  const remote = record.project.remote;
  return remote?.kind === "ssh" ? remote.host : remote?.distro;
}

async function copy(value: string) {
  try {
    if (window.pix?.copy) await window.pix.copy(value);
    else await navigator.clipboard.writeText(value);
    layout.showNotice(t("common.copied"));
  } catch {
    layout.showNotice(t("common.copyFailed"), "error");
  }
}

async function revealSession(record: ProjectGroup, path: string) {
  try {
    await desktop.invoke("app.revealSession", { id: record.id, path });
  } catch {
    layout.showNotice(t("nav.revealFailed"), "error");
  }
}

</script>

<template>
  <aside class="panel navigator-panel">
    <header class="panel-header">
      <strong>{{ t("nav.projects") }}</strong>
    </header>

    <div class="navigator-actions">
      <Button class="grow justify-start" variant="ghost" @click="session.create()">
        <Plus :size="16" />{{ t("nav.newSession") }}
      </Button>
      <Button variant="ghost" size="icon" :title="t('nav.importSession')" @click="session.importSession()">
        <Upload :size="16" />
      </Button>
      <Button variant="ghost" size="icon" :title="t('nav.refreshSessions')" @click="session.refresh()">
        <RefreshCw :size="16" />
      </Button>
    </div>

    <label class="session-search">
      <Search :size="16" />
      <input v-model="session.query" :placeholder="t('nav.searchSessions')" />
    </label>

    <nav class="project-list">
      <section v-for="record in session.filteredProjects" :key="record.id" class="project-group" :data-project-id="record.id">
        <div class="project-row" :class="{ active: record.id === session.activeProjectId }">
          <button
            class="project-main"
            type="button"
            :title="record.project.path"
            :aria-expanded="!collapsed.has(record.id)"
            @click="toggleProject(record.id)"
          >
            <FolderOpen v-if="!collapsed.has(record.id)" :size="17" />
            <FolderSync v-else-if="record.project.remote" :size="17" />
            <Folder v-else :size="17" />
            <strong>{{ record.project.name }}</strong>
            <small v-if="record.project.remote">{{ remoteLabel(record) }}</small>
          </button>
          <i
            v-if="record.project.remote"
            class="project-connection"
            :class="{ connected: record.connected }"
            :title="record.connected ? t('nav.connected') : t('nav.disconnected')"
          />
          <div class="project-actions">
            <NavigatorMenu @open-change="emit('menuOpenChange', $event)">
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon" :title="t('nav.projectActions')">
                  <MoreHorizontal :size="15" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent data-navigator-menu class="menu-content" :side-offset="5">
                  <DropdownMenuItem class="menu-item" @select="emit('activateProject', record)">
                    {{ t("nav.openProject") }}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    class="menu-item danger"
                    :disabled="record.id === session.activeProjectId"
                    @select="emit('forgetProject', record)"
                  >
                    {{ t("nav.removeFromList") }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </NavigatorMenu>
            <Button
              data-action="create-project-session"
              variant="ghost"
              size="icon"
              :title="t('nav.newSessionInProject')"
              @click="emit('createProjectSession', record)"
            >
              <SquarePen :size="16" />
            </Button>
          </div>
        </div>

        <div v-if="!collapsed.has(record.id) || session.query" class="project-sessions">
          <div v-for="item in visible(record)" :key="item.path" class="session-row">
            <NavigatorMenu context @open-change="emit('menuOpenChange', $event)">
              <ContextMenuTrigger as-child>
                <button
                  type="button"
                  class="session-item"
                  :class="{ active: record.id === session.activeProjectId && session.current?.session.path === item.path }"
                  :title="item.name || item.firstMessage || item.id"
                  @click="emit('openProjectSession', record, item.path)"
                >
                  <span>
                    <strong>{{ item.name || item.firstMessage || item.id }}</strong>
                    <small>{{ relative(item.modified) }}</small>
                  </span>
                  <i
                    :class="{
                      running: record.id === session.activeProjectId && session.current?.session.path === item.path && session.activity?.active,
                      current: record.id === session.activeProjectId && session.current?.session.path === item.path,
                    }"
                  />
                </button>
              </ContextMenuTrigger>
              <ContextMenuPortal>
                <ContextMenuContent data-navigator-menu class="menu-content" :side-offset="5">
                  <ContextMenuItem data-action="session-copy-path" class="menu-item" @select="copy(item.path)">
                    {{ t("nav.copyPath") }}
                  </ContextMenuItem>
                  <ContextMenuItem data-action="session-copy-id" class="menu-item" @select="copy(item.id)">
                    {{ t("nav.copySessionId") }}
                  </ContextMenuItem>
                  <ContextMenuItem
                    data-action="session-reveal"
                    class="menu-item"
                    :disabled="record.project.remote?.kind === 'ssh'"
                    :title="record.project.remote?.kind === 'ssh' ? t('nav.revealRemoteUnavailable') : undefined"
                    @select="revealSession(record, item.path)"
                  >
                    {{ t("nav.revealSession") }}
                  </ContextMenuItem>
                  <ContextMenuItem data-action="session-rename" class="menu-item" @select="emit('rename', record, item.path, item.name ?? '')">
                    {{ t("common.rename") }}
                  </ContextMenuItem>
                  <ContextMenuItem data-action="session-delete" class="menu-item danger" @select="emit('removeProjectSession', record, item.path)">
                    {{ t("common.delete") }}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenuPortal>
            </NavigatorMenu>
          </div>
          <button
            v-if="!session.query && !expanded.has(record.id) && record.sessions.length > previewCount"
            type="button"
            class="show-more"
            @click="showAll(record.id)"
          >
            {{ t("nav.showMore") }}
          </button>
          <p v-if="!record.sessions.length" class="project-empty">{{ t("nav.noSessions") }}</p>
        </div>
      </section>
      <p v-if="!session.filteredProjects.length" class="empty-copy">{{ t("nav.noProjects") }}</p>
    </nav>

    <footer class="navigator-footer">
      <Button variant="ghost" class="justify-start" @click="emit('settings')">
        <Settings :size="16" />{{ t("nav.settings") }}
      </Button>
    </footer>
  </aside>
</template>
