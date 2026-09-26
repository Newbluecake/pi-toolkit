import { describe, expect, it, vi } from "vitest";
import {
  SWITCH_FALLBACK_TEXT,
  SWITCH_RESUME_TEXT,
  createSwitchContextTool,
} from "../../src/tools/switch-context-tool.js";
import { PendingHandoffStore } from "../../src/context-switch/store.js";
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
