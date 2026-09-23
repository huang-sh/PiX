<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UsageOverview, UsageRange } from "../../../shared/usage";
import { USAGE_RANGES } from "../../../shared/usage";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";
import { useLayoutStore } from "../../stores/layout";

const { t } = useI18n();
const layout = useLayoutStore();
const range = ref<UsageRange>("30d");
const overview = ref<UsageOverview>();
const loading = ref(false);
const error = ref("");

// Subscription-billed providers (coding plans) the user marked as not billed
// per token; persisted with the app settings, applied by the main process.
const unbilled = computed(
  () => new Set((layout.settings?.app.usage?.unbilledProviders ?? []).map(p => p.toLowerCase())),
);
const providerOf = (model: string) => model.slice(0, model.indexOf("/")) || model;
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

// Costs below a dollar still matter for cheap models, so they keep their
// sub-cent precision instead of collapsing to $0.00.
const fmtCost = (value: number) =>
  value > 0 ? `$${value >= 1 ? value.toFixed(2) : value.toFixed(4)}` : "$0";
// Tooltip suffix marking the estimated portion of one day's cost.
const dayCostTitle = (day: { day: string; cost: number; estimatedCost: number; tokens: number }) =>
  `${day.day}: ${fmtCost(day.cost)}${day.estimatedCost > 0 ? ` (≈${fmtCost(day.estimatedCost)})` : ""} · ${fmtTokens(day.tokens)}`;
const fmtTokens = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const fmtDate = (iso: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

const maxDayCost = computed(() =>
  Math.max(0.000001, ...(overview.value?.days.map((day) => day.cost) ?? [0])),
);
// A paid day never fully disappears in the chart; a free one stays flat.
const barHeight = (cost: number) =>
  cost <= 0 ? "0%" : `${Math.max(3, (cost / maxDayCost.value) * 100)}%`;

async function load() {
  loading.value = true;
  error.value = "";
  try {
    overview.value = await desktop.invoke<UsageOverview>("usage.overview", {
      range: range.value,
    });
  } catch (e) {
    overview.value = undefined;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(range, load);
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
      <Button variant="outline" size="sm" :disabled="loading" data-action="usage-refresh" @click="load">
        <RefreshCw :size="14" :class="{ spin: loading }" /> {{ t(loading ? "settings.usage.refreshing" : "settings.usage.refresh") }}
      </Button>
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
          <small>{{ t("settings.usage.sessions") }}</small>
          <strong>{{ overview.sessionCount }}</strong>
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
        <div class="usage-chart" role="img" :aria-label="t('settings.usage.dailyCostLabel')">
          <div
            v-for="day in overview.days"
            :key="day.day"
            class="usage-bar-col"
            :title="dayCostTitle(day)"
          >
            <div class="usage-bar" :style="{ height: barHeight(day.cost) }"></div>
            <small v-if="day === overview.days[0] || day === overview.days.at(-1)">{{ day.day.slice(5) }}</small>
          </div>
        </div>
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

      <div v-if="overview.sessions.length" class="usage-block">
        <h3>{{ t("settings.usage.sessionsTitle") }}</h3>
        <table class="usage-table">
          <thead>
            <tr>
              <th>{{ t("settings.usage.colSession") }}</th>
              <th>{{ t("settings.usage.colLastActive") }}</th>
              <th>{{ t("settings.usage.colMessages") }}</th>
              <th>{{ t("settings.usage.colTokensIn") }}</th>
              <th>{{ t("settings.usage.colTokensOut") }}</th>
              <th>{{ t("settings.usage.colCost") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in overview.sessions" :key="row.path">
              <td class="usage-model" :title="row.path">{{ row.name || row.firstMessage || row.id }}</td>
              <td>{{ fmtDate(row.modified) }}</td>
              <td>{{ row.messageCount }}</td>
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

      <p class="usage-note">{{ t("settings.usage.costSourceNote") }}</p>
    </template>
  </section>
</template>

<style scoped>
.usage-panel { display: grid; gap: 18px; }
.usage-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
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
.usage-chart {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 120px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.usage-bar-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; gap: 3px; min-width: 0; }
.usage-bar { width: 100%; max-width: 26px; border-radius: 3px 3px 0 0; background: var(--accent); opacity: 0.85; }
.usage-bar-col small { color: var(--muted); font-size: 10px; white-space: nowrap; }
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
.usage-model { font-family: var(--font-mono, monospace); max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
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
