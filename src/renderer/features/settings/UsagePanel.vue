<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UsageDayRow, UsageOverview, UsageRange } from "../../../shared/usage";
import { USAGE_RANGES } from "../../../shared/usage";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";
import { useLayoutStore } from "../../stores/layout";

const { t } = useI18n();
const layout = useLayoutStore();
const range = ref<UsageRange>("30d");
const scope = ref<"project" | "all">("project");
const overview = ref<UsageOverview>();
const loading = ref(false);
const error = ref("");

// Subscription-billed providers (coding plans) the user marked as not billed
// per token; persisted with the app settings, applied by the main process.
const unbilled = computed(
  () => new Set((layout.settings?.app.usage?.unbilledProviders ?? []).map(p => p.toLowerCase())),
);
const providerOf = (model: string) => {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
};
async function toggleBilling(provider: string) {
  if (!provider) return;
  const next = new Set(unbilled.value);
  next.has(provider.toLowerCase()) ? next.delete(provider.toLowerCase()) : next.add(provider.toLowerCase());
  try {
    await layout.updateAppSettings({ usage: { unbilledProviders: [...next] } });
    await load();
  } catch (e) {
    layout.showNotice(e instanceof Error ? e.message : String(e), "error");
  }
}

const rangeLabels: Record<UsageRange, string> = {
  today: "settings.usage.rangeToday",
  "7d": "settings.usage.range7d",
  "30d": "settings.usage.range30d",
  all: "settings.usage.rangeAll",
};
const scopeLabels: Record<"project" | "all", string> = {
  project: "settings.usage.scopeProject",
  all: "settings.usage.scopeAll",
};

// Costs below a dollar still matter for cheap models, so they keep their
// sub-cent precision instead of collapsing to $0.00.
const fmtCost = (value: number) =>
  value > 0 ? `$${value >= 1 ? value.toFixed(2) : value.toFixed(4)}` : "$0";
const fmtTokens = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const fmtMonth = new Intl.DateTimeFormat(undefined, { month: "short" }).format;
// Tooltip of one heatmap day: tokens lead because the cell color tracks them.
const dayTitle = (day: UsageDayRow) =>
  `${day.day}: ${fmtTokens(day.tokens)} · ${fmtCost(day.cost)}${day.estimatedCost > 0 ? ` (≈${fmtCost(day.estimatedCost)})` : ""}`;

// GitHub-contributions-style weeks: Monday-first columns, month initials on
// the columns where a month begins, hollow cells for days without usage.
const heatWeeks = computed(() => {
  const days = overview.value?.days ?? [];
  const weeks: Array<{ label: string; cells: Array<UsageDayRow | null> }> = [];
  let week: Array<UsageDayRow | null> = [];
  if (days.length)
    for (let i = 0; i < (new Date(`${days[0]!.day}T00:00:00`).getDay() + 6) % 7; i++)
      week.push(null);
  for (const day of days) {
    week.push(day);
    if (week.length === 7) {
      weeks.push({ label: "", cells: week });
      week = [];
    }
  }
  if (week.length) weeks.push({ label: "", cells: week });
  let lastMonth = -1;
  for (const column of weeks) {
    const first = column.cells.find(Boolean);
    if (!first) continue;
    const date = new Date(`${first.day}T00:00:00`);
    if (date.getMonth() !== lastMonth) {
      lastMonth = date.getMonth();
      column.label = fmtMonth(date);
    }
  }
  return weeks;
});
const maxDayTokens = computed(() =>
  Math.max(1, ...(overview.value?.days.map((day) => day.tokens) ?? [0])),
);
// Five steps against the busiest day; days without usage stay hollow.
// Fills are GitHub's contribution greens (light scheme, with a dark-scheme
// set below), keyed by data attribute so plain colors style the cells.
const heatLevel = (day: UsageDayRow) =>
  day.tokens <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((4 * day.tokens) / maxDayTokens.value)));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    overview.value = await desktop.invoke<UsageOverview>("usage.overview", {
      range: range.value,
      scope: scope.value,
    });
  } catch (e) {
    overview.value = undefined;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([range, scope], load);
</script>

<template>
  <section class="settings-card usage-panel" data-usage-settings>
    <div class="settings-toolbar usage-toolbar">
      <div class="usage-ranges" role="group" :aria-label="t('settings.usage.cost')">
        <button
          v-for="option in USAGE_RANGES"
          :key="option"
          type="button"
          :class="{ active: range === option }"
          :data-usage-range="option"
          @click="range = option"
        >
          {{ t(rangeLabels[option]) }}
        </button>
      </div>
      <div class="usage-toolbar-right">
        <div class="usage-ranges" role="group" :aria-label="t('settings.usage.scopeLabel')">
          <button
            v-for="option in (['project', 'all'] as const)"
            :key="option"
            type="button"
            :class="{ active: scope === option }"
            :data-usage-scope="option"
            @click="scope = option"
          >
            {{ t(scopeLabels[option]) }}
          </button>
        </div>
        <Button variant="outline" size="sm" :disabled="loading" data-action="usage-refresh" @click="load">
          <RefreshCw :size="14" :class="{ spin: loading }" /> {{ t(loading ? "settings.usage.refreshing" : "settings.usage.refresh") }}
        </Button>
      </div>
    </div>

    <p v-if="error" class="usage-feedback" role="alert">{{ error }}</p>
    <p v-else-if="overview && !overview.sessionCount" class="usage-feedback" role="status">
      {{ t("settings.usage.empty") }}
    </p>

    <template v-if="overview">
      <div class="usage-cards">
        <div class="usage-card usage-card-cost">
          <small>{{ t("settings.usage.cost") }}</small>
          <strong>{{ fmtCost(overview.totals.cost) }}</strong>
          <em
            v-if="overview.estimatedCost > 0"
            class="usage-est-note"
            :title="t('settings.usage.estimatedTip', { v: fmtCost(overview.estimatedCost) })"
          >≈ {{ t("settings.usage.includesEstimated", { v: fmtCost(overview.estimatedCost) }) }}</em>
        </div>
        <div class="usage-card">
          <small>{{ t("settings.usage.todayCost") }}</small>
          <strong>{{ fmtCost(overview.today.cost) }}</strong>
        </div>
        <div class="usage-card">
          <small>{{ t("settings.usage.tokensIn") }}</small>
          <strong>{{ fmtTokens(overview.totals.input) }}</strong>
        </div>
        <div class="usage-card">
          <small>{{ t("settings.usage.tokensOut") }}</small>
          <strong>{{ fmtTokens(overview.totals.output) }}</strong>
        </div>
        <div class="usage-card">
          <small>{{ t("settings.usage.cacheRead") }}</small>
          <strong>{{ fmtTokens(overview.totals.cacheRead) }}</strong>
        </div>
        <div class="usage-card">
          <small>{{ t("settings.usage.cacheWrite") }}</small>
          <strong>{{ fmtTokens(overview.totals.cacheWrite) }}</strong>
        </div>
      </div>

      <div v-if="overview.days.length" class="usage-block">
        <h3>{{ t("settings.usage.dailyTitle") }}</h3>
        <div class="usage-heat" role="img" :aria-label="t('settings.usage.dailyCostLabel')">
          <div class="usage-heat-months">
            <span v-for="(column, index) in heatWeeks" :key="index">{{ column.label }}</span>
          </div>
          <div class="usage-heat-grid">
            <div v-for="(column, index) in heatWeeks" :key="index" class="usage-heat-week">
              <div
                v-for="(day, slot) in column.cells"
                :key="slot"
                class="usage-heat-cell"
                :class="{ empty: !day || heatLevel(day) === 0 }"
                :data-heat-level="day ? heatLevel(day) : undefined"
                :title="day ? dayTitle(day) : undefined"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="scope === 'all' && overview.projects.length" class="usage-block">
        <h3>{{ t("settings.usage.projectsTitle") }}</h3>
        <table class="usage-table">
          <thead>
            <tr>
              <th>{{ t("settings.usage.colProject") }}</th>
              <th>{{ t("settings.usage.sessions") }}</th>
              <th>{{ t("settings.usage.colTokensIn") }}</th>
              <th>{{ t("settings.usage.colTokensOut") }}</th>
              <th>{{ t("settings.usage.colCost") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in overview.projects" :key="row.id">
              <td class="usage-model" :title="row.path">{{ row.name }}</td>
              <td>{{ row.sessions }}</td>
              <td>{{ fmtTokens(row.usage.input) }}</td>
              <td>{{ fmtTokens(row.usage.output) }}</td>
              <td>
                {{ fmtCost(row.usage.cost) }}<em
                  v-if="row.estimatedCost > 0"
                  class="usage-est-mark"
                  :title="t('settings.usage.estimatedTip', { v: fmtCost(row.estimatedCost) })"
                >≈</em>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="overview.models.length" class="usage-block">
        <h3>{{ t("settings.usage.modelsTitle") }}</h3>
        <table class="usage-table">
          <thead>
            <tr>
              <th>{{ t("settings.usage.colModel") }}</th>
              <th>{{ t("settings.usage.colTokensIn") }}</th>
              <th>{{ t("settings.usage.colTokensOut") }}</th>
              <th>{{ t("settings.usage.colCacheR") }}</th>
              <th>{{ t("settings.usage.colCacheW") }}</th>
              <th>{{ t("settings.usage.colCost") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in overview.models" :key="row.model">
              <td class="usage-model">
                {{ row.model }}
                <button
                  type="button"
                  class="usage-sub"
                  :class="{ on: unbilled.has(providerOf(row.model)) }"
                  :title="t('settings.usage.subMarkTitle')"
                  :data-usage-sub="providerOf(row.model)"
                  @click="toggleBilling(providerOf(row.model))"
                >{{ t("settings.usage.subMark") }}</button>
              </td>
              <td>{{ fmtTokens(row.usage.input) }}</td>
              <td>{{ fmtTokens(row.usage.output) }}</td>
              <td>{{ fmtTokens(row.usage.cacheRead) }}</td>
              <td>{{ fmtTokens(row.usage.cacheWrite) }}</td>
              <td>
                <template v-if="unbilled.has(providerOf(row.model))">—</template>
                <template v-else>
                  {{ fmtCost(row.usage.cost) }}<em
                    v-if="row.estimatedCost > 0"
                    class="usage-est-mark"
                    :title="t('settings.usage.estimatedTip', { v: fmtCost(row.estimatedCost) })"
                  >≈</em>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="usage-note">{{ t("settings.usage.costSourceNote") }}</p>
    </template>
  </section>
</template>

<style scoped>
.usage-panel { display: grid; gap: 18px; }
.usage-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.usage-toolbar-right { display: flex; align-items: center; gap: 10px; }
.usage-ranges { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.usage-ranges button {
  padding: 5px 12px;
  border: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-size: var(--font-size-caption);
  cursor: pointer;
}
.usage-ranges button:last-child { border-right: 0; }
.usage-ranges button.active { background: var(--accent); color: var(--accent-foreground); }
.usage-feedback { color: var(--muted); font-size: 13px; }
.usage-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
.usage-card {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.usage-card small { color: var(--muted); font-size: var(--font-size-caption); }
.usage-card strong { font-size: 17px; font-variant-numeric: tabular-nums; }
.usage-card-cost strong { color: var(--accent-strong, var(--accent)); }
.usage-est-note { color: var(--muted); font-size: var(--font-size-caption); font-style: normal; }
.usage-est-mark { margin-left: 4px; color: var(--muted); font-style: normal; cursor: help; }
.usage-block { display: grid; gap: 8px; }
.usage-block h3 { margin: 0; font-size: 13px; font-weight: 600; }
.usage-heat {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  overflow-x: auto;
}
.usage-heat-months { display: flex; gap: 2px; }
.usage-heat-months span {
  width: 13px;
  flex: 0 0 13px;
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}
.usage-heat-grid { display: flex; gap: 2px; }
.usage-heat-week { display: grid; grid-template-rows: repeat(7, 13px); gap: 2px; }
.usage-heat-cell { width: 13px; height: 13px; border-radius: 3px; }
.usage-heat-cell.empty { border: 1px solid var(--border); }
.usage-heat-cell[data-heat-level="1"] { background: #9be9a8; }
.usage-heat-cell[data-heat-level="2"] { background: #40c463; }
.usage-heat-cell[data-heat-level="3"] { background: #30a14e; }
.usage-heat-cell[data-heat-level="4"] { background: #216e39; }
:global(:root[data-color-scheme="dark"]) .usage-heat-cell[data-heat-level="1"] { background: #0e4429; }
:global(:root[data-color-scheme="dark"]) .usage-heat-cell[data-heat-level="2"] { background: #006d32; }
:global(:root[data-color-scheme="dark"]) .usage-heat-cell[data-heat-level="3"] { background: #26a641; }
:global(:root[data-color-scheme="dark"]) .usage-heat-cell[data-heat-level="4"] { background: #39d353; }
.usage-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.usage-table th {
  position: sticky;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: var(--font-size-caption);
  font-weight: 500;
  text-align: right;
  white-space: nowrap;
}
.usage-table th:first-child, .usage-table td:first-child { text-align: left; padding-left: 0; }
.usage-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.usage-model { font-family: var(--font-mono, monospace); max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
.usage-sub {
  margin-left: 7px;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
}
.usage-sub:hover { border-color: var(--accent); color: var(--text); }
.usage-sub.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-strong, var(--accent)); }
.usage-note { margin: 0; color: var(--muted); font-size: var(--font-size-caption); }
.spin { animation: usage-spin 1s linear infinite; }
@keyframes usage-spin { to { transform: rotate(360deg); } }
</style>
