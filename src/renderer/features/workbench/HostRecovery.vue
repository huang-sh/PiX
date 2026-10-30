<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Server, TriangleAlert } from "@lucide/vue";
import type { HostConnectionState } from "../../../shared/host-protocol";
import Button from "../../components/ui/Button.vue";

const props = defineProps<{ state: HostConnectionState; busy: boolean }>();
const emit = defineEmits<{ retry: []; restart: [id: string]; logs: []; quit: [] }>();
const { t } = useI18n();
const confirming = ref(false);
const cancelButton = ref<HTMLButtonElement>();
let timer: ReturnType<typeof setTimeout> | undefined;
const reason = computed(() => {
  const host = props.state.host;
  if (!host?.verified) return "hostRecovery.unavailable";
  if (host.stopping) return "hostRecovery.stopping";
  if (host.running || host.pending || host.commands || host.terminals) return "hostRecovery.tasksActive";
  if (host.clients) return "hostRecovery.clientsActive";
  if (host.remoteConnections) return "hostRecovery.remoteActive";
  return "hostRecovery.versionConflict";
});
watch(() => [props.busy, confirming.value], () => {
  clearTimeout(timer);
  if (!props.busy && !confirming.value) timer = setTimeout(() => emit("retry"), 5000);
}, { immediate: true });
watch(() => props.state.host?.id, () => { confirming.value = false; });
onBeforeUnmount(() => clearTimeout(timer));
async function confirmRestart() {
  confirming.value = true;
  await nextTick();
  cancelButton.value?.focus();
}
function restart() {
  if (props.busy || !props.state.host?.verified) return;
  emit("restart", props.state.host.id);
}
</script>

<template>
  <section class="host-recovery" data-host-recovery aria-labelledby="host-recovery-title">
    <div class="host-recovery-card">
      <div class="host-recovery-icon"><Server :size="26" /></div>
      <p class="host-recovery-eyebrow">PiX {{ state.version }}</p>
      <h1 id="host-recovery-title">{{ t("hostRecovery.title") }}</h1>
      <p class="host-recovery-description">{{ t(reason) }}</p>
      <dl v-if="state.host" class="host-recovery-status" aria-live="polite">
        <div><dt>{{ t("hostRecovery.backgroundVersion") }}</dt><dd>{{ state.host.version }}</dd></div>
        <div v-if="state.host.running !== undefined"><dt>{{ t("hostRecovery.runningTasks") }}</dt><dd>{{ state.host.running }}</dd></div>
        <div v-if="state.host.pending"><dt>{{ t("hostRecovery.pendingTasks") }}</dt><dd>{{ t("hostRecovery.yes") }}</dd></div>
        <div v-if="state.host.commands"><dt>{{ t("hostRecovery.commands") }}</dt><dd>{{ state.host.commands }}</dd></div>
        <div v-if="state.host.terminals"><dt>{{ t("hostRecovery.terminals") }}</dt><dd>{{ state.host.terminals }}</dd></div>
        <div v-if="state.host.clients !== undefined"><dt>{{ t("hostRecovery.otherClients") }}</dt><dd>{{ state.host.clients }}</dd></div>
        <div v-if="state.host.remoteConnections !== undefined"><dt>{{ t("hostRecovery.remoteConnections") }}</dt><dd>{{ state.host.remoteConnections }}</dd></div>
      </dl>
      <template v-if="!confirming">
        <p class="host-recovery-hint">{{ t(state.host?.verified ? "hostRecovery.autoRetry" : "hostRecovery.unverifiedHint") }}</p>
        <div class="host-recovery-actions">
          <Button data-action="host-retry" :disabled="busy" @click="emit('retry')"><RefreshCw :size="15" :class="{ 'host-recovery-spin': busy }" />{{ t(busy ? "hostRecovery.connecting" : "hostRecovery.retry") }}</Button>
          <Button data-action="host-force" variant="outline" :disabled="busy || !state.host?.verified" @click="confirmRestart">{{ t("hostRecovery.restart") }}</Button>
        </div>
      </template>
      <div v-else class="host-recovery-confirm" role="alertdialog" aria-labelledby="host-force-title" aria-describedby="host-force-description" @keydown.esc="!busy && (confirming = false)">
        <h2 id="host-force-title"><TriangleAlert :size="18" />{{ t("hostRecovery.confirmTitle") }}</h2>
        <p id="host-force-description">{{ t("hostRecovery.confirmBody") }}</p>
        <div class="host-recovery-actions">
          <button ref="cancelButton" type="button" class="host-recovery-cancel" data-action="host-force-cancel" :disabled="busy" @click="confirming = false">{{ t("common.cancel") }}</button>
          <Button data-action="host-force-confirm" variant="danger" :disabled="busy" @click="restart">{{ t(busy ? "hostRecovery.restarting" : "hostRecovery.confirmRestart") }}</Button>
        </div>
      </div>
      <details v-if="state.error" class="host-recovery-details"><summary>{{ t("hostRecovery.details") }}</summary><pre>{{ state.error }}</pre></details>
      <footer class="host-recovery-footer">
        <Button variant="ghost" data-action="host-logs" @click="emit('logs')">{{ t("hostRecovery.logs") }}</Button>
        <Button variant="ghost" data-action="host-quit" @click="emit('quit')">{{ t("hostRecovery.quit") }}</Button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.host-recovery { display: flex; flex-direction: column; align-items: center; height: 100%; min-height: 0; overflow: auto; padding: 48px 24px; background: var(--background); color: var(--text); }
.host-recovery-card { width: min(100%, 520px); margin: auto 0; flex-shrink: 0; }
.host-recovery-icon { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 24px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); color: var(--accent); }
.host-recovery-eyebrow { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
h1 { font-size: 24px; font-weight: 600; margin: 0 0 12px; letter-spacing: -.4px; }
.host-recovery-description, .host-recovery-hint { color: var(--muted); font-size: 14px; line-height: 1.7; margin: 0 0 24px; }
.host-recovery-status { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 18px; margin: 0 0 20px; }
.host-recovery-status > div { display: flex; justify-content: space-between; gap: 24px; padding: 6px 0; font-size: 13px; }
dt { color: var(--muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
.host-recovery-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.host-recovery-confirm { border: 1px solid var(--danger); border-radius: 12px; padding: 18px; }
h2 { display: flex; align-items: center; gap: 8px; font-size: 15px; margin: 0 0 12px; font-weight: 600; }
.host-recovery-confirm p { font-size: 13px; line-height: 1.75; margin: 0 0 18px; color: var(--muted); white-space: pre-line; }
.host-recovery-cancel { height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); font-size: 14px; }
.host-recovery-cancel:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.host-recovery-details { margin-top: 24px; color: var(--muted); font-size: 12px; }
.host-recovery-details summary { cursor: pointer; }
.host-recovery-details pre { max-height: 120px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 10px; }
.host-recovery-footer { display: flex; gap: 4px; margin: 24px 0 0 -12px; }
.host-recovery-spin { animation: host-spin 1s linear infinite; } @keyframes host-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .host-recovery-spin { animation: none; } }
</style>
