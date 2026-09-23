<script setup lang="ts">
import { Folder, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useExtensionsContext, useSettingsInspector } from "./settings-context";

const { t } = useI18n();
const { close, registerCloseButton } = useSettingsInspector();
const { selectedExtension, extensionName } = useExtensionsContext();
</script>

<template>
  <aside v-if="selectedExtension" id="extension-details-panel" class="settings-inspector extension-inspector" aria-labelledby="extension-details-title" @keydown.esc.stop="close">
    <header class="settings-inspector-header">
      <div><small>{{ t("settings.extensionDetails") }}</small><h2 id="extension-details-title">{{ extensionName(selectedExtension.path) }}</h2><span>{{ selectedExtension.source }}</span></div>
      <button :ref="registerCloseButton" type="button" class="settings-inspector-close" :aria-label="t('common.close')" @click="close"><X :size="18" /></button>
    </header>
    <div :key="selectedExtension.resolvedPath" class="settings-inspector-body extension-detail-body" tabindex="0" :aria-label="t('settings.extensionDetails')">
      <span class="extension-scope-badge">{{ t(`settings.extensionFilters.${selectedExtension.scope}`) }}</span>
      <p v-if="selectedExtension.bundled" class="extension-no-capabilities">{{ t("settings.extensionBundledNote") }}</p>
      <div class="extension-path"><strong><Folder :size="13" />{{ t("settings.extensionLocation") }}</strong><code>{{ selectedExtension.resolvedPath }}</code></div>
      <div v-if="selectedExtension.tools.length || selectedExtension.commands.length" class="extension-capabilities">
        <section v-if="selectedExtension.tools.length"><h3>{{ t("settings.extensionTools", { n: selectedExtension.tools.length }) }}</h3><div v-for="tool in selectedExtension.tools" :key="tool.name" class="extension-capability"><code>{{ tool.name }}</code><p v-if="tool.description">{{ tool.description }}</p></div></section>
        <section v-if="selectedExtension.commands.length"><h3>{{ t("settings.extensionCommands", { n: selectedExtension.commands.length }) }}</h3><div v-for="command in selectedExtension.commands" :key="command.name" class="extension-capability"><code>/{{ command.name }}</code><p v-if="command.description">{{ command.description }}</p></div></section>
      </div>
      <p v-else class="extension-no-capabilities">{{ t("settings.extensionNoCapabilities") }}</p>
    </div>
  </aside>
</template>
