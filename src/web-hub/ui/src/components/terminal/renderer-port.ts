/** Public DI boundary: the list/chrome can load without evaluating xterm. */
export const TERMINAL_RENDERER_FACTORY = Symbol("terminal-renderer-factory");
export type TerminalRendererFactory = typeof import("./renderer.js").mountTerminal;
