<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { LoaderCircle } from "@lucide/vue";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { useI18n } from "vue-i18n";
import type { DesktopEvent, ExtensionDialog } from "../../shared/types";
import { desktop } from "../api";
import { useLayoutStore } from "../stores/layout";
import Button from "./ui/Button.vue";
import MarkdownRenderer from "./MarkdownRenderer.vue";

const { t } = useI18n();
const queue = ref<ExtensionDialog[]>([]);
const current = computed(() => queue.value.find(request => request.kind !== "oauth"));
const oauth = computed(() => queue.value.find(request => request.kind === "oauth"));
const answer = ref("");
const oauthAnswer = ref("");
const busy = ref(false);
let unsubscribe: (() => void) | undefined;
let mounted = false;
let replaying = 0;
const dismissed = new Set<string>();
const disconnected = new Set<string>();
watch(() => current.value?.id, () => { answer.value = current.value?.options?.[0] ?? ""; });
watch(() => oauth.value?.id, () => { oauthAnswer.value = ""; });
function add(request: ExtensionDialog) {
  if (request.projectId && disconnected.has(request.projectId)) return;
  if (!dismissed.has(request.id) && !queue.value.some(item => item.id === request.id)) queue.value.push(request);
}
async function restore() {
  replaying++;
  try {
    const requests = await desktop.invoke<ExtensionDialog[]>("ui.pending");
    if (mounted) requests.forEach(add);
  } catch { /* A disconnected host will publish requests after reconnecting. */ }
  finally { if (--replaying === 0) dismissed.clear(); }
}
function onEvent(event: DesktopEvent) {
  if (event.type === "ui.request") add(event.payload as ExtensionDialog);
  if (event.type === "ui.dismiss") {
    const { id } = event.payload as { id: string };
    if (replaying) dismissed.add(id);
    queue.value = queue.value.filter(item => item.id !== id);
  }
  if (event.type === "remote.connection") {
    const { projectId, connected } = event.payload as { projectId: string; connected: boolean };
    if (connected) { disconnected.delete(projectId); void restore(); }
    else { disconnected.add(projectId); queue.value = queue.value.filter(item => item.projectId !== projectId); }
  }
}
async function respond(cancel = false, request = current.value, value = answer.value) {
  if (!request || busy.value) return;
  busy.value = true;
  try {
    await desktop.invoke("ui.respond", { id: request.id, projectId: request.projectId,
      value: cancel ? undefined : request.kind === "confirm" ? "yes" : value });
    queue.value = queue.value.filter(item => item.id !== request.id);
  } catch (error) {
    useLayoutStore().showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally { busy.value = false; }
}
onMounted(() => { mounted = true; unsubscribe = desktop.onEvent(onEvent); void restore(); });
onBeforeUnmount(() => { mounted = false; unsubscribe?.(); });
</script>

<template>
  <DialogRoot :open="!!current" @update:open="open => { if (!open) void respond(true); }">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent v-if="current" class="rename-dialog extension-dialog" data-extension-dialog>
        <DialogTitle>{{ current.title }}</DialogTitle>
        <DialogDescription class="dialog-source">{{ current.source }}</DialogDescription>
        <MarkdownRenderer v-if="current.message" :content="current.message" :custom-id="current.id" />
        <form @submit.prevent="respond()">
          <select v-if="current.kind === 'select'" v-model="answer" :aria-label="current.title">
            <option v-for="option in current.options" :key="option" :value="option">{{ option }}</option>
          </select>
          <input v-else-if="current.kind === 'input'" v-model="answer" :placeholder="current.placeholder" :aria-label="current.title" autocomplete="off" />
          <footer>
            <Button type="button" variant="ghost" :disabled="busy" @click="respond(true)">{{ t('common.cancel') }}</Button>
            <Button type="submit" :disabled="busy">{{ t('common.continue') }}</Button>
          </footer>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <section v-if="oauth" :key="oauth.id" class="oauth-notice" data-oauth-notice :aria-label="t('oauth.waiting')">
    <div class="oauth-status" role="status">
      <LoaderCircle class="spin" :size="18" aria-hidden="true" />
      <div><strong>{{ t('oauth.waiting') }}</strong><span>{{ oauth.source }}</span></div>
    </div>
    <p>{{ t('oauth.browserHint') }}</p>
    <details>
      <summary>{{ t('oauth.manualFallback') }}</summary>
      <form @submit.prevent="oauthAnswer.trim() && respond(false, oauth, oauthAnswer.trim())">
        <p>{{ t('oauth.manualHint') }}</p>
        <p v-if="oauth.placeholder">{{ t('oauth.manualAddressHint', { url: oauth.placeholder }) }}</p>
        <label :for="`oauth-answer-${oauth.id}`">{{ t('oauth.redirectUrl') }}</label>
        <input :id="`oauth-answer-${oauth.id}`" v-model="oauthAnswer" :placeholder="oauth.placeholder ? `${oauth.placeholder}?code=…&state=…&client_id=…` : undefined" autocomplete="off" :disabled="busy" />
        <footer><Button type="submit" size="sm" :disabled="busy || !oauthAnswer.trim()">{{ t('common.continue') }}</Button></footer>
      </form>
    </details>
    <footer><Button type="button" variant="ghost" size="sm" :disabled="busy" @click="respond(true, oauth)">{{ t('oauth.cancel') }}</Button></footer>
  </section>
</template>

<style scoped>
.extension-dialog { max-height: 80vh; overflow: auto; }
.dialog-source { margin: 0 0 12px; overflow-wrap: anywhere; color: var(--muted); font-size: var(--font-size-caption); }
select { width: 100%; height: 39px; padding: 0 11px; }
.oauth-notice { position: fixed; right: 16px; bottom: 16px; z-index: 140; width: min(380px, calc(100vw - 32px)); max-height: calc(100vh - 80px); overflow: auto; padding: 16px; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow); }
.oauth-status { display: flex; align-items: center; gap: 10px; }
.oauth-status > svg { flex-shrink: 0; color: var(--accent); }
.oauth-status > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.oauth-status span { color: var(--muted); font-size: var(--font-size-caption); overflow-wrap: anywhere; }
.oauth-notice p { margin: 12px 0; color: var(--muted); font-size: var(--font-size-small); line-height: 1.6; }
.oauth-notice summary { cursor: pointer; color: var(--text); font-size: var(--font-size-small); }
.oauth-notice label { display: block; margin-bottom: 6px; font-size: var(--font-size-small); }
.oauth-notice input { width: 100%; height: 39px; padding: 0 11px; }
.oauth-notice footer { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
