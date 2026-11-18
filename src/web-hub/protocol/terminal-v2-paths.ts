/** T51 P0 declarations only. Zero imports: safe for eager HTTP consumers.
 * No route registration/cap advertisement until P6 replaces the complete v1 assembly. */
export const TERMINAL_V2_CAP = "terminal.tabs.v2";
export const TERMINAL_V2_HTTP_PATHS = Object.freeze({
  list: "/api/terminal/v2/list",
  create: "/api/terminal/v2/create",
  creation: "/api/terminal/v2/creation",
  rename: "/api/terminal/v2/rename",
  close: "/api/terminal/v2/close",
  view: "/api/terminal/v2/view",
  input: "/api/terminal/v2/input",
  resize: "/api/terminal/v2/resize",
  ack: "/api/terminal/v2/ack",
});
export type TerminalOpV2 = keyof typeof TERMINAL_V2_HTTP_PATHS;

/** Pure names only; production must not initialize or inspect v1 to guess fresh state.
 * Initialization/checkpoint belongs to the separately authorized P5 tools. */
export function terminalV2Files(stateDir: string) {
  return {
    root: `${stateDir}/terminal-v2`,
    ledger: `${stateDir}/terminal-v2/ledger.json`,
    marker: `${stateDir}/terminal-v2/marker.json`,
    witness: `${stateDir}/.terminal-initialized-v2`,
    archive: `${stateDir}/.terminal-allocation-archive-v2`,
  } as const;
}
