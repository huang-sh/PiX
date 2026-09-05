import { cpSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

// Preserve npm's installed layout, including nested versions. Pi supplies its
// SDK peer imports through the extension loader; copy only runtime dependencies.
export function bundlePiPackage(appDir, resources, name) {
  const modules = join(appDir, "node_modules");
  const destination = join(resources, "pi-builtin", "node_modules");
  const copied = new Set();
  function copy(name, parent, optional = false) {
    const require = createRequire(join(parent, "package.json"));
    const manifest = require.resolve.paths(name)
      .map((path) => join(path, name, "package.json"))
      .find(existsSync);
    if (!manifest) {
      if (optional) return;
      throw new Error(`Missing bundled dependency ${name} required by ${parent}. Run npm ci.`);
    }
    const source = dirname(manifest);
    if (copied.has(source)) return;
    const path = relative(modules, source);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error(`Bundled dependency is outside project node_modules: ${source}`);
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    cpSync(source, join(destination, path), {
      recursive: true,
      filter: (file) => file === source || basename(file) !== "node_modules",
    });
    copied.add(source);
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }))
      copy(dependency, source, Object.hasOwn(pkg.optionalDependencies ?? {}, dependency));
  }
  copy(name, appDir);
  return copied.size;
}
