import { defineStore } from "pinia";
import { toRaw } from "vue";
import type { LayoutState, PanelId, SettingsBundle } from "../../shared/types";
import { desktop } from "../api";
import type { PromptImage } from "../../shared/types";
import { imageDataUrl } from "../../shared/images";
import { applyAppearance, applyTheme } from "../theme";
import type { ThemePreference } from "../../shared/theme";

export type ContentSection =
  | "home"
  | "files"
  | "browser"
  | "changes"
  | "terminal"
  | "output"
  | "events";
export type ContentTab = Exclude<ContentSection, "home">;

export const NOTICE_AUTO_DISMISS_MS = 6000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const defaultLayout = (): LayoutState => ({
  version: 4,
  navigatorPinned: false,
  widths: { navigator: 248, chat: 356, content: 320 },
  collapsed: { navigator: true, chat: true, content: true },
  minimap: false,
  composer: { open: false },
  utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
});

export const useLayoutStore = defineStore("layout", {
  state: () => ({
    hydrated: false,
    panelsSettled: false,
    screen: "workbench" as "workbench" | "settings",
    settingsCategory: "general",
    settings: undefined as SettingsBundle | undefined,
    themeSaving: false,
    layout: defaultLayout(),
    contentSection: "home" as ContentSection,
    contentTabs: [] as ContentTab[],
    commandOpen: false,
    commandQuery: "",
    imagePreview: undefined as { src: string; alt: string } | undefined,
    notice: undefined as { level: string; message: string } | undefined,
  }),
  actions: {
    applySettings(settings: SettingsBundle) {
      this.settings = settings;
      applyTheme(settings.app.theme);
      applyAppearance(settings.app);
    },
    // Fold the saved bundle back so the mirror never trails main: the next
    // settings draft snapshots this state when the page opens.
    async updateAppSettings(patch: Record<string, unknown>) {
      this.applySettings(
        await desktop.invoke<SettingsBundle>("settings.update", { scope: "app", patch }),
      );
    },
    async setTheme(preference: ThemePreference) {
      if (!this.settings || this.themeSaving) return;
      const previous = this.settings.app.theme;
      this.themeSaving = true;
      this.settings.app.theme = preference;
      applyTheme(preference);
      try {
        const saved = await desktop.invoke<SettingsBundle>("settings.update", {
          scope: "app", patch: { theme: preference },
        });
        this.settings.app.theme = saved.app.theme;
        applyTheme(saved.app.theme);
      } catch (error) {
        this.settings.app.theme = previous;
        applyTheme(previous);
        throw error;
      } finally {
        this.themeSaving = false;
      }
    },
    previewImage(image: PromptImage, alt: string) {
      this.imagePreview = { src: imageDataUrl(image), alt };
    },
    hydrate(settings: SettingsBundle, layout?: LayoutState) {
      this.applySettings(settings);
      // Callers may pass reactive store state; toRaw keeps structuredClone happy.
      this.layout = structuredClone(toRaw(layout ?? defaultLayout()));
      // The chat panel opens on demand (node double-click, prompt submit) and is
      // never restored expanded: every boot/workspace reload starts with it closed.
      this.layout.collapsed.chat = true;
      if ((this.layout.version ?? 0) < 3) {
        const defaults = defaultLayout();
        if ((this.layout.version ?? 0) < 2) {
          this.layout.widths.navigator = defaults.widths.navigator;
          this.layout.widths.chat = defaults.widths.chat;
        }
        this.layout.collapsed.chat = true;
      }
      if (typeof this.layout.navigatorPinned !== "boolean") this.layout.navigatorPinned = false;
      if (!this.layout.navigatorPinned) this.layout.collapsed.navigator = true;
      if ((this.layout.version ?? 0) < 4) {
        this.layout.version = 4;
        void this.save();
      }
      if (!this.layout.composer) this.layout.composer = { open: false };
      if (!this.contentTabs.length) this.layout.collapsed.content = true;
      this.hydrated = true;
    },
    showNotice(message: string, level = "info") {
      clearTimeout(noticeTimer);
      this.notice = { message, level };
      // Errors stay until dismissed; anything less urgent auto-expires so the
      // corner does not accumulate a stale message the user never clicked.
      if (level !== "error")
        noticeTimer = setTimeout(() => { this.notice = undefined; }, NOTICE_AUTO_DISMISS_MS);
    },
    dismissNotice() {
      clearTimeout(noticeTimer);
      this.notice = undefined;
    },
    async setCollapsed(panel: PanelId, collapsed: boolean) {
      this.layout.collapsed[panel] = collapsed;
      await this.save();
    },
    async toggle(panel: PanelId) {
      await this.setCollapsed(panel, !this.layout.collapsed[panel]);
    },
    async toggleNavigatorPinned() {
      this.layout.navigatorPinned = !this.layout.navigatorPinned;
      this.layout.collapsed.navigator = false;
      await this.save();
    },
    async setWidth(panel: PanelId, width: number) {
      this.layout.widths[panel] = Math.round(width);
      await this.save();
    },
    async toggleMinimap() {
      this.layout.minimap = !this.layout.minimap;
      await this.save();
    },
    async setComposerOpen(open: boolean) {
      this.layout.composer.open = open;
      await this.save();
    },
    async openTool(section: ContentSection) {
      if (section !== "home" && !this.contentTabs.includes(section)) this.contentTabs.push(section);
      this.contentSection = section;
      await this.setCollapsed("content", false);
    },
    selectTool(section: ContentTab) {
      this.contentSection = section;
    },
    async closeTool(section: ContentTab) {
      const index = this.contentTabs.indexOf(section);
      if (index < 0) return;
      this.contentTabs.splice(index, 1);
      if (!this.contentTabs.length) {
        this.contentSection = "home";
        await this.setCollapsed("content", true);
      } else if (this.contentSection === section) {
        this.contentSection = this.contentTabs[Math.min(index, this.contentTabs.length - 1)]!;
      }
    },
    async save() {
      await desktop.invoke("layout.save", { layout: structuredClone(toRaw(this.layout)) });
    },
  },
});
