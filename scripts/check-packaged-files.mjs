import { extractFile } from "@electron/asar";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

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
