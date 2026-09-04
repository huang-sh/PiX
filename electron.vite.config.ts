import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve("src/main/index.ts") },
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
