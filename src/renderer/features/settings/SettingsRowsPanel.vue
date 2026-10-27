<script setup lang="ts">
import { useLayoutStore } from "../../stores/layout";
import SettingRow from "./SettingRow.vue";
import { useI18n } from "vue-i18n";
import { useSettingsDraftContext } from "./settings-context";
import NodeCardSettings from "./NodeCardSettings.vue";

const layout = useLayoutStore();
const { t } = useI18n();
const { rows } = useSettingsDraftContext();
</script>

<template>
  <div v-if="layout.settingsCategory === 'appearance'" class="appearance-settings">
    <section v-for="group in (['interface', 'canvas'] as const)" :key="group" class="settings-card" :data-appearance-group="group">
      <h2 class="settings-group-title">{{ t(`settings.appearanceGroups.${group}`) }}</h2>
      <SettingRow v-for="row in rows.filter(row => row.group === group)" :key="row.path" :row="row" :disabled="row.path === 'theme' && layout.themeSaving" />
    </section>
    <NodeCardSettings />
  </div>
  <section v-else class="settings-card">
    <p v-if="layout.settingsCategory === 'tools'" class="settings-hint">{{ t('settings.mcpHint') }}</p>
    <SettingRow
      v-for="row in rows"
      :key="`${row.scope}:${row.path}`"
      :row="row"
      :disabled="row.path === 'theme' && layout.themeSaving"
    />
  </section>
</template>
