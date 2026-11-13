/** Eager-safe terminal HTTP paths. Zero imports/schemas/side effects beyond freeze.
 * Shared by the eager browser HTTP contract and the lazy private terminal protocol.
 * Keep the original insertion order and values; never pull terminal.ts into this module.
 */
export const TERMINAL_HTTP_PATHS = Object.freeze({
  prepare: "/api/terminal/prepare",
  open: "/api/terminal/open",
  list: "/api/terminal/list",
  attach: "/api/terminal/attach",
  detach: "/api/terminal/detach",
  input: "/api/terminal/input",
  resize: "/api/terminal/resize",
  ack: "/api/terminal/ack",
  renew: "/api/terminal/renew",
  state: "/api/terminal/state",
  close: "/api/terminal/close",
}) as Readonly<
  Record<
    "prepare" | "open" | "list" | "attach" | "detach" | "input" | "resize" | "ack" | "renew" | "state" | "close",
    string
  >
>;
