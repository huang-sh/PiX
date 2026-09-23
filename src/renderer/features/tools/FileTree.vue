<script setup lang="ts">
import { ChevronRight, File, Folder } from "@lucide/vue";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "reka-ui";
import { useI18n } from "vue-i18n";
import type { FileNode } from "../../../shared/types";

withDefaults(
  defineProps<{
    nodes: FileNode[];
    depth?: number;
    query?: string;
    activePath?: string;
    local?: boolean;
    /** Linux only: registered .desktop applications for a node's MIME type. */
    openWithApps?: (node: FileNode) => { id: string; name: string }[];
  }>(),
  { depth: 0, query: "", activePath: "", local: true, openWithApps: undefined },
);
const emit = defineEmits<{
  open: [path: string];
  expand: [node: FileNode];
  copyPath: [node: FileNode];
  openExternal: [node: FileNode];
  openWith: [node: FileNode];
  openWithApp: [node: FileNode, appId: string];
  /** Fires when a row menu opens so the parent can load the app list. */
  menuOpen: [node: FileNode];
}>();

const { t } = useI18n();
// Windows and macOS open a native chooser through the parent; Linux picks
// from the .desktop list in a submenu.
const isLinux = /^Linux/i.test(navigator.platform);

function toggle(event: Event, node: FileNode) {
  if ((event.currentTarget as HTMLDetailsElement).open && node.children === undefined)
    emit("expand", node);
}
</script>

<template>
  <!-- Triggers wrap only the row itself (summary/button), never the nested
       subtree, so a right-click on a child row cannot bubble into an
       ancestor directory's menu. -->
  <template v-for="node in nodes" :key="node.path">
    <details
      v-if="node.kind === 'directory'"
      :data-directory-path="node.path"
      :open="Boolean(query)"
      @toggle="toggle($event, node)"
    >
      <ContextMenuRoot @update:open="(open) => open && emit('menuOpen', node)">
        <ContextMenuTrigger as-child>
          <summary :style="{ paddingLeft: `${8 + depth * 14}px` }">
            <ChevronRight class="tree-chevron" :size="13" />
            <Folder :size="14" />
            <span>{{ node.name }}</span>
          </summary>
        </ContextMenuTrigger>
        <ContextMenuPortal>
          <ContextMenuContent class="menu-content tool-menu-content" :side-offset="2">
            <ContextMenuItem class="menu-item" data-action="tree-copy-path" @select="emit('copyPath', node)">
              {{ t("tools.copyPath") }}
            </ContextMenuItem>
            <ContextMenuItem
              class="menu-item"
              data-action="tree-open-external"
              :disabled="!local"
              :title="!local ? t('tools.openExternallyRemote') : undefined"
              @select="emit('openExternal', node)"
            >
              {{ t("tools.openExternally") }}
            </ContextMenuItem>
            <ContextMenuSub v-if="isLinux">
              <ContextMenuSubTrigger class="menu-item" data-action="tree-open-with">
                {{ t("tools.openWith") }} <ChevronRight :size="13" />
              </ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent class="menu-content tool-menu-content" :side-offset="2">
                  <ContextMenuItem
                    v-for="app in openWithApps?.(node) ?? []"
                    :key="app.id"
                    class="menu-item"
                    :data-app="app.id"
                    @select="emit('openWithApp', node, app.id)"
                  >
                    {{ app.name }}
                  </ContextMenuItem>
                  <ContextMenuItem
                    v-if="!(openWithApps?.(node) ?? []).length"
                    class="menu-item"
                    disabled
                    data-app="none"
                  >
                    {{ t("tools.openWithNone") }}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>
            <ContextMenuItem
              v-else
              class="menu-item"
              data-action="tree-open-with"
              @select="emit('openWith', node)"
            >
              {{ t("tools.openWith") }}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuPortal>
      </ContextMenuRoot>
      <FileTree
        :nodes="node.children ?? []"
        :depth="depth + 1"
        :query="query"
        :active-path="activePath"
        :local="local"
        :open-with-apps="openWithApps"
        @open="emit('open', $event)"
        @expand="emit('expand', $event)"
        @copy-path="emit('copyPath', $event)"
        @open-external="emit('openExternal', $event)"
        @open-with="emit('openWith', $event)"
        @open-with-app="(node, appId) => emit('openWithApp', node, appId)"
        @menu-open="emit('menuOpen', $event)"
      />
    </details>
    <ContextMenuRoot v-else @update:open="(open) => open && emit('menuOpen', node)">
      <ContextMenuTrigger as-child>
        <button
          type="button"
          class="tree-file"
          :data-file-path="node.path"
          :class="{ active: node.path === activePath }"
          :style="{ paddingLeft: `${8 + depth * 14}px` }"
          @click="emit('open', node.path)"
        >
          <File :size="14" />
          <span>{{ node.name }}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent class="menu-content tool-menu-content" :side-offset="2">
          <ContextMenuItem class="menu-item" data-action="tree-copy-path" @select="emit('copyPath', node)">
            {{ t("tools.copyPath") }}
          </ContextMenuItem>
          <ContextMenuItem
            class="menu-item"
            data-action="tree-open-external"
            :disabled="!local"
            :title="!local ? t('tools.openExternallyRemote') : undefined"
            @select="emit('openExternal', node)"
          >
            {{ t("tools.openExternally") }}
          </ContextMenuItem>
          <ContextMenuSub v-if="isLinux">
            <ContextMenuSubTrigger class="menu-item" data-action="tree-open-with">
              {{ t("tools.openWith") }} <ChevronRight :size="13" />
            </ContextMenuSubTrigger>
            <ContextMenuPortal>
              <ContextMenuSubContent class="menu-content tool-menu-content" :side-offset="2">
                <ContextMenuItem
                  v-for="app in openWithApps?.(node) ?? []"
                  :key="app.id"
                  class="menu-item"
                  :data-app="app.id"
                  @select="emit('openWithApp', node, app.id)"
                >
                  {{ app.name }}
                </ContextMenuItem>
                <ContextMenuItem
                  v-if="!(openWithApps?.(node) ?? []).length"
                  class="menu-item"
                  disabled
                  data-app="none"
                >
                  {{ t("tools.openWithNone") }}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuPortal>
          </ContextMenuSub>
          <ContextMenuItem
            v-else
            class="menu-item"
            data-action="tree-open-with"
            @select="emit('openWith', node)"
          >
            {{ t("tools.openWith") }}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenuRoot>
  </template>
</template>
