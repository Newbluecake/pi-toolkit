import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { createInitialState, reduce, TOOL_HISTORY_CAP, toolTrailPatch } from "../../src/core/state-machine.js";
import type { DriverEvent, RunInput, RunState } from "../../src/core/types.js";
import { previewToolArgs } from "../../src/runtime/session-driver.js";

const budget = { ...DEFAULT_BUDGET, totalMs: 60_000, queueWaitMs: 1_000 };

function apply(s: RunState, input: RunInput): RunState {
  return reduce(s, { generation: s.generation, input }, budget).state;
}
function sessionEvent(s: RunState, event: DriverEvent, at: number): RunState {
  return apply(s, { kind: "session_event", at, event });
}
/** Drive a fresh run into model_turn so tool events are legal. */
function runningState(meta?: Extract<RunInput, { kind: "enqueued" }>["meta"]): RunState {
  let s = createInitialState("r", 1, 0);
  s = apply(s, { kind: "enqueued", at: 0, budget, ...(meta ? { meta } : {}) });
  s = apply(s, { kind: "slot_acquired", at: 1 });
  s = apply(s, { kind: "phase_entered", at: 2, phase: "session_create" });
  s = apply(s, { kind: "session_created", at: 3, sessionId: "s1" });
  s = apply(s, { kind: "phase_entered", at: 4, phase: "extension_bind" });
  s = apply(s, { kind: "phase_entered", at: 5, phase: "prompt_dispatch" });
  s = sessionEvent(s, { t: "turn_start" }, 6); // prompt_dispatch → model_turn
  return s;
}

describe("M-A: display meta at enqueue", () => {
  it("folds model/label/agentType/title into diag exactly once", () => {
    const s = runningState({
      model: { provider: "copilot-completion", id: "kimi-k3" },
      label: "重构用户模块",
      title: "重构 用户 模块",
      agentType: "architect",
    });
    expect(s.diag.title).toBe("重构 用户 模块"); // raw display title: inner whitespace kept, never dasherized
    expect(s.diag.model).toEqual({ provider: "copilot-completion", id: "kimi-k3" });
    expect(s.diag.label).toBe("重构用户模块");
    expect(s.diag.agentType).toBe("architect");
  });

  it("leaves meta fields absent when not provided", () => {
    const s = runningState();
    expect(s.diag.model).toBeUndefined();
    expect(s.diag.label).toBeUndefined();
    expect(s.diag.agentType).toBeUndefined();
    expect("title" in s.diag).toBe(false);
  });

  it("retired consult meta (#40) on an enqueued input is ignored: no experts/consultOf/consultCache/consultThread reach diag", () => {
    const legacy = {
      label: "legacy",
      experts: { refs: [{ runId: "r_e0", agentType: "architect" }], granted: true },
      consultOf: { askerRunId: "r_asker" },
      consultCache: { v: 1, predicted: { state: "warm" } },
      consultThread: { threadId: "c7k9q2mx", seq: 1 },
    } as never;
    const s = runningState(legacy);
    expect(s.diag.label).toBe("legacy");
    for (const key of ["experts", "consultOf", "consultCache", "consultThread"]) expect(s.diag).not.toHaveProperty(key);
  });

  it("session_created carries the actual session model — fills the default case and overrides spawn-time meta", () => {
    // no spawn-time model → session_created fills it
    let s = createInitialState("r", 1, 0);
    s = apply(s, { kind: "enqueued", at: 0, budget });
    s = apply(s, { kind: "slot_acquired", at: 1 });
    s = apply(s, { kind: "phase_entered", at: 2, phase: "session_create" });
    s = apply(s, { kind: "session_created", at: 3, sessionId: "s1", model: { provider: "pi", id: "default-model" } });
    expect(s.diag.model).toEqual({ provider: "pi", id: "default-model" });
    // spawn-time meta present → actual session model still wins (ground truth)
    let t = createInitialState("r2", 1, 0);
    t = apply(t, { kind: "enqueued", at: 0, budget, meta: { model: { provider: "cfg", id: "configured" } } });
    t = apply(t, { kind: "slot_acquired", at: 1 });
    t = apply(t, { kind: "phase_entered", at: 2, phase: "session_create" });
    t = apply(t, { kind: "session_created", at: 3, sessionId: "s2", model: { provider: "pi", id: "actual" } });
    expect(t.diag.model).toEqual({ provider: "pi", id: "actual" });
    // session_created without model keeps the spawn-time value
    let u = createInitialState("r3", 1, 0);
    u = apply(u, { kind: "enqueued", at: 0, budget, meta: { model: { provider: "cfg", id: "configured" } } });
    u = apply(u, { kind: "slot_acquired", at: 1 });
    u = apply(u, { kind: "phase_entered", at: 2, phase: "session_create" });
    u = apply(u, { kind: "session_created", at: 3, sessionId: "s3" });
    expect(u.diag.model).toEqual({ provider: "cfg", id: "configured" });
  });

  it("M-B2: session_created carries the effective thinking level — set when present, kept absent otherwise", () => {
    // present → folded into diag next to the model
    let s = createInitialState("r", 1, 0);
    s = apply(s, { kind: "enqueued", at: 0, budget });
    s = apply(s, { kind: "slot_acquired", at: 1 });
    s = apply(s, { kind: "phase_entered", at: 2, phase: "session_create" });
    s = apply(s, {
      kind: "session_created",
      at: 3,
      sessionId: "s1",
      model: { provider: "zai", id: "glm-5.3" },
      thinking: "high",
    });
    expect(s.diag.thinkingLevel).toBe("high");
    expect(s.diag.model).toEqual({ provider: "zai", id: "glm-5.3" });
    // absent → the field stays absent (old journals / no-capability handles)
    let u = createInitialState("r2", 1, 0);
    u = apply(u, { kind: "enqueued", at: 0, budget });
    u = apply(u, { kind: "slot_acquired", at: 1 });
    u = apply(u, { kind: "phase_entered", at: 2, phase: "session_create" });
    u = apply(u, { kind: "session_created", at: 3, sessionId: "s2" });
    expect(u.diag.thinkingLevel).toBeUndefined();
    expect("thinkingLevel" in u.diag).toBe(false);
  });
});

describe("M-A: tool trail (toolHistory / toolCounts)", () => {
  it("records start/end with argsPreview, duration ordering and error flag", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "c1", toolName: "bash", argsPreview: "ls -la" }, 10);
    expect(s.phase).toBe("tool_exec");
    expect(s.diag.toolHistory).toEqual([{ name: "bash", toolCallId: "c1", startedAt: 10, argsPreview: "ls -la" }]);
    s = sessionEvent(s, { t: "tool_end", toolCallId: "c1", toolName: "bash", isError: true }, 22);
    expect(s.diag.toolHistory).toEqual([
      { name: "bash", toolCallId: "c1", startedAt: 10, endedAt: 22, isError: true, argsPreview: "ls -la" },
    ]);
    expect(s.diag.toolCounts).toEqual({ bash: 1 });
  });

  it("counts per tool name across multiple calls", () => {
    let s = runningState();
    for (const [i, name] of ["bash", "read", "bash"].entries()) {
      s = sessionEvent(s, { t: "tool_start", toolCallId: `c${i}`, toolName: name }, 10 + i * 10);
      s = sessionEvent(s, { t: "tool_end", toolCallId: `c${i}`, toolName: name, isError: false }, 15 + i * 10);
    }
    expect(s.diag.toolCounts).toEqual({ bash: 2, read: 1 });
    expect(s.diag.toolHistory).toHaveLength(3);
  });

  it("caps toolHistory at TOOL_HISTORY_CAP while toolCounts keeps the full total", () => {
    let s = runningState();
    const n = TOOL_HISTORY_CAP + 5;
    for (let i = 0; i < n; i++) {
      s = sessionEvent(s, { t: "tool_start", toolCallId: `c${i}`, toolName: "bash" }, 10 + i * 2);
      s = sessionEvent(s, { t: "tool_end", toolCallId: `c${i}`, toolName: "bash", isError: false }, 11 + i * 2);
    }
    expect(s.diag.toolHistory).toHaveLength(TOOL_HISTORY_CAP);
    expect(s.diag.toolHistory![0]!.toolCallId).toBe(`c${n - TOOL_HISTORY_CAP}`);
    expect(s.diag.toolCounts).toEqual({ bash: n });
  });

  it("tool_end for a ring-evicted record is a safe no-op", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "gone", toolName: "bash" }, 10);
    // evict "gone" by flooding the ring
    for (let i = 0; i < TOOL_HISTORY_CAP; i++) {
      s = sessionEvent(s, { t: "tool_start", toolCallId: `c${i}`, toolName: "read" }, 20 + i);
    }
    const before = s.diag.toolHistory;
    s = sessionEvent(s, { t: "tool_end", toolCallId: "gone", toolName: "bash", isError: false }, 99);
    expect(s.diag.toolHistory).toEqual(before);
  });

  it("parallel tool_start while already in tool_exec is still recorded", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "a", toolName: "bash" }, 10);
    expect(s.phase).toBe("tool_exec");
    s = sessionEvent(s, { t: "tool_start", toolCallId: "b", toolName: "read" }, 11);
    expect(s.diag.toolHistory?.map((r) => r.toolCallId)).toEqual(["a", "b"]);
    expect(s.diag.toolCounts).toEqual({ bash: 1, read: 1 });
  });

  it("stays in tool_exec until the LAST parallel tool settles", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "a", toolName: "bash" }, 10);
    s = sessionEvent(s, { t: "tool_start", toolCallId: "b", toolName: "read" }, 11);
    expect(s.phase).toBe("tool_exec");
    expect(s.diag.pendingTools).toBe(2);
    // First sibling ends: still tool_exec (the tree must keep showing 🔧),
    // currentTool points at the remaining in-flight call.
    s = sessionEvent(s, { t: "tool_end", toolCallId: "a", toolName: "bash", isError: false }, 12);
    expect(s.phase).toBe("tool_exec");
    expect(s.diag.pendingTools).toBe(1);
    expect(s.diag.currentTool?.toolCallId).toBe("b");
    expect(s.diag.lastWarn).toBeUndefined();
    // Last sibling ends: now the run is genuinely back in a model turn.
    s = sessionEvent(s, { t: "tool_end", toolCallId: "b", toolName: "read", isError: false }, 13);
    expect(s.phase).toBe("model_turn");
    expect(s.diag.pendingTools).toBe(0);
    expect(s.diag.currentTool).toBeUndefined();
    expect(s.diag.lastWarn).toBeUndefined();
  });

  it("rejects a tool_end for an unknown toolCallId even in tool_exec", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "a", toolName: "bash" }, 10);
    s = sessionEvent(s, { t: "tool_end", toolCallId: "zzz", toolName: "bash", isError: false }, 11);
    expect(s.phase).toBe("tool_exec");
    expect(s.diag.pendingTools).toBe(1);
    expect(s.diag.lastWarn).toBe("illegal:session_event");
  });
});

describe("M-A: tool trail — retired consult fact (#40)", () => {
  it("a tool_end still carrying the old `consult` fact settles the call normally and never writes diag.consults", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "c1", toolName: "consult" }, 10);
    s = sessionEvent(
      s,
      {
        t: "tool_end",
        toolCallId: "c1",
        toolName: "consult",
        isError: false,
        consult: { result: "completed", costUsd: 0.1 },
      } as never,
      15,
    );
    expect(s.diag).not.toHaveProperty("consults");
    expect(s.diag.toolCounts).toEqual({ consult: 1 });
    expect(s.diag.toolHistory!.find((r) => r.toolCallId === "c1")).toMatchObject({ endedAt: 15, isError: false });
  });

  it("an unknown tool_end with the old fact stays an illegal-event warning and still writes no diag.consults", () => {
    const s = runningState();
    const out = reduce(
      s,
      {
        generation: s.generation,
        input: {
          kind: "session_event",
          at: 20,
          event: {
            t: "tool_end",
            toolCallId: "gone",
            toolName: "consult",
            isError: true,
            consult: { result: "bad_ref" },
          },
        } as never,
      },
      budget,
    );
    expect(out.state.diag.lastWarn).toBe("illegal:session_event");
    expect(out.state.diag).not.toHaveProperty("consults");
  });
});

describe("set_model: model_changed diag patch", () => {
  const switched = { provider: "anthropic", id: "claude-haiku-4" };
  /** runningState() with session_created carrying an actual model (session_created is legal exactly once). */
  function runningWithModel(): RunState {
    let s = createInitialState("r", 1, 0);
    s = apply(s, { kind: "enqueued", at: 0, budget });
    s = apply(s, { kind: "slot_acquired", at: 1 });
    s = apply(s, { kind: "phase_entered", at: 2, phase: "session_create" });
    s = apply(s, { kind: "session_created", at: 3, sessionId: "s1", model: { provider: "pi", id: "old" } });
    s = apply(s, { kind: "phase_entered", at: 4, phase: "extension_bind" });
    s = apply(s, { kind: "phase_entered", at: 5, phase: "prompt_dispatch" });
    s = sessionEvent(s, { t: "turn_start" }, 6);
    return s;
  }

  it("overrides the diag.model written by session_created", () => {
    let s = runningWithModel();
    expect(s.diag.model).toEqual({ provider: "pi", id: "old" });
    s = sessionEvent(s, { t: "model_changed", model: switched }, 8);
    expect(s.diag.model).toEqual(switched);
  });

  it("M-B2: a model_changed carrying thinking updates diag.thinkingLevel; absent keeps the previous level", () => {
    let s = runningWithModel();
    // establish a level (as session_created would have written it)
    s = { ...s, diag: { ...s.diag, thinkingLevel: "high" } };
    s = sessionEvent(s, { t: "model_changed", model: switched, thinking: "low" }, 8);
    expect(s.diag.thinkingLevel).toBe("low");
    expect(s.diag.model).toEqual(switched);
    // a switch event without the field keeps the previously stored level
    s = sessionEvent(s, { t: "model_changed", model: switched }, 9);
    expect(s.diag.thinkingLevel).toBe("low");
    expect(s.diag.model).toEqual(switched);
  });

  it("emits no effects and leaves phase/status/lastEventType untouched", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "turn_start" }, 7); // sets lastEventType
    const before = s;
    const out = reduce(
      s,
      {
        generation: s.generation,
        input: { kind: "session_event", at: 8, event: { t: "model_changed", model: switched } },
      },
      budget,
    );
    expect(out.effects).toEqual([]);
    expect(out.state.phase).toBe(before.phase);
    expect(out.state.status).toBe(before.status);
    expect(out.state.diag.lastEventType).toBe(before.diag.lastEventType);
    expect(out.state.diag.lastEventAt).toBe(before.diag.lastEventAt);
    expect(out.state.armedTimers).toBe(before.armedTimers);
  });

  it("is ignored after a terminal status (the outcome snapshot is already sealed)", () => {
    let s = runningWithModel();
    s = apply(s, { kind: "prompt_settled", at: 9, text: "done" });
    expect(s.status).toBe("completed");
    const sealedDiag = s.diag;
    const sealedOutcome = s.outcome;
    s = sessionEvent(s, { t: "model_changed", model: switched }, 10);
    expect(s.diag).toBe(sealedDiag);
    expect(s.diag.model).toEqual({ provider: "pi", id: "old" });
    expect(s.outcome).toBe(sealedOutcome);
  });

  it("a switch before settle lands in outcome.diag.model (finish copies diag)", () => {
    let s = runningWithModel();
    s = sessionEvent(s, { t: "model_changed", model: switched }, 8);
    s = apply(s, { kind: "prompt_settled", at: 9, text: "done" });
    expect(s.outcome?.diag.model).toEqual(switched);
  });
});

describe("M-A: previewToolArgs", () => {
  it("prefers the informative scalar field", () => {
    expect(previewToolArgs({ command: "npm test", timeout: 5 })).toBe("npm test");
    expect(previewToolArgs({ path: "/tmp/x.ts" })).toBe("/tmp/x.ts");
  });
  it("falls back to compact key=value pairs and collapses whitespace", () => {
    expect(previewToolArgs({ n: 1 })).toBe("n=1");
    expect(previewToolArgs({ run_id: "r_1", wait: false, opts: { a: 1 } })).toBe('run_id=r_1 wait=false opts={"a":1}');
    expect(previewToolArgs("a\n  b")).toBe("a b");
  });
  it("renders addressed tools (consult / message_agent) as → target: body", () => {
    expect(previewToolArgs({ expert: "plan:auth", question: "why \n JWT?" })).toBe("→ plan:auth: why JWT?");
    expect(previewToolArgs({ to: "root", kind: "finding", text: "done" })).toBe("→ root: done");
    // Only one half present ⇒ no arrow form.
    expect(previewToolArgs({ expert: "main" })).toBe("expert=main");
  });
  it("truncates to the cap with an ellipsis", () => {
    const out = previewToolArgs({ command: "x".repeat(200) })!;
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns undefined for empty/unstringifiable input", () => {
    expect(previewToolArgs(undefined)).toBeUndefined();
    expect(previewToolArgs("   ")).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(previewToolArgs(cyclic)).toBeUndefined();
  });
});
