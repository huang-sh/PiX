export interface CompactionRecord {
  status: "running" | "complete" | "aborted" | "error";
  startedAt?: string;
  endedAt?: string;
  entryTimestamp?: string;
  durationMs?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  error?: string;
}

export interface RunTiming {
  startedAt: string;
  agentStartedAt?: string;
  compactions: CompactionRecord[];
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const timestamp = (value: unknown): string | undefined =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
const amount = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function readRunTiming(value: unknown): RunTiming | undefined {
  const raw = object(value), startedAt = timestamp(raw?.startedAt);
  if (!raw || !startedAt) return undefined;
  const compactions: CompactionRecord[] = [];
  for (const value of Array.isArray(raw.compactions) ? raw.compactions : []) {
    const item = object(value);
    if (!item || !["running", "complete", "aborted", "error"].includes(String(item.status))) continue;
    compactions.push({ status: item.status as CompactionRecord["status"], startedAt: timestamp(item.startedAt),
      endedAt: timestamp(item.endedAt), entryTimestamp: timestamp(item.entryTimestamp), durationMs: amount(item.durationMs),
      tokensBefore: amount(item.tokensBefore), tokensAfter: amount(item.tokensAfter),
      ...(typeof item.error === "string" ? { error: item.error } : {}) });
  }
  return { startedAt, agentStartedAt: timestamp(raw.agentStartedAt), compactions };
}

export function runDurations(timing: RunTiming, end: number) {
  const elapsed = (start: string) => Math.max(0, end - Date.parse(start));
  const compactionDurationMs = timing.compactions.reduce((sum, item) => sum + (item.status === "running" && item.startedAt
    ? elapsed(item.startedAt) : item.durationMs ?? 0), 0);
  const agentStart = Date.parse(timing.agentStartedAt ?? "");
  const agentCompactionMs = timing.compactions.reduce((sum, item) => {
    const compactionStart = Date.parse(item.startedAt ?? "");
    const start = Math.max(agentStart, compactionStart);
    const endedAt = Date.parse(item.endedAt ?? "");
    const finish = Math.min(end, Number.isFinite(endedAt) ? endedAt
      : item.status === "running" ? end : compactionStart + (item.durationMs ?? 0));
    return sum + (Number.isFinite(start) && finish >= start ? finish - start : 0);
  }, 0);
  return { durationMs: elapsed(timing.startedAt), compactionDurationMs,
    ...(Number.isFinite(agentStart) ? { agentDurationMs: Math.max(0, end - agentStart - agentCompactionMs) } : {}) };
}
