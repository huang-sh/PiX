<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { DesktopEvent, TerminalEvent, TerminalSession } from "../../../shared/types";
import { desktop } from "../../api";

import { activeTheme } from "../../theme";
import { terminalTheme } from "./terminal-theme";
import { readCodeTypography } from "../../lib/typography";

const props = withDefaults(defineProps<{ active: boolean; projectKey: string; connected?: boolean }>(), { connected: true });
const { t } = useI18n();
const host = ref<HTMLElement>();
const terminal = new Terminal({
  cursorBlink: true,
  // xterm draws on canvas: resolve the same font stack used by code and Markdown.
  fontFamily: readCodeTypography().fontFamily,
  fontSize: 14,
  lineHeight: 1.5,
  scrollback: 10_000,
  theme: terminalTheme(activeTheme.value),
});
watch(activeTheme, (theme) => { terminal.options.theme = terminalTheme(theme); });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.options.disableStdin = true;

let sessionId = "";
let generation = 0;
let needsStart = true;
let resizeObserver: ResizeObserver | undefined;
let unsubscribe: (() => void) | undefined;
const earlyEvents = new Map<string, TerminalEvent[]>();

function renderEvent(payload: TerminalEvent) {
  if (payload.data) terminal.write(payload.data);
  if (payload.exitCode !== undefined) {
    sessionId = "";
    terminal.options.disableStdin = true;
    terminal.writeln(`\r\n${t("terminal.exited", { code: payload.exitCode })}`);
  }
}

function onEvent(event: DesktopEvent) {
  if (event.type !== "terminal") return;
  const payload = event.payload as TerminalEvent;
  if (payload.id === sessionId) return renderEvent(payload);
  if (!sessionId) {
    const events = earlyEvents.get(payload.id) ?? [];
    events.push(payload);
    earlyEvents.set(payload.id, events);
  }
}

function fitTerminal() {
  if (!props.active || !host.value?.offsetWidth || !host.value.offsetHeight) return;
  fit.fit();
  if (sessionId)
    void desktop.invoke("terminal.resize", {
      id: sessionId,
      cols: terminal.cols,
      rows: terminal.rows,
    }).catch(() => undefined);
}

async function start() {
  if (sessionId || !props.active || !props.connected) return;
  const token = ++generation;
  needsStart = false;
  terminal.options.disableStdin = true;
  await nextTick();
  fitTerminal();
  try {
    const session = await desktop.invoke<TerminalSession>("terminal.create", {
      cols: terminal.cols,
      rows: terminal.rows,
    });
    if (token !== generation) {
      if (session.id) await desktop.invoke("terminal.kill", { id: session.id }).catch(() => undefined);
      return;
    }
    if (!session.id) {
      terminal.writeln(t("terminal.cancelled"));
      return;
    }
    sessionId = session.id;
    terminal.options.disableStdin = false;
    for (const event of earlyEvents.get(sessionId) ?? []) renderEvent(event);
    earlyEvents.delete(sessionId);
    terminal.focus();
  } catch (error) {
    terminal.writeln(`\r\n${t("terminal.failed", { message: error instanceof Error ? error.message : String(error) })}`);
  }
}

async function stop() {
  generation++;
  const id = sessionId;
  sessionId = "";
  terminal.options.disableStdin = true;
  if (id) await desktop.invoke("terminal.kill", { id }).catch(() => undefined);
}

watch(
  () => props.connected,
  async (connected) => {
    if (!connected) {
      generation++;
      sessionId = "";
      earlyEvents.clear();
      needsStart = true;
      terminal.options.disableStdin = true;
      terminal.writeln(`\r\n${t("remote.connectionLost")}`);
    } else if (needsStart) await start();
  },
);

watch(
  () => props.active,
  async (active) => {
    if (!active) return;
    if (needsStart) await start();
    else await nextTick(fitTerminal);
  },
);

watch(
  () => props.projectKey,
  async () => {
    await stop();
    terminal.reset();
    earlyEvents.clear();
    needsStart = true;
    if (props.active) await start();
  },
);

onMounted(async () => {
  terminal.open(host.value!);
  unsubscribe = desktop.onEvent(onEvent);
  terminal.onData((data) => {
    if (sessionId) void desktop.invoke("terminal.write", { id: sessionId, data }).catch(() => undefined);
  });
  resizeObserver = new ResizeObserver(fitTerminal);
  resizeObserver.observe(host.value!);
  await start();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  resizeObserver?.disconnect();
  void stop();
  terminal.dispose();
});
</script>

<template>
  <div class="terminal-view full-tool">
    <div ref="host" class="terminal-host" />
  </div>
</template>
