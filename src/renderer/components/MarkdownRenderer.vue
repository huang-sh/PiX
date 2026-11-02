<script setup lang="ts">
import NodeRenderer, { enableKatex } from "markstream-vue";
import { DropdownMenuRoot, DropdownMenuPortal, DropdownMenuContent, DropdownMenuItem } from "reka-ui";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { ProjectInfo } from "../../shared/types";
import { desktop } from "../api";
import { colorScheme } from "../theme";
import { useI18n } from "vue-i18n";
import { useLayoutStore } from "../stores/layout";
import { useWorkspaceStore } from "../stores/workspace";
import { readCodeTypography } from "../lib/typography";

// Global switch for $...$/$$...$$ math nodes; katex itself is lazy-loaded on
// first formula, so non-math content pays nothing.
enableKatex();

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
const markdown = ref<HTMLElement | null>(null);
let listObserver: MutationObserver | undefined;
const linkMenuOpen = ref(false);
const contextLink = shallowRef<{ href: string; url?: string; project: ProjectInfo | undefined; x: number; y: number }>();
const linkMenuAnchor = computed(() => ({
  getBoundingClientRect: () => new DOMRect(contextLink.value?.x ?? 0, contextLink.value?.y ?? 0, 0, 0),
}));
const externalFileBlocked = computed(() => {
  const link = contextLink.value;
  return !link || (!link.url && (!link.project || link.project !== workspace.project
    || Boolean(link.project.remote) || (!absoluteFilePath(fileLinkPath(link.href)) && !resolveProjectPath(link.href, link.project.path))));
});

function linkUrl(href: string) {
  // Drive-letter paths are files even though URL parses their drive as a scheme.
  if (/^[a-zA-Z]:[\\/]/.test(decodePath(href))) return;
  try { return new URL(href); } catch { return; }
}

function fileLinkPath(href: string) {
  const url = linkUrl(href);
  if (url?.protocol === "file:") {
    const path = decodePath(url.pathname).replace(/^\/([a-zA-Z]:[\\/])/, "$1");
    return url.hostname ? `//${url.hostname}${path}` : path;
  }
  return decodePath(href);
}

function absoluteFilePath(path: string) {
  return path.startsWith("/") || /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(path);
}

function onContentContextMenu(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const href = event.target.closest("a[href]")?.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  const url = linkUrl(href);
  if (url && !["http:", "https:", "mailto:", "file:"].includes(url.protocol)) return;
  contextLink.value = { href, url: url && url.protocol !== "file:" ? url.href : undefined,
    project: workspace.project, x: event.clientX, y: event.clientY };
  event.preventDefault();
  event.stopPropagation();
  linkMenuOpen.value = true;
}

async function openContextLink() {
  const link = contextLink.value;
  if (!link || externalFileBlocked.value) return;
  try {
    if (link.url) await desktop.invoke("app.openExternal", { url: link.url });
    else {
      await desktop.invoke("app.openFileLink", { href: link.href });
    }
  } catch (error) {
    if (link.url || workspace.project === link.project)
      layout.showNotice(t("links.openFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
  }
}

async function copyContextLink() {
  const link = contextLink.value;
  if (!link) return;
  // Files copy as readable paths; web URLs retain encoded query separators.
  const address = link.url ? link.href : fileLinkPath(link.href);
  try {
    if (desktop.copy) await desktop.copy(address);
    else await navigator.clipboard.writeText(address);
    layout.showNotice(t("common.copied"));
  } catch {
    layout.showNotice(t("common.copyFailed"), "error");
  }
}

function updateListIndents() {
  for (const list of markdown.value?.querySelectorAll("ol.list-node") ?? []) {
    let digits = 1;
    for (const item of list.children) {
      if (item instanceof HTMLLIElement)
        digits = Math.max(digits, String(item.value).length);
    }
    // Include punctuation and a gap; ch also follows compact/hover font sizes.
    (list as HTMLOListElement).style.setProperty("--ms-flow-list-indent", `${digits + 2}ch`);
  }
}

onMounted(() => {
  if (!markdown.value) return;
  // The renderer patches descendants asynchronously. Only list structure and
  // counter changes matter; prose tokens and our own style writes do not.
  listObserver = new MutationObserver(records => {
    if (records.some(record => record.type === "attributes"
      || record.target instanceof HTMLOListElement
      || [...record.addedNodes].some(node => node instanceof Element
        && (node.matches("ol.list-node") || node.querySelector("ol.list-node")))))
      updateListIndents();
  });
  listObserver.observe(markdown.value, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["value"],
  });
  updateListIndents();
});

onBeforeUnmount(() => listObserver?.disconnect());

// Markdown links split into two families. Absolute http/https links render
// with target="_blank", which the main process hands to the OS browser;
// plain left-clicks go to the built-in Browser tool instead (modified clicks
// keep the OS path). Every other href — relative paths, file: URLs, absolute
// filesystem paths, #anchors — renders without a target, so its default
// action would navigate the app window itself; those resolve against the
// project and open as workspace files (anchors scroll within the message),
// regardless of modifiers.
async function onContentClick(event: MouseEvent) {
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
  const url = linkUrl(href);
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
  const project = workspace.project;
  let path = resolveProjectPath(href, project?.path);
  // Decode after parsing so a percent-encoded colon stays in the filename.
  const suffix = /:([1-9]\d*)$/.exec(href);
  const line = suffix && Number.isSafeInteger(Number(suffix[1])) ? Number(suffix[1]) : undefined;
  event.preventDefault();
  if (!path) {
    layout.showNotice(t("links.fileNotFound", { path: href }), "warning");
    return;
  }
  const linePath = line ? resolveProjectPath(href.slice(0, suffix!.index), project?.path) : null;
  try {
    if (linePath && project?.path.startsWith("/") && !project.path.startsWith("//")) {
      // POSIX filenames can end in :digits. Preserve existing file links,
      // and only interpret a line suffix if the literal file is missing.
      try {
        await workspace.openFile(path);
      } catch (error) {
        if (workspace.project !== project) return;
        // IPC preserves Node's message; errno names inside its path are data.
        if (!(error instanceof Error) || !/^(?:ENOENT|ENOTDIR):\s/.test(error.message)) throw error;
        path = linePath;
        await workspace.openFile(path, line);
      }
    } else {
      path = linePath ?? path;
      await workspace.openFile(path, linePath ? line : undefined);
    }
    if (workspace.project === project) await layout.openTool("files");
  } catch {
    if (workspace.project === project)
      layout.showNotice(t("links.fileNotFound", { path }), "warning");
  }
}

// Maps a markdown href onto a project-relative workspace path. file: URLs and
// drive-letter/UNC paths must sit under the project root; bare paths resolve
// against it ("x", "./x" and "/x" all count from the root, since chat has no
// per-file base). A "/x" href that spells out the project root itself counts
// as a POSIX absolute path instead. Anything escaping the root yields null.
function resolveProjectPath(href: string, root: string | undefined): string | null {
  if (!root) return null;
  // A single-letter prefix is a Windows drive ("D:/a.png"), not a URL scheme;
  // every scheme that reaches this handler (file:, mailto:, …) is longer.
  if (/^[a-z]{2,}:/i.test(href)) {
    if (!/^file:/i.test(href)) return null;
    try {
      // file:///D:/a/b.md → "/D:/a/b.md"; percent-decoded once, here.
      const segments = hrefSegments(decodePath(new URL(href).pathname));
      return segments ? sliceUnderRoot(segments, root) : null;
    } catch {
      return null;
    }
  }
  const normalized = decodePath(href).replaceAll("\\", "/");
  const segments = hrefSegments(normalized);
  if (!segments) return null;
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//"))
    return sliceUnderRoot(segments, root);
  // A lone leading "/" is ambiguous in chat: "/README.md" is root-relative
  // shorthand, but "/Users/me/proj/x" spells out a POSIX absolute path. The
  // absolute reading only wins when it lands under the root; otherwise the
  // href stays root-relative like any bare path.
  if (normalized.startsWith("/")) {
    const sliced = sliceUnderRoot(segments, root);
    if (sliced) return sliced;
  }
  return segments.join("/");
}

// Splits a decoded path into clean segments, dropping "." and folding ".."
// upwards; null when a ".." would climb past the start or nothing remains.
function hrefSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.pop()) return null;
    } else segments.push(segment);
  }
  return segments.length ? segments : null;
}

// Absolute paths are matched segment-wise against the root (case-blind,
// Windows-friendly) instead of slicing strings, so case mismatches and
// multi-byte lowercasing cannot shift the boundary.
function sliceUnderRoot(segments: string[], root: string): string | null {
  const rootSegments = root.replaceAll("\\", "/").replace(/\/+$/, "").split("/").filter(Boolean);
  const underRoot =
    rootSegments.length < segments.length &&
    rootSegments.every((segment, index) => segments[index]!.toLowerCase() === segment.toLowerCase());
  return underRoot ? segments.slice(rootSegments.length).join("/") : null;
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
  <div ref="markdown" class="agent-markdown" :data-streaming="streaming" @click="onContentClick" @contextmenu="onContentContextMenu">
    <NodeRenderer
      :is-dark="colorScheme === 'dark'"
      :content="content"
      :custom-id="customId"
      mode="chat"
      :final="!streaming"
      :smooth-streaming="false"
      :typewriter="false"
      :fade="false"
      html-policy="safe"
      :render-code-blocks-as-pre="true"
      :code-block-options="codeBlockOptions"
    />
    <DropdownMenuRoot v-model:open="linkMenuOpen" :modal="false">
      <DropdownMenuPortal>
        <DropdownMenuContent class="menu-content" :reference="linkMenuAnchor" side="bottom" align="start" @close-auto-focus.prevent>
          <DropdownMenuItem class="menu-item" data-action="markdown-open-external"
            :disabled="externalFileBlocked"
            :title="!contextLink?.url && contextLink?.project?.remote ? t('tools.openExternallyRemote') : undefined"
            @select="openContextLink"
          >{{ t("tools.openExternally") }}</DropdownMenuItem>
          <DropdownMenuItem class="menu-item" data-action="markdown-copy-address" @select="copyContextLink">
            {{ t("links.copyAddress") }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
