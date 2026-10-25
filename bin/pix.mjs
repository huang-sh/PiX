#!/usr/bin/env node
import { existsSync } from "node:fs";
const entry = new URL("../server/dist/cli/index.js", import.meta.url);
if (!existsSync(entry)) {
  console.error("PiX CLI is not built. Run npm run build:cli first.");
  process.exitCode = 1;
} else await import(entry.href);
