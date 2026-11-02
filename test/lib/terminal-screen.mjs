import xterm from '@xterm/headless';

// Parse actual PTY output, including cursor movement and differential redraws.
// Searching the raw byte stream can falsely pass on text no longer on screen.
export function terminalScreen(pty, cols = 100, rows = 30) {
  const terminal = new xterm.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  let raw = '';
  const output = pty.onData(data => { raw += data; terminal.write(data); });
  const replies = terminal.onData(data => pty.write(data));
  function lines(start, end) {
    const buffer = terminal.buffer.active;
    return Array.from({ length: end - start }, (_, index) => buffer.getLine(start + index)?.translateToString(true) ?? '').join('\n');
  }
  return {
    get raw() { return raw; },
    get text() { return lines(0, terminal.buffer.active.length); },
    get viewport() { const start = terminal.buffer.active.viewportY; return lines(start, start + terminal.rows); },
    resize(cols, rows) { terminal.resize(cols, rows); pty.resize(cols, rows); },
    dispose() { output.dispose(); replies.dispose(); terminal.dispose(); },
  };
}
