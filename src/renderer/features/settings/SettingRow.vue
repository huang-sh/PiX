<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { Row } from "./use-settings-draft";
import { useSettingsDraftContext } from "./settings-context";

defineProps<{ row: Row; disabled?: boolean }>();
const { t } = useI18n();
const { value, setValue, rowHint, optionLabel } = useSettingsDraftContext();
</script>

<template>
  <label class="setting-row" :data-setting-path="row.path">
    <span><strong>{{ t(row.label) }}</strong><small>{{ rowHint(row) }}</small></span>
    <input v-if="row.type === 'check'" class="switch" type="checkbox" :checked="Boolean(value(row))" @change="setValue(row, $event)" />
    <select v-else-if="row.type === 'select'" :value="String(value(row))" :disabled="disabled" @change="setValue(row, $event)">
      <option v-for="option in row.options" :key="option" :value="option">{{ optionLabel(option) }}</option>
    </select>
    <input v-else :type="row.type ?? 'text'" :value="String(value(row))" :placeholder="row.placeholder" :min="row.min" :max="row.max" @change="setValue(row, $event)" />
  </label>
</template>
