<script setup lang="ts">
import { Check, Lock, RotateCcw, X } from "@lucide/vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { shortcutsBlocked } from "../../keyboard-shortcuts";
import { relativeTimeUnit } from "../../lib/relative-time";
import type { HistoryEntry } from "./store";
import {
  closePanel,
  history,
  lockIndex,
  redoTo,
  undoDepth,
  undoTo,
} from "./store";

const { t } = useI18n();

// "3 minutes ago" goes stale while the panel sits open; tick the clock so
// template reads re-render.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

function relative(ts: number): string {
  const { unit, n } = relativeTimeUnit(now.value - ts);
  return t(`time.${unit}`, { n });
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

// Escape belongs to whatever dialog or editable owns the focus; the panel
// only closes on an Esc nobody else claimed.
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !history.panelOpen) return;
  if (shortcutsBlocked(event)) return;
  closePanel();
}

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
  clock = setInterval(() => { now.value = Date.now(); }, 30_000);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  if (clock) clearInterval(clock);
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

<style scoped>
/* ── history panel ─────────────────────────────────────────────────── */

.history-panel {
  position: fixed;
  top: 56px;
  right: 12px;
  width: 380px;
  max-height: calc(100vh - 176px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  z-index: 160;
  color: var(--text);
  font-size: var(--font-size-small);
  overflow: hidden;
}

.history-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}

.history-panel-title {
  font-size: var(--font-size-ui);
  font-weight: 700;
  color: var(--text);
  flex-shrink: 0;
}

.history-panel-meta {
  font-size: var(--font-size-caption);
  color: var(--faint);
  flex-shrink: 0;
}

.history-panel-close {
  margin-left: auto;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--muted);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.history-panel-close:hover {
  background: color-mix(in srgb, var(--muted-surface) 60%, transparent);
  color: var(--text);
}

.history-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.history-panel-empty {
  padding: 28px 14px;
  text-align: center;
  color: var(--faint);
  font-size: var(--font-size-small);
}

.history-separator {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
}

.history-separator-line {
  flex: 1;
  height: 1px;
  background: var(--border);
}

.history-separator-text {
  font-size: 11px;
  font-weight: 600;
  color: var(--faint);
  white-space: nowrap;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0 10px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: none;
  color: var(--text);
  font-size: var(--font-size-small);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}

.history-row:hover:not(:disabled) {
  background: color-mix(in srgb, var(--muted-surface) 80%, transparent);
}

.history-row:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.history-row-undone {
  color: var(--muted);
}

.history-row-locked {
  color: var(--faint);
}

.history-row-lock {
  color: var(--muted);
}

.history-row-failed {
  color: var(--danger);
}

.history-row-icon {
  flex: 0 0 auto;
  width: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}

.history-row-failed .history-row-icon {
  color: var(--danger);
}

.history-row-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-row-time {
  flex: 0 0 auto;
  font-size: var(--font-size-caption);
  color: var(--faint);
  white-space: nowrap;
  margin-left: auto;
}

.history-panel-foot {
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--faint);
  text-align: center;
}
</style>
