import type { DesktopRouteMap } from "../src/shared/desktop-routes.js";
import type { DesktopApi, DesktopRoute, PromptImage, SessionHistoryWindow, SessionSnapshot, SessionSummary } from "../src/shared/types.js";

// Checked by tsc in npm test; never executed. Invalid calls must remain compile errors.
async function checkDesktopRoutes(api: DesktopApi, image: PromptImage) {
  const opened: SessionSnapshot = await api.invoke("session.open", { path: "session.jsonl" });
  const sessions: SessionSummary[] = await api.invoke("session.list");
  const current: SessionSnapshot | undefined = await api.invoke("session.snapshot");
  const page: SessionHistoryWindow = await api.invoke("session.branchWindow", {
    session: "session.jsonl", limit: 40, bytes: 4 << 20,
  });
  const sent: SessionSnapshot = await api.invoke("pixie.send", { text: "Hello" });
  const imageOnly: SessionSnapshot = await api.invoke("pixie.send", { images: [image] });
  const stopped: void = await api.invoke("pixie.stop");
  const preview: string = (await api.invoke("pixie.previewPrompt")).text;
  const customized: string = (await api.invoke("pixie.previewPrompt", { identity: "Pixie" })).text;
  const cleared = await api.invoke("pixie.clearHistory");
  if ("cancelled" in cleared) cleared.cancelled satisfies true;
  else cleared satisfies SessionSnapshot;
  const imported = await api.invoke("session.import");
  if (imported) imported.imported satisfies string;
  // Other routes keep working during the incremental migration.
  const legacy: { ok: boolean } = await api.invoke<{ ok: boolean }>("app.quit");
  void [opened, sessions, current, page, sent, imageOnly, stopped, preview, customized, legacy];

  // @ts-expect-error session.open requires a path payload
  api.invoke("session.open");
  // @ts-expect-error undefined cannot replace a required payload
  api.invoke("session.open", undefined);
  // @ts-expect-error path must be a string
  api.invoke("session.open", { path: 123 });
  // @ts-expect-error fields from another route are not accepted
  api.invoke("session.open", { query: "hello" });
  // @ts-expect-error typos must not be silently accepted
  api.invoke("session.open", { path: "session.jsonl", projectID: "wrong" });
  // @ts-expect-error the caller cannot override a typed route's output
  api.invoke<number>("session.open", { path: "session.jsonl" });
  // @ts-expect-error inferred return type is not caller-selected
  const wrongResult: number = await api.invoke("session.open", { path: "session.jsonl" });
  // @ts-expect-error there may be no current session
  const missingSession: SessionSnapshot = await api.invoke("session.snapshot");
  // @ts-expect-error cancellation must be narrowed before accessing the snapshot
  const cancelledSnapshot: SessionSnapshot = await api.invoke("pixie.clearHistory");
  // @ts-expect-error sending requires text or images
  api.invoke("pixie.send", {});
  // @ts-expect-error no payload is accepted by pixie.stop
  api.invoke("pixie.stop", { text: "hello" });
  // @ts-expect-error history requests require the byte budget accepted by the validator
  api.invoke("session.branchWindow", { session: "session.jsonl", limit: 40 });
  // @ts-expect-error the unknown route must not match the legacy overload
  api.invoke("session.missing");
  const uncertainRoute = Math.random() > 0.5 ? "session.open" : "pixie.stop";
  // @ts-expect-error a union route cannot make a required payload optional
  api.invoke(uncertainRoute);
  // @ts-expect-error a union route cannot accept the wrong variant's payload
  api.invoke(uncertainRoute, { path: "session.jsonl" });
  const correlated: ["session.open", { path: string }] | ["pixie.stop"] = Math.random() > 0.5
    ? ["session.open", { path: "session.jsonl" }] : ["pixie.stop"];
  const unionResult: SessionSnapshot | void = await api.invoke(...correlated);
  void unionResult;
  void [wrongResult, missingSession, cancelledSnapshot];
}
void checkDesktopRoutes;

type Unmapped = Exclude<Extract<DesktopRoute, `pixie.${string}` | `session.${string}`>, keyof DesktopRouteMap>;
const allSessionAndPixieRoutesMapped: Unmapped extends never ? true : false = true;
void allSessionAndPixieRoutesMapped;
