import { computed } from "vue";
import { useLayoutStore } from "../../stores/layout";

/**
 * Runtime switch for the experimental operation-history module. Reads the
 * persisted setting so a save in the settings page applies immediately.
 */
export const historyEnabled = computed(
  () => useLayoutStore().settings?.app.experimentalHistory === true,
);
