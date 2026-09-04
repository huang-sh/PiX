<script setup lang="ts">
import {
  ArrowUpRight,
  ChevronRight,
  FileText,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  X,
} from "@lucide/vue";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  SplitterGroup,
  SplitterPanel,
  SplitterResizeHandle,
} from "reka-ui";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import { desktop } from "../../api";
import { useLayoutStore, type ContentTab } from "../../stores/layout";
import { useWorkspaceStore, type WorkspaceTab } from "../../stores/workspace";
import FileTree from "./FileTree.vue";
import { filterFileTree } from "./file-tree";
import TerminalView from "./TerminalView.vue";

const layout = useLayoutStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

// reka-ui 2.10.4 boots px-sized panels at their min size (initial layout runs
// before the group is measured), which jammed the editor against its 100px
// floor and left the file divider draggable one way only. Declare the panels
// in percent instead; the content width is current at mount because the
// workbench keeps widths.content updated on every drag.
const contentEstimate = Math.max(1, layout.layout.widths.content);
const pct = (px: number) => Math.min(95, Math.max(0, (px / contentEstimate) * 100));
const launchUrl = ref(workspace.browserUrl);
const fileQuery = ref("");
const fileTreeOpen = ref(true);
const fileTreePanel = ref<{ collapse: () => void; expand: () => void }>();
const lineNumbers = ref<HTMLElement>();
const hasDesktop = Boolean(window.pix);
const tools: { id: ContentTab; label: string; icon: unknown }[] = [
  { id: "files", label: "tools.files", icon: FolderTree },
  { id: "changes", label: "tools.changes", icon: GitBranch },
  { id: "terminal", label: "tools.terminal", icon: Terminal },
  { id: "browser", label: "tools.browser", icon: Globe },
  { id: "output", label: "tools.output", icon: FileText },
  { id: "events", label: "tools.events", icon: FileText },
];
const panelTools = tools.filter((tool) => ["files", "terminal", "browser"].includes(tool.id));
const toolById = (id: ContentTab) => tools.find((tool) => tool.id === id)!;
const active = computed(() => workspace.active);
const workspaceSection = computed(() =>
  ["browser", "changes"].includes(layout.contentSection),
);
const fileTabs = computed(() => workspace.tabs.filter((tab) => tab.kind === "file"));
const activeFile = computed(() =>
  fileTabs.value.find((tab) => tab.id === workspace.activeTab) ?? fileTabs.value[0],
);
const filteredFiles = computed(() => filterFileTree(workspace.files, fileQuery.value));
const terminalProjectKey = computed(() => JSON.stringify(workspace.project ?? {}));
const breadcrumb = computed(() => activeFile.value?.path?.split("/") ?? []);
const gutter = computed(() => {
  const lines = activeFile.value?.document?.content.split("\n").length ?? 1;
  return Array.from({ length: lines }, (_, index) => index + 1).join("\n");
});

async function openFile(path: string) {
  await workspace.openFile(path);
}

function editorInput(event: Event) {
  const tab = activeFile.value;
  if (tab?.document) tab.document.content = (event.target as HTMLTextAreaElement).value;
}

function editorScroll(event: Event) {
  if (lineNumbers.value)
    lineNumbers.value.scrollTop = (event.target as HTMLTextAreaElement).scrollTop;
}

function selectFile(tab: WorkspaceTab) {
  layout.selectTool("files");
  workspace.activeTab = tab.id;
}

function closeFile(id: string) {
  workspace.closeTab(id);
  if (fileTabs.value.length) workspace.activeTab = fileTabs.value[0]!.id;
}

function toggleFileTree() {
  fileTreeOpen.value = !fileTreeOpen.value;
  if (fileTreeOpen.value) fileTreePanel.value?.expand();
  else fileTreePanel.value?.collapse();
}

async function save(tab: WorkspaceTab) {
  if (tab.document) await workspace.saveFile(tab, tab.document.content);
}
</script>

<template>
  <section class="panel tool-panel">
    <header class="tool-tabs-bar">
      <nav class="tool-tabs" role="tablist" :aria-label="t('tools.openTools')">
        <template v-for="id in layout.contentTabs" :key="id">
          <div
            v-if="id === 'files' && !fileTabs.length"
            class="tool-tab"
            data-tool-tab="files"
            :class="{ active: layout.contentSection === 'files' }"
          >
            <button
              type="button"
              class="tool-tab-main"
              role="tab"
              :aria-selected="layout.contentSection === 'files'"
              @click="layout.selectTool('files')"
            >
              <FileText :size="14" />
              <span>{{ t("tools.openFile") }}</span>
            </button>
            <button
              type="button"
              class="tool-tab-close"
              :aria-label="t('tools.closeTab', { name: t('tools.openFile') })"
              @click="layout.closeTool('files')"
            >
              <X :size="12" />
            </button>
          </div>

          <template v-else-if="id === 'files'">
            <div
              v-for="tab in fileTabs"
              :key="tab.id"
              class="tool-tab file-tool-tab"
              data-tool-tab="files"
              :data-file-tab="tab.path"
              :class="{ active: layout.contentSection === 'files' && activeFile?.id === tab.id }"
            >
              <button
                type="button"
                class="tool-tab-main"
                role="tab"
                :aria-selected="layout.contentSection === 'files' && activeFile?.id === tab.id"
                @click="selectFile(tab)"
              >
                <FileText :size="14" />
                <span>{{ tab.title }}</span>
              </button>
              <button
                type="button"
                class="tool-tab-close"
                :aria-label="t('tools.closeTab', { name: tab.title })"
                @click="closeFile(tab.id)"
              >
                <X :size="12" />
              </button>
            </div>
          </template>

          <div
            v-else
            class="tool-tab"
            :data-tool-tab="id"
            :class="{ active: layout.contentSection === id }"
          >
            <button
              type="button"
              class="tool-tab-main"
              role="tab"
              :aria-selected="layout.contentSection === id"
              @click="layout.selectTool(id)"
            >
              <component :is="toolById(id).icon" :size="14" />
              <span>{{ t(toolById(id).label) }}</span>
            </button>
            <button
              type="button"
              class="tool-tab-close"
              :aria-label="t('tools.closeTab', { name: t(toolById(id).label) })"
              @click="layout.closeTool(id)"
            >
              <X :size="12" />
            </button>
          </div>
        </template>
      </nav>

      <DropdownMenuRoot v-if="layout.contentTabs.length">
        <DropdownMenuTrigger as-child>
          <Button data-action="add-tool-tab" variant="ghost" size="icon" :title="t('tools.newToolTab')">
            <Plus :size="17" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent class="menu-content tool-menu-content" align="end" :side-offset="5">
            <DropdownMenuItem
              v-for="tool in panelTools"
              :key="tool.id"
              class="menu-item tool-menu-item"
              :data-tool-menu="tool.id"
              @select="layout.openTool(tool.id)"
            >
              <component :is="tool.icon" :size="16" />
              <span>{{ t(tool.label) }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </header>

    <TerminalView
      v-if="layout.contentTabs.includes('terminal')"
      v-show="layout.contentSection === 'terminal'"
      :active="layout.contentSection === 'terminal'"
      :project-key="terminalProjectKey"
    />

    <div v-if="layout.contentSection === 'home'" class="tool-home">
      <button
        v-for="tool in panelTools"
        :key="tool.id"
        type="button"
        :data-tool-section="tool.id"
        @click="layout.openTool(tool.id)"
      >
        <component :is="tool.icon" :size="17" />
        <span>{{ t(tool.label) }}</span>
        <ChevronRight :size="15" />
      </button>
    </div>

    <template v-else-if="layout.contentSection === 'terminal'" />

    <pre v-else-if="layout.contentSection === 'output'" class="log-view full-tool">{{
      workspace.utilityOutput || layout.notice?.message || t("tools.noOutput")
    }}</pre>
    <pre v-else-if="layout.contentSection === 'events'" class="log-view full-tool">{{
      workspace.events.join("\n") || t("tools.noEvents")
    }}</pre>

    <template v-else-if="layout.contentSection === 'files'">
      <SplitterGroup
        id="pix-file-workspace"
        auto-save-id="pix-file-workspace"
        direction="horizontal"
        class="file-workspace"
      >
        <SplitterPanel id="file-editor-panel" :order="1" :min-size="pct(100)">
          <main class="file-main">
          <header class="file-toolbar">
            <nav class="file-breadcrumb" :aria-label="t('tools.filePath')">
              <span>{{ workspace.project?.name ?? workspace.project?.path }}</span>
              <template v-for="(part, index) in breadcrumb" :key="`${index}:${part}`">
                <ChevronRight :size="12" />
                <strong>{{ part }}</strong>
              </template>
            </nav>
            <div class="file-toolbar-actions">
              <Button variant="ghost" size="icon" :title="t('tools.refreshFiles')" @click="workspace.loadFiles()">
                <RefreshCw :size="14" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                :title="fileTreeOpen ? t('tools.hideTree') : t('tools.showTree')"
                :aria-pressed="fileTreeOpen"
                data-action="toggle-file-tree"
                @click="toggleFileTree"
              >
                <PanelRight :size="16" />
              </Button>
              <Button
                v-if="activeFile?.document && !activeFile.document.readonly"
                size="sm"
                @click="save(activeFile)"
              >{{ t("common.save") }}</Button>
            </div>
          </header>

          <div v-if="!activeFile" class="file-empty">
            <FolderOpen :size="28" />
            <strong>{{ t("tools.openFile") }}</strong>
            <span>{{ t("tools.selectFile") }}</span>
          </div>

          <div v-else-if="activeFile.document?.dataUrl" class="image-preview">
            <img :src="activeFile.document.dataUrl" :alt="activeFile.title" />
          </div>

          <div v-else-if="activeFile.document" class="code-editor">
            <pre ref="lineNumbers" aria-hidden="true">{{ gutter }}</pre>
            <textarea
              class="file-editor"
              :readonly="activeFile.document.readonly"
              :value="activeFile.document.content"
              :aria-label="t('tools.editFile', { name: activeFile.title })"
              @input="editorInput"
              @scroll="editorScroll"
            />
          </div>
          </main>
        </SplitterPanel>

        <SplitterResizeHandle
          class="resize-handle file-resize-handle"
          :class="{ hidden: !fileTreeOpen }"
          :aria-label="t('tools.resizeTree')"
        />

        <SplitterPanel
          id="file-tree-panel"
          ref="fileTreePanel"
          :order="2"
          collapsible
          :collapsed-size="0"
          :default-size="pct(320)"
          :min-size="pct(180)"
          :max-size="pct(800)"
          @collapse="fileTreeOpen = false"
          @expand="fileTreeOpen = true"
        >
          <aside v-if="fileTreeOpen" class="file-explorer">
            <div class="file-filter">
              <Search :size="14" />
              <input v-model="fileQuery" type="search" :placeholder="t('tools.filterFiles')" :aria-label="t('tools.filterFiles')" />
            </div>
            <div class="file-tree">
              <FileTree
                :key="fileQuery"
                :nodes="filteredFiles"
                :query="fileQuery"
                :active-path="activeFile?.path"
                @open="openFile"
                @expand="workspace.loadChildren"
              />
              <p v-if="fileQuery && !filteredFiles.length" class="empty-copy">{{ t("tools.noMatchingFiles") }}</p>
            </div>
          </aside>
        </SplitterPanel>
      </SplitterGroup>
    </template>

    <template v-else>
      <div
        v-if="layout.contentSection !== 'browser' || active?.kind !== 'browser'"
        class="tool-explorer"
        :class="{ expanded: !workspace.tabs.length }"
      >

        <template v-if="layout.contentSection === 'changes'">
          <button
            v-for="change in workspace.git.changes"
            :key="change.path"
            type="button"
            class="change-item"
            @click="workspace.openChange(change.path)"
          >
            <b>{{ change.status }}</b><span>{{ change.path }}</span>
          </button>
          <p v-if="!workspace.git.available" class="empty-copy">{{ t("tools.gitUnavailable") }}</p>
          <p v-else-if="!workspace.git.changes.length" class="empty-copy">{{ t("tools.clean") }}</p>
        </template>

        <form v-else class="browser-launch" @submit.prevent="workspace.openBrowser(launchUrl)">
          <input v-model="launchUrl" :placeholder="t('tools.searchUrl')" />
          <Button type="submit" size="sm">{{ t("common.open") }}</Button>
          <nav>
            <button type="button" @click="workspace.openBrowser('https://pi.dev')">pi.dev</button>
            <button type="button" @click="workspace.openBrowser('https://github.com')">GitHub</button>
          </nav>
        </form>
      </div>

      <div v-if="workspaceSection && workspace.tabs.length" class="content-workspace">
        <nav class="workspace-tabs">
          <button
            v-for="tab in workspace.tabs"
            :key="tab.id"
            type="button"
            :class="{ active: workspace.activeTab === tab.id }"
            @click="workspace.activeTab = tab.id"
          >
            <span>{{ tab.title }}</span>
            <X :size="13" @click.stop="workspace.closeTab(tab.id)" />
          </button>
        </nav>

        <div v-if="active" class="workspace-view">
          <template v-if="active.kind === 'file' && active.document">
            <div class="editor-header">
              <span>{{ active.path }}</span>
              <Button size="sm" @click="save(active)">{{ t("common.save") }}</Button>
            </div>
            <textarea
              class="file-editor"
              :readonly="active.document.readonly"
              :value="active.document.content"
              @input="editorInput"
            />
          </template>
          <pre v-else-if="active.kind === 'changes'" class="diff-view">{{ workspace.diff || t("tools.noChanges") }}</pre>
          <template v-else-if="active.kind === 'browser'">
            <form class="browser-bar" @submit.prevent="workspace.openBrowser(active.url)">
              <input :value="active.url" @input="active.url = ($event.target as HTMLInputElement).value" />
              <Button type="submit" size="sm">{{ t("common.go") }}</Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                @click="desktop.invoke('app.openExternal', { url: active.url })"
              >
                <ArrowUpRight :size="15" />
              </Button>
            </form>
            <webview
              v-if="hasDesktop"
              class="browser-frame"
              :src="active.url"
              partition="persist:pix-browser"
            />
            <iframe v-else class="browser-frame" :src="active.url" />
          </template>
        </div>
      </div>
    </template>
  </section>
</template>
