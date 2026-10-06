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

describe("createQueueMirror — full-text match key (wire clip leak fix)", () => {
  // The wire `text` is display-only (plan §4.4 "截 200 字符"); the dequeue match key is the
  // FULL enqueue text pi replays in `message_start`. Before the fix a >200-char steer could
  // never dequeue and the grace expiry marked it `dropped` even though pi had consumed it.
  const longA = "A".repeat(300);
  const longB = "B".repeat(300);

  it("wire text stays clipped at 200 chars, yet dequeueByText(fullText) returns the item", () => {
    const q = createQueueMirror();
    q.enqueue({ text: longA, deliver: "steer", source: "web", cmdId: "c1" });
    const wire = q.items()[0];
    expect(wire?.text).toHaveLength(200); // wire byte-identical: still the clipped copy
    expect(wire?.text).toBe(longA.slice(0, 200));
    const dequeued = q.dequeueByText(longA); // pi's message_start carries the full text
    expect(dequeued).toMatchObject({ cmdId: "c1", deliver: "steer" });
    expect(q.items()).toEqual([]);
    expect(q.fullTextCount()).toBe(0);
  });

  it("two long messages sharing a 200-char prefix do not cross-consume (why the key is full text)", () => {
    const q = createQueueMirror();
    const shared = "S".repeat(250);
    q.enqueue({ text: shared + "-one", deliver: "steer", source: "web", cmdId: "c1" });
    q.enqueue({ text: shared + "-two", deliver: "steer", source: "web", cmdId: "c2" });
    expect(q.dequeueByText(`${shared}-two`)?.cmdId).toBe("c2"); // exact full text, not prefix
    expect(q.dequeueByText(`${shared}-two`)).toBeUndefined(); // already consumed
    expect(q.dequeueByText(`${shared}-one`)?.cmdId).toBe("c1");
  });

  it("dequeueByText(fullText) works for followUp too, and a miss on the clipped prefix leaves the queue untouched", () => {
    const q = createQueueMirror();
    q.enqueue({ text: longB, deliver: "followUp", source: "tui" });
    expect(q.dequeueByText(longB.slice(0, 200))).toBeUndefined(); // clipped prefix is not a key
    expect(q.items()).toHaveLength(1);
    expect(q.dequeueByText(longB)?.deliver).toBe("followUp");
  });

  it("fullText entries are removed on every removal path — fullTextCount always mirrors items().length (no leak)", () => {
    // dequeue path
    const q = createQueueMirror({ maxItems: 3 });
    q.enqueue({ text: longA, deliver: "steer", source: "web", cmdId: "c1" });
    q.enqueue({ text: longB, deliver: "followUp", source: "tui" });
    q.enqueue({ text: "short", deliver: "steer", source: "tui" });
    expect(q.fullTextCount()).toBe(3);
    q.dequeueByText(longA);
    expect(q.fullTextCount()).toBe(q.items().length).toBe(2);

    // overflow-shift GC path (maxItems 3): the two oldest leave queue and map together
    q.enqueue({ text: "new1", deliver: "steer", source: "tui" });
    q.enqueue({ text: "new2", deliver: "steer", source: "tui" });
    expect(q.fullTextCount()).toBe(q.items().length).toBe(3);

    // clearAll path
    q.clearAll();
    expect(q.fullTextCount()).toBe(0);

    // dispose path
    q.enqueue({ text: longA, deliver: "steer", source: "web", cmdId: "c2" });
    q.dispose();
    expect(q.fullTextCount()).toBe(0);

    // clearIfEmpty grace-clear path
    const { q: g, t } = clockMirror();
    g.enqueue({ text: longB, deliver: "steer", source: "web", cmdId: "c9" });
    expect(g.fullTextCount()).toBe(1);
    g.clearIfEmpty(false); // arm
    expect(g.fullTextCount()).toBe(1); // within grace: nothing removed yet
    t(2000); // past the 1.5s grace
    expect(g.clearIfEmpty(false)).toHaveLength(1);
    expect(g.fullTextCount()).toBe(0);
  });
});

/** Deterministic clock for the grace-window tests below. */
function clockMirror(startAt = 0): { q: ReturnType<typeof createQueueMirror>; t: (ms: number) => void } {
  let clock = startAt;
  const q = createQueueMirror({ now: () => clock });
  return { q, t: (ms) => (clock = ms) };
}

describe("createQueueMirror — clearIfEmpty (§4.4 row 3, grace-window contract)", () => {
  it("a no-op while hasPending is still true", () => {
    const q = createQueueMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    expect(q.clearIfEmpty(true)).toEqual([]);
    expect(q.items()).toHaveLength(1);
  });

  it("the first false sample only arms the grace — nothing is cleared yet (busy-steer race fix)", () => {
    const { q, t } = clockMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    t(100);
    expect(q.clearIfEmpty(false)).toEqual([]);
    expect(q.items()).toHaveLength(1);
    t(1000); // still within the 1.5s grace
    expect(q.clearIfEmpty(false)).toEqual([]);
    expect(q.items()).toHaveLength(1);
    expect(q.takeDropped()).toEqual([]);
  });

  it("clears everything and records web cmdIds as dropped once the empty condition persists past the grace", () => {
    const { q, t } = clockMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    q.enqueue({ text: "b", deliver: "followUp", source: "tui" });
    t(100);
    q.clearIfEmpty(false); // arm
    t(100 + 1500);
    const cleared = q.clearIfEmpty(false); // past grace
    expect(cleared).toHaveLength(2);
    expect(q.items()).toEqual([]);
    expect(q.takeDropped()).toEqual(["c1"]);
  });

  it("a hasPending=true sample inside the grace resets the arm entirely", () => {
    const { q, t } = clockMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    t(100);
    q.clearIfEmpty(false); // arm at 100
    t(900);
    q.clearIfEmpty(true); // reset — nothing armed now
    t(2399);
    q.clearIfEmpty(false); // first false sample of the new window: arms at 2399
    t(2399 + 1499); // still within the fresh grace
    expect(q.clearIfEmpty(false)).toEqual([]);
    t(2399 + 1500); // past it
    expect(q.clearIfEmpty(false)).toHaveLength(1);
  });

  it("an empty-queue false sample resets the arm, so a later item gets a full grace", () => {
    const { q, t } = clockMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    t(100);
    q.clearIfEmpty(false); // arm at 100
    q.dequeueByText("a"); // queue drained by delivery (message_start) — also resets
    t(500);
    q.clearIfEmpty(false); // empty queue: no-op + reset
    q.enqueue({ text: "b", deliver: "steer", source: "web", cmdId: "c2" });
    t(1900); // first false sample after the enqueue: arms here (a leaked 100-arm would already be past grace)
    q.clearIfEmpty(false);
    t(1900 + 1499);
    expect(q.clearIfEmpty(false)).toEqual([]);
    t(1900 + 1500);
    expect(q.clearIfEmpty(false)).toHaveLength(1);
    expect(q.takeDropped()).toEqual(["c2"]);
  });

  it("takeDropped is one-shot: the next call returns an empty array", () => {
    const { q, t } = clockMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    t(0);
    q.clearIfEmpty(false);
    t(1500);
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
    const { q, t } = clockMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    t(0);
    q.clearIfEmpty(false); // arm
    t(1500);
    q.clearIfEmpty(false); // clear + record c1 as dropped
    q.dispose();
    expect(q.items()).toEqual([]);
    expect(q.takeDropped()).toEqual([]);
  });

  it("dispose also drops an armed grace window", () => {
    const { q, t } = clockMirror();
    q.enqueue({ text: "a", deliver: "steer", source: "web", cmdId: "c1" });
    t(0);
    q.clearIfEmpty(false); // arm
    q.dispose();
    q.enqueue({ text: "b", deliver: "steer", source: "web", cmdId: "c2" });
    t(1400); // would be past the grace had the arm leaked through dispose
    expect(q.clearIfEmpty(false)).toEqual([]);
    expect(q.items()).toHaveLength(1);
  });
});
