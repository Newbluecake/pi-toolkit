import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHubTerminalContextV2,
  type TerminalContextLinkV2,
} from "../../../../../src/web-hub/hub/terminal/v2/context.js";
import type { TerminalContextRequest } from "../../../../../src/web-hub/protocol/terminal-v2.js";
afterEach(() => vi.useRealTimers());
function fixture() {
  const scope = { agentKey: "agent", sessionId: "session", epoch: "epoch" };
  const sent: TerminalContextRequest[] = [];
  let permitted = true;
  let link: TerminalContextLinkV2 | undefined = {
    instance: {},
    scope,
    declaration: {
      v: 2,
      enabled: true,
      sessionId: scope.sessionId,
      epoch: scope.epoch,
      contextGeneration: 1,
      limits: { maxPerSession: 2, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
    },
    pendingBytes: 0,
    send(frame) {
      sent.push(frame);
      return true;
    },
  };
  const h = createHubTerminalContextV2({ link: () => link, permitted: () => permitted });
  return {
    scope,
    sent,
    h,
    get link() {
      return link!;
    },
    setLink(v: typeof link) {
      link = v;
    },
    deny() {
      permitted = false;
    },
    reply(request: TerminalContextRequest) {
      return {
        t: "terminal_context_res",
        v: 2,
        rid: request.rid,
        ok: true,
        sessionId: scope.sessionId,
        epoch: scope.epoch,
        contextGeneration: request.contextGeneration,
        cwd: "/private-cwd",
      };
    },
  };
}
describe("private hub context v2", () => {
  it("requires matching declaration, preserves exact link identity and freezes snapshots", async () => {
    const f = fixture();
    const pending = f.h.port.resolve(f.scope, new AbortController().signal);
    f.h.consume(f.link.instance, f.reply(f.sent[0]!));
    const snapshot = await pending;
    expect(snapshot.cwd).toBe("/private-cwd");
    expect(Object.isFrozen(snapshot.scope)).toBe(true);
    expect(Object.isFrozen(snapshot.limits)).toBe(true);
    expect(f.h.port.current(snapshot)).toBe(true);
    expect(f.h.port.current({ ...snapshot })).toBe(false);
    f.setLink({ ...f.link, instance: {} });
    expect(f.h.port.current(snapshot)).toBe(false);
  });
  it("unknown rid/wrong socket cannot settle; link retirement fences late response", async () => {
    const f = fixture();
    const pending = f.h.port.resolve(f.scope, new AbortController().signal);
    f.h.consume({}, f.reply(f.sent[0]!));
    f.h.consume(f.link.instance, { ...f.reply(f.sent[0]!), rid: "z".repeat(24) });
    const assertion = expect(pending).rejects.toMatchObject({ failure: { code: "E_UNSUPPORTED" } });
    f.h.retire(f.link.instance);
    await assertion;
    f.h.consume(f.link.instance, f.reply(f.sent[0]!));
  });
  it("bounds physical metadata wait to 2s and does not probe an undeclared/denied target", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const p = f.h.port.resolve(f.scope, new AbortController().signal);
    const rejected = expect(p).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    f.deny();
    await expect(f.h.port.resolve(f.scope, new AbortController().signal)).rejects.toBeDefined();
    expect(f.sent).toHaveLength(1);
  });
  it("has a global 32-flight cap and dispose settles all accepted metadata futures", async () => {
    const f = fixture();
    const pending = Array.from({ length: 32 }, () => f.h.port.resolve(f.scope, new AbortController().signal));
    const observed = pending.map((p) =>
      p.then(
        () => "unexpected",
        () => "rejected",
      ),
    );
    await expect(f.h.port.resolve(f.scope, new AbortController().signal)).rejects.toBeDefined();
    expect(f.sent).toHaveLength(32);
    f.h.dispose();
    expect(await Promise.all(observed)).toEqual(Array(32).fill("rejected"));
  });
});
