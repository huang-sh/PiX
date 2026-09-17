<script setup lang="ts">
import { ChevronRight, Folder, LoaderCircle, X } from "@lucide/vue";
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { DirectoryListing, FileNode } from "../../../shared/types";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";

const props = defineProps<{
  open: boolean;
  mode: "project" | "session";
}>();
const emit = defineEmits<{ close: []; pick: [path: string] }>();
const { t } = useI18n();
const path = ref("");
const entries = ref<FileNode[]>([]);
const busy = ref(false);
const error = ref("");

const folders = () => entries.value.filter((entry) => entry.kind === "directory");
const files = () =>
  entries.value.filter(
    (entry) => entry.kind === "file" && entry.name.toLowerCase().endsWith(".jsonl"),
  );

async function browse(target = path.value) {
  busy.value = true;
  error.value = "";
  try {
    const listing = await desktop.invoke<DirectoryListing>("workspace.directories", {
      path: target,
      files: props.mode === "session",
    });
    path.value = listing.path;
    entries.value = listing.entries;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function parentDirectory() {
  const current = path.value.replace(/[\\/]+$/, "");
  const cut = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
  if (cut < 0) return;
  const parent = cut === 0 ? "/" : current.slice(0, cut);
  void browse(parent.length === 2 && parent.endsWith(":") ? `${parent}/` : parent);
}

function choose(entry: FileNode) {
  if (entry.kind === "directory") void browse(entry.path);
  else emit("pick", entry.path);
}

function submit() {
  const value = path.value.trim();
  if (!value || busy.value) return;
  emit("pick", value);
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    path.value = "";
    entries.value = [];
    error.value = "";
    void browse("");
  },
);
</script>

<template>
  <DialogRoot :open="open" @update:open="!$event && emit('close')">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="path-picker" data-path-picker>
        <header>
          <div>
            <DialogTitle>{{ t(mode === "session" ? "pathPicker.importTitle" : "pathPicker.title") }}</DialogTitle>
            <p>{{ t(mode === "session" ? "pathPicker.importHint" : "pathPicker.hint") }}</p>
          </div>
          <Button variant="ghost" size="icon" :aria-label="t('common.close')" @click="emit('close')">
            <X :size="16" />
          </Button>
        </header>
        <form @submit.prevent="mode === 'session' && files().length === 0 ? submit() : browse()">
          <label>
            <span>{{ t("pathPicker.path") }}</span>
            <div class="path-picker-row">
              <input v-model="path" data-path-picker-input autocomplete="off" />
              <Button type="submit" variant="outline" :disabled="busy">
                <LoaderCircle v-if="busy" class="remote-inline-spinner" :size="15" />
                {{ busy ? t("remote.loading") : t("common.go") }}
              </Button>
            </div>
          </label>
        </form>
        <div class="remote-folder-list path-picker-list">
          <button v-if="path" type="button" :disabled="busy" @click="parentDirectory">
            <Folder :size="17" /><span>..</span><small>{{ t("pathPicker.parentDirectory") }}</small>
          </button>
          <button
            v-for="node in folders()"
            :key="node.path"
            type="button"
            :disabled="busy"
            @click="choose(node)"
          >
            <Folder :size="17" /><span>{{ node.name }}</span><ChevronRight :size="15" />
          </button>
          <button
            v-for="node in files()"
            :key="node.path"
            type="button"
            :disabled="busy"
            @click="choose(node)"
          >
            <span /><span>{{ node.name }}</span>
          </button>
          <p v-if="!busy && !folders().length && !files().length" class="remote-empty">
            {{ t("pathPicker.empty") }}
          </p>
        </div>
        <p v-if="error" class="wsl-dialog-error">{{ error }}</p>
        <footer>
          <Button type="button" variant="ghost" @click="emit('close')">{{ t("common.cancel") }}</Button>
          <Button
            v-if="mode === 'project'"
            data-action="path-picker-open"
            type="button"
            :disabled="busy || !path.trim()"
            @click="submit"
          >
            {{ t("welcome.openProject") }}
          </Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
