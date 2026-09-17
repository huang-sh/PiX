import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("src/renderer"),
  publicDir: resolve("resources"),
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === "webview" } } }),
    tailwindcss(),
  ],
  build: {
    outDir: resolve("out/renderer"),
    emptyOutDir: true,
    rollupOptions: { input: resolve("src/renderer/index.html") },
  },
  server: { host: "127.0.0.1" },
});
