import { homedir } from "node:os";
import { join } from "node:path";

/** PiX profile root; PIX_HOME relocates the whole profile (dev, tests, CI). */
export const pixHome = () => process.env.PIX_HOME ?? homedir();
/** PiX owns ~/.pix/agent the way the pi CLI owns ~/.pi/agent. */
export const pixAgentDir = () => join(pixHome(), ".pix", "agent");
