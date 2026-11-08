#!/usr/bin/env node
// The standalone Pixie launcher: the shared CLI entry with "pixie" defaulted in.
import { existsSync } from "node:fs";
process.argv.splice(2, 0, "pixie");
const entry = new URL("../server/dist/cli/index.js", import.meta.url);
if (!existsSync(entry)) {
  console.error("PiX CLI is not built. Run npm run build:cli first.");
  process.exitCode = 1;
} else await import(entry.href);
