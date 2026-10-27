<script setup lang="ts">
import { computed } from "vue";
import { ArrowDown, ArrowUp } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { DEFAULT_NODE_CARD_FIELDS, OPTIONAL_NODE_CARD_FIELDS, normalizeNodeCardFields, type NodeCardField } from "../../../shared/node-card";
import Button from "../../components/ui/Button.vue";
import { useSettingsDraftContext } from "./settings-context";

const { t } = useI18n();
const { draft, save } = useSettingsDraftContext();
const selected = computed(() => normalizeNodeCardFields(draft.value?.app.nodeCardFields));
const fields = computed(() => [...selected.value, ...OPTIONAL_NODE_CARD_FIELDS.filter(field => !selected.value.includes(field))]);

function update(fields: readonly NodeCardField[]) {
  if (!draft.value) return;
  draft.value.app.nodeCardFields = [...fields];
  save("app");
}
function toggle(field: NodeCardField) {
  update(selected.value.includes(field) ? selected.value.filter(item => item !== field) : [...selected.value, field]);
}
function move(field: NodeCardField, offset: number) {
  const next = [...selected.value];
  const index = next.indexOf(field);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target]!, next[index]!];
  update(next);
}
</script>

<template>
  <section class="settings-card" data-appearance-group="nodeCard">
    <header class="node-card-settings-header">
      <div>
        <h2 class="settings-group-title">{{ t('settings.appearanceGroups.nodeCard') }}</h2>
        <p>{{ t('settings.nodeCard.description') }}</p>
      </div>
      <Button variant="ghost" size="sm" type="button" data-node-card-reset @click="update(DEFAULT_NODE_CARD_FIELDS)">{{ t('settings.nodeCard.reset') }}</Button>
    </header>
    <ol class="node-card-fields" :aria-label="t('settings.nodeCard.fields')">
      <li v-for="field in fields" :key="field" :data-node-card-field="field">
        <label><input type="checkbox" :checked="selected.includes(field)" @change="toggle(field)" /><span>{{ t(`graph.nodeInfo.${field}`) }}</span></label>
        <div v-if="selected.includes(field)" class="node-card-field-order">
          <Button variant="ghost" size="icon" type="button" :disabled="selected.indexOf(field) === 0" :aria-label="t('settings.nodeCard.moveUp', { field: t(`graph.nodeInfo.${field}`) })" data-move="up" @click="move(field, -1)"><ArrowUp :size="14" /></Button>
          <Button variant="ghost" size="icon" type="button" :disabled="selected.indexOf(field) === selected.length - 1" :aria-label="t('settings.nodeCard.moveDown', { field: t(`graph.nodeInfo.${field}`) })" data-move="down" @click="move(field, 1)"><ArrowDown :size="14" /></Button>
        </div>
      </li>
    </ol>
  </section>
</template>
