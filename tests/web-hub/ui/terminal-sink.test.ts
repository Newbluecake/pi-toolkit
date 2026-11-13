import { describe, expect, it, vi } from "vitest";
import { useHub } from "../../../src/web-hub/ui/src/composables/useHub.js";
import type { HubTransport } from "../../../src/web-hub/ui/src/transport/types.js";
describe("private terminal SSE sink (§4.4 / §7.3)", () => {
  it("bypasses the transcript reducer, caches only the connection for a later explicit panel, and forgets it on dispose", () => {
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
    const connection = { connectionInstance: "instance", connectionToken: "private-token", expiresAt: 60000 };
    hub.dispatch({ event: "terminal_connection", data: connection });
    expect(hub.state.value).toBe(before);
    const sink = vi.fn();
    const stop = hub.terminalEvents!(sink);
    expect(sink).toHaveBeenCalledWith("terminal_connection", connection);
    const output = { output: "bytes are not a transcript item" };
    hub.dispatch({ event: "terminal", data: output });
    expect(sink).toHaveBeenLastCalledWith("terminal", output);
    expect(hub.state.value).toBe(before);
    stop();
    hub.dispatch({ event: "terminal", data: output });
    expect(sink).toHaveBeenCalledTimes(2);
    const disposeSink = vi.fn();
    hub.terminalEvents!(disposeSink);
    hub.dispose();
    expect(disposeSink).toHaveBeenLastCalledWith("disconnected", null);
    const late = vi.fn();
    hub.terminalEvents!(late);
    expect(late).not.toHaveBeenCalled();
  });
});
