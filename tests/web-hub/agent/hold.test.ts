/**
 * Process-level hold buffer unit tests (plan §4.3 A1, §9 anchor `hold.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHoldBuffer,
  holdWired,
  HOLD_MAX_ITEMS,
  RETURNED_MAX_ITEMS,
  RETURNED_TTL_MS,
} from "../../../src/web-hub/agent/hold.js";
import type { CmdOrigin } from "../../../src/web-hub/protocol/messages.js";

const HOLD_BAG_KEY = Symbol.for("pi-subagent:web-hub:hold-buffer");

function resetBag(): void {
  delete (globalThis as Record<symbol, unknown>)[HOLD_BAG_KEY];
}

beforeEach(resetBag);
afterEach(resetBag);

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "r1" };

function item(
  cmdId: string,
  overrides: Partial<{ sessionId: string; owner: string; text: string; deliver: "steer" | "followUp" }> = {},
) {
  return {
    cmdId,
    sessionId: overrides.sessionId ?? "s1",
    owner: overrides.owner ?? "owner-1",
    text: overrides.text ?? `text-${cmdId}`,
    deliver: overrides.deliver ?? ("steer" as const),
    origin: ORIGIN,
    at: 1000,
  };
}

describe("holdWired", () => {
  it("is true unless control or steerRecall is explicitly false", () => {
    expect(holdWired({})).toBe(true);
    expect(holdWired({ control: true, steerRecall: true })).toBe(true);
    expect(holdWired({ control: false })).toBe(false);
    expect(holdWired({ steerRecall: false })).toBe(false);
    expect(holdWired({ control: false, steerRecall: false })).toBe(false);
  });
});

describe("createHoldBuffer — hold/held/countHeld (FIFO + capacity)", () => {
  it("held() returns items in ascending `at` (FIFO) order", () => {
    const buf = createHoldBuffer();
    buf.hold({ ...item("a"), at: 3000 }, 1000);
    buf.hold({ ...item("b"), at: 1000 }, 1000);
    buf.hold({ ...item("c"), at: 2000 }, 1000);
    expect(buf.held("s1").map((h) => h.cmdId)).toEqual(["b", "c", "a"]);
  });

  it("hold() refuses once the session reaches HOLD_MAX_ITEMS", () => {
    const buf = createHoldBuffer();
    for (let i = 0; i < HOLD_MAX_ITEMS; i++) {
      expect(buf.hold(item(`h${i}`), 1000)).toBe(true);
    }
    expect(buf.countHeld("s1")).toBe(HOLD_MAX_ITEMS);
    expect(buf.hold(item("overflow"), 1000)).toBe(false);
  });

  it("capacity is scoped per session", () => {
    const buf = createHoldBuffer();
    for (let i = 0; i < HOLD_MAX_ITEMS; i++) buf.hold(item(`h${i}`, { sessionId: "s1" }), 1000);
    expect(buf.hold(item("other-session", { sessionId: "s2" }), 1000)).toBe(true);
  });
});

describe("createHoldBuffer — takeForHandoff / release / recall linearization (F1)", () => {
  it("takeForHandoff transitions held → handing and is undefined unless currently held", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    const taken = buf.takeForHandoff("a", 1001);
    expect(taken?.cmdId).toBe("a");
    expect(buf.held("s1")).toHaveLength(0);
    expect(buf.takeForHandoff("a", 1002)).toBeUndefined(); // already handing
    expect(buf.takeForHandoff("ghost", 1002)).toBeUndefined();
  });

  it("release removes a handing item entirely (sent)", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    buf.takeForHandoff("a", 1001);
    buf.release("a");
    expect(buf.recall("a", 1002)).toEqual({ kind: "unknown" });
  });

  it("recall on a held item removes it and reports from:'held'", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    const outcome = buf.recall("a", 1001);
    expect(outcome.kind).toBe("recalled");
    if (outcome.kind === "recalled") {
      expect(outcome.from).toBe("held");
      expect(outcome.item.cmdId).toBe("a");
    }
    expect(buf.held("s1")).toHaveLength(0);
  });

  it("recall on a handing item (already taken for handoff) ⇒ too_late — the F1 race", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    buf.takeForHandoff("a", 1001); // linearized first: held → handing
    expect(buf.recall("a", 1002)).toEqual({ kind: "too_late" });
    // the item is untouched by the losing recall — still handing, still recoverable by release.
    buf.release("a");
  });

  it("recall on an unknown id ⇒ unknown", () => {
    const buf = createHoldBuffer();
    expect(buf.recall("ghost", 1000)).toEqual({ kind: "unknown" });
  });

  it("recall on a returned item removes it and reports from:'returned'", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    buf.markReturned(["a"], "aborted", 1001);
    const outcome = buf.recall("a", 1002);
    expect(outcome.kind).toBe("recalled");
    if (outcome.kind === "recalled") expect(outcome.from).toBe("returned");
  });
});

describe("createHoldBuffer — markReturned / returnSession (idempotent)", () => {
  it("markReturned transitions held|handing → returned{reason} and is idempotent", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    const first = buf.markReturned(["a"], "stale", 1001);
    expect(first).toHaveLength(1);
    expect(first[0]?.state).toBe("returned");
    expect(first[0]?.reason).toBe("stale");
    const second = buf.markReturned(["a"], "stale", 1002); // already returned ⇒ no-op
    expect(second).toHaveLength(0);
  });

  it("markReturned silently skips unknown ids", () => {
    const buf = createHoldBuffer();
    expect(buf.markReturned(["ghost"], "stale", 1000)).toHaveLength(0);
  });

  it("returnSession returns every held item of the given session only, idempotently", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { sessionId: "s1" }), 1000);
    buf.hold(item("b", { sessionId: "s1" }), 1000);
    buf.hold(item("c", { sessionId: "s2" }), 1000);
    const returned = buf.returnSession("s1", "session", 1001);
    expect(returned.map((h) => h.cmdId).sort()).toEqual(["a", "b"]);
    expect(buf.held("s2")).toHaveLength(1);
    expect(buf.returnSession("s1", "session", 1002)).toHaveLength(0); // idempotent
  });
});

describe("createHoldBuffer — adopt (session_start boundary, §5.1)", () => {
  it("foreign-owner held items (pre-/reload) → returned{reload}", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { owner: "old-owner", sessionId: "s1" }), 1000);
    const { returned, droppedHanding } = buf.adopt("new-owner", "s1", 2000);
    expect(returned.map((h) => h.cmdId)).toEqual(["a"]);
    expect(returned[0]?.reason).toBe("reload");
    expect(droppedHanding).toHaveLength(0);
  });

  it("same-owner, foreign-session held items → returned{session}", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { owner: "owner-1", sessionId: "old-session" }), 1000);
    const { returned } = buf.adopt("owner-1", "new-session", 2000);
    expect(returned.map((h) => h.cmdId)).toEqual(["a"]);
    expect(returned[0]?.reason).toBe("session");
  });

  it("same-owner, same-session held items are left alone", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { owner: "owner-1", sessionId: "s1" }), 1000);
    const { returned } = buf.adopt("owner-1", "s1", 2000);
    expect(returned).toHaveLength(0);
    expect(buf.held("s1")).toHaveLength(1);
  });

  it("foreign-owner handing items are dropped (already pi's problem), never returned", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { owner: "old-owner" }), 1000);
    buf.takeForHandoff("a", 1001);
    const { returned, droppedHanding } = buf.adopt("new-owner", "s1", 2000);
    expect(droppedHanding).toEqual(["a"]);
    expect(returned).toHaveLength(0);
    expect(buf.recall("a", 2001)).toEqual({ kind: "unknown" });
  });

  it("same-owner handing items are left alone (still mid flight)", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { owner: "owner-1" }), 1000);
    buf.takeForHandoff("a", 1001);
    const { droppedHanding } = buf.adopt("owner-1", "s1", 2000);
    expect(droppedHanding).toHaveLength(0);
  });

  it("adopt is idempotent (second call sees nothing left to adopt)", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { owner: "old-owner" }), 1000);
    buf.adopt("new-owner", "s1", 2000);
    const second = buf.adopt("new-owner", "s1", 2001);
    expect(second.returned).toHaveLength(0);
    expect(second.droppedHanding).toHaveLength(0);
  });
});

describe("createHoldBuffer — project (wire projection)", () => {
  it("projects the current session's held rows plus every session's returned rows", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { sessionId: "s1" }), 1000);
    buf.hold(item("b", { sessionId: "s2" }), 1000);
    buf.markReturned(["b"], "stale", 1001);
    const rows = buf.project("s1", 2000);
    expect(rows.map((r) => r.cmdId).sort()).toEqual(["a", "b"]);
    const held = rows.find((r) => r.cmdId === "a");
    expect(held).toMatchObject({ state: "held", sessionId: "s1" });
    const returned = rows.find((r) => r.cmdId === "b");
    expect(returned).toMatchObject({ state: "returned", reason: "stale", sessionId: "s2" });
  });

  it("never projects another session's held rows", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a", { sessionId: "other" }), 1000);
    expect(buf.project("s1", 1000)).toHaveLength(0);
  });

  it("never projects a handing item", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    buf.takeForHandoff("a", 1001);
    expect(buf.project("s1", 1002)).toHaveLength(0);
  });

  it("clips text on a code-point boundary (never splits a surrogate pair)", () => {
    const buf = createHoldBuffer();
    const emoji = "\u{1F600}"; // U+1F600, a surrogate pair in UTF-16
    const longText = "x".repeat(199) + emoji + "tail";
    buf.hold(item("a", { text: longText }), 1000);
    const [row] = buf.project("s1", 1000);
    expect(row?.text.length).toBeLessThanOrEqual(200);
    // the clip must never end mid-surrogate-pair (which would produce an unpaired lone surrogate).
    const lastCode = row!.text.charCodeAt(row!.text.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });

  it("returned rows evicted past RETURNED_TTL_MS never appear in a later project()", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    buf.markReturned(["a"], "stale", 1000);
    expect(buf.project("s1", 1000 + RETURNED_TTL_MS - 1)).toHaveLength(1);
    expect(buf.project("s1", 1000 + RETURNED_TTL_MS + 1)).toHaveLength(0);
  });

  it("caps returned rows at RETURNED_MAX_ITEMS, oldest-updated evicted first", () => {
    const buf = createHoldBuffer();
    for (let i = 0; i < RETURNED_MAX_ITEMS + 3; i++) {
      buf.hold(item(`r${i}`), 1000);
      buf.markReturned([`r${i}`], "stale", 1000 + i);
    }
    const rows = buf.project("s1", 2000);
    expect(rows).toHaveLength(RETURNED_MAX_ITEMS);
    expect(rows.find((r) => r.cmdId === "r0")).toBeUndefined();
  });
});

describe("createHoldBuffer — rev() monotonicity", () => {
  it("bumps on every mutation and never decreases", () => {
    const buf = createHoldBuffer();
    const r0 = buf.rev();
    buf.hold(item("a"), 1000);
    const r1 = buf.rev();
    expect(r1).toBeGreaterThan(r0);
    buf.takeForHandoff("a", 1001);
    const r2 = buf.rev();
    expect(r2).toBeGreaterThan(r1);
    buf.release("a");
    expect(buf.rev()).toBeGreaterThan(r2);
  });

  it("a no-op mutation (markReturned on nothing) never bumps rev", () => {
    const buf = createHoldBuffer();
    const r0 = buf.rev();
    buf.markReturned(["ghost"], "stale", 1000);
    expect(buf.rev()).toBe(r0);
  });
});

describe("createHoldBuffer — sweep", () => {
  it("sweep() evicts TTL-expired returned rows and reports their ids", () => {
    const buf = createHoldBuffer();
    buf.hold(item("a"), 1000);
    buf.markReturned(["a"], "stale", 1000);
    const evicted = buf.sweep(1000 + RETURNED_TTL_MS + 1);
    expect(evicted).toEqual(["a"]);
  });
});

describe("createHoldBuffer — bag injection (test isolation, item 8)", () => {
  it("two instances sharing an injected bag see each other's mutations", () => {
    const bag = { v: 1 as const, rev: 0, items: new Map() };
    const a = createHoldBuffer({ bag });
    const b = createHoldBuffer({ bag });
    a.hold(item("x"), 1000);
    expect(b.held("s1").map((h) => h.cmdId)).toEqual(["x"]);
  });

  it("two instances with fresh (non-shared) bags are fully isolated", () => {
    const a = createHoldBuffer({ bag: { v: 1, rev: 0, items: new Map() } });
    const b = createHoldBuffer({ bag: { v: 1, rev: 0, items: new Map() } });
    a.hold(item("x"), 1000);
    expect(b.held("s1")).toHaveLength(0);
  });

  it("without an injected bag, two instances share the process-level Symbol.for bag", () => {
    const a = createHoldBuffer();
    a.hold(item("x"), 1000);
    const b = createHoldBuffer(); // simulates a fresh module instance after /reload
    expect(b.held("s1").map((h) => h.cmdId)).toEqual(["x"]);
  });
});
