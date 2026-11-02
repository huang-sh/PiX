import { defineStore } from "pinia";
import { markRaw, nextTick } from "vue";
import { canvasCommand, type CanvasCommand } from "../../shared/canvas";
import { useLayoutStore } from "./layout";

export const useCanvasStore = defineStore("canvas", {
  state: () => ({ handler: undefined as ((command: CanvasCommand) => Promise<unknown>) | undefined, executing: false }),
  actions: {
    register(handler: (command: CanvasCommand) => Promise<unknown>) {
      this.handler = markRaw(handler);
      return () => { if (this.handler === handler) this.handler = undefined; };
    },
    async execute(input: unknown) {
      const command = canvasCommand(input);
      if (this.executing) throw new Error("Another canvas operation is still in progress");
      this.executing = true;
      try {
        useLayoutStore().screen = "workbench";
        await nextTick();
        if (!this.handler) throw new Error("The canvas is not available yet");
        return await this.handler(command);
      } finally { this.executing = false; }
    },
  },
});
