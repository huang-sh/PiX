import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve("src/main/index.ts"), "graph-export-worker": resolve("src/main/graph-export-worker.ts") } },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    publicDir: resolve("resources"),
    plugins: [
      vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === "webview" } } }),
      tailwindcss(),
    ],
    build: {
      rollupOptions: { input: resolve("src/renderer/index.html") },
    },
  },
});
