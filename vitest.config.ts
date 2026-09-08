import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue({ template: { transformAssetUrls: false } })],
  test: {
    environment: "jsdom",
    include: ["test/renderer/**/*.test.ts"],
    setupFiles: ["test/renderer/setup.ts"],
  },
});
