import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/minimap/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";
import { desktop } from "./api";
import { startTheme } from "./theme";

const stopTheme = startTheme(desktop.initialTheme ?? "light");
window.addEventListener("unload", stopTheme, { once: true });

createApp(App).use(createPinia()).use(i18n).mount("#app");
