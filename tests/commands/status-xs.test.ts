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
      membership: { joined: true, receive: "wake" },
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
});
