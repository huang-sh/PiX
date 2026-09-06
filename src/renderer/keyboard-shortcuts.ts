import { SHORTCUTS, shortcutBindings, validShortcut, type ShortcutOverrides } from "../shared/shortcuts";

export const isMac = () => /Mac/i.test(navigator.platform);

export function captureShortcut(event: KeyboardEvent, mac = isMac()): string | undefined {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.getModifierState?.("AltGraph")) return;
  // Mod means the platform's primary modifier. Never silently ignore an extra modifier.
  if (mac ? event.ctrlKey : event.metaKey) return;
  const key = event.key === " " ? "Space" : event.key === "+" ? "Plus" : [...event.key].length === 1 ? event.key.toLowerCase() : event.key;
  const binding = [mac ? event.metaKey && "Mod" : event.ctrlKey && "Mod", event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+");
  return validShortcut(binding) ? binding : undefined;
}

export function shortcutsBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return true;
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return !!target?.closest('.xterm, .terminal-view, webview, [role="dialog"], [role="alertdialog"]') ||
    !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-shortcut-recording]');
}

export function shortcutForEvent(event: KeyboardEvent, overrides: ShortcutOverrides = {}, mac = isMac()) {
  if (shortcutsBlocked(event)) return;
  const binding = captureShortcut(event, mac);
  return binding ? SHORTCUTS.find(({ id }) => shortcutBindings(id, overrides).includes(binding))?.id : undefined;
}
