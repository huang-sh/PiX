import { extractFile } from "@electron/asar";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Missing optional dependencies must fail packaging, not the user's first search.
export function checkPackagedFff(resources, platform, arch) {
  const modules = join(resources, "pi-builtin", "node_modules");
  const ffiTarget = `${platform}-${arch}${platform === "win32" ? "-msvc" : ""}`;
  for (const name of [
    "@ff-labs/pi-fff", "@ff-labs/fff-node", "ffi-rs",
    `@ff-labs/fff-bin-${platform}-${arch}`, `@yuuang/ffi-rs-${ffiTarget}`,
  ]) {
    try {
      const dir = join(modules, name);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const entry = pkg.pi?.extensions[0] ?? pkg.main;
      if (!statSync(join(dir, entry)).size) throw new Error("empty entry point");
    } catch (cause) {
      throw new Error(`Incomplete PiX package: ${name}. Run npm ci and package on ${platform}-${arch}.`, { cause });
    }
  }
}

// A build that silently drops the bundled skills tree ships an app where they
// just vanish (resolveBuiltinSkills returns nothing, no error); fail the
// packaging instead.
export function checkPackagedSkills(resources) {
  const skills = join(resources, "skills");
  const bundled = existsSync(skills)
    ? readdirSync(skills, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(skills, entry.name, "SKILL.md")))
    : [];
  if (!bundled.length)
    throw new Error(
      `Incomplete PiX package: no bundled skills under ${skills}. Keep the electron-builder extraResources "skills" entry in sync with the repo skills/ tree.`,
    );
}

// Check the finished archive, not just the build directory: packaging can
// otherwise succeed while a concurrent build has temporarily emptied it.
export function checkPackagedFiles(archive, appDir) {
  const renderer = join(appDir, "out", "renderer");
  const required = new Set([
    join("out", "main", "index.js"),
    join("out", "preload", "index.cjs"),
    join("out", "renderer", "index.html"),
  ]);
  for (const entry of readdirSync(renderer, { recursive: true, withFileTypes: true })) {
    if (entry.isFile())
      required.add(relative(appDir, join(entry.parentPath, entry.name)));
  }
  for (const file of required) {
    try {
      const built = readFileSync(join(appDir, file));
      if (!built.length || !extractFile(archive, file).equals(built))
        throw new Error("missing, empty, or different from the build output");
    } catch (cause) {
      throw new Error(`Incomplete PiX package: ${file}. Finish the build before packaging.`, { cause });
    }
  }
}
