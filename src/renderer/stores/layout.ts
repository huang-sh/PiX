import { defineStore } from "pinia";
import { toRaw } from "vue";
import type { LayoutState, PanelId, SettingsBundle } from "../../shared/types";
import { desktop } from "../api";
import type { PromptImage } from "../../shared/types";
import { imageDataUrl } from "../../shared/images";

export type ContentSection =
  | "home"
  | "files"
  | "browser"
  | "changes"
  | "terminal"
  | "output"
  | "events";
export type ContentTab = Exclude<ContentSection, "home">;

const defaultLayout = (): LayoutState => ({
  version: 3,
  widths: { navigator: 248, chat: 356, content: 320 },
  collapsed: { navigator: false, chat: true, content: true },
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
    layout: defaultLayout(),
    contentSection: "home" as ContentSection,
    contentTabs: [] as ContentTab[],
    commandOpen: false,
    commandQuery: "",
    imagePreview: undefined as { src: string; alt: string } | undefined,
    notice: undefined as { level: string; message: string } | undefined,
  }),
  actions: {
    previewImage(image: PromptImage, alt: string) {
      this.imagePreview = { src: imageDataUrl(image), alt };
    },
    hydrate(settings: SettingsBundle, layout?: LayoutState) {
      this.settings = settings;
      // Callers may pass reactive store state; toRaw keeps structuredClone happy.
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
        this.layout.version = 3;
        this.layout.collapsed.chat = true;
        void this.save();
      }
      if (!this.layout.composer) this.layout.composer = { open: false };
      if (!this.contentTabs.length) this.layout.collapsed.content = true;
      document.documentElement.dataset.theme = settings.app.theme;
      document.documentElement.dataset.density = settings.app.density;
      this.hydrated = true;
    },
    showNotice(message: string, level = "info") {
      this.notice = { message, level };
    },
    async setCollapsed(panel: PanelId, collapsed: boolean) {
      this.layout.collapsed[panel] = collapsed;
      await this.save();
    },
    async toggle(panel: PanelId) {
      await this.setCollapsed(panel, !this.layout.collapsed[panel]);
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
