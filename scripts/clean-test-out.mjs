import { rmSync } from "node:fs";

// tsc compiles tests incrementally and never removes outputs, so tests deleted
// from a branch keep running as ghosts until out-test is cleared.
rmSync(new URL("../out-test", import.meta.url), { recursive: true, force: true });
