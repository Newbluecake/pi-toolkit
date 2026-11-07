import { describe, expect, it } from "vitest";
import { ThreadDirectory, THREAD_DIRECTORY_CAPACITY } from "../../../src/fabric/thread/directory.js";

const H = (n: number) => `fs:handle${String(n).padStart(5, "0")}`;

describe("ThreadDirectory (§3.1 LRU 32)", () => {
  it("notes entries and reports open state", () => {
    const dir = new ThreadDirectory();
    dir.note(H(1), "topic-a", 100);
    expect(dir.size).toBe(1);
    expect(dir.isOpen(H(1))).toBe(true);
    expect(dir.isOpen(H(2))).toBe(false);
    expect(dir.get(H(1))?.label).toBe("topic-a");
  });

  it("evicts the least-recently-noted entry at capacity 32", () => {
    const dir = new ThreadDirectory();
    for (let i = 0; i < THREAD_DIRECTORY_CAPACITY; i++) dir.note(H(i), `t${i}`, i);
    expect(dir.size).toBe(THREAD_DIRECTORY_CAPACITY);
    dir.note(H(999), "new", 999);
    expect(dir.size).toBe(THREAD_DIRECTORY_CAPACITY);
    expect(dir.get(H(0))).toBeUndefined(); // oldest evicted
    expect(dir.get(H(1))).toBeDefined();
    expect(dir.get(H(999))).toBeDefined();
  });

  it("re-noting refreshes recency and updates the label", () => {
    const dir = new ThreadDirectory();
    for (let i = 0; i < THREAD_DIRECTORY_CAPACITY; i++) dir.note(H(i), `t${i}`, i);
    dir.note(H(0), "renamed", 50); // refresh the oldest
    dir.note(H(999), "new", 51);
    expect(dir.get(H(0))?.label).toBe("renamed"); // survived
    expect(dir.get(H(1))).toBeUndefined(); // next-oldest evicted instead
  });

  it("get/isOpen do NOT refresh recency (admission probes keep a dead thread cold)", () => {
    const dir = new ThreadDirectory();
    for (let i = 0; i < THREAD_DIRECTORY_CAPACITY; i++) dir.note(H(i), `t${i}`, i);
    expect(dir.isOpen(H(0))).toBe(true);
    dir.note(H(999), "new", 999);
    expect(dir.get(H(0))).toBeUndefined(); // probe did not save it
  });

  it("close marks an open entry closed, once; a later note never resurrects it (§5.4)", () => {
    const dir = new ThreadDirectory();
    dir.note(H(1), "topic", 1);
    expect(dir.close(H(1))).toBe(true);
    expect(dir.close(H(1))).toBe(false); // already closed
    expect(dir.close(H(2))).toBe(false); // unknown
    expect(dir.isOpen(H(1))).toBe(false);
    dir.note(H(1), "topic-again", 2); // a re-bound binding mints a NEW handle; this never reopens
    expect(dir.isOpen(H(1))).toBe(false);
    expect(dir.get(H(1))?.label).toBe("topic-again");
  });

  it("list preserves LRU order (oldest first)", () => {
    const dir = new ThreadDirectory(3);
    dir.note(H(1), "a", 1);
    dir.note(H(2), "b", 2);
    dir.note(H(1), "a", 3); // refresh H(1)
    dir.note(H(3), "c", 4);
    expect(dir.list().map((e) => e.h)).toEqual([H(2), H(1), H(3)]);
  });

  // ------------------------------------------------ rebind-plan r3 §4.7 (rev tracking)

  it("note carries rev as a MONOTONIC MAX (out-of-order frames never roll it back)", () => {
    const dir = new ThreadDirectory();
    dir.note(H(1), "topic", 1, 41);
    expect(dir.get(H(1))?.rev).toBe(41);
    dir.note(H(1), "topic", 2, 40); // stale frame — must not regress
    expect(dir.get(H(1))?.rev).toBe(41);
    dir.note(H(1), "topic", 3, 42);
    expect(dir.get(H(1))?.rev).toBe(42);
    dir.note(H(1), "topic", 4); // no rev on the frame — kept, not cleared
    expect(dir.get(H(1))?.rev).toBe(42);
  });

  it("note without rev leaves an absent rev absent; noteRev is monotonic and never creates entries", () => {
    const dir = new ThreadDirectory();
    dir.note(H(1), "topic", 1);
    expect(dir.get(H(1))?.rev).toBeUndefined();
    dir.noteRev(H(1), 7);
    expect(dir.get(H(1))?.rev).toBe(7);
    dir.noteRev(H(1), 6);
    expect(dir.get(H(1))?.rev).toBe(7);
    dir.noteRev(H(2), 9); // unknown handle — no entry minted
    expect(dir.get(H(2))).toBeUndefined();
  });

  it("close() CLEARS rev (no longer fresh once the binding moved); a later note does not restore it", () => {
    const dir = new ThreadDirectory();
    dir.note(H(1), "topic", 1, 41);
    expect(dir.close(H(1))).toBe(true);
    expect(dir.get(H(1))?.rev).toBeUndefined();
    dir.note(H(1), "topic", 2, 50); // closed entry: label updates, still closed (never resurrected)
    expect(dir.isOpen(H(1))).toBe(false);
    expect(dir.get(H(1))?.rev).toBe(50); // monotonic max still applies (fresh frame, fresh rev)
  });

  it("reopen resurrects a closed entry ONLY via the trusted acquire path, carrying the hub's current rev", () => {
    const dir = new ThreadDirectory();
    dir.note(H(1), "topic", 1, 41);
    dir.close(H(1));
    dir.reopen(H(1), "topic", 2, 43);
    expect(dir.isOpen(H(1))).toBe(true);
    expect(dir.get(H(1))?.rev).toBe(43);
    // reopen on an unknown handle mints an open entry (same as note)
    dir.reopen(H(2), "other", 3, 5);
    expect(dir.isOpen(H(2))).toBe(true);
    expect(dir.get(H(2))?.rev).toBe(5);
    // reopen is monotonic on rev too, and refreshes recency
    dir.reopen(H(1), "topic", 4, 42);
    expect(dir.get(H(1))?.rev).toBe(43);
  });
});
