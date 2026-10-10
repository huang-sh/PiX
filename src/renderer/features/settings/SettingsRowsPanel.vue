<script setup lang="ts">
import { useLayoutStore } from "../../stores/layout";
import SettingRow from "./SettingRow.vue";
import { useI18n } from "vue-i18n";
import { useSettingsDraftContext } from "./settings-context";

const layout = useLayoutStore();
const { t } = useI18n();
const { rows } = useSettingsDraftContext();
</script>

<template>
  <section class="settings-card">
    <p v-if="layout.settingsCategory === 'tools'" class="settings-hint">{{ t('settings.mcpHint') }}</p>
    <SettingRow
      v-for="row in rows"
      :key="`${row.scope}:${row.path}`"
      :row="row"
      :disabled="row.path === 'theme' && layout.themeSaving"
    />
  </section>
</template>
