<script setup lang="ts">
import { onMounted, ref } from "vue";
import { MonitorUp } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { desktop } from "../../api";
import { useLayoutStore } from "../../stores/layout";
import Button from "../../components/ui/Button.vue";
import SettingRow from "./SettingRow.vue";

interface DeployedWorkspace {
  id: string;
  kind: "ssh" | "wsl";
  target: string;
  path: string;
  connected: boolean;
  pushedProviders: string[];
}

const { t } = useI18n();
const layout = useLayoutStore();
const deployed = ref<DeployedWorkspace[]>([]);
const revoking = ref("");

async function refresh() {
  try {
    deployed.value = await desktop.invoke<DeployedWorkspace[]>("remote.deployed");
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

async function revoke(row: DeployedWorkspace) {
  revoking.value = row.id;
  try {
    const result = await desktop.invoke<{ revoked: string[] }>("remote.revoke", { id: row.id });
    layout.showNotice(t("settings.remote.revoked", { n: result.revoked.length }));
    await refresh();
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    revoking.value = "";
  }
}

onMounted(refresh);
</script>

<template>
  <div>
    <section class="settings-card" :aria-label="t('settings.remote.deploy')">
      <SettingRow
        :row="{
          path: 'deployModelCredentialsToRemote',
          label: t('settings.remote.deploy'),
          scope: 'app',
          type: 'check',
          description: t('settings.remote.deployDesc'),
        }"
      />
      <p class="remote-hint">{{ t("settings.remote.deployHint") }}</p>
    </section>

    <section class="settings-card" :aria-label="t('settings.remote.deployedTitle')">
      <h3 class="remote-subheading">{{ t("settings.remote.deployedTitle") }}</h3>
      <p v-if="deployed.length === 0" class="settings-empty">{{ t("settings.remote.deployedEmpty") }}</p>
      <div v-for="row in deployed" :key="row.id" class="remote-deployed-row">
        <MonitorUp :size="16" aria-hidden="true" />
        <div class="remote-deployed-main">
          <strong>{{ row.target }}</strong>
          <span class="remote-deployed-path">{{ row.path }}</span>
          <span class="remote-deployed-state" :data-connected="row.connected">
            {{ row.connected ? t("settings.remote.hostConnected") : t("settings.remote.hostOffline") }}
          </span>
        </div>
        <div class="remote-deployed-side">
          <span v-if="row.pushedProviders.length">
            {{ t("settings.remote.pushedCount", { n: row.pushedProviders.length }) }}
          </span>
          <Button
            variant="outline"
            :disabled="!row.connected || row.pushedProviders.length === 0 || revoking === row.id"
            @click="revoke(row)"
          >
            {{ revoking === row.id ? t("settings.remote.working") : t("settings.remote.revoke") }}
          </Button>
        </div>
      </div>
      <p class="remote-hint">{{ t("settings.remote.deployedHint") }}</p>
    </section>
  </div>
</template>
