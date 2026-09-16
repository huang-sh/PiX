import { createI18n } from "vue-i18n";
import * as app from "./app";
import * as graph from "./graph";
import * as remote from "./remote";
import * as settings from "./settings";
import * as workbench from "./workbench";
import { composeMessages, onDomainChange, setDomains } from "./registry";

setDomains({ app, graph, workbench, remote, settings });

export const messages = composeMessages();

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
  const setMessages = (msgs: ReturnType<typeof composeMessages>) => {
    for (const locale of ["en", "zh-CN"] as const)
      i18n.global.setLocaleMessage(locale, msgs[locale]);
  };
  // Domain modules self-accept their own edits; re-apply the recomposed dictionary.
  onDomainChange(() => setMessages(composeMessages()));
  import.meta.hot.accept((updated) => {
    if (!updated) return;
    setMessages(updated.messages);
  });
}
