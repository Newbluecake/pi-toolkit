import { describe, expect, it } from "vitest";
import type { Clock, TimerHandle } from "../../src/core/clock.js";
import {
  JUDGE_LIMITS,
  JUDGE_MAX_TOKENS,
  JUDGE_SESSION_MODEL_FALLBACK,
  buildJudgePrompt,
  judgeModelChain,
  judgeRelevance,
  parseJudgeReply,
  type JudgeInput,
  type JudgePort,
} from "../../src/topic-switch/judge.js";

/** 手动推进的假时钟：timer 存队列，fireDue() 同步触发到期回调。 */
class FakeClock implements Clock {
  nowMs = 1_000_000;
  private nextId = 1;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];

  now(): number {
    return this.nowMs;
  }
  setTimer(delayMs: number, fn: () => void): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, at: this.nowMs + Math.max(0, delayMs), fn });
    return { id };
  }
  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle.id);
  }
  /** 触发所有已到期 timer（不推进时间）。 */
  fireDue(): void {
    let fired = true;
    while (fired) {
      fired = false;
      const due = this.timers.filter((t) => t.at <= this.nowMs).sort((a, b) => a.at - b.at);
      for (const t of due) {
        this.timers = this.timers.filter((x) => x.id !== t.id);
        t.fn();
        fired = true;
      }
    }
  }
}

const INPUT: JudgeInput = {
  sessionName: "缓存调优",
  compactionSummary: "讨论了 TTL 与保活。",
  recentUserMessages: ["读一下 README", "再概括一次"],
  lastAssistantExcerpt: "已完成概括。",
  request: "写一首关于秋天的七言绝句",
  imageCount: 1,
};

describe("constants", () => {
  it("D3 toggle and frozen limits (plan §P1)", () => {
    expect(JUDGE_SESSION_MODEL_FALLBACK).toBe(true);
    expect(JUDGE_MAX_TOKENS).toBe(64);
    expect(Object.isFrozen(JUDGE_LIMITS)).toBe(true);
    expect(JUDGE_LIMITS.requestChars).toBe(2000);
  });
});

describe("judgeModelChain (D3)", () => {
  it("configured → title → session, strict-parsed, deduped, order preserved", () => {
    const chain = judgeModelChain({
      configured: "moonshot/kimi-k3",
      title: "zai-coding-cn/glm-5.3-flash",
      session: "anthropic/claude-sonnet-5",
    });
    expect(chain).toEqual([
      { provider: "moonshot", id: "kimi-k3", origin: "configured" },
      { provider: "zai-coding-cn", id: "glm-5.3-flash", origin: "title" },
      { provider: "anthropic", id: "claude-sonnet-5", origin: "session" },
    ]);
  });

  it("unparseable refs are skipped; empty strings are skipped", () => {
    expect(
      judgeModelChain({ configured: "kimi-k3", title: "", session: "anthropic/claude-sonnet-5" }).map((r) => r.origin),
    ).toEqual(["session"]);
    expect(judgeModelChain({ configured: "x/", title: "/y", session: "" })).toEqual([]);
  });

  it("dedup keeps the first occurrence (configured wins over an identical session ref)", () => {
    const chain = judgeModelChain({ configured: "moonshot/kimi-k3", title: "other/m1", session: "moonshot/kimi-k3" });
    expect(chain).toEqual([
      { provider: "moonshot", id: "kimi-k3", origin: "configured" },
      { provider: "other", id: "m1", origin: "title" },
    ]);
  });
});

describe("buildJudgePrompt", () => {
  it("contains all blocks in order, image note, and the JSON-only system instruction", () => {
    const { systemPrompt, userPrompt } = buildJudgePrompt(INPUT);
    expect(systemPrompt).toContain("related=true");
    expect(systemPrompt).toContain("只输出 JSON");
    const blocks = userPrompt.split("\n\n");
    expect(blocks.length).toBe(5);
    expect(blocks[0]).toContain("Session title: 缓存调优");
    expect(blocks[1]).toContain("Latest compaction summary");
    expect(blocks[2]).toContain("Recent user messages");
    expect(blocks[2]).toContain("- 读一下 README");
    expect(blocks[3]).toContain("Last assistant reply");
    expect(blocks[4]).toContain("NEW REQUEST");
    expect(blocks[4]).toContain("[1 images attached]");
  });

  it("omits absent blocks; zero images omit the note", () => {
    const { userPrompt } = buildJudgePrompt({ recentUserMessages: [], request: "新任务", imageCount: 0 });
    expect(userPrompt).toBe("NEW REQUEST:\n新任务");
  });

  it("clips every field by code points to its JUDGE_LIMITS bound", () => {
    const filler = "字".repeat(JUDGE_LIMITS.requestChars + 50);
    const { userPrompt } = buildJudgePrompt({ request: filler, imageCount: 0, recentUserMessages: [] });
    const requestLine = userPrompt.slice(userPrompt.indexOf("NEW REQUEST:"));
    expect([...requestLine].length).toBeLessThanOrEqual("NEW REQUEST:\n".length + JUDGE_LIMITS.requestChars);
    // 码点截断：不会碎代理对
    const astral = "😀".repeat(JUDGE_LIMITS.recentUserMessageChars + 5);
    const { userPrompt: up2 } = buildJudgePrompt({ recentUserMessages: [astral], request: "x", imageCount: 0 });
    expect(up2).not.toContain("\uFFFD");
  });
});

describe("parseJudgeReply", () => {
  it("parses the first balanced object, tolerating leading prose and trailing junk", () => {
    expect(parseJudgeReply('好的，结果是 {"related": false, "confidence": 0.86} 谢谢')).toEqual({
      related: false,
      confidence: 0.86,
    });
    expect(parseJudgeReply('{"related": true, "confidence": 0.9} {"related": false, "confidence": 0.1}')).toEqual({
      related: true,
      confidence: 0.9,
    });
  });

  it("braces inside strings do not break balance", () => {
    expect(parseJudgeReply('{"related": true, "confidence": 0.5, "note": "a } b { c"}')).toEqual({
      related: true,
      confidence: 0.5,
    });
  });

  it("clamps confidence into [0,1]", () => {
    expect(parseJudgeReply('{"related": true, "confidence": 1.7}')).toEqual({ related: true, confidence: 1 });
    expect(parseJudgeReply('{"related": true, "confidence": -3}')).toEqual({ related: true, confidence: 0 });
  });

  it("rejects: no object, unbalanced, non-JSON, non-boolean related, non-finite confidence, missing fields", () => {
    for (const bad of [
      "",
      "no braces here",
      '{"related": true', // 未闭合
      "{not json}",
      '{"related": "yes", "confidence": 0.5}',
      '{"related": true, "confidence": "0.5"}',
      '{"related": true}',
      '{"confidence": 0.5}',
      '{"related": true, "confidence": 0.5, "x": }',
    ]) {
      expect(parseJudgeReply(bad)).toBeUndefined();
    }
  });
});

function port(respond: (signal: AbortSignal) => Promise<string>): JudgePort & { callCount(): number } {
  let calls = 0;
  return {
    callCount: () => calls,
    complete: (systemPrompt: string, userPrompt: string, signal: AbortSignal) => {
      calls += 1;
      expect(systemPrompt).toContain("related");
      expect(userPrompt).toContain("NEW REQUEST");
      return respond(signal);
    },
  };
}

describe("judgeRelevance", () => {
  it("ok: resolves parsed verdict with elapsed ms", async () => {
    const clock = new FakeClock();
    const p = port(() => Promise.resolve('{"related": false, "confidence": 0.91}'));
    const verdict = await judgeRelevance(p, INPUT, 6_000, clock, new AbortController().signal);
    expect(verdict).toEqual({ kind: "ok", related: false, confidence: 0.91, ms: 0 });
  });

  it("timeout: fires via the clock timer; late port result is discarded", async () => {
    const clock = new FakeClock();
    let resolvePort: ((text: string) => void) | undefined;
    const p = port(
      () =>
        new Promise<string>((resolve) => {
          resolvePort = resolve;
        }),
    );
    const pending = judgeRelevance(p, INPUT, 6_000, clock, new AbortController().signal);
    // cancel timer @6000 与 withDeadline timer @6500 都已武装；只触发到期的 6000。
    clock.nowMs += 6_000;
    clock.fireDue();
    const verdict = await pending;
    expect(verdict.kind).toBe("timeout");
    // 迟到的成功结果被丢弃（race 已由 cancel 赢得）
    resolvePort?.('{"related": false, "confidence": 0.99}');
    await Promise.resolve();
    expect(verdict.kind).toBe("timeout");
  });

  it("external abort mid-flight ⇒ aborted; late result discarded; port not called when pre-aborted", async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    let resolvePort: ((text: string) => void) | undefined;
    const p = port(
      () =>
        new Promise<string>((resolve) => {
          resolvePort = resolve;
        }),
    );
    const pending = judgeRelevance(p, INPUT, 6_000, clock, ac.signal);
    ac.abort();
    resolvePort?.('{"related": false, "confidence": 0.99}');
    await expect(pending).resolves.toEqual(expect.objectContaining({ kind: "aborted" }));

    // 预先 aborted ⇒ 端口完全不被调用
    const ac2 = new AbortController();
    ac2.abort();
    const p2 = port(() => Promise.resolve("{}"));
    const v2 = await judgeRelevance(p2, INPUT, 6_000, clock, ac2.signal);
    expect(v2.kind).toBe("aborted");
    expect(p2.callCount()).toBe(0);
  });

  it("port rejection (not abort) ⇒ error; parse failure ⇒ parse-error", async () => {
    const clock = new FakeClock();
    const failing = port(() => Promise.reject(new Error("boom")));
    const v1 = await judgeRelevance(failing, INPUT, 6_000, clock, new AbortController().signal);
    expect(v1.kind).toBe("error");
    const garbage = port(() => Promise.resolve("I cannot answer that"));
    const v2 = await judgeRelevance(garbage, INPUT, 6_000, clock, new AbortController().signal);
    expect(v2.kind).toBe("parse-error");
  });

  it("timeoutMs clock timer beats a hanging port even when the outer deadline never fires", async () => {
    const clock = new FakeClock();
    const hanging = port(
      () =>
        new Promise<string>(() => {
          /* never settles */
        }),
    );
    const pending = judgeRelevance(hanging, INPUT, 6_000, clock, new AbortController().signal);
    clock.nowMs += 6_000;
    clock.fireDue();
    await expect(pending).resolves.toEqual(expect.objectContaining({ kind: "timeout" }));
  });

  it("cleans up its clock timers on every exit path (no leaks into the caller's clock)", async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    const p = port(() => Promise.resolve('{"related": true, "confidence": 0.5}'));
    await judgeRelevance(p, INPUT, 6_000, clock, ac.signal);
    // ok 路径：cancel timer 应被清理 —— 推进 10s 后不再有回调炸出
    clock.nowMs += 10_000;
    expect(() => clock.fireDue()).not.toThrow();
  });
});
