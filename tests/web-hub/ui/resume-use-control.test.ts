/**
 * web-resume plan v2 §2.6 (P3) — `useControl`'s NON-optimistic `queryCommand`: a fresh id
 * per call, `expect.sessionId` rides it, and — unlike `runCommand` — NO `ctl_send` item is
 * dispatched and the request is never `remember`ed (a later `query`/`retry` by that id must
 * answer the local miss, proving nothing was retained for the queue UI).
 */
import { describe, expect, it, vi } from "vitest";
import { createControl } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { CmdRequest, HubTransport } from "../../../src/web-hub/ui/src/transport/types.js";

function fakeTransport(sessionId: string | undefined) {
  const commands: CmdRequest[] = [];
  const transport: HubTransport = {
    mode: "token",
    start: async () => {},
    close: () => {},
    subscribe: async () => ({ ok: true }),
    unsubscribe: async () => {},
    page: async () => ({ ok: true, data: {} }),
    command: (req) => {
      commands.push(req);
      return Promise.resolve({ ok: true, data: { sessions: { v: 1 } } });
    },
    dialog: async () => ({ ok: true }),
  };
  return { transport, commands };
}

describe("createControl.queryCommand (web-resume §2.6)", () => {
  it("sends op:command with a fresh id + expect, and nothing else per call", async () => {
    const { transport, commands } = fakeTransport("sess-1");
    const dispatch = vi.fn();
    const control = createControl(transport, dispatch, { getSessionId: () => "sess-1" });
    const [a, b] = await Promise.all([
      control.queryCommand!("a1", "resume", '__list {"scope":"recent"}'),
      control.queryCommand!("a1", "resume", '__list {"scope":"all"}'),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      agentKey: "a1",
      op: "command",
      name: "resume",
      args: '__list {"scope":"recent"}',
      expect: { sessionId: "sess-1" },
    });
    expect("queryOnly" in commands[0]!).toBe(false); // a real execute, never queryOnly
    expect(commands[0]!.id).not.toBe(commands[1]!.id); // fresh id every call
  });

  it("dispatches NO ctl_send (no optimistic queue row) and retains nothing", async () => {
    const { transport } = fakeTransport("sess-1");
    const dispatch = vi.fn();
    const control = createControl(transport, dispatch, { getSessionId: () => "sess-1" });
    await control.queryCommand!("a1", "resume", '__list {"scope":"recent"}');
    expect(dispatch).not.toHaveBeenCalled();
    // not remembered ⇒ query/retry by that id answer the local miss
    const miss = await control.query("a1", "nope");
    expect(miss.ok).toBe(false);
    expect((miss as { error?: string }).error).toBe("E_UNKNOWN_ID");
    const retryMiss = await control.retry("a1", "nope");
    expect(retryMiss.ok).toBe(false);
  });

  it("omits expect when the session id is unknown", async () => {
    const { transport, commands } = fakeTransport(undefined);
    const control = createControl(transport, vi.fn(), {});
    await control.queryCommand!("a1", "resume", "__list {}");
    expect(commands[0]!.expect).toBeUndefined();
  });
});
