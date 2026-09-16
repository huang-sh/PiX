import { createI18n } from "vue-i18n";
import { en as appEn, zhCN as appZh } from "./app";
import { en as graphEn, zhCN as graphZh } from "./graph";
import { en as remoteEn, zhCN as remoteZh } from "./remote";
import { en as settingsEn, zhCN as settingsZh } from "./settings";
import { en as workbenchEn, zhCN as workbenchZh } from "./workbench";

export const messages = {
  en: { ...appEn, ...graphEn, ...workbenchEn, ...remoteEn, ...settingsEn },
  "zh-CN": { ...appZh, ...graphZh, ...workbenchZh, ...remoteZh, ...settingsZh },
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
  import.meta.hot.accept(
    ["./app", "./graph", "./remote", "./settings", "./workbench"],
    ([app, graph, remote, settings, workbench]) => {
      if (!app || !graph || !remote || !settings || !workbench) return;
      const next = {
        en: { ...app.en, ...graph.en, ...workbench.en, ...remote.en, ...settings.en },
        "zh-CN": { ...app.zhCN, ...graph.zhCN, ...workbench.zhCN, ...remote.zhCN, ...settings.zhCN },
      };
      for (const locale of ["en", "zh-CN"] as const)
        i18n.global.setLocaleMessage(locale, next[locale]);
    },
  );
}
