import { describe, expect, it, vi } from "vitest";
import {
  SWITCH_FALLBACK_TEXT,
  SWITCH_RESUME_TEXT,
  createSwitchContextTool,
} from "../../src/tools/switch-context-tool.js";
import type { CapabilityStatus } from "../../src/context-switch/capability.js";
import { ChildSwitchStore, PendingHandoffStore } from "../../src/context-switch/store.js";
import type { TodoTrackerSnapshot } from "../../src/todo/nudge.js";

type CompactCallbacks = { onComplete: () => void; onError: (error: Error) => void };

const goal = "把 compact-hint 的动作层换成模型自写交接内容的上下文切换工具，交接内容由模型负责写全。";
const progress = "钩子与工具已落地，settings 已加开关，正在补齐单测与集成测试，尚未更新文档。";
const next = "补 tool/hook 单测，跑 typecheck 与全量测试，再改 README/AGENTS/CHANGELOG。";

function params(extra: Record<string, unknown> = {}) {
  return { goal, progress, next_steps: next, ...extra };
}

function harness(
  options: {
    mode?: "print" | "json";
    now?: () => number;
    cooldownMs?: number;
    todoTracker?: () => TodoTrackerSnapshot;
  } = {},
) {
  let callbacks: CompactCallbacks | undefined;
  const compact = vi.fn((next_: CompactCallbacks) => {
    callbacks = next_;
  });
  const notify = vi.fn();
  const sendUserMessage = vi.fn();
  const store = new PendingHandoffStore();
  const ctx = { mode: options.mode, compact, getContextUsage: () => ({ tokens: 180_000 }), ui: { notify } };
  const tool = createSwitchContextTool({
    store,
    sendUserMessage,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
    ...(options.todoTracker === undefined ? {} : { todoTracker: options.todoTracker }),
  });
  const execute = (args: Record<string, unknown> = params()) =>
    tool.execute!("call", args as never, undefined as never, undefined as never, ctx as never);
  return { callbacks: () => callbacks, compact, execute, notify, sendUserMessage, store, tool };
}

describe("tools/switch-context-tool", () => {
  it("rejects print and json modes without switching", async () => {
    for (const mode of ["print", "json"] as const) {
      const h = harness({ mode });
      const result = await h.execute();
      expect(result.details).toEqual({ ok: false, reason: "non_interactive_mode" });
      expect(h.compact).not.toHaveBeenCalled();
      expect(h.store.hasFresh()).toBe(false);
    }
  });

  it("refuses an under-specified handoff instead of compacting", async () => {
    const h = harness();
    const result = await h.execute({ goal: "改点东西", progress: "改了", next_steps: "继续" });
    expect(result.details).toMatchObject({ ok: false, reason: "invalid_handoff" });
    expect(result.isError).toBe(true);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.store.hasFresh()).toBe(false);
  });

  it("stages the rendered handoff and triggers compaction", async () => {
    const h = harness();
    const result = await h.execute(params({ key_files: ["src/a.ts — 入口"] }));
    expect(result.details).toMatchObject({ ok: true, keepRecent: true });
    expect(result.terminate).toBe(true);
    expect(h.compact).toHaveBeenCalledOnce();
    const pending = h.store.peek();
    expect(pending?.core).toContain("## 当前目标");
    expect(pending?.core).toContain("src/a.ts — 入口");
    expect(pending?.keepRecent).toBe(true);
  });

  it("propagates keep_recent=false to the stored handoff", async () => {
    const h = harness();
    await h.execute(params({ keep_recent: false }));
    expect(h.store.peek()?.keepRecent).toBe(false);
  });

  it("rejects a second call while a switch is in flight, and honours the cooldown", async () => {
    let now = 100_000;
    const h = harness({ now: () => now, cooldownMs: 1_000 });
    await h.execute();
    expect((await h.execute()).details).toMatchObject({ reason: "in_flight" });
    h.callbacks()!.onComplete();
    expect((await h.execute()).details).toMatchObject({ reason: "cooldown" });
    now += 1_001;
    expect((await h.execute()).details).toMatchObject({ ok: true });
    expect(h.compact).toHaveBeenCalledTimes(2);
  });

  it("resumes with the switch text when the hook consumed the handoff", async () => {
    const h = harness();
    await h.execute();
    h.store.consume(); // 钩子吃掉了交接文本
    h.callbacks()!.onComplete();
    expect(h.sendUserMessage).toHaveBeenCalledWith(SWITCH_RESUME_TEXT);
  });

  it("warns the model when its handoff was NOT applied (generic summary instead)", async () => {
    const h = harness();
    await h.execute();
    // store 里仍留着本次的交接文本 ⇒ 钩子没吃到
    h.callbacks()!.onComplete();
    expect(h.sendUserMessage).toHaveBeenCalledWith(SWITCH_FALLBACK_TEXT);
    expect(h.store.hasFresh()).toBe(false);
  });

  it("stays silent when resume is false", async () => {
    const h = harness();
    await h.execute(params({ resume: false }));
    h.callbacks()!.onComplete();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
  });

  it("clears the staged handoff and reports failure on compaction error", async () => {
    const h = harness();
    await h.execute();
    h.callbacks()!.onError(new Error("boom"));
    expect(h.store.hasFresh()).toBe(false);
    expect(h.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("上下文切换失败"));
  });

  it("resets the in-flight guard and clears the handoff when compact() throws synchronously", async () => {
    const store = new PendingHandoffStore();
    const compact = vi.fn(() => {
      throw new Error("stale context");
    });
    const tool = createSwitchContextTool({ store, sendUserMessage: vi.fn() });
    const ctx = { mode: "tui", compact, getContextUsage: () => undefined, ui: { notify: vi.fn() } };
    await expect(
      tool.execute!("call", params() as never, undefined as never, undefined as never, ctx as never),
    ).rejects.toThrow("stale context");
    expect(store.hasFresh()).toBe(false);
  });

  it("survives a sendUserMessage that throws after the session was replaced", async () => {
    const store = new PendingHandoffStore();
    let callbacks: CompactCallbacks | undefined;
    const tool = createSwitchContextTool({
      store,
      sendUserMessage: () => {
        throw new Error("session replaced");
      },
    });
    const ctx = {
      mode: "tui",
      compact: (next_: CompactCallbacks) => {
        callbacks = next_;
      },
      getContextUsage: () => undefined,
      ui: { notify: vi.fn() },
    };
    await tool.execute!("call", params() as never, undefined as never, undefined as never, ctx as never);
    expect(() => callbacks!.onComplete()).not.toThrow();
  });
});

describe("tools/switch-context-tool: todo-nudge handoff advisory", () => {
  it("appends the advisory when open tasks exist and evidence fired", async () => {
    const h = harness({ todoTracker: () => ({ openTaskCount: 2, turnsSinceTouch: 1, hasEvidence: true }) });
    const result = await h.execute();
    expect(result.content[0]?.text).toContain("2 个未完成任务");
    expect(result.content[0]?.text).toContain("已 1 轮未更新");
    expect(result.content[0]?.text).toContain("请先 TaskUpdate 再切换");
    // Advisory-only: the switch itself is unaffected.
    expect(result.details).toMatchObject({ ok: true });
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("appends the advisory when open tasks exist and >=10 turns passed without evidence", async () => {
    const h = harness({ todoTracker: () => ({ openTaskCount: 1, turnsSinceTouch: 10, hasEvidence: false }) });
    const result = await h.execute();
    expect(result.content[0]?.text).toContain("1 个未完成任务");
  });

  it("omits the advisory with no open tasks", async () => {
    const h = harness({ todoTracker: () => ({ openTaskCount: 0, turnsSinceTouch: 100, hasEvidence: true }) });
    const result = await h.execute();
    expect(result.content[0]?.text).not.toContain("未完成任务");
  });

  it("omits the advisory with open tasks but neither evidence nor enough elapsed turns", async () => {
    const h = harness({ todoTracker: () => ({ openTaskCount: 2, turnsSinceTouch: 3, hasEvidence: false }) });
    const result = await h.execute();
    expect(result.content[0]?.text).not.toContain("未完成任务");
  });

  it("omits the advisory entirely when no todoTracker dep was injected (nudge disabled/child session)", async () => {
    const h = harness();
    const result = await h.execute();
    expect(result.content[0]?.text).not.toContain("未完成任务");
  });

  it("never blocks the switch when the todoTracker throws", async () => {
    const h = harness({
      todoTracker: () => {
        throw new Error("boom");
      },
    });
    const result = await h.execute();
    expect(result.details).toMatchObject({ ok: true });
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("only appends the advisory to the successful switch path, not to early-return errors", async () => {
    const h = harness({
      mode: "print",
      todoTracker: () => ({ openTaskCount: 3, turnsSinceTouch: 50, hasEvidence: true }),
    });
    const result = await h.execute();
    expect(result.details).toEqual({ ok: false, reason: "non_interactive_mode" });
    expect(result.content[0]?.text).not.toContain("未完成任务");
  });
});

function compactionEntry(seq: number) {
  return {
    type: "compaction",
    id: `c${seq}`,
    fromHook: true,
    details: { source: "pi-toolkit:switch_context", seq },
  };
}

function boundaryHarness(
  options: {
    now?: () => number;
    cooldownMs?: number;
    childMaxSwitches?: number;
    capability?: CapabilityStatus;
    branch?: unknown[];
    sessionFile?: string | undefined;
    noSessionFile?: boolean;
    mode?: "print" | "json" | "interactive";
  } = {},
) {
  const childStore = new ChildSwitchStore();
  const sessionFile = options.noSessionFile ? undefined : (options.sessionFile ?? "/tmp/child-session.jsonl");
  const branch = options.branch ?? [];
  const notify = vi.fn();
  const compact = vi.fn();
  const sendUserMessage = vi.fn();
  const ctx = {
    mode: options.mode ?? "print",
    compact,
    getContextUsage: () => ({ tokens: 10_000 }),
    ui: { notify },
    sessionManager: { getSessionFile: () => sessionFile, getBranch: () => branch },
  };
  const tool = createSwitchContextTool({
    store: new PendingHandoffStore(),
    sendUserMessage,
    mode: "boundary",
    childStore,
    getCapabilityStatus: () => options.capability ?? { state: "ready" },
    ...(options.childMaxSwitches === undefined ? {} : { childMaxSwitches: options.childMaxSwitches }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
  });
  const execute = (args: Record<string, unknown> = params(), toolCallId = "call-1") =>
    tool.execute!(toolCallId, args as never, undefined as never, undefined as never, ctx as never);
  return { childStore, compact, execute, notify, sendUserMessage, tool };
}

describe("tools/switch-context-tool boundary mode (child-context-switch plan §2.1)", () => {
  it("does not reject print/json — boundary mode is for non-interactive child sessions", async () => {
    for (const mode of ["print", "json"] as const) {
      const h = boundaryHarness({ mode });
      const result = await h.execute();
      expect(result.details).toMatchObject({ ok: true });
    }
  });

  it("never calls ctx.compact or sendUserMessage, and never terminates the turn", async () => {
    const h = boundaryHarness();
    const result = await h.execute();
    expect(result.details).toMatchObject({ ok: true });
    expect(result.terminate).toBeUndefined();
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
  });

  it("stages by toolCallId into the child store instead of the TTL store", async () => {
    const h = boundaryHarness();
    await h.execute(params(), "call-42");
    const staged = h.childStore.peek();
    expect(staged?.toolCallId).toBe("call-42");
    expect(staged?.core).toContain("## 当前目标");
    expect(staged?.keepRecent).toBe(true);
    expect(typeof staged?.nonce).toBe("string");
  });

  it("rejects an under-specified handoff without staging anything", async () => {
    const h = boundaryHarness();
    const result = await h.execute({ goal: "改点东西", progress: "改了", next_steps: "继续" });
    expect(result.details).toMatchObject({ ok: false, reason: "invalid_handoff" });
    expect(h.childStore.hasPending()).toBe(false);
  });

  it("cooldown: refuses a second switch within the window", async () => {
    let now = 1_000;
    const h = boundaryHarness({ now: () => now, cooldownMs: 60_000 });
    await h.execute(params(), "call-1");
    now += 1_000;
    const second = await h.execute(params(), "call-2");
    expect(second.details).toMatchObject({ ok: false, reason: "cooldown" });
  });

  it("in-flight: refuses a second switch while one is still staged (not yet consumed by turn_end)", async () => {
    const h = boundaryHarness({ cooldownMs: 0 });
    await h.execute(params(), "call-1");
    const second = await h.execute(params(), "call-2");
    expect(second.details).toMatchObject({ ok: false, reason: "in_flight" });
    // once consumed (as the turn_end handler would do), a new switch is allowed again.
    h.childStore.take(["call-1"]);
    const third = await h.execute(params(), "call-3");
    expect(third.details).toMatchObject({ ok: true });
  });

  it("childMaxSwitches: rejects once the branch already has that many switch_context compactions", async () => {
    const branch = [compactionEntry(1), compactionEntry(2)];
    const h = boundaryHarness({ childMaxSwitches: 2, branch });
    const result = await h.execute();
    expect(result.details).toMatchObject({ ok: false, reason: "limit_reached" });
    expect(h.childStore.hasPending()).toBe(false);
  });

  it("childMaxSwitches: counts continue across resume (pre-existing branch entries)", async () => {
    const branch = [compactionEntry(1), compactionEntry(2), compactionEntry(3), compactionEntry(4)];
    const h = boundaryHarness({ childMaxSwitches: 5, branch });
    const result = await h.execute();
    expect(result.details).toMatchObject({ ok: true });
  });

  it("capability disabled -> unavailable, never stages", async () => {
    const h = boundaryHarness({ capability: { state: "disabled", reason: "l0-missing" } });
    const result = await h.execute();
    expect(result.details).toMatchObject({ ok: false, reason: "capability_disabled" });
    expect(result.content[0]?.text).toContain("l0-missing");
    expect(h.childStore.hasPending()).toBe(false);
  });

  it("capability not yet observed/ready -> not_ready, never stages", async () => {
    for (const state of ["unknown", "static-ok", "observed"] as const) {
      const h = boundaryHarness({ capability: { state } });
      const result = await h.execute();
      expect(result.details).toMatchObject({ ok: false, reason: "not_ready" });
      expect(h.childStore.hasPending()).toBe(false);
    }
  });

  it("capability verifying (another switch mid self-check) -> retry shortly, never stages", async () => {
    const h = boundaryHarness({ capability: { state: "verifying" } });
    const result = await h.execute();
    expect(result.details).toMatchObject({ ok: false, reason: "verifying" });
    expect(h.childStore.hasPending()).toBe(false);
  });

  it("capability verified -> allowed, same as ready", async () => {
    const h = boundaryHarness({ capability: { state: "verified" } });
    const result = await h.execute();
    expect(result.details).toMatchObject({ ok: true });
  });

  it("no session file (unpersistable session) -> unavailable, never stages", async () => {
    const h = boundaryHarness({ noSessionFile: true });
    const result = await h.execute();
    expect(result.details).toMatchObject({ ok: false, reason: "no_session_file" });
    expect(h.childStore.hasPending()).toBe(false);
  });
});
