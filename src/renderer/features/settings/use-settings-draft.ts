import { computed, ref, toRaw, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { normalizeTheme } from "../../../shared/theme";
import { DEFAULT_OUTPUT_STYLE } from "../../../shared/skills";
import type { SettingsBundle } from "../../../shared/types";
import { desktop } from "../../api";
import { applyDiff, settingsDiff } from "../../lib/settings-diff";
import { applyAppearance } from "../../theme";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";

export type Scope = "app" | "global" | "project";

function sectionKeyOf(scope: Scope): "app" | "piGlobal" | "piProject" {
  return scope === "app" ? "app" : scope === "global" ? "piGlobal" : "piProject";
}

export interface Row {
  path: string;
  label: string;
  scope: Scope;
  type?: "text" | "number" | "check" | "select";
  options?: string[];
  fallback?: unknown;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}

// Mirrors withDefaultPowershellTool in the main process: Windows agents get
// the powershell tool appended to Pi's built-in default set, other platforms
// keep the four. The sandboxed renderer reads the platform from the browser
// API, same as isMac() in keyboard-shortcuts.ts.
const defaultToolsFallback = /^Win/i.test(navigator.platform)
  ? ["read", "bash", "edit", "write", "powershell"]
  : ["read", "bash", "edit", "write"];

export function useSettingsDraft(outputStyleSkills?: Ref<string[]>) {
  const layout = useLayoutStore();
  const session = useSessionStore();
  const { locale, t, te } = useI18n();
  const draft = ref<SettingsBundle>();
  // The pristine twin of the draft: saves diff the two, so a write carries
  // only the keys this page changed and never clobbers keys other writers
  // saved meanwhile (theme picker, update banner, the pi runtime's own
  // settings).
  let base: SettingsBundle | undefined;

  // Committed edits save themselves: setValue mutates the draft and queues
  // the scope; the flush loop writes each queued scope's diff. An edit made
  // while a write is in flight just re-queues — nothing is dropped the way a
  // disabled save button could skip one.
  const queued = new Set<Scope>();
  let flushing = false;
  // The scope section as it stood when the in-flight write's diff was
  // computed: edits made since are exactly diff(draft, this snapshot).
  let writing: { scope: Scope; section: Record<string, unknown> } | undefined;

  watch(
    () => layout.settings,
    (incoming) => {
      if (!incoming || !flushing || !draft.value || !base) {
        draft.value = incoming ? structuredClone(toRaw(incoming)) : undefined;
        base = incoming ? structuredClone(toRaw(incoming)) : undefined;
        return;
      }
      // A flush's own applySettings — or an external writer racing it — must
      // not discard edits still queued. Adopt the bundle, then overlay each
      // queued scope's edits since the in-flight write began (or since the
      // baseline, when no write is out for it): never the raw draft values a
      // normalizing write side may have dropped. Sync so the loop's next
      // diff already sees the advanced baseline.
      const snapshot = structuredClone(toRaw(incoming));
      for (const scope of queued) {
        const origin = writing?.scope === scope ? writing.section : sectionFor(scope, base)!;
        applyDiff(sectionFor(scope, snapshot)!, settingsDiff(sectionFor(scope, draft.value)!, origin));
      }
      draft.value = snapshot;
      base = structuredClone(toRaw(incoming));
    },
    { immediate: true, flush: "sync" },
  );

  const rows = computed<Row[]>(() => {
    switch (layout.settingsCategory) {
      case "general":
        return [
          { path: "language", label: "settings.rows.language", scope: "app", type: "select", options: ["system", "zh-CN", "en"] },
          { path: "enterToSend", label: "settings.rows.enterToSend", scope: "app", type: "check", fallback: true, description: "settings.rows.enterToSendDesc" },
          { path: "openLinksInApp", label: "settings.rows.openLinksInApp", scope: "app", type: "check", fallback: true, description: "settings.rows.openLinksInAppDesc" },
          { path: "defaultProjectTrust", label: "settings.rows.defaultProjectTrust", scope: "global", type: "select", options: ["ask", "always", "never"], fallback: "ask", description: "settings.rows.defaultProjectTrustDesc" },
          { path: "enableInstallTelemetry", label: "settings.rows.installTelemetry", scope: "global", type: "check", fallback: true, description: "settings.rows.installTelemetryDesc" },
          { path: "warnings.anthropicExtraUsage", label: "settings.rows.anthropicWarnings", scope: "global", type: "check", fallback: true },
          { path: "confirmDestructiveActions", label: "settings.rows.confirmDestructive", scope: "app", type: "check", description: "settings.rows.confirmDestructiveDesc" },
          { path: "openLastSessionOnStartup", label: "settings.rows.openLastSession", scope: "app", type: "check", fallback: false, description: "settings.rows.openLastSessionDesc" },
          { path: "closeToTray", label: "settings.rows.closeToTray", scope: "app", type: "check", fallback: true, description: "settings.rows.closeToTrayDesc" },
        ];
      case "appearance":
        return [
          { path: "theme", label: "settings.rows.theme", scope: "app", type: "select", options: ["system", "light", "dark", "teal", "peach"] },
          { path: "density", label: "settings.rows.density", scope: "app", type: "select", options: ["comfortable", "compact"] },
          { path: "canvasDotGrid", label: "settings.rows.canvasDotGrid", scope: "app", type: "check", fallback: true, description: "settings.rows.canvasDotGridDesc" },
          { path: "canvasDotGridSpacing", label: "settings.rows.canvasDotGridSpacing", scope: "app", type: "number", fallback: 24, min: 8, max: 96, description: "settings.rows.canvasDotGridSpacingDesc" },
          { path: "canvasDotGridDotSize", label: "settings.rows.canvasDotGridDotSize", scope: "app", type: "number", fallback: 4, min: 1, max: 6, description: "settings.rows.canvasDotGridDotSizeDesc" },
        ];
      case "models":
        return [
          { path: "defaultThinkingLevel", label: "settings.rows.defaultThinkingLevel", scope: "global", type: "select", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], fallback: "medium", description: "settings.rows.defaultThinkingLevelDesc" },
          { path: "enabledModels", label: "settings.rows.enabledModels", scope: "global", fallback: [], placeholder: "openai/*, anthropic/claude-*", description: "settings.rows.enabledModelsDesc" },
        ];
      case "sessions":
        return [
          { path: "sessionDir", label: "settings.rows.sessionDir", scope: "project", fallback: ".pi/sessions" },
          { path: "compaction.enabled", label: "settings.rows.autoCompaction", scope: "global", type: "check", fallback: true },
          { path: "compaction.reserveTokens", label: "settings.rows.reserveTokens", scope: "global", type: "number", fallback: 16384 },
          { path: "compaction.keepRecentTokens", label: "settings.rows.keepRecentTokens", scope: "global", type: "number", fallback: 20000 },
          { path: "branchSummary.reserveTokens", label: "settings.rows.branchSummaryReserve", scope: "global", type: "number", fallback: 16384 },
          { path: "branchSummary.skipPrompt", label: "settings.rows.skipBranchSummary", scope: "global", type: "check", fallback: false },
        ];
      case "experimental":
        return [
          { path: "experimentalHistory", label: "settings.rows.experimentalHistory", scope: "app", type: "check", fallback: false, description: "settings.rows.experimentalHistoryDesc" },
        ];
      case "agent":
        return [
          { path: "outputStyle", label: "settings.rows.outputStyle", scope: "global", type: "select", options: outputStyleSkills?.value ?? [], fallback: DEFAULT_OUTPUT_STYLE, description: "settings.rows.outputStyleDesc" },
          { path: "steeringMode", label: "settings.rows.steeringDelivery", scope: "global", type: "select", options: ["one-at-a-time", "all"], fallback: "one-at-a-time" },
          { path: "followUpMode", label: "settings.rows.followUpDelivery", scope: "global", type: "select", options: ["one-at-a-time", "all"], fallback: "one-at-a-time" },
          { path: "transport", label: "settings.rows.transport", scope: "global", type: "select", options: ["auto", "sse", "websocket", "websocket-cached"], fallback: "auto" },
          { path: "httpIdleTimeoutMs", label: "settings.rows.httpIdleTimeout", scope: "global", type: "select", options: ["30000", "60000", "120000", "300000", "0"], fallback: 300000 },
          { path: "retry.enabled", label: "settings.rows.autoRetry", scope: "global", type: "check", fallback: true },
          { path: "retry.maxRetries", label: "settings.rows.maxRetries", scope: "global", type: "number", fallback: 3 },
          { path: "retry.baseDelayMs", label: "settings.rows.retryBaseDelay", scope: "global", type: "number", fallback: 1000 },
          { path: "retry.maxDelayMs", label: "settings.rows.retryMaxDelay", scope: "global", type: "number", fallback: 60000 },
          { path: "retry.providerRetryTimeoutMs", label: "settings.rows.providerRetryTimeout", scope: "global", type: "number", fallback: 120000 },
          { path: "retry.providerMaxRetries", label: "settings.rows.providerMaxRetries", scope: "global", type: "number", fallback: 5 },
        ];
      case "tools":
        return [
          { path: "defaultTools", label: "settings.rows.defaultTools", scope: "project", fallback: defaultToolsFallback },
          { path: "images.autoResize", label: "settings.rows.resizeImages", scope: "global", type: "check", fallback: true },
          { path: "images.blockImages", label: "settings.rows.blockImages", scope: "global", type: "check", fallback: false },
          { path: "enableSkillCommands", label: "settings.rows.skillCommands", scope: "global", type: "check", fallback: true, description: "settings.rows.skillCommandsDesc" },
        ];
      case "shell":
        return [
          { path: "shellPath", label: "settings.rows.shellPath", scope: "global" },
          { path: "shellCommandPrefix", label: "settings.rows.commandPrefix", scope: "global" },
          { path: "externalEditor", label: "settings.rows.externalEditor", scope: "global", placeholder: "code --wait" },
          { path: "npmCommand", label: "settings.rows.packageCommand", scope: "global", fallback: [], placeholder: "pnpm, dlx", description: "settings.rows.packageCommandDesc" },
          { path: "httpProxy", label: "settings.rows.httpProxy", scope: "global" },
          { path: "websocketConnectTimeoutMs", label: "settings.rows.websocketTimeout", scope: "global", type: "number", fallback: 10000 },
        ];
      default:
        return [];
    }
  });

  function optionLabel(option: string) {
    const key = `options.${option}`;
    return te(key) ? t(key) : option;
  }

  function rowHint(row: Row) {
    return row.description
      ? t(row.description)
      : t("settings.storedIn", { scope: t(`settings.scope.${row.scope}`) });
  }

  function sectionFor(scope: Scope, bundle: SettingsBundle | undefined): Record<string, unknown> | undefined {
    if (!bundle) return undefined;
    return (scope === "app"
      ? bundle.app
      : scope === "global"
        ? bundle.piGlobal
        : bundle.piProject) as unknown as Record<string, unknown>;
  }

  function rootFor(row: Row): Record<string, unknown> | undefined {
    return sectionFor(row.scope, draft.value);
  }

  function value(row: Row): unknown {
    if (row.scope === "app" && row.path === "theme") return layout.settings?.app.theme;
    let current: unknown = rootFor(row);
    for (const key of row.path.split("."))
      current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
    current ??= row.fallback ?? "";
    return Array.isArray(current) ? current.join(", ") : current;
  }

  function setValue(row: Row, event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (row.scope === "app" && row.path === "theme") {
      void layout.setTheme(normalizeTheme(target.value)).catch((error) => {
        target.value = layout.settings!.app.theme;
        layout.showNotice(error instanceof Error ? error.message : String(error), "error");
      });
      return;
    }
    let next: unknown = target instanceof HTMLInputElement && target.type === "checkbox"
      ? target.checked
      : target instanceof HTMLInputElement && target.type === "number"
        ? Number(target.value)
        : target.value;
    if (row.type === "select" && typeof row.fallback === "number") next = Number(next);
    if (["enabledModels", "defaultTools", "npmCommand"].includes(row.path))
      next = String(next).split(",").map((item) => item.trim()).filter(Boolean);
    // Clearing defaultTools means "unset" — Pi's defaults plus PiX's powershell
    // append — not a no-tools list; the settings diff encodes the removed key.
    if (row.path === "defaultTools" && (next as string[]).length === 0)
      next = undefined;
    const parts = row.path.split(".");
    let current = rootFor(row);
    if (!current) return;
    parts.forEach((key, index) => {
      if (index === parts.length - 1) current![key] = next;
      else {
        if (!current![key] || typeof current![key] !== "object") current![key] = {};
        current = current![key] as Record<string, unknown>;
      }
    });
    if (row.scope === "app" && ["density", "canvasDotGrid", "canvasDotGridSpacing", "canvasDotGridDotSize"].includes(row.path) && draft.value)
      applyAppearance(draft.value.app);
    save(row.scope);
  }

  function save(scope: Scope) {
    if (!draft.value) return;
    queued.add(scope);
    if (flushing) return;
    flushing = true;
    void flush();
  }

  // Non-app scopes only reach a running session through a reload. One per
  // committed change would hammer the session, so bursts coalesce behind a
  // short quiet period — and one that lands mid-stream is held until the
  // session goes idle again, never dropped.
  const RELOAD_QUIET_MS = 400;
  let reloadPending = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const sessionIdle = () =>
    !!session.current && !session.current.runtime.isStreaming && !session.current.runtime.isCompacting;

  function scheduleReload() {
    if (!session.current) return;
    reloadPending = true;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      // Still streaming or compacting: stay pending; the idle watcher
      // re-arms the timer once the session settles.
      if (!sessionIdle()) return;
      reloadPending = false;
      session.control({ action: "reload" }).catch((error) =>
        layout.showNotice(error instanceof Error ? error.message : String(error), "error"));
    }, RELOAD_QUIET_MS);
  }

  watch(sessionIdle, (idle) => {
    if (idle && reloadPending) scheduleReload();
  });

  async function flush() {
    try {
      while (queued.size && draft.value && base) {
        let reload = false;
        for (const scope of [...queued]) {
          queued.delete(scope);
          // toRaw hands the diff plain values, so the patch crosses IPC
          // without proxy cloning.
          const patch = settingsDiff(sectionFor(scope, toRaw(draft.value))!, sectionFor(scope, base)!);
          if (!Object.keys(patch).length) continue;
          writing = { scope, section: structuredClone(toRaw(sectionFor(scope, draft.value)!)) };
          try {
            const settings = await desktop.invoke<SettingsBundle>("settings.update", { scope, patch });
            // applySettings mirrors the merged bundle app-wide; the watcher
            // above folds it into draft and base, keeping queued edits alive.
            layout.applySettings(settings);
            locale.value = settings.app.language === "system"
              ? navigator.language === "zh-CN" ? "zh-CN" : "en"
              : settings.app.language;
            reload ||= scope !== "app";
          } catch (error) {
            // The write failed: restore the scope to what is on disk, then
            // overlay the edits made since the write began — the scope is
            // still queued, so the next round writes them.
            const key = sectionKeyOf(scope);
            const restored = structuredClone(sectionFor(scope, base)!) as Record<string, unknown>;
            applyDiff(restored, settingsDiff(sectionFor(scope, draft.value)!, writing.section));
            (draft.value as unknown as Record<string, unknown>)[key] = restored;
            if (scope === "app") applyAppearance(draft.value.app);
            layout.showNotice(error instanceof Error ? error.message : String(error), "error");
          } finally {
            writing = undefined;
          }
        }
        if (reload) scheduleReload();
      }
    } finally {
      flushing = false;
    }
  }

  return { draft, rows, optionLabel, rowHint, value, setValue, save };
}
