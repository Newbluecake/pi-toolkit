/**
 * `@logic/state.js`'s SCHEDULES-specific reducer surface (scheduled-reports W1, plan r3
 * §5.6) — the `"schedules"` SSE case, the `"hello"` clear, and the `hub`-frame caps-drop
 * clear (mirrors load-state.test.ts's harness; a new file keeps this package's edits out of
 * the shared logic-state.test.ts).
 */
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import { SCHED_EVENT } from "../../../src/web-hub/ui/src/logic/schedule.js";
import { makePayload } from "./fixtures/schedule.js";

type Msg = { event: string; data: any; id?: number; at?: number };
const run = (msgs: Msg[], s = initialState(null)) => msgs.reduce((acc, m) => reduce(acc, m), s);

describe('reduce — "schedules" SSE event (cap sched.v1)', () => {
  it("accepts a well-formed frame and stamps the browser-clock receive anchor", () => {
    const payload = makePayload();
    const s = run([{ event: SCHED_EVENT, data: payload, at: 123_456 }]);
    expect(s.schedules).toBe(payload);
    expect(s.schedulesReceivedAt).toBe(123_456);
  });

  it("drops malformed frames wholesale (slot untouched)", () => {
    const s = run([{ event: SCHED_EVENT, data: { sessions: "junk" }, at: 1 }]);
    expect(s.schedules).toBeUndefined();
    expect(s.schedulesReceivedAt).toBeUndefined();
  });

  it("a later frame wholesale-replaces the slot (overwrite semantics, same as spawns/load)", () => {
    const a = makePayload();
    const b = makePayload([]);
    const s = run([
      { event: SCHED_EVENT, data: a, at: 1 },
      { event: SCHED_EVENT, data: b, at: 2 },
    ]);
    expect(s.schedules).toBe(b);
    expect(s.schedulesReceivedAt).toBe(2);
  });

  it("hello clears the slot (stale until the hub's post-agents resend)", () => {
    const s = run([
      { event: SCHED_EVENT, data: makePayload(), at: 1 },
      { event: "hello", data: { clientId: "c2" }, at: 2 },
    ]);
    expect(s.schedules).toBeUndefined();
    expect(s.schedulesReceivedAt).toBeUndefined();
  });

  it("a hub frame whose caps dropped sched.v1 clears the slot; with the cap it survives", () => {
    const withCap = run([
      { event: "hub", data: { caps: ["cmd.v1", "sched.v1"] }, at: 0 },
      { event: SCHED_EVENT, data: makePayload(), at: 1 },
      { event: "hub", data: { caps: ["cmd.v1", "sched.v1"] }, at: 2 },
    ]);
    expect(withCap.schedules).toBeDefined();
    const dropped = run([
      { event: "hub", data: { caps: ["cmd.v1", "sched.v1"] }, at: 0 },
      { event: SCHED_EVENT, data: makePayload(), at: 1 },
      { event: "hub", data: { caps: ["cmd.v1"] }, at: 2 },
    ]);
    expect(dropped.schedules).toBeUndefined();
    expect(dropped.schedulesReceivedAt).toBeUndefined();
  });
});
