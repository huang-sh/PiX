<script setup lang="ts">
import { ListEnd, ScrollText, Wrench } from "@lucide/vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { useI18n } from "vue-i18n";
import PersonasPanel from "./PersonasPanel.vue";
import SettingRow from "./SettingRow.vue";
import SystemPromptSection from "./SystemPromptSection.vue";
import { useSettingsDraftContext } from "./settings-context";

const { t } = useI18n();
const { rows } = useSettingsDraftContext();
const tabs = [
  { id: "prompts", icon: ScrollText },
  { id: "queue", icon: ListEnd },
  { id: "connection", icon: Wrench },
] as const;
</script>

<template>
  <TabsRoot class="agent-settings" default-value="prompts" :unmount-on-hide="false">
    <TabsList class="agent-settings-tabs" :aria-label="t('settings.agentTabsLabel')">
      <TabsTrigger v-for="tab in tabs" :key="tab.id" :value="tab.id" :data-agent-tab="tab.id">
        <component :is="tab.icon" :size="16" aria-hidden="true" />
        {{ t(`settings.agentTabs.${tab.id}`) }}
      </TabsTrigger>
    </TabsList>

    <TabsContent value="prompts" class="agent-settings-panel" data-agent-panel="prompts">
      <section class="settings-card" data-agent-group="personas"><PersonasPanel /></section>
      <section class="settings-card" data-agent-group="style">
        <SettingRow v-for="row in rows.filter(row => row.group === 'prompts')" :key="row.path" :row="row" />
      </section>
      <section class="settings-card" data-agent-group="systemPrompt"><SystemPromptSection /></section>
    </TabsContent>

    <TabsContent value="queue" class="agent-settings-panel" data-agent-panel="queue">
      <section class="settings-card" data-agent-group="queue">
        <header class="agent-settings-card-head">
          <h2>{{ t('settings.agentGroups.queue') }}</h2>
          <p>{{ t('settings.agentGroupHints.queue') }}</p>
        </header>
        <SettingRow v-for="row in rows.filter(row => row.group === 'queue')" :key="row.path" :row="row" />
      </section>
    </TabsContent>

    <TabsContent value="connection" class="agent-settings-panel" data-agent-panel="connection">
      <section v-for="group in (['connection', 'retry'] as const)" :key="group" class="settings-card" :data-agent-group="group">
        <header class="agent-settings-card-head">
          <h2>{{ t(`settings.agentGroups.${group}`) }}</h2>
          <p>{{ t(`settings.agentGroupHints.${group}`) }}</p>
        </header>
        <SettingRow v-for="row in rows.filter(row => row.group === group)" :key="row.path" :row="row" />
      </section>
    </TabsContent>
  </TabsRoot>
</template>
