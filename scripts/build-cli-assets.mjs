import { cpSync, rmSync } from "node:fs";
const server = new URL("../server/", import.meta.url);
const skills = new URL("skills/", server);
rmSync(skills, { recursive: true, force: true });
cpSync(new URL("../skills/", import.meta.url), skills, { recursive: true });
cpSync(new URL("../LICENSE", import.meta.url), new URL("LICENSE", server));
