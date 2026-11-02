<script setup lang="ts">
import { Check, ChevronDown, GitBranch, LoaderCircle } from "@lucide/vue";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { isSessionRunning } from "../../shared/session";
import { desktop } from "../api";
import { useLayoutStore } from "../stores/layout";
import { useSessionStore } from "../stores/session";
import { useWorkspaceStore } from "../stores/workspace";

const workspace = useWorkspaceStore();
const session = useSessionStore();
const layout = useLayoutStore();
const { t } = useI18n();
const branches = ref<string[]>([]);
const loading = ref(false);
const error = ref("");
const open = ref(false);
let request = 0;
watch(() => workspace.project, () => { request++; open.value = false; branches.value = []; loading.value = false; }, { flush: "sync" });
const busy = computed(() => Boolean(session.current && isSessionRunning(session.current)) || session.sessions.some(item => item.running));
const unsaved = computed(() => workspace.tabs.some(tab => tab.kind === "file" && tab.document?.content !== tab.savedContent));
const blocked = computed(() => workspace.gitSwitching ? t("tools.gitSwitching") : busy.value ? t("tools.gitBusy") : unsaved.value ? t("tools.gitUnsaved") : "");

async function load(show: boolean) {
  if (!show) return;
  const project = workspace.project;
  const ticket = ++request;
  loading.value = true;
  branches.value = [];
  error.value = "";
  try {
    const [names] = await Promise.all([desktop.invoke<string[]>("git.branches"), workspace.loadGit()]);
    if (workspace.project === project && ticket === request) branches.value = names;
  } catch (failure) {
    if (workspace.project === project && ticket === request) error.value = String(failure);
  } finally { if (ticket === request) loading.value = false; }
}

async function select(branch: string) {
  if (blocked.value) return;
  const project = workspace.project;
  try { await workspace.switchGitBranch(branch); }
  catch (failure) {
    if (workspace.project === project)
      layout.showNotice(failure instanceof Error ? failure.message : String(failure), "error");
  }
}
</script>

<template>
  <DropdownMenuRoot v-if="workspace.project && workspace.git.available" v-model:open="open" @update:open="load">
    <DropdownMenuTrigger as-child>
      <button type="button" class="git-branch-picker" :disabled="Boolean(blocked)"
        :title="blocked || t('tools.gitSwitchHint', { branch: workspace.git.branch })" :aria-label="t('tools.gitSwitch')">
        <LoaderCircle v-if="workspace.gitSwitching" :size="13" class="spin" aria-hidden="true" />
        <GitBranch v-else :size="13" aria-hidden="true" />
        <span>{{ workspace.git.branch || 'HEAD' }}</span><ChevronDown :size="12" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="menu-content git-branch-menu" align="end" :side-offset="5">
        <DropdownMenuLabel class="git-branch-hint">{{ t('tools.gitSwitchScope') }}</DropdownMenuLabel>
        <DropdownMenuLabel v-if="loading">{{ t('tools.gitLoading') }}</DropdownMenuLabel>
        <DropdownMenuLabel v-else-if="error" role="alert">{{ error }}</DropdownMenuLabel>
        <DropdownMenuLabel v-else-if="!branches.length">{{ t('tools.gitNoBranches') }}</DropdownMenuLabel>
        <DropdownMenuItem v-for="branch in branches" :key="branch" class="menu-item"
          :data-git-branch="branch"
          :disabled="Boolean(blocked) || branch === workspace.git.branch" :title="branch" @select="select(branch)">
          <Check v-if="branch === workspace.git.branch" :size="13" /><GitBranch v-else :size="13" />
          <span>{{ branch }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
