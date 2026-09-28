/**
 * Process-level command ledger (plan §4.5/D7/D15, §9.1 v2 addendum).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandLedger, LEDGER_CAPACITY, type LedgerResult } from "../../../src/web-hub/agent/ledger.js";

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");

function resetLedger(): void {
  delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
}

beforeEach(resetLedger);
afterEach(resetLedger);

const OK: LedgerResult = { ok: true, data: { op: "abort", wasBusy: false } };
const RETRYABLE_NONE: LedgerResult = { ok: false, code: "E_STALE_CTX", retryable: true, effect: "none" };
const TERMINAL_FAIL: LedgerResult = { ok: false, code: "E_SESSION_CHANGED", retryable: false, effect: "none" };
const UNKNOWN_FAIL: LedgerResult = { ok: false, code: "E_DEADLINE", retryable: true, effect: "unknown" };

describe("createCommandLedger — begin (D7 rule 1)", () => {
  it("first sighting of an id writes a running entry", () => {
    const ledger = createCommandLedger();
    const outcome = ledger.begin("id1", "abort", { op: "abort" }, 1000);
    expect(outcome.kind).toBe("new");
    expect(ledger.get("id1")?.state).toBe("running");
  });

  it("same id while still running ⇒ 'running' outcome (no re-execution)", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "abort", { op: "abort" }, 1000);
    const outcome = ledger.begin("id1", "abort", { op: "abort" }, 1001);
    expect(outcome.kind).toBe("running");
  });

  it("same id, different payload ⇒ digest_mismatch (id reused)", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "prompt", { op: "prompt", text: "a" }, 1000);
    const outcome = ledger.begin("id1", "prompt", { op: "prompt", text: "b" }, 1001);
    expect(outcome.kind).toBe("digest_mismatch");
  });

  it("terminal id re-sent with the same payload ⇒ dup with the cached result", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "abort", { op: "abort" }, 1000);
    ledger.settle("id1", OK, 1001);
    const outcome = ledger.begin("id1", "abort", { op: "abort" }, 1002);
    expect(outcome).toEqual({ kind: "dup", result: OK });
  });
});

describe("createCommandLedger — settle (D7 rule 2)", () => {
  it("a retryable, effect:none failure deletes the entry (safe to re-execute)", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "abort", { op: "abort" }, 1000);
    ledger.settle("id1", RETRYABLE_NONE, 1001);
    expect(ledger.get("id1")).toBeUndefined();
    expect(ledger.begin("id1", "abort", { op: "abort" }, 1002).kind).toBe("new");
  });

  it("a non-retryable failure is cached as terminal (dup on retry, no dup flag on the error branch)", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "prompt", { op: "prompt", text: "x" }, 1000);
    ledger.settle("id1", TERMINAL_FAIL, 1001);
    const outcome = ledger.begin("id1", "prompt", { op: "prompt", text: "x" }, 1002);
    expect(outcome).toEqual({ kind: "dup", result: TERMINAL_FAIL });
  });

  it("a retryable, effect:unknown failure (D15 timeout) stays cached, not deleted", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "steer_subagent", { op: "steer_subagent" }, 1000);
    ledger.settle("id1", UNKNOWN_FAIL, 1001);
    expect(ledger.get("id1")?.state).toBe("failed");
  });

  it("settle with opts.late marks the entry late and is reflected in query()", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "steer_subagent", { op: "steer_subagent" }, 1000);
    ledger.settle("id1", OK, 2000, { late: true });
    expect(ledger.query("id1")).toEqual({ state: "ok", late: true, result: OK });
  });

  it("settle on an unknown id is a silent no-op", () => {
    const ledger = createCommandLedger();
    expect(() => ledger.settle("ghost", OK, 1000)).not.toThrow();
  });
});

describe("createCommandLedger — query (queryOnly / E_UNKNOWN_ID)", () => {
  it("unknown id ⇒ undefined (agent-side E_UNKNOWN_ID trigger)", () => {
    const ledger = createCommandLedger();
    expect(ledger.query("nope")).toBeUndefined();
  });

  it("running id ⇒ {state:'running'} with no result", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "abort", { op: "abort" }, 1000);
    expect(ledger.query("id1")).toEqual({ state: "running" });
  });

  it("terminal id ⇒ state + result, no late flag when never late", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "abort", { op: "abort" }, 1000);
    ledger.settle("id1", OK, 1001);
    expect(ledger.query("id1")).toEqual({ state: "ok", result: OK });
  });
});

describe("createCommandLedger — prompt sub-state track (§4.3)", () => {
  it("updatePrompt advances promptState/behavior/reason independently of the generic state", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "prompt", { op: "prompt", text: "hi" }, 1000, { text: "hi" });
    ledger.updatePrompt("id1", { promptState: "dispatched" }, 1000);
    ledger.settle("id1", { ok: true, data: { op: "prompt", delivery: "observed" } }, 1003);
    // settle() already made the generic state "ok" (D5: prompt HTTP reply is unconditionally ok),
    // but the ctl-facing wire state must still reflect the (still evolving) prompt sub-state.
    expect(ledger.get("id1")?.state).toBe("ok");
    ledger.updatePrompt("id1", { promptState: "observed", behavior: "idle" }, 1004);
    const frame = ledger.frame("sess-1", "epoch-1", 1005);
    expect(frame.items[0]).toMatchObject({ cmdId: "id1", op: "prompt", state: "observed", behavior: "idle" });
  });

  it("findDispatchedByText returns the earliest still-dispatched entry with an exact text match", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "prompt", { op: "prompt", text: "same" }, 1000, { text: "same" });
    ledger.updatePrompt("id1", { promptState: "dispatched" }, 1000);
    ledger.begin("id2", "prompt", { op: "prompt", text: "same", deliver: "steer" }, 1001, { text: "same" });
    ledger.updatePrompt("id2", { promptState: "dispatched" }, 1001);
    const match = ledger.findDispatchedByText("same");
    expect(match?.id).toBe("id1");
  });

  it("findDispatchedByText ignores entries whose promptState already moved past 'dispatched'", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "prompt", { op: "prompt", text: "hi" }, 1000, { text: "hi" });
    ledger.updatePrompt("id1", { promptState: "observed" }, 1000);
    expect(ledger.findDispatchedByText("hi")).toBeUndefined();
  });

  it("updatePrompt past 'observed' clears the matching text (no longer needed)", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "prompt", { op: "prompt", text: "hi" }, 1000, { text: "hi" });
    ledger.updatePrompt("id1", { promptState: "started" }, 1000);
    expect(ledger.get("id1")?.text).toBeUndefined();
  });
});

describe("createCommandLedger — ctl frame projection", () => {
  it("caps at 32 items, most-recently-updated first", () => {
    const ledger = createCommandLedger();
    for (let i = 0; i < 40; i++) {
      ledger.begin(`id${i}`, "abort", { op: "abort", i }, 1000 + i);
      ledger.settle(`id${i}`, OK, 1000 + i);
    }
    const frame = ledger.frame("sess-1", "epoch-1", 2000);
    expect(frame.items).toHaveLength(32);
    expect(frame.items[0]?.cmdId).toBe("id39");
    expect(frame).toMatchObject({ t: "ctl", epoch: "epoch-1", sessionId: "sess-1" });
  });

  it("a failed terminal entry carries its error code on the wire item", () => {
    const ledger = createCommandLedger();
    ledger.begin("id1", "abort", { op: "abort" }, 1000);
    ledger.settle("id1", TERMINAL_FAIL, 1001);
    const frame = ledger.frame("sess-1", "e", 1002);
    expect(frame.items[0]).toMatchObject({ state: "failed", code: "E_SESSION_CHANGED" });
  });
});

describe("createCommandLedger — capacity/TTL only evict terminal entries", () => {
  it("running entries are never evicted even past capacity", () => {
    const ledger = createCommandLedger();
    ledger.begin("keepalive", "steer_subagent", { op: "steer_subagent" }, 0);
    for (let i = 0; i < LEDGER_CAPACITY + 50; i++) {
      ledger.begin(`t${i}`, "abort", { op: "abort", i }, i);
      ledger.settle(`t${i}`, OK, i);
    }
    expect(ledger.get("keepalive")?.state).toBe("running");
  });

  it("TTL-expired terminal entries are swept away on the next begin/frame call", () => {
    const ledger = createCommandLedger();
    ledger.begin("old", "abort", { op: "abort" }, 0);
    ledger.settle("old", OK, 0);
    const THIRTY_ONE_MIN = 31 * 60_000;
    ledger.begin("new", "abort", { op: "abort", n: 1 }, THIRTY_ONE_MIN);
    expect(ledger.get("old")).toBeUndefined();
  });
});

describe("createCommandLedger — process-level (Symbol.for) sharing", () => {
  it("two independently constructed instances share the same underlying table", () => {
    const a = createCommandLedger();
    a.begin("shared", "abort", { op: "abort" }, 1000);
    a.settle("shared", OK, 1001);
    const b = createCommandLedger(); // simulates a fresh module instance after /reload
    expect(b.query("shared")).toEqual({ state: "ok", result: OK });
  });
});

describe("createCommandLedger — countRunning", () => {
  it("counts only running entries, optionally filtered by op", () => {
    const ledger = createCommandLedger();
    ledger.begin("a", "steer_subagent", { op: "steer_subagent" }, 1000);
    ledger.begin("b", "abort", { op: "abort" }, 1000);
    ledger.begin("c", "steer_subagent", { op: "steer_subagent", n: 2 }, 1000);
    expect(ledger.countRunning()).toBe(3);
    expect(ledger.countRunning("steer_subagent")).toBe(2);
    ledger.settle("a", OK, 1001);
    expect(ledger.countRunning("steer_subagent")).toBe(1);
  });
});
