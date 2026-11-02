<script setup lang="ts">
import { RefreshCw, Settings2 } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { balanceQuery, type ProviderBalance } from "../../../shared/provider-balances";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";
import { useLayoutStore } from "../../stores/layout";

const { t, locale } = useI18n();
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const layout = useLayoutStore();
const cards = ref<ProviderBalance[]>([]);
const loading = ref(false), error = ref("");
const busy = ref(new Set<string>());
const queries = computed(() => layout.settings?.app.usage?.balanceQueries ?? {});
const form = ref<{ provider: string; url: string; path: string; currency: string; multiplier: number }>();
const saving = ref(false), formError = ref("");
let epoch = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const money = (currency: string, value: number) => new Intl.NumberFormat(locale.value, {
  style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4,
}).format(value);
const time = (value: string) => new Date(value).toLocaleString(locale.value);

async function load(refresh = false) {
  const request = ++epoch;
  loading.value = true;
  busy.value.clear();
  error.value = "";
  try {
    const next = await desktop.invoke<ProviderBalance[]>("usage.balances", { refresh });
    if (request === epoch) cards.value = next;
  } catch {
    if (request === epoch) error.value = t("settings.usage.balancesLoadError");
  } finally { if (request === epoch) loading.value = false; }
}

async function refreshCard(provider: string) {
  if (loading.value || busy.value.has(provider)) return;
  const request = epoch;
  busy.value.add(provider);
  error.value = "";
  try {
    const next = await desktop.invoke<ProviderBalance[]>("usage.balances", { provider, refresh: true });
    if (request === epoch) cards.value = cards.value.flatMap(card => card.provider === provider ? next : [card]);
  } catch {
    if (request === epoch) error.value = t("settings.usage.balancesLoadError");
  } finally { if (request === epoch) busy.value.delete(provider); }
}

function edit(provider: string) {
  formError.value = "";
  form.value = { provider, url: "", path: "data.balance", currency: "USD", multiplier: 1, ...queries.value[provider] };
}

async function save(reset = false) {
  if (!form.value || saving.value) return;
  const draft = { ...form.value };
  formError.value = "";
  let query;
  try { if (!reset) query = balanceQuery(draft); }
  catch { formError.value = t("settings.usage.balanceQueryInvalid"); return; }
  saving.value = true;
  try {
    await layout.updateAppSettings({ usage: { balanceQueries: { [draft.provider]: query ?? null } } });
    form.value = undefined;
  } catch { formError.value = t("settings.usage.balanceQuerySaveError"); }
  finally { saving.value = false; }
}

watch([queries, () => props.active], () => { if (props.active) void load(); });
onMounted(() => {
  if (props.active) void load();
  timer = setInterval(() => {
    if (props.active && document.visibilityState === "visible" && !loading.value && !busy.value.size) void load();
  }, 60_000);
});
onBeforeUnmount(() => { ++epoch; clearInterval(timer); });
</script>

<template>
  <section class="balances" data-provider-balances :aria-busy="loading">
    <header class="balance-head">
      <div><h3>{{ t("settings.usage.balancesTitle") }}</h3><p>{{ t("settings.usage.balancesHint") }}</p></div>
      <Button variant="outline" size="sm" :disabled="loading || !!busy.size" data-balance-refresh-all @click="load(true)">
        <RefreshCw :size="14" :class="{ spin: loading }" />{{ t(loading ? "settings.usage.refreshing" : "settings.usage.refresh") }}
      </Button>
    </header>
    <p v-if="error" role="alert" class="balance-error">{{ error }}</p>
    <p v-if="!loading && !cards.length && !error" class="balance-empty">{{ t("settings.usage.balancesEmpty") }}</p>
    <div v-if="cards.length" class="balance-grid">
      <article v-for="card in cards" :key="card.provider" class="balance-card" :data-balance-provider="card.provider" :aria-busy="busy.has(card.provider)">
        <header><strong>{{ card.name }}</strong><span class="balance-actions">
          <Button variant="ghost" size="icon" :title="t('settings.usage.balanceConfigure')" :aria-label="t('settings.usage.balanceConfigure')" :disabled="saving" :data-balance-configure="card.provider" @click="edit(card.provider)"><Settings2 :size="13" /></Button>
          <Button variant="ghost" size="icon" :disabled="loading || busy.has(card.provider)" :title="t('settings.usage.refresh')" :aria-label="t('settings.usage.refresh')" :data-balance-refresh="card.provider" @click="refreshCard(card.provider)"><RefreshCw :size="13" :class="{ spin: busy.has(card.provider) }" /></Button>
        </span></header>
        <span class="balance-provider-id">{{ card.provider }}</span>
        <div v-for="entry in card.amounts" :key="entry.currency" class="balance-amount" :class="{ depleted: entry.remaining <= 0 }">{{ money(entry.currency, entry.remaining) }}</div>
        <p v-if="card.stale" class="balance-stale">{{ t('settings.usage.balanceStale') }}</p>
        <p v-if="card.error" :class="card.error === 'unsupported' ? 'balance-empty' : 'balance-error'">{{ t(`settings.usage.balanceErrors.${card.error}`) }}</p>
        <time v-if="card.updatedAt" :datetime="card.updatedAt">{{ t('settings.usage.balanceUpdated', { time: time(card.updatedAt) }) }}</time>
      </article>
    </div>
    <form v-if="form" class="balance-form" data-balance-form @submit.prevent="save()">
      <h4>{{ t('settings.usage.balanceConfigure') }} · {{ form.provider }}</h4>
      <p>{{ t('settings.usage.balanceQueryHint') }}</p>
      <label>{{ t('settings.usage.balanceUrl') }}<input v-model="form.url" type="url" required maxlength="2048" placeholder="https://api.example.com/balance" data-balance-url :disabled="saving" /></label>
      <label>{{ t('settings.usage.balancePath') }}<input v-model="form.path" required maxlength="200" placeholder="data.balance" data-balance-path :disabled="saving" /></label>
      <div class="balance-form-row">
        <label>{{ t('settings.usage.balanceCurrency') }}<input v-model="form.currency" required pattern="[A-Z]{3}" maxlength="3" placeholder="USD" data-balance-currency :disabled="saving" /></label>
        <label>{{ t('settings.usage.balanceMultiplier') }}<input v-model.number="form.multiplier" type="number" required step="any" min="0.000000000001" data-balance-multiplier :disabled="saving" /></label>
      </div>
      <p v-if="formError" role="alert" class="balance-error">{{ formError }}</p>
      <footer>
        <Button v-if="queries[form.provider]" type="button" variant="ghost" :disabled="saving" data-balance-reset @click="save(true)">{{ t('settings.usage.balanceReset') }}</Button>
        <span />
        <Button type="button" variant="outline" :disabled="saving" @click="form = undefined">{{ t('common.cancel') }}</Button>
        <Button type="submit" :disabled="saving" data-balance-save>{{ t(saving ? 'settings.saving' : 'common.save') }}</Button>
      </footer>
    </form>
  </section>
</template>

<style scoped>
.balances { display: grid; gap: 12px; padding: 16px; }
.balance-head, .balance-card header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.balance-head > div { min-width: 0; }
.balance-head > button { flex: none; }
h3, h4, p { margin: 0; }
h3, h4 { font-size: 13px; }
.balance-head p, .balance-form p, .balance-empty, time { color: var(--muted); font-size: var(--font-size-caption); }
.balance-head p { margin-top: 5px; }
.balance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 10px; }
.balance-card { display: grid; align-content: start; gap: 5px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.balance-card header strong { font-size: 13px; overflow-wrap: anywhere; }
.balance-actions { display: flex; flex: none; }
.balance-provider-id { color: var(--muted); font-size: 11px; }
.balance-amount { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.balance-error, .depleted { color: var(--danger); }
.balance-error, .balance-stale { font-size: var(--font-size-caption); }
.balance-stale { color: var(--muted); }
.balance-form { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; }
.balance-form label { display: grid; gap: 5px; font-size: 12px; }
.balance-form input { width: 100%; min-width: 0; min-height: 34px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); }
.balance-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.balance-form footer { display: flex; align-items: center; gap: 8px; }
.balance-form footer > span { flex: 1; }
.spin { animation: balance-spin 1s linear infinite; }
@keyframes balance-spin { to { transform: rotate(360deg); } }
</style>
