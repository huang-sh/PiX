<script setup lang="ts">
import { ChartColumn, Wallet } from "@lucide/vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import ProviderBalances from "./ProviderBalances.vue";
import UsagePanel from "./UsagePanel.vue";

const { t } = useI18n();
const tab = ref("statistics");
</script>

<template>
  <TabsRoot v-model="tab" class="settings-tabbed" :unmount-on-hide="false">
    <TabsList class="settings-tabs" :aria-label="t('settings.usage.tabsLabel')">
      <TabsTrigger value="statistics" data-usage-tab="statistics"><ChartColumn :size="16" aria-hidden="true" />{{ t('settings.usage.tabs.statistics') }}</TabsTrigger>
      <TabsTrigger value="balances" data-usage-tab="balances"><Wallet :size="16" aria-hidden="true" />{{ t('settings.usage.tabs.balances') }}</TabsTrigger>
    </TabsList>
    <TabsContent value="statistics" class="settings-tab-panel" data-usage-panel="statistics">
      <UsagePanel />
    </TabsContent>
    <TabsContent value="balances" class="settings-tab-panel" data-usage-panel="balances">
      <section class="settings-card"><ProviderBalances :active="tab === 'balances'" /></section>
    </TabsContent>
  </TabsRoot>
</template>
