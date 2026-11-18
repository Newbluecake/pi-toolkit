/** Eager transport facade, zero protocol/renderer imports or requests at construction.
 * The validated transport is loaded only when the explicitly opened feature calls it. */
import type { createTerminalTransportV2, TerminalTransportV2 } from "./terminal-v2.js";
export function createLazyTerminalTransportV2(deps: {
  fetch(url: string, init?: RequestInit): Promise<unknown>;
  onConn(state: "auth"): void;
}): TerminalTransportV2 {
  let loaded: Promise<TerminalTransportV2> | undefined;
  const load = () =>
    (loaded ??= import("../components/terminal/v2/terminal-v2-feature.js").then((module) =>
      module.createTerminalTransportV2({
        onConn: deps.onConn,
        fetch: async (url, init) => {
          const response = await deps.fetch(url, init);
          if (!(response instanceof Response)) throw new Error("E_TERMINAL_RESPONSE");
          return response;
        },
      }),
    ));
  return {
    request: async (op, body, signal) => (await load()).request(op, body, signal),
    view: async (body, onFrame, signal) => (await load()).view(body, onFrame, signal),
  };
}
