import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue({ template: { transformAssetUrls: false } })],
  test: {
    environment: "jsdom",
    include: ["test/renderer/**/*.test.ts"],
    setupFiles: ["test/renderer/setup.ts"],
    // The DOM-heavy suites run 4s+ each when healthy and get starved further
    // under parallel environment setup; the 5s default times them out spuriously.
    testTimeout: 15_000,
  },
});
