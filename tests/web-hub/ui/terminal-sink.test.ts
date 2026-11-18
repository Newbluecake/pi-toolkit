import { describe, expect, it } from "vitest";
import { useHub } from "../../../src/web-hub/ui/src/composables/useHub.js";
import type { HubTransport } from "../../../src/web-hub/ui/src/transport/types.js";
describe("removed public terminal SSE execution path", () => {
  it("refuses legacy private events with byte-identical reducer state and exposes no cached private sink", () => {
    const hub = useHub({
      createTransport: () =>
        ({
          mode: "token",
          start: async () => {},
          close() {},
          subscribe: async () => ({ ok: true }),
          unsubscribe: async () => {},
          page: async () => ({ ok: true, data: {} }),
        }) as unknown as HubTransport,
      doc: { hidden: false, addEventListener() {}, removeEventListener() {} },
      win: { addEventListener() {}, removeEventListener() {} },
      setTimeout: () => 1,
      clearTimeout() {},
    });
    const before = hub.state.value;
    const bytes = JSON.stringify(before);
    const connection = { connectionInstance: "old-instance", connectionToken: "private-token", expiresAt: 60000 };
    hub.dispatch({ event: "terminal_connection", data: connection });
    hub.dispatch({ event: "terminal", data: { output: "private-output-marker" } });
    expect(hub.state.value).toBe(before);
    expect(JSON.stringify(hub.state.value)).toBe(bytes);
    expect(Object.hasOwn(hub, "terminalEvents")).toBe(false);
    expect(Object.hasOwn(hub, "terminal")).toBe(false);
    expect(JSON.stringify(hub.state.value)).not.toContain("private-output-marker");
    hub.dispose();
    hub.dispatch({ event: "terminal_connection", data: connection });
    expect(hub.state.value).toBe(before);
  });
});
