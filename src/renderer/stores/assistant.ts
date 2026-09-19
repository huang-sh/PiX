import { defineStore } from "pinia";
import { markRaw } from "vue";
import type {
  AgentActivity,
  PromptImage,
  RuntimeModel,
  SessionSnapshot,
} from "../../shared/types";
import { reduceAgentActivity } from "../../shared/agent-stream";
import { deliversPendingTurn } from "../../shared/session";
import { desktop } from "../api";

// The overlay card registers its DOM handle here: focus moves and the
// focus-state check behind Ctrl+E belong to whichever card is mounted, while
// the runtime state below must survive the card being hidden.
export interface AssistantOverlayHandle {
  containsFocus(): boolean;
  focus(): void;
}
let overlay: AssistantOverlayHandle | undefined;
export function registerAssistantOverlay(handle?: AssistantOverlayHandle) {
  overlay = handle;
}

// Composer draft shape shared with PromptComposer's draftState, so the text
// (and attachments) survive hiding the card.
export interface AssistantDraft {
  text: string;
  images: PromptImage[];
  busy: boolean;
  readingImages: boolean;
  error: string;
}

export const useAssistantStore = defineStore("assistant", {
  state: () => ({
    visible: false,
    snapshot: undefined as SessionSnapshot | undefined,
    activity: undefined as AgentActivity | undefined,
    /** Optimistic user turn, shown until the send reply carries the real entry. */
    pending: undefined as { text: string; images?: PromptImage[]; timestamp: string; knownEntryIds: Set<string> } | undefined,
    draft: { text: "", images: [], busy: false, readingImages: false, error: "" } as AssistantDraft,
    models: [] as RuntimeModel[],
    /** Local model/thinking overrides; undefined follows the session's own. */
    model: undefined as RuntimeModel | null | undefined,
    thinking: undefined as string | undefined,
    error: "",
    /** A reply settled while the card was hidden; cleared by the next show. */
    unread: false,
    /** Single-flight init promise: a fresh store instance starts a fresh flight. */
    initFlight: undefined as Promise<void> | undefined,
  }),
  getters: {
    ready(state): boolean {
      return Boolean(state.snapshot);
    },
    running(state): boolean {
      // pending marks the whole send flight: from submit to the settled reply,
      // so the stop control appears immediately and a second Enter cannot queue.
      return Boolean(state.pending || state.snapshot?.runtime.isStreaming || state.activity?.active);
    },
  },
  actions: {
    show() {
      this.visible = true;
      this.unread = false;
      overlay?.focus();
      void this.ensure();
    },
    hide() {
      this.visible = false;
    },
    // Ctrl+E: hidden → show; visible but focus elsewhere → focus the input;
    // focus already inside → collapse. One key never both closes and reopens.
    activate() {
      if (!this.visible) this.show();
      else if (overlay?.containsFocus()) this.hide();
      else overlay?.focus();
    },
    async ensure() {
      this.error = "";
      try {
        // A failed init must be retryable: the flight is cached only while it runs.
        await (this.initFlight ??= this.initialize().catch(error => {
          this.initFlight = undefined;
          throw error;
        }));
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    },
    async initialize() {
      const [snapshot] = await Promise.all([
        desktop.invoke<SessionSnapshot>("assistant.ensure"),
        this.loadModels(),
      ]);
      this.applySnapshot(snapshot);
    },
    async loadModels() {
      this.models = await desktop.invoke<RuntimeModel[]>("agent.control", { action: "getModels" });
    },
    applySnapshot(snapshot: SessionSnapshot) {
      snapshot.entries = markRaw(snapshot.entries);
      snapshot.projection = markRaw(snapshot.projection);
      this.snapshot = snapshot;
      // Match only entries the send never saw: repeating a sent text must not
      // let the older turn clear the pending one.
      const pending = this.pending;
      if (pending && deliversPendingTurn(snapshot.projection.messages, pending.text, pending.knownEntryIds))
        this.pending = undefined;
      this.retireSettledActivity();
    },
    /** The live section dies with the run, but only once its turn is in the
     *  history (pending gone) — otherwise the reply could flash it away. */
    retireSettledActivity() {
      if (this.snapshot && !this.snapshot.runtime.isStreaming &&
        this.activity && !this.activity.active && !this.pending)
        this.activity = undefined;
    },
    async send(text: string, images?: PromptImage[]) {
      await this.ensure();
      if (!this.snapshot || this.running) return false;
      this.pending = {
        text,
        images: images?.length ? images : undefined,
        timestamp: new Date().toISOString(),
        knownEntryIds: new Set(this.snapshot.entries.map(entry => entry.id)),
      };
      try {
        const snapshot = await desktop.invoke<SessionSnapshot>("assistant.send", {
          text,
          ...(images?.length ? { images } : {}),
          ...(this.model ? { provider: this.model.provider, modelId: this.model.id } : {}),
          ...(this.thinking ? { thinkingLevel: this.thinking } : {}),
        });
        this.applySnapshot(snapshot);
        // The reply closes the turn: it supersedes the optimistic message even
        // if the projection match above somehow missed the entry.
        this.pending = undefined;
        this.retireSettledActivity();
        this.error = "";
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        // PromptComposer restores the draft on a failed submit; the pending
        // turn must go with it or the card would show a message never sent.
        this.pending = undefined;
        return false;
      } finally {
        if (!this.visible) this.unread = true;
      }
    },
    async stop() {
      try {
        await desktop.invoke("assistant.stop");
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    },
    async newSession() {
      if (this.running) return;
      try {
        this.applySnapshot(await desktop.invoke<SessionSnapshot>("assistant.newSession"));
        this.model = undefined;
        this.thinking = undefined;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    },
    // Pi events arrive re-tagged as desktop "assistant" events; the payload is
    // the runtime's own {type: "agent" | "notice", payload} event.
    onEvent(event: { type?: string; payload?: unknown } | undefined) {
      if (!event) return;
      if (event.type === "agent") {
        const wasActive = this.activity?.active;
        const activity = reduceAgentActivity(this.activity, event.payload);
        this.activity = activity;
        if (wasActive && !activity?.active && !this.visible) this.unread = true;
        // The turn's reply snapshot usually wins the race against this event
        // (the forwarder defers it a tick), so the settle itself must retire
        // the live section too — or the working indicator sticks forever.
        this.retireSettledActivity();
      } else if (event.type === "notice") {
        // Only failures reach the card's error strip; info notices (login
        // progress and the like) have no surface here and stay silent.
        const payload = event.payload as { message?: string; level?: string } | undefined;
        if (payload?.message && payload.level === "error") this.error = payload.message;
      }
    },
  },
});
