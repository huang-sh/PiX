import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MainController } from "../src/main/controller.js";
import type { DesktopEvent } from "../src/shared/types.js";

for (const streaming of [false, true]) {
  test(`deleting the ${streaming ? "streaming" : "idle"} current session closes it before unlinking`, { timeout: 15_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "pix-delete-"));
    const previousHome = process.env.PIX_HOME;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PIX_HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    const cwd = join(home, "ws");
    const realCwd = join(home, "real-ws");
    mkdirSync(realCwd);
    symlinkSync(realCwd, cwd, process.platform === "win32" ? "junction" : "dir");
    const controller = new MainController(cwd, {
      pickProject: async () => undefined,
      pickSession: async () => undefined,
      confirm: async () => false,
      openExternal: async () => undefined,
      quit() {},
    });
    try {
      const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128_000 }] });
      const factory = controller.pi.factory.bind(controller.pi);
      controller.pi.factory = (pi: unknown) => async (args: unknown) => {
        const created = await factory(pi)(args);
        created.services.modelRuntime.registerNativeProvider(faux.provider);
        return created;
      };
      await controller.invoke("agent.control", { action: "newSession" });
      await controller.invoke("agent.control", { action: "setModel", provider: "faux", modelId: "faux-1" });
      faux.setResponses([fauxAssistantMessage("first answer")]);
      await controller.invoke("agent.control", { action: "prompt", text: "first prompt" });
      const path = controller.current!.session.path;
      const runtime = controller.pi.runtime;

      await controller.invoke("session.delete", { path });
      assert.equal(existsSync(path), true, "cancelled deletion preserves the file");
      assert.equal(controller.pi.runtime, runtime);
      const other = join(controller.files.dir!, "other.jsonl");
      copyFileSync(path, other);
      await controller.invoke("session.delete", { path: other, confirmed: true });
      assert.equal(controller.pi.runtime, runtime, "deleting another session preserves the runtime");

      let running: Promise<unknown> | undefined;
      if (streaming) {
        let signalStarted!: () => void;
        const started = new Promise<void>((resolve) => (signalStarted = resolve));
        faux.setResponses([async (_context, options) => {
          signalStarted();
          await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
          return fauxAssistantMessage("", { stopReason: "aborted" });
        }]);
        running = controller.invoke("agent.control", { action: "prompt", text: "running prompt" });
        await started;
      }
      const events: DesktopEvent[] = [];
      controller.onEvent((event) => events.push(event));
      const deletion = controller.invoke("session.delete", { path, confirmed: true });
      await assert.rejects(controller.invoke("agent.control", { action: "prompt", text: "while closing" }), /Session is closing/);
      await deletion;
      await running;

      assert.equal(controller.pi.runtime, undefined);
      assert.equal(controller.current, undefined);
      assert.equal(existsSync(path), false);
      assert.deepEqual(events.at(-1), { type: "sessions", payload: { deletedPath: path, sessions: [] } });
      await assert.rejects(controller.invoke("agent.control", { action: "prompt", text: "must not resurrect" }), /Open a session first/);
      assert.equal(existsSync(path), false);
      assert.deepEqual(await controller.sessions(), []);
      await controller.invoke("agent.control", { action: "newSession" });
      assert.ok(controller.pi.runtime, "a new session can be created after deletion");
    } finally {
      controller.dispose();
      if (previousHome === undefined) delete process.env.PIX_HOME;
      else process.env.PIX_HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(home, { recursive: true, force: true });
    }
  });
}
