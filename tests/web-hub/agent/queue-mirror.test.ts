/**
 * Queue mirror (plan §4.4/D6, §9.1 v2 addendum).
 */
import { describe, expect, it } from "vitest";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";

describe("createQueueMirror — enqueue/dequeue", () => {
  it("enqueue records deliver/source/cmdId and a monotonically increasing local id", () => {
    const q = createQueueMirror({ now: () => 42 });
    const item = q.enqueue({ text: "hi", deliver: "steer", source: "web", cmdId: "c1" });
    expect(item).toMatchObject({ text: "hi", deliver: "steer", source: "web", cmdId: "c1", at: 42 });
    expect(q.items()).toEqual([item]);
  });

  it("clips text to 200 characters by default", () => {
    const q = createQueueMirror();
    const long = "x".repeat(250);
    const item = q.enqueue({ text: long, deliver: "followUp", source: "tui" });
    expect(item.text).toHaveLength(200);
  });

  it("dequeueByText prefers a steer match over a followUp match with the same text (K17 fallback order)", () => {
    const q = createQueueMirror();
    q.enqueue({ text: "same", deliver: "followUp", source: "tui" });
    q.enqueue({ text: "same", deliver: "steer", source: "web", cmdId: "c1" });
    const dequeued = q.dequeueByText("same");
    expect(dequeued?.deliver).toBe("steer");
    expect(dequeued?.cmdId).toBe("c1");
    expect(q.items()).toHaveLength(1);
    expect(q.items()[0]?.deliver).toBe("followUp");
  });

  it("dequeueByText with no match returns undefined and leaves the queue untouched", () => {
    const q = createQueueMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "tui" });
    expect(q.dequeueByText("b")).toBeUndefined();
    expect(q.items()).toHaveLength(1);
  });

  it("caps at 32 items, dropping the oldest", () => {
    const q = createQueueMirror({ maxItems: 3 });
    q.enqueue({ text: "1", deliver: "steer", source: "tui" });
    q.enqueue({ text: "2", deliver: "steer", source: "tui" });
    q.enqueue({ text: "3", deliver: "steer", source: "tui" });
    q.enqueue({ text: "4", deliver: "steer", source: "tui" });
    expect(q.items().map((i) => i.text)).toEqual(["2", "3", "4"]);
  });
});

describe("createQueueMirror — clearIfEmpty (§4.4 row 3)", () => {
  it("a no-op while hasPending is still true", () => {
    const q = createQueueMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    expect(q.clearIfEmpty(true)).toEqual([]);
    expect(q.items()).toHaveLength(1);
  });

  it("clears everything and records web cmdIds as dropped once hasPending goes false", () => {
    const q = createQueueMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    q.enqueue({ text: "b", deliver: "followUp", source: "tui" });
    const cleared = q.clearIfEmpty(false);
    expect(cleared).toHaveLength(2);
    expect(q.items()).toEqual([]);
    expect(q.takeDropped()).toEqual(["c1"]);
  });

  it("takeDropped is one-shot: the next call returns an empty array", () => {
    const q = createQueueMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    q.clearIfEmpty(false);
    q.takeDropped();
    expect(q.takeDropped()).toEqual([]);
  });
});

describe("createQueueMirror — clearAll (§4.4 row 4)", () => {
  it("unconditionally empties the mirror and returns everything that was in it", () => {
    const q = createQueueMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    q.enqueue({ text: "b", deliver: "followUp", source: "extension" });
    const cleared = q.clearAll();
    expect(cleared).toHaveLength(2);
    expect(q.items()).toEqual([]);
  });
});

describe("createQueueMirror — dispose", () => {
  it("empties the queue and dropped bookkeeping", () => {
    const q = createQueueMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    q.clearIfEmpty(false);
    q.dispose();
    expect(q.items()).toEqual([]);
    expect(q.takeDropped()).toEqual([]);
  });
});
