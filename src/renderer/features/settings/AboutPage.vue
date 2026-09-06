<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { version } from "../../../../package.json";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";

const { t } = useI18n();
const logoSrc = "icon.png";
const repositoryUrl = "https://github.com/huang-sh/PiX";
const error = ref("");

async function openLink(url: string) {
  error.value = "";
  try {
    await desktop.invoke("app.openExternal", { url });
  } catch {
    error.value = t("settings.about.openFailed");
  }
}
</script>

<template>
  <section class="about-page" aria-labelledby="about-name">
    <img class="about-logo" :src="logoSrc" alt="" width="72" height="72" draggable="false" />
    <h2 id="about-name">PiX</h2>
    <p class="about-subtitle">{{ t("settings.about.builtOn") }}</p>
    <p class="about-version">{{ t("settings.about.version", { version }) }}</p>
    <div class="about-actions">
      <Button variant="outline" data-about-updates @click="openLink(`${repositoryUrl}/releases`)">
        {{ t("settings.about.checkUpdates") }}
      </Button>
      <Button variant="outline" data-about-source @click="openLink(repositoryUrl)">
        {{ t("settings.about.sourceFeedback") }}
      </Button>
    </div>
    <p class="about-hint">{{ t("settings.about.updatesHint") }}</p>
    <p v-if="error" class="about-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.about-page { display: flex; flex-direction: column; align-items: center; padding: 46px 0 64px; text-align: center; }
.about-logo { object-fit: contain; border-radius: 18px; }
.about-page h2 { margin: 22px 0 8px; color: var(--text); font-size: 24px; font-weight: 650; line-height: 1.3; }
.about-subtitle, .about-hint { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
.about-version { margin: 26px 0 34px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 14px; }
.about-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; }
.about-actions button { height: auto; min-height: 44px; padding: 10px 22px; border-radius: 11px; font-size: 16px; }
.about-hint { margin-top: 14px; font-size: 13px; }
.about-error { margin: 12px 0 0; color: var(--danger); font-size: 13px; }
</style>
