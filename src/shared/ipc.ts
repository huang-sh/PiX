/**
 * Every renderer→main call rides on one `ipcMain.handle` channel. Electron
 * re-throws a rejected handler as `Error invoking remote method 'pix:invoke':
 * Error: <message>`, and that wrapper leaked into user-facing text. The handler
 * therefore answers with this envelope instead of throwing, and the preload
 * turns it back into a plain Error carrying only the message the main process
 * wrote.
 */
export type InvokeReply<T> = { ok: true; result: T } | { ok: false; message: string };

export function unwrapInvokeReply<T>(reply: InvokeReply<T>): T {
  if (reply.ok) return reply.result;
  throw new Error(reply.message);
}
