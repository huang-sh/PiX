<script setup lang="ts">
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";

const emit = defineEmits<{ openProject: [] }>();
const { t } = useI18n();
// Bound at runtime (not compiled by transformAssetUrls) so it resolves
// against the document URL: the public-dir icon.png ships next to the
// built index.html and is served at the dev-server root.
const logoSrc = "icon.png";
</script>

<template>
  <div class="welcome" data-welcome>
    <div class="welcome-hero">
      <span class="welcome-logo-wrap">
        <img class="welcome-logo" :src="logoSrc" alt="PiX" draggable="false" />
      </span>
      <h1 class="welcome-wordmark">PiX</h1>
      <p class="welcome-tagline">{{ t("welcome.tagline") }}</p>
    </div>
    <div class="welcome-actions">
      <Button data-action="welcome-open-project" @click="emit('openProject')">
        {{ t("welcome.openProject") }}
      </Button>
    </div>
  </div>
</template>
