import { describe, expect, it } from "vitest";
import { DEFAULT_HANDOFF_TTL_MS, PendingHandoffStore } from "../../src/context-switch/store.js";

function store(now: () => number) {
  return new PendingHandoffStore({ now });
}

describe("context-switch/store", () => {
  it("stages, peeks and consumes exactly once", () => {
    const s = new PendingHandoffStore();
    const seq = s.stage({ core: "A", keepRecent: true, resume: true });
    expect(seq).toBe(1);
    expect(s.hasFresh()).toBe(true);
    expect(s.peek()?.core).toBe("A");
    expect(s.consume()?.seq).toBe(seq);
    expect(s.consume()).toBeUndefined();
    expect(s.hasFresh()).toBe(false);
  });

  it("expires stale handoffs (a stale handoff must never be injected)", () => {
    let clock = 1_000;
    const s = store(() => clock);
    s.stage({ core: "A", keepRecent: false, resume: true });
    clock += DEFAULT_HANDOFF_TTL_MS;
    expect(s.peek()).toBeDefined();
    clock += 1;
    expect(s.peek()).toBeUndefined();
    expect(s.consume()).toBeUndefined();
  });

  it("honours a custom ttl", () => {
    let clock = 0;
    const s = new PendingHandoffStore({ ttlMs: 10, now: () => clock });
    s.stage({ core: "A", keepRecent: true, resume: false });
    clock = 11;
    expect(s.hasFresh()).toBe(false);
  });

  it("clear(seq) only drops the matching handoff", () => {
    const s = new PendingHandoffStore();
    const first = s.stage({ core: "A", keepRecent: true, resume: true });
    const second = s.stage({ core: "B", keepRecent: true, resume: true });
    expect(second).toBe(first + 1);
    s.clear(first); // 旧序号：不得误删后来者
    expect(s.peek()?.core).toBe("B");
    s.clear(second);
    expect(s.peek()).toBeUndefined();
  });

  it("clear() without a seq drops whatever is pending", () => {
    const s = new PendingHandoffStore();
    s.stage({ core: "A", keepRecent: true, resume: true });
    s.clear();
    expect(s.peek()).toBeUndefined();
  });

  it("keeps keepRecent/resume flags verbatim", () => {
    const s = new PendingHandoffStore();
    s.stage({ core: "A", keepRecent: false, resume: false });
    const pending = s.peek();
    expect(pending?.keepRecent).toBe(false);
    expect(pending?.resume).toBe(false);
  });
});
