import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("runtime probe enforces the server minimum, Linux, and supported CPU", () => {
  const checker = pathToFileURL(resolve(import.meta.dirname, "../server/bin/check-runtime.mjs")).href;
  for (const [version, platform, arch, accepted] of [
    ["22.18.0", "linux", "x64", false], ["22.19.0", "linux", "x64", true],
    ["22.23.1", "linux", "x64", true], ["24.11.1", "linux", "arm64", true],
    ["24.18.0", "win32", "x64", false], ["24.18.0", "linux", "ia32", false],
    ["24.0.0-rc.1", "linux", "x64", false],
  ]) {
    const code = `Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}});
      Object.defineProperty(process, 'platform', {value: ${JSON.stringify(platform)}});
      Object.defineProperty(process, 'arch', {value: ${JSON.stringify(arch)}});
      process.argv[2] = '--probe'; await import(${JSON.stringify(checker)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    assert.equal(result.status === 0, accepted, `${version} ${platform} ${arch}: ${result.stderr}`);
  }
});

test("shared Linux runtime installer selection and rollback", () => {
  const root = resolve(import.meta.dirname, "..");
  let result;
  if (process.platform === "win32") {
    const distro = process.env.PIX_TEST_WSL_DISTRO || "Ubuntu-24.04";
    const path = spawnSync("wsl.exe", ["-d", distro, "--exec", "wslpath", "-a", "-u", root], { encoding: "utf8" });
    assert.equal(path.status, 0, path.stderr || path.stdout);
    const linuxRoot = path.stdout.trim();
    result = spawnSync("wsl.exe", ["-d", distro, "--exec", "sh", `${linuxRoot}/test/fixtures/runtime-installer.sh`, linuxRoot], { encoding: "utf8", timeout: 60_000 });
  } else {
    result = spawnSync("sh", [resolve(root, "test/fixtures/runtime-installer.sh"), root], { encoding: "utf8", timeout: 60_000 });
  }
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.equal((result.stdout.match(/PASS:/g) ?? []).length, 6);
});
