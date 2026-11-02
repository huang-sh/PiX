export const NODE_CARD_FIELDS = ["model", "duration", "cost", "tokens", "context", "thinking", "branch"] as const;
export type NodeCardField = typeof NODE_CARD_FIELDS[number];
export const FIXED_NODE_CARD_FIELDS: readonly NodeCardField[] = ["model", "thinking"];
export const OPTIONAL_NODE_CARD_FIELDS = NODE_CARD_FIELDS.filter(field => !FIXED_NODE_CARD_FIELDS.includes(field));
export const DEFAULT_NODE_CARD_FIELDS: readonly NodeCardField[] = ["branch", "context"];

export function normalizeNodeCardFields(value: unknown): NodeCardField[] {
  if (!Array.isArray(value)) return [...DEFAULT_NODE_CARD_FIELDS];
  return [...new Set(value.filter((field): field is NodeCardField => OPTIONAL_NODE_CARD_FIELDS.includes(field)))];
}
