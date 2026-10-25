import { serveLocalHost } from "./local-host.js";

serveLocalHost().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
