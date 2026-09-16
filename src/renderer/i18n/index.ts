import { createI18n } from "vue-i18n";
import * as app from "./app";
import * as graph from "./graph";
import * as remote from "./remote";
import * as settings from "./settings";
import * as workbench from "./workbench";

export const messages = {
  en: { ...app.en, ...graph.en, ...workbench.en, ...remote.en, ...settings.en },
  "zh-CN": { ...app.zhCN, ...graph.zhCN, ...workbench.zhCN, ...remote.zhCN, ...settings.zhCN },
};

const create = () => createI18n({
  legacy: false,
  locale: navigator.language === "zh-CN" ? "zh-CN" : "en",
  fallbackLocale: "en",
  messages,
});

// Keep the plugin already installed on the app when translations hot-update.
export const i18n: ReturnType<typeof create> = import.meta.hot?.data?.i18n ?? create();
if (import.meta.hot?.data) {
  import.meta.hot.data.i18n = i18n;
  import.meta.hot.accept((updated) => {
    if (!updated) return;
    for (const locale of ["en", "zh-CN"] as const)
      i18n.global.setLocaleMessage(locale, updated.messages[locale]);
  });
  // Vite hands this callback only the domain module that changed; remember the
  // latest of each and recompose so a single-file edit still swaps both locales.
  type Domain = { en: Record<string, any>; zhCN: Record<string, any> };
  const domains: Record<"app" | "graph" | "remote" | "settings" | "workbench", Domain> = { app, graph, remote, settings, workbench };
  const asDomain = (mod: unknown): Domain => mod as Domain;
  import.meta.hot.accept(
    ["./app", "./graph", "./remote", "./settings", "./workbench"],
    ([appMod, graphMod, remoteMod, settingsMod, workbenchMod]) => {
      if (appMod) domains.app = asDomain(appMod);
      if (graphMod) domains.graph = asDomain(graphMod);
      if (remoteMod) domains.remote = asDomain(remoteMod);
      if (settingsMod) domains.settings = asDomain(settingsMod);
      if (workbenchMod) domains.workbench = asDomain(workbenchMod);
      const next: any = {
        en: { ...domains.app.en, ...domains.graph.en, ...domains.workbench.en, ...domains.remote.en, ...domains.settings.en },
        "zh-CN": { ...domains.app.zhCN, ...domains.graph.zhCN, ...domains.workbench.zhCN, ...domains.remote.zhCN, ...domains.settings.zhCN },
      };
      for (const locale of ["en", "zh-CN"] as const)
        i18n.global.setLocaleMessage(locale, next[locale]);
    },
  );
}
