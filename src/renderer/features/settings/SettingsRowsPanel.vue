<script setup lang="ts">
import { useLayoutStore } from "../../stores/layout";
import SettingRow from "./SettingRow.vue";
import { useSettingsDraftContext } from "./settings-context";

const layout = useLayoutStore();
const { rows } = useSettingsDraftContext();
</script>

<template>
  <section class="settings-card">
    <SettingRow
      v-for="row in rows"
      :key="`${row.scope}:${row.path}`"
      :row="row"
      :disabled="row.path === 'theme' && layout.themeSaving"
    />
  </section>
</template>
