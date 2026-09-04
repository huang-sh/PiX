import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainController, type Platform } from "../src/main/controller.js";

const platform: Platform = {
  async pickProject() {
    return undefined;
  },
  async pickSession() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async openExternal() {},
  quit() {},
};

test("first run boots project-less and refuses project-scoped routes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-noproject-"));
  try {
    const controller = new MainController(null, platform);
    controller.settings.appPath = join(home, "settings.json");
    const boot = (await controller.invoke("app.bootstrap", {})) as {
      project: unknown;
      sessions: unknown[];
      projects: unknown[];
    };
    assert.equal(boot.project, null);
    assert.deepEqual(boot.sessions, []);
    assert.deepEqual(boot.projects, []);
    // No project is silently remembered while none is open.
    assert.deepEqual(controller.settings.projectHistory(), []);
    for (const route of [
      "session.list",
      "workspace.tree",
      "git.status",
      "shell.run",
      "terminal.create",
    ] as const) {
      await assert.rejects(
        () => controller.invoke(route, route === "shell.run"
          ? { command: "echo hi" }
          : route === "terminal.create"
            ? { cols: 80, rows: 24 }
            : {}),
        /Open a project first/,
      );
    }
    // App-scope settings still work without a project.
    const bundle = (await controller.invoke("settings.update", {
      scope: "app",
      patch: { language: "zh-CN" },
    })) as { app: { language: string; lastProject?: string } };
    assert.equal(bundle.app.language, "zh-CN");
    assert.equal(bundle.app.lastProject, undefined);
    // Project-scope writes stay refused.
    await assert.rejects(
      () => controller.invoke("settings.update", {
        scope: "project",
        patch: {},
      }),
      /Open a project first/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("picking a project opens it and records it as the last project", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-pick-"));
  const project = join(home, "project");
  try {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "note.md"), "# fixture");
    const controller = new MainController(null, {
      ...platform,
      async pickProject() {
        return project;
      },
    });
    controller.settings.appPath = join(home, "settings.json");
    controller.sessions = async () => [];
    const boot = (await controller.invoke("app.pickProject", {})) as {
      project: { path: string };
      projects: { id: string }[];
    };
    assert.equal(boot.project.path, project);
    assert.equal(boot.projects.length, 1);
    assert.equal(controller.settings.bundle().app.lastProject, project);
    // Project routes work again and the session dir was created.
    assert.deepEqual(await controller.invoke("session.list", {}), []);
    const tree = (await controller.invoke("workspace.tree", {})) as {
      name: string;
    }[];
    assert.ok(tree.some((entry) => entry.name === "note.md"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("restoring the last project still works on later runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-restore-"));
  const project = join(home, "project");
  try {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "note.md"), "# fixture");
    const opening = new MainController(null, {
      ...platform,
      async pickProject() {
        return project;
      },
    });
    opening.settings.appPath = join(home, "settings.json");
    opening.sessions = async () => [];
    await opening.invoke("app.pickProject", {});
    // A fresh controller (next launch) restores the chosen project.
    const next = new MainController(null, platform);
    next.settings.appPath = join(home, "settings.json");
    next.sessions = async () => [];
    const boot = (await next.invoke("app.bootstrap", {})) as {
      project: { path: string };
    };
    assert.equal(boot.project.path, project);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
