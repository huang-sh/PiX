import { defineStore } from "pinia";
import { toRaw } from "vue";
import type { LayoutState, PanelId, SessionSnapshot, SettingsBundle } from "../../shared/types";
import { desktop } from "../api";
import { i18n } from "../i18n";
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
type GraphRunState = NonNullable<SessionSnapshot["graph"]>["runs"][number];

export const NOTICE_AUTO_DISMISS_MS = 6000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const defaultLayout = (): LayoutState => ({
  version: 4,
  navigatorPinned: false,
  widths: { navigator: 248, chat: 356, content: 320, settings: 260 },
  collapsed: { navigator: true, chat: true, content: true },
  minimap: false,
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
    // Node ids pinned to extra chat columns (session-scoped, like contentTabs;
    // the primary column always follows the graph selection). The width they
    // widened the slot from/to persists in layout.chatPinWidth so a boot
    // without pins can restore the user's width.
    chatColumns: [] as string[],
    // Parent node per in-flight pin. A settled run carries no pending of its
    // own, so the last frame that showed the run in flight is remembered to
    // revert a failed column to the node the prompt was submitted from.
    chatColumnParents: {} as Record<string, string>,
    // Composer expansion per pinned column. A pinned column remounts when its
    // node advances, so the flag lives here to survive that remount — fresh
    // pins and every new session start collapsed. The primary column never
    // remounts and keeps its expansion in component state.
    chatColumnComposers: {} as Record<string, boolean>,
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
      // Composer expansion is per-column ephemeral state; saved layouts may
      // still carry the old global flag.
      delete (this.layout as { composer?: unknown }).composer;
      if ((this.layout.version ?? 0) < 3) {
        const defaults = defaultLayout();
        if ((this.layout.version ?? 0) < 2) {
          this.layout.widths.navigator = defaults.widths.navigator;
          this.layout.widths.chat = defaults.widths.chat;
        }
        this.layout.collapsed.chat = true;
      }
      if (typeof this.layout.navigatorPinned !== "boolean") this.layout.navigatorPinned = false;
      // Layouts saved before the settings sidebar became resizable carry no
      // width for it; the default restores the fixed width it used to have.
      if (typeof this.layout.widths.settings !== "number") this.layout.widths.settings = 260;
      if (!this.layout.navigatorPinned) this.layout.collapsed.navigator = true;
      if ((this.layout.version ?? 0) < 4) {
        this.layout.version = 4;
        void this.save();
      }
      if (!this.contentTabs.length) this.layout.collapsed.content = true;
      // Pins never survive a boot; settle the width they widened, if it stuck.
      this.settleChatWidth();
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
    // Two pinned columns beside the selection-following primary column.
    async openChatColumn(nodeId: string) {
      if (this.chatColumns.includes(nodeId)) {
        await this.setCollapsed("chat", false);
        return;
      }
      if (this.chatColumns.length >= 2) {
        this.showNotice(i18n.global.t("branch.panelLimit"), "warning");
        return;
      }
      this.chatColumns.push(nodeId);
      // Equal-width columns need room; the default width fits only one. Manual
      // resizes in between are respected — only the widened value restores.
      const width = (this.chatColumns.length + 1) * 320;
      if (this.layout.widths.chat < width) {
        this.layout.chatPinWidth = { from: this.layout.chatPinWidth?.from ?? this.layout.widths.chat, to: width };
        this.layout.widths.chat = width;
      }
      await this.setCollapsed("chat", false);
    },
    closeChatColumn(nodeId: string) {
      this.chatColumns = this.chatColumns.filter(id => id !== nodeId);
      delete this.chatColumnParents[nodeId];
      delete this.chatColumnComposers[nodeId];
      this.settleChatWidth();
    },
    clearChatColumns() {
      if (this.chatColumns.length) this.chatColumns = [];
      this.chatColumnParents = {};
      this.chatColumnComposers = {};
      this.settleChatWidth();
    },
    // A pinned column that submitted follows its branch to the new node.
    // Advancing onto an already-pinned node merges the two into one column
    // instead of producing a duplicate id (and a duplicate v-for key).
    advanceChatColumn(from: string, to: string) {
      if (!this.chatColumns.includes(from) || from === to) return;
      delete this.chatColumnParents[from];
      // The composer expansion follows the column across its remount; a merge
      // onto an already-pinned node keeps that column's own expansion.
      const composer = this.chatColumnComposers[from];
      delete this.chatColumnComposers[from];
      if (composer !== undefined && !(to in this.chatColumnComposers)) this.chatColumnComposers[to] = composer;
      const merged: string[] = [];
      for (const id of this.chatColumns) {
        const next = id === from ? to : id;
        if (!merged.includes(next)) merged.push(next);
      }
      this.chatColumns = merged;
    },
    // Closing the last pin puts back the width the slot had before pinning —
    // unless the user resized it themselves in the meantime. The memo persists
    // so a boot without pins (pins never survive a restart) restores too.
    settleChatWidth() {
      const pin = this.layout.chatPinWidth;
      if (this.chatColumns.length || pin === undefined) return;
      this.layout.chatPinWidth = undefined;
      if (this.layout.widths.chat === pin.to) this.layout.widths.chat = pin.from;
      void this.save();
    },
    // Keeps pinned columns healthy: a column dies with its node or session, and
    // a column that submitted follows its branch — a pending pin resolves to
    // the real node once the run creates it, and a failed run falls back to the
    // node the prompt was submitted from.
    trackChatColumns(nodeIds: ReadonlySet<string>, runs: GraphRunState[]) {
      if (!this.chatColumns.length) return;
      // Iterate a copy: advancing or closing rebuilds the list.
      for (const id of [...this.chatColumns]) {
        if (nodeIds.has(id)) continue;
        if (!id.startsWith("pending:")) {
          this.closeChatColumn(id);
          continue;
        }
        const run = runs.find(run => `pending:${run.runId}` === id);
        if (run?.nodeId && nodeIds.has(run.nodeId)) this.advanceChatColumn(id, run.nodeId);
        else if (run && run.status !== "running") {
          // A settled run carries no pending of its own; the parent comes from
          // the last frame that saw the run in flight.
          const parent = run.pending?.parentNodeId ?? this.chatColumnParents[id];
          if (parent && nodeIds.has(parent)) this.advanceChatColumn(id, parent);
          else this.closeChatColumn(id);
        } else if (run?.pending?.parentNodeId)
          this.chatColumnParents[id] = run.pending.parentNodeId;
        else if (!run) this.closeChatColumn(id);
      }
      this.settleChatWidth();
    },
    async save() {
      await desktop.invoke("layout.save", { layout: structuredClone(toRaw(this.layout)) });
    },
  },
});
