import test from "node:test";
import assert from "node:assert/strict";
import { createModels, InMemoryCredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/main/pi-runtime.js";
import { ExtensionDialogs } from "../src/main/extension-dialogs.js";
import type { DesktopEvent } from "../src/shared/types.js";

test("only OpenAI browser callback fallbacks use a nonmodal login request", async t => {
  for (const [provider, type, kind] of [
    ["openai", "manual_code", "oauth"],
    ["openai", "text", "input"],
    ["anthropic", "manual_code", "input"],
  ] as const) await t.test(`${provider} ${type}`, async t => {
    const dialogs = new ExtensionDialogs(() => {});
    const runtime = new PiRuntime(null, null, () => {}, async () => {}, dialogs);
    let ready!: () => void;
    const prompted = new Promise<void>(resolve => { ready = resolve; });
    t.mock.method(runtime, "modelRuntime", async () => ({
      login: async (_provider: string, _type: string, interaction: any) => {
        const response = interaction.prompt({ type, message: "Sign in", placeholder: "redirect URL" });
        ready();
        assert.equal(await response, "manual redirect");
      },
      checkAuth: async () => ({ type: "oauth" }),
    }));
    t.mock.method(runtime, "refreshBrokerAuth", async () => {});
    const login = runtime.control({ action: "loginOAuth", provider, method: "browser" });
    await prompted;
    const [request] = dialogs.list();
    assert.ok(request);
    assert.equal(request.kind, kind);
    assert.equal(request.source, provider);
    dialogs.respond(request.id, "manual redirect");
    await login;
    assert.deepEqual(dialogs.list(), []);
  });
});

test("OAuth cancellation reaches token exchange without cancelling successful callback cleanup", async t => {
  for (const outcome of ["callback", "manual", "cancel-before-callback", "cancel-during-exchange"] as const) await t.test(outcome, async t => {
    const events: DesktopEvent[] = [];
    const dialogs = new ExtensionDialogs(event => events.push(event));
    const runtime = new PiRuntime(null, null, () => {}, async () => {}, dialogs);
    const credentials = new InMemoryCredentialStore();
    const previous: OAuthCredential = { type: "oauth", access: "previous-access", refresh: "previous-refresh", expires: Date.now() + 3600_000 };
    const next: OAuthCredential = { ...previous, access: "new-access", refresh: "new-refresh" };
    await credentials.modify("openai", async () => previous);
    const models = createModels({ credentials });
    let ready!: () => void;
    let callback!: () => void;
    let startExchange!: () => void;
    let finishExchange!: () => void;
    let flowSignal!: AbortSignal;
    let exchangeAborted = false;
    const prompted = new Promise<void>(resolve => { ready = resolve; });
    const browserCallback = new Promise<void>(resolve => { callback = resolve; });
    const exchanging = new Promise<void>(resolve => { startExchange = resolve; });
    const exchanged = new Promise<void>(resolve => { finishExchange = resolve; });
    models.setProvider({
      id: "openai", name: "OpenAI", getModels: () => [],
      stream: () => { throw new Error("not used"); },
      streamSimple: () => { throw new Error("not used"); },
      auth: { oauth: {
        name: "OpenAI",
        login: async interaction => {
          flowSignal = interaction.signal;
          const manualAbort = new AbortController();
          const response = interaction.prompt({ type: "manual_code", message: "Sign in",
            signal: AbortSignal.any([manualAbort.signal, interaction.signal]) });
          ready();
          try {
            await Promise.race([browserCallback, response]);
            startExchange();
            // Like fetch(), token exchange must stop when the login signal aborts.
            await new Promise<void>((resolve, reject) => {
              const abort = () => { exchangeAborted = true; reject(interaction.signal.reason); };
              interaction.signal.addEventListener("abort", abort, { once: true });
              void exchanged.then(() => { interaction.signal.removeEventListener("abort", abort); resolve(); });
              if (interaction.signal.aborted) abort();
            });
            return next;
          } finally { manualAbort.abort(); }
        },
        refresh: async credential => credential,
        toAuth: async credential => ({ apiKey: credential.access }),
      } },
    });
    t.mock.method(runtime, "modelRuntime", async () => models);
    t.mock.method(runtime, "refreshBrokerAuth", async () => {});
    const login = runtime.control({ action: "loginOAuth", provider: "openai", method: "browser" });
    const cancelled = outcome.startsWith("cancel-");
    const result = cancelled ? assert.rejects(login, /Sign-in cancelled/) : login;
    await prompted;
    const [request] = dialogs.list();
    assert.ok(request);
    assert.equal(request.kind, "oauth");
    if (outcome === "manual") dialogs.respond(request.id, "manual redirect");
    else if (outcome !== "cancel-before-callback") callback();
    if (outcome !== "cancel-before-callback") await exchanging;
    if (cancelled) dialogs.respond(request.id);
    await new Promise<void>(resolve => setImmediate(resolve));
    finishExchange();
    await result;
    assert.equal(flowSignal.aborted, cancelled, "provider prompt cleanup must not abort a successful login");
    assert.equal(exchangeAborted, outcome === "cancel-during-exchange");
    assert.deepEqual(await credentials.read("openai"), cancelled ? previous : next);
    assert.deepEqual(dialogs.list(), []);
    assert.ok(events.some(event => event.type === "ui.dismiss" && (event.payload as { id: string }).id === request.id));
  });
});
