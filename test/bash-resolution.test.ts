import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  deriveBashPathsFromGit,
  detectWindowsBash,
  findExecutableOnPath,
  memoizeOnce,
  withDefaultPowershellTool,
  withDetectedBashShell,
} from "../src/main/bash-resolution.js";

function tempTree() {
  return mkdtempSync(join(tmpdir(), "pix-bash-"));
}

test("findExecutableOnPath expands PATHEXT in PATH order", () => {
  const root = tempTree();
  try {
    const first = join(root, "first"),
      second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, "git.exe"), "");
    writeFileSync(join(second, "git.bat"), "");
    const env = {
      PATH: [first, second].join(delimiter),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    assert.equal(findExecutableOnPath("git", env), join(first, "git.exe"));
    assert.equal(findExecutableOnPath("git.exe", env), join(first, "git.exe"));
    rmSync(join(first, "git.exe"));
    assert.equal(findExecutableOnPath("git", env), join(second, "git.bat"));
    assert.equal(findExecutableOnPath("git", { PATH: "" }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveBashPathsFromGit maps every git.exe location to Git\\bin", () => {
  const root = tempTree();
  try {
    assert.deepEqual(deriveBashPathsFromGit(join(root, "cmd", "git.exe")), [
      join(root, "bin", "bash.exe"),
      join(dirname(root), "bin", "bash.exe"),
    ]);
    assert.equal(
      deriveBashPathsFromGit(join(root, "usr", "bin", "git.exe"))[1],
      join(root, "bin", "bash.exe"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectWindowsBash prefers Git Bash under Program Files over PATH", () => {
  const root = tempTree();
  try {
    const programFiles = join(root, "pf"),
      gitRoot = join(root, "software", "Git");
    mkdirSync(join(programFiles, "Git", "bin"), { recursive: true });
    mkdirSync(join(gitRoot, "cmd"), { recursive: true });
    mkdirSync(join(gitRoot, "bin"), { recursive: true });
    writeFileSync(join(programFiles, "Git", "bin", "bash.exe"), "");
    writeFileSync(join(gitRoot, "bin", "bash.exe"), "");
    writeFileSync(join(gitRoot, "cmd", "git.exe"), "");
    assert.equal(
      detectWindowsBash({
        platform: "win32",
        env: {
          ProgramFiles: programFiles,
          PATH: join(gitRoot, "cmd"),
          PATHEXT: ".EXE",
        },
      }),
      join(programFiles, "Git", "bin", "bash.exe"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectWindowsBash derives bash from git.exe on PATH", () => {
  const root = tempTree();
  try {
    const gitRoot = join(root, "software", "Git");
    mkdirSync(join(gitRoot, "cmd"), { recursive: true });
    mkdirSync(join(gitRoot, "usr", "bin"), { recursive: true });
    mkdirSync(join(gitRoot, "bin"), { recursive: true });
    writeFileSync(join(gitRoot, "bin", "bash.exe"), "");
    writeFileSync(join(gitRoot, "cmd", "git.exe"), "");
    writeFileSync(join(gitRoot, "usr", "bin", "git.exe"), "");
    const env = (pathEntry: string) => ({
      ProgramFiles: join(root, "missing-pf"),
      PATH: pathEntry,
      PATHEXT: ".EXE",
    });
    assert.equal(
      detectWindowsBash({ platform: "win32", env: env(join(gitRoot, "cmd")) }),
      join(gitRoot, "bin", "bash.exe"),
    );
    assert.equal(
      detectWindowsBash({
        platform: "win32",
        env: env(join(gitRoot, "usr", "bin")),
      }),
      join(gitRoot, "bin", "bash.exe"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectWindowsBash falls back to bash.exe directly on PATH", () => {
  const root = tempTree();
  try {
    const msys = join(root, "msys", "bin");
    mkdirSync(msys, { recursive: true });
    writeFileSync(join(msys, "bash.exe"), "");
    assert.equal(
      detectWindowsBash({
        platform: "win32",
        env: {
          ProgramFiles: join(root, "missing-pf"),
          PATH: msys,
          PATHEXT: ".EXE",
        },
      }),
      join(msys, "bash.exe"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectWindowsBash returns undefined without matches and off Windows", () => {
  const root = tempTree();
  try {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const env = { ProgramFiles: empty, PATH: empty, PATHEXT: ".EXE" };
    assert.equal(detectWindowsBash({ platform: "win32", env }), undefined);
    writeFileSync(join(empty, "bash.exe"), "");
    assert.equal(detectWindowsBash({ platform: "linux", env }), undefined);
    assert.equal(detectWindowsBash({ platform: "darwin", env }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memoizeOnce probes the detector once and caches undefined too", () => {
  let calls = 0;
  const probe = memoizeOnce(() => {
    calls++;
    return "D:\\software\\Git\\bin\\bash.exe";
  });
  assert.equal(probe(), "D:\\software\\Git\\bin\\bash.exe");
  assert.equal(probe(), "D:\\software\\Git\\bin\\bash.exe");
  assert.equal(calls, 1);
  let misses = 0;
  const miss = memoizeOnce(() => {
    misses++;
    return undefined;
  });
  assert.equal(miss(), undefined);
  assert.equal(miss(), undefined);
  assert.equal(misses, 1);
});

test("withDetectedBashShell falls back only when no shellPath is configured", () => {
  const manager = {
    configured: undefined as string | undefined,
    getShellPath(): string | undefined {
      return this.configured;
    },
    settingCount(): number {
      return 1;
    },
  };
  const detected = "D:\\software\\Git\\bin\\bash.exe";
  assert.equal(withDetectedBashShell(manager, undefined), manager);
  const fallback = withDetectedBashShell(manager, detected);
  assert.notEqual(fallback, manager);
  assert.equal(fallback.getShellPath(), detected);
  assert.equal(fallback.settingCount(), 1);
  manager.configured = "C:\\custom\\bash.exe";
  assert.equal(fallback.getShellPath(), "C:\\custom\\bash.exe");
});

test("withDefaultPowershellTool appends powershell to any default set", () => {
  const manager = {
    configured: undefined as string[] | undefined,
    getDefaultTools(): string[] | undefined {
      return this.configured;
    },
    settingCount(): number {
      return 1;
    },
  };
  assert.equal(withDefaultPowershellTool(manager, "linux"), manager);
  const fallback = withDefaultPowershellTool(manager, "win32");
  assert.notEqual(fallback, manager);
  assert.deepEqual(fallback.getDefaultTools(), [
    "read",
    "bash",
    "edit",
    "write",
    "powershell",
  ]);
  assert.equal(fallback.settingCount(), 1);
  // A migrated pi CLI config that lists tools without powershell still gets
  // it appended, without rewriting the configured order.
  manager.configured = ["read", "bash", "edit", "write"];
  assert.deepEqual(fallback.getDefaultTools(), [
    "read",
    "bash",
    "edit",
    "write",
    "powershell",
  ]);
  // An explicit list already containing powershell passes through untouched.
  manager.configured = ["read", "powershell", "edit", "write"];
  assert.deepEqual(fallback.getDefaultTools(), [
    "read",
    "powershell",
    "edit",
    "write",
  ]);
  // An explicitly empty list is a deliberate "no built-in tools"; forcing a
  // shell back on would grant execution the user turned away.
  manager.configured = [];
  assert.deepEqual(fallback.getDefaultTools(), []);
});

test("wrappers read settings mutated through the wrapper", () => {
  const manager = {
    settings: {} as { defaultTools?: string[]; shellPath?: string },
    getDefaultTools(): string[] | undefined {
      return this.settings.defaultTools;
    },
    getShellPath(): string | undefined {
      return this.settings.shellPath;
    },
    // Mirrors Pi's SettingsManager.applyOverrides/reload: fresh state lands
    // as own properties of whatever object the method runs on.
    applyOverrides(overrides: { defaultTools?: string[]; shellPath?: string }) {
      this.settings = { ...this.settings, ...overrides };
    },
  };
  const wrapped = withDefaultPowershellTool(
    withDetectedBashShell(manager, "D:\\software\\Git\\bin\\bash.exe"),
    "win32",
  );
  assert.deepEqual(wrapped.getDefaultTools(), [
    "read",
    "bash",
    "edit",
    "write",
    "powershell",
  ]);
  assert.equal(wrapped.getShellPath(), "D:\\software\\Git\\bin\\bash.exe");
  wrapped.applyOverrides({ shellPath: "C:\\custom\\bash.exe" });
  assert.equal(wrapped.getShellPath(), "C:\\custom\\bash.exe");
  wrapped.applyOverrides({ defaultTools: ["read", "grep"] });
  assert.deepEqual(wrapped.getDefaultTools(), ["read", "grep", "powershell"]);
  wrapped.applyOverrides({ defaultTools: [] });
  assert.deepEqual(wrapped.getDefaultTools(), []);
});
