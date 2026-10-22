import { describe, expect, it } from "vitest";
import { renderStatus, type StatusCommandDeps } from "../../src/commands/status.js";
import type { StackXs } from "../../src/stack.js";
const deps = (): StatusCommandDeps => ({
  query: { list: () => [] } as never,
  orphans: { totalCount: 0, recent: [], lateRecoveredCount: 0 } as never,
  notifier: {
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    ackedSuppressions: 0,
    degraded: [],
  } as never,
});
describe("/agent status xs live stack view", () => {
  it("off/undefined is byte-identical to no port", () => {
    expect(renderStatus({ ...deps(), xs: () => undefined })).toBe(renderStatus(deps()));
    expect(renderStatus(deps())).not.toContain("xs ");
  });
  it("renders English compact tokens, honest unavailable outbound usage, and live counters", () => {
    const stack = {
      membership: { joined: true, receive: "wake", receivePref: "wake" },
      receiver: {
        wakeQuota: () => ({ recvUsed: 3, recvCap: 30, wakesUsed: 1, wakesCap: 12 }),
        countersSnapshot: () => ({ fenced: 1 }),
      },
      fence: { status: () => ({ stuck: [] }) },
      controller: { state: "bound" },
      audit: {},
    } as unknown as StackXs;
    const d = { ...deps(), xs: () => ({ stack, capability: "verified", outCap: 60 }) };
    const expected =
      "xs joined · recv wake · cap verified · in 3/30h · out n/a/60h · wakes 1/12h · fenced 1 · stuck 0 · unbound 0 · lateAbort 0 · abortStuck 0";
    expect(renderStatus(d)).toContain(expected);
    expect(renderStatus(d).split("\n")).toHaveLength(renderStatus(deps()).split("\n").length + 1);
    stack.audit.wake_late_aborted = 2;
    stack.audit.abortStuck = 1;
    expect(renderStatus(d)).toContain("lateAbort 2 · abortStuck 1");
    Object.assign(stack.controller!, { state: "deferred" });
    expect(renderStatus(d)).toContain("unbound 1");
  });

  it("reply on: adds a compact English replies line from the live ledger; pref shown only when it differs", () => {
    const stats = {
      pending: 2,
      inbox: 1,
      timedOut: 1,
      late: 3,
      rejected: 4,
      owed: 5,
      dropped: 6,
      ledger: { size: 7, capacity: 64 },
    };
    const seen: string[] = [];
    const stack = {
      membership: { joined: true, receive: "off", receivePref: "replies" },
      receiver: {
        wakeQuota: () => ({ recvUsed: 0, recvCap: 30, wakesUsed: 0, wakesCap: 12 }),
        countersSnapshot: () => ({ fenced: 0 }),
      },
      fence: { status: () => ({ stuck: [] }) },
      audit: {},
      reply: {
        sessionId: "S1",
        maxPending: 8,
        ledger: {
          stats: (sid: string) => {
            seen.push(sid);
            return stats;
          },
        },
      },
    } as unknown as StackXs;
    const d = { ...deps(), xs: () => ({ stack, capability: "verified", outCap: 60 }) };
    const out = renderStatus(d);
    expect(out).toContain("recv off (pref replies) · cap verified");
    expect(out).toContain("xs replies p2/8 i1 to1 late3 rej4 owed5 drop6 · ledger 7/64");
    expect(seen).toEqual(["S1"]);
    expect(out.split("\n")).toHaveLength(renderStatus(deps()).split("\n").length + 2);
  });

  it("channels line: absent for default-only, present for named/suspended/unread", () => {
    const mk = (eff: string[], susp: string[], unread?: number) =>
      ({
        membership: { joined: true, receive: "wake", receivePref: "wake", effective: () => eff, suspended: () => susp },
        receiver: {
          wakeQuota: () => ({ recvUsed: 0, recvCap: 30, wakesUsed: 0, wakesCap: 12 }),
          countersSnapshot: () => ({ fenced: 0 }),
        },
        fence: { status: () => ({ stuck: [] }) },
        audit: {},
        ...(unread === undefined ? {} : { unread: () => unread }),
      }) as unknown as StackXs;
    const render = (s: StackXs) =>
      renderStatus({ ...deps(), xs: () => ({ stack: s, capability: "verified", outCap: 60 }) });
    expect(render(mk(["default"], []))).not.toContain("xs channels");
    expect(render(mk(["default", "team"], []))).toContain("xs channels #default #team (2/4)");
    expect(render(mk([], ["team"]))).toContain("xs channels - (0/4) · suspended #team");
    expect(render(mk(["default"], [], 3))).toContain("xs channels #default (1/4) · inbox 3");
    expect(render(mk(["default"], [], 150))).toContain("inbox 99+");
  });
});
