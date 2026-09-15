<script setup lang="ts">
import { Check, Lock, RotateCcw, X } from "@lucide/vue";
import { computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import type { HistoryEntry } from "../stores/history";
import {
  closePanel,
  history,
  lockIndex,
  redoTo,
  undoDepth,
  undoTo,
} from "../stores/history";

const { t } = useI18n();

function relative(ts: number): string {
  const elapsed = Math.max(0, Date.now() - ts);
  if (elapsed < 60_000) return t("time.now");
  if (elapsed < 3_600_000) return t("time.minutes", { n: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t("time.hours", { n: Math.floor(elapsed / 3_600_000) });
  return t("time.days", { n: Math.floor(elapsed / 86_400_000) });
}

interface PanelRow {
  kind: "entry" | "separator";
  label?: string;
  entry?: HistoryEntry;
  icon?: typeof Check;
  applied?: boolean;
  locked?: boolean;
  failed?: boolean;
  clickable?: boolean;
}

const rows = computed<PanelRow[]>(() => {
  const { entries, cursor } = history;
  if (entries.length === 0) return [];

  const li = lockIndex();
  const result: PanelRow[] = [];
  let insertLockSep = false;
  let prevApplied = true;

  // Newest first: entries[length-1] first, entries[0] last.
  for (let d = 0; d < entries.length; d += 1) {
    const oi = entries.length - 1 - d;
    const entry = entries[oi];
    if (!entry) continue;

    const applied = oi < cursor;

    // "Current position" separator: the applied block starts after an
    // undone one.
    if (applied && !prevApplied) {
      result.push({ kind: "separator", label: t("history.panel.currentPosition") });
    }
    prevApplied = applied;

    if (!entry.undoable) {
      if (li >= 0) insertLockSep = true;
    } else if (insertLockSep) {
      result.push({ kind: "separator", label: t("history.panel.lockedBelow") });
      insertLockSep = false;
    }

    const isLocked = applied && li >= 0 && oi <= li;
    const clickable = !history.busy && entry.undoable && !isLocked;

    let Icon: typeof Check;
    if (!entry.undoable) Icon = Lock;
    else if (applied) Icon = Check;
    else Icon = RotateCcw;

    result.push({
      kind: "entry",
      entry,
      icon: Icon,
      applied,
      locked: isLocked,
      failed: entry.failed,
      clickable,
    });
  }

  return result;
});

function rowTitle(row: PanelRow): string {
  if (!row.entry) return "";
  const abs = new Date(row.entry.time).toLocaleString();
  let title = abs;
  if (!row.entry.undoable || row.locked) {
    title += ` — ${t("history.panel.lockedTooltip")}`;
  }
  if (row.entry.failed) {
    title += ` — ${t("history.panel.failedTooltip")}`;
  }
  return title;
}

function onRowClick(row: PanelRow): void {
  if (!row.clickable || !row.entry) return;
  void (row.applied ? undoTo(row.entry.id) : redoTo(row.entry.id));
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && history.panelOpen) closePanel();
}

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="history.panelOpen" class="history-panel" :aria-label="t('history.panel.title')">
    <div class="history-panel-head">
      <strong class="history-panel-title">{{ t("history.panel.title") }}</strong>
      <span class="history-panel-meta">
        {{ t("history.panel.meta", { n: history.entries.length, depth: undoDepth() }) }}
      </span>
      <button
        type="button"
        class="history-panel-close"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="closePanel()"
      >
        <X :size="14" />
      </button>
    </div>
    <div class="history-panel-body">
      <p v-if="history.entries.length === 0" class="history-panel-empty">
        {{ t("history.panel.empty") }}
      </p>
      <template v-else>
        <div
          v-for="(row, idx) in rows"
          :key="row.kind === 'separator' ? `sep-${idx}` : `entry-${row.entry!.id}`"
        >
          <div v-if="row.kind === 'separator'" class="history-separator">
            <span class="history-separator-line" />
            <span class="history-separator-text">{{ row.label }}</span>
            <span class="history-separator-line" />
          </div>
          <button
            v-else
            type="button"
            class="history-row"
            :class="{
              'history-row-applied': row.applied,
              'history-row-undone': !row.applied && !row.failed,
              'history-row-locked': row.locked,
              'history-row-lock': !row.entry!.undoable,
              'history-row-failed': row.failed,
            }"
            :title="rowTitle(row)"
            :disabled="!row.clickable"
            @click="onRowClick(row)"
          >
            <span class="history-row-icon"><component :is="row.icon" :size="14" /></span>
            <span class="history-row-label">{{ row.entry!.label }}</span>
            <span class="history-row-time">{{ relative(row.entry!.time) }}</span>
          </button>
        </div>
      </template>
    </div>
    <div class="history-panel-foot">
      {{ t("history.panel.footer") }}
    </div>
  </div>
  </Teleport>
</template>
