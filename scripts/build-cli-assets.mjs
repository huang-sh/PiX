import { fileURLToPath } from "node:url";
import { prepareLinuxCliHooks } from "./linux-cli-hooks.mjs";
import { cpSync, rmSync } from "node:fs";
const server = new URL("../server/", import.meta.url);
for (const name of ["skills", "pixie-skills"]) {
  const destination = new URL(`${name}/`, server);
  rmSync(destination, { recursive: true, force: true });
  cpSync(new URL(`../${name}/`, import.meta.url), destination, { recursive: true });
}
cpSync(new URL("../LICENSE", import.meta.url), new URL("LICENSE", server));

prepareLinuxCliHooks(fileURLToPath(new URL("../build/generated/", import.meta.url)));
