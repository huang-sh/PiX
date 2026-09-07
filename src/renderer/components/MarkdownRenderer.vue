<script setup lang="ts">
import NodeRenderer from "markstream-vue";
import { colorScheme } from "../theme";
import { useI18n } from "vue-i18n";
import { useLayoutStore } from "../stores/layout";
import { useWorkspaceStore } from "../stores/workspace";
import { readCodeTypography } from "../lib/typography";

withDefaults(defineProps<{
  content: string;
  customId: string;
  streaming?: boolean;
}>(), {
  streaming: false,
});

const codeBlockOptions = readCodeTypography();
const layout = useLayoutStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

// Markdown links split into two families. Absolute http/https links render
// with target="_blank", which the main process hands to the OS browser;
// plain left-clicks go to the built-in Browser tool instead (modified clicks
// keep the OS path). Every other href — relative paths, file: URLs, #anchors
// — renders without a target, so its default action would navigate the app
// window itself; those resolve against the project and open as workspace
// files (anchors scroll within the message), regardless of modifiers.
function onContentClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const href = event.target.closest("a[href]")?.getAttribute("href");
  if (!href || layout.settings?.app.openLinksInApp !== true) return;
  if (href.startsWith("#")) {
    event.preventDefault();
    const id = CSS.escape(href.slice(1));
    (event.currentTarget as HTMLElement)
      .querySelector(`[id="${id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  let url: URL | undefined;
  try {
    url = new URL(href);
  } catch {
    // Not an absolute URL — fall through to project-path handling.
  }
  if (url) {
    // Only web links and file: URLs are ours; mailto: and other schemes keep
    // the default path (the main process allowlists them anyway).
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:")
      return;
    if (url.protocol !== "file:") {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      workspace.openBrowser(url.href);
      void layout.openTool("browser");
      return;
    }
  }
  const path = resolveProjectPath(href, workspace.project?.path);
  event.preventDefault();
  if (!path) {
    layout.showNotice(t("links.fileNotFound", { path: href }), "warning");
    return;
  }
  workspace
    .openFile(path)
    .then(() => layout.openTool("files"))
    .catch(() => layout.showNotice(t("links.fileNotFound", { path }), "warning"));
}

// Maps a markdown href onto a project-relative workspace path. file: URLs and
// drive-letter/UNC paths must sit under the project root; bare paths resolve
// against it ("x", "./x" and "/x" all count from the root, since chat has no
// per-file base). Anything escaping the root yields null.
function resolveProjectPath(href: string, root: string | undefined): string | null {
  if (!root) return null;
  let absolute: string | undefined;
  if (/^[a-z]+:/i.test(href)) {
    if (!/^file:/i.test(href)) return null;
    try {
      // file:///D:/a/b.md → "/D:/a/b.md"; stays percent-encoded for now.
      absolute = new URL(href).pathname;
    } catch {
      return null;
    }
  } else {
    const normalized = href.replaceAll("\\", "/");
    if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//"))
      absolute = normalized;
  }
  const segments: string[] = [];
  for (const segment of decodePath(absolute ?? href).replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.pop()) return null;
    } else segments.push(segment);
  }
  if (!segments.length) return null;
  if (!absolute) return segments.join("/");
  // Absolute paths are matched segment-wise against the root (case-blind,
  // Windows-friendly) instead of slicing strings, so case mismatches and
  // multi-byte lowercasing cannot shift the boundary.
  const rootSegments = root.replaceAll("\\", "/").replace(/\/+$/, "").split("/").filter(Boolean);
  const underRoot =
    rootSegments.length <= segments.length &&
    rootSegments.every((segment, index) => segments[index]!.toLowerCase() === segment.toLowerCase());
  if (!underRoot) return null;
  return segments.slice(rootSegments.length).join("/") || null;
}

// Percent-decoding must never throw away the click, and "+" is literal in paths.
function decodePath(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", "%2B"));
  } catch {
    return value;
  }
}
</script>

<template>
  <div class="agent-markdown" :data-streaming="streaming" @click="onContentClick">
    <NodeRenderer
      :is-dark="colorScheme === 'dark'"
      :content="content"
      :custom-id="customId"
      mode="chat"
      :final="!streaming"
      :smooth-streaming="streaming ? 'auto' : false"
      :typewriter="streaming ? 'simple' : false"
      :fade="false"
      html-policy="safe"
      :render-code-blocks-as-pre="true"
      :code-block-options="codeBlockOptions"
    />
  </div>
</template>
