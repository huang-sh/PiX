// Wiki feature contracts shared by the main process and the renderer.
// The wiki is a derived, read-only view of session graphs stored under
// `<project>/.pix/wiki`; source sessions are never modified.

export type WikiPageState = "fresh" | "dirty" | "invalid";

export interface WikiBranchStatus {
  branchId: string;
  /** Live task state when set, otherwise the persisted page state. */
  status: WikiPageState | "queued" | "updating" | "failed";
  coveredTurns: number;
  totalTurns: number;
  error?: string;
}

export interface WikiUsageSummary {
  input: number;
  output: number;
  calls: number;
  cost: number | null;
}

export interface WikiStatus {
  sessionPath: string;
  /** False when the session or its storage is gone (e.g. deleted). */
  available: boolean;
  reason?: string;
  enabled: boolean;
  /** Session section key inside the workspace wiki (its header id). */
  sessionKey?: string;
  model: { provider: string; id: string } | null;
  budgetTokens?: number;
  paused?: boolean;
  /** Workspace-wide cumulative spend across all sessions in this wiki. */
  usage: WikiUsageSummary;
  branches: WikiBranchStatus[];
  updatedAt: string;
}

/** Runtime persistence events a wiki service reacts to. Fired after data is on disk. */
export type WikiGraphEvent =
  | { kind: "opened" }
  | { kind: "settled"; branchId: string }
  | { kind: "deleted" };

export interface WikiAppSettings {
  /** Automatic background summaries after each settled turn. */
  enabled?: boolean;
  provider?: string;
  modelId?: string;
  /** Soft budget for cumulative wiki model tokens; unlimited when unset. */
  budgetTokens?: number;
}
