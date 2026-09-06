export const SHORTCUTS = [
  { id: "commands", defaults: ["Mod+k", "Mod+Shift+p"] },
  { id: "terminal", defaults: ["Mod+`"] },
  { id: "navigator", defaults: ["Mod+b"] },
  { id: "tools", defaults: ["Mod+Alt+b"] },
  { id: "settings", defaults: ["Mod+,"] },
] as const;

export type ShortcutId = typeof SHORTCUTS[number]["id"];
export type ShortcutOverrides = Partial<Record<ShortcutId, string[]>>;

export function shortcutBindings(id: ShortcutId, overrides: ShortcutOverrides = {}): readonly string[] {
  return overrides[id] ?? SHORTCUTS.find((item) => item.id === id)!.defaults;
}

const namedKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert", "Delete", "Backspace", "Space", "Plus"];

export function validShortcut(binding: string): boolean {
  const parts = binding.split("+");
  const key = parts.pop()!;
  const modifiers = ["Mod", "Alt", "Shift"].filter((modifier) => parts.includes(modifier));
  if (parts.join("+") !== modifiers.join("+")) return false;
  const functionKey = /^F([1-9]|1\d|2[0-4])$/.test(key);
  if (!parts.includes("Mod") && !functionKey) return false;
  if (!functionKey && !namedKeys.includes(key) && !/^[^\s\p{C}+]$/u.test(key)) return false;
  if (key !== key.toLowerCase() && !namedKeys.includes(key) && !functionKey) return false;
  // Preserve native editing, window close/quit and reload shortcuts, including Shift variants.
  if (parts.includes("Mod") && !parts.includes("Alt") && ["a", "c", "v", "x", "z", "y", "w", "q", "r", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return false;
  if (binding === "Alt+F4") return false;
  return true;
}

export function shortcutConflict(overrides: ShortcutOverrides): { binding: string; first: ShortcutId; second: ShortcutId } | undefined {
  const used = new Map<string, ShortcutId>();
  for (const { id } of SHORTCUTS) {
    for (const binding of shortcutBindings(id, overrides)) {
      const first = used.get(binding);
      if (first) return { binding, first, second: id };
      used.set(binding, id);
    }
  }
}

export function validateShortcutOverrides(value: unknown): asserts value is ShortcutOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid keyboard shortcuts");
  for (const [id, bindings] of Object.entries(value)) {
    if (!SHORTCUTS.some((item) => item.id === id) || !Array.isArray(bindings) ||
      bindings.some((binding) => typeof binding !== "string" || !validShortcut(binding)))
      throw new Error("Invalid keyboard shortcuts");
  }
  if (shortcutConflict(value as ShortcutOverrides)) throw new Error("Keyboard shortcuts conflict");
}

export function formatShortcut(binding: string, mac = false): string {
  return binding.split("+").map((part) => part === "Mod" ? mac ? "Cmd" : "Ctrl" : part === "Plus" ? "+" : part.length === 1 ? part.toUpperCase() : part).join("+");
}
