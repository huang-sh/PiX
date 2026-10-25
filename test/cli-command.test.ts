import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandStatus, installCommand, registerDesktopCommand, uninstallCommand } from "../src/main/cli-command.js";

const temporary = () => mkdtempSync(join(tmpdir(), "pix-command-"));

test("Unix command registration supports fresh shells, relocation, exact cleanup and opt-out", { skip: process.platform === "win32" }, () => {
  const home = temporary();
  const options = { home, platform: "darwin" as const, shell: "/bin/zsh" };
  const original = '# existing config\nexport KEEP="original"';
  writeFileSync(join(home, ".zprofile"), original);
  const target = join(home, "App space ' dollar$", "pix");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n'); chmodSync(target, 0o755);
  try {
    installCommand({ ...options, launcher: target });
    installCommand({ ...options, launcher: target });
    assert.equal(commandStatus(options).installed, true);
    assert.equal(readFileSync(join(home, ".zprofile"), "utf8").split("# >>> PiX CLI >>>").length, 2);
    const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
    const invoke = spawnSync(shell, ["-c", '. "$HOME/.zprofile"; pix "a b" \'$literal\'; printf "%s" "$KEEP"'], {
      encoding: "utf8", env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
    });
    assert.equal(invoke.status, 0, invoke.stderr);
    assert.equal(invoke.stdout, "a b\n$literal\noriginal");
    const moved = join(home, "relocated");
    writeFileSync(moved, '#!/bin/sh\nprintf moved\n'); chmodSync(moved, 0o755);
    installCommand({ ...options, launcher: moved });
    assert.equal(spawnSync(join(home, ".pix/bin/pix"), [], { encoding: "utf8" }).stdout, "moved");
    // Keep edits made after install, including exact original trailing content.
    const profile = join(home, ".zprofile");
    writeFileSync(profile, readFileSync(profile, "utf8") + "# later edit\n");
    uninstallCommand(options);
    assert.equal(readFileSync(profile, "utf8"), original + "\n# later edit\n");
    assert.equal(existsSync(join(home, ".zshrc")), false);
    assert.equal(commandStatus(options).installed, false);
    registerDesktopCommand(moved, options);
    assert.equal(commandStatus(options).installed, false, "a later GUI launch respects explicit removal");
    installCommand({ ...options, launcher: moved });
    assert.equal(commandStatus(options).installed, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Bash registration preserves login precedence and symlinked dotfiles", { skip: process.platform === "win32" }, () => {
  const home = temporary();
  const file = join(home, "dotfiles", "profile");
  mkdirSync(join(file, "..")); writeFileSync(file, "export ORIGINAL=1\n");
  symlinkSync(file, join(home, ".profile"));
  const options = { home, platform: "linux" as const, shell: "/bin/bash", launcher: "/opt/PiX/resources/cli/pix" };
  try {
    installCommand(options);
    assert.equal(existsSync(join(home, ".bash_profile")), false);
    assert.match(readFileSync(file, "utf8"), /PiX CLI/);
    uninstallCommand(options);
    assert.equal(readFileSync(file, "utf8"), "export ORIGINAL=1\n");
    assert.equal(existsSync(join(home, ".bashrc")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("registration refuses foreign commands and cleanup leaves their replacements intact", { skip: process.platform === "win32" }, () => {
  const home = temporary(), dir = join(home, ".pix", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pix"), "foreign command");
  const options = { home, platform: "linux" as const, shell: "/bin/bash", launcher: "/app/resources/cli/pix" };
  try {
    assert.throws(() => installCommand(options), /Another command/);
    assert.equal(existsSync(join(home, ".profile")), false);
    uninstallCommand(options);
    assert.equal(readFileSync(join(dir, "pix"), "utf8"), "foreign command");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("fish PATH uses session scope and its configuration is cleaned up", { skip: process.platform === "win32" }, () => {
  const home = temporary();
  const options = { home, platform: "linux" as const, shell: "/usr/bin/fish", launcher: "/app/resources/cli/pix" };
  try {
    installCommand(options);
    const fish = join(home, ".config/fish/conf.d/pix-cli.fish");
    assert.match(readFileSync(fish, "utf8"), /set -gx PATH/);
    assert.doesNotMatch(readFileSync(fish, "utf8"), /set -U|fish_add_path/);
    uninstallCommand(options);
    assert.equal(existsSync(fish), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
