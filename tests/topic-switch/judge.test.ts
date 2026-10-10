import { describe, expect, it } from "vitest";
import type { Clock, TimerHandle } from "../../src/core/clock.js";
import {
  JUDGE_ATTEMPT_FLOOR_MS,
  JUDGE_LIMITS,
  JUDGE_MAX_TOKENS,
  JUDGE_SESSION_MODEL_FALLBACK,
  buildJudgePrompt,
  judgeAttemptBudgetMs,
  judgeModelChain,
  judgeRelevance,
  judgeWithFailover,
  parseJudgeReply,
  type JudgeAttempt,
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
  pendingCount(): number {
    return this.timers.length;
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
  it("configured (list, in order) → title → session, strict-parsed, deduped, order preserved", () => {
    const chain = judgeModelChain({
      configured: ["moonshot/kimi-k3", "zai-coding-cn/glm-5.3-flash"],
      title: "openai/gpt-5-mini",
      session: "anthropic/claude-sonnet-5",
    });
    expect(chain).toEqual([
      { provider: "moonshot", id: "kimi-k3", origin: "configured" },
      { provider: "zai-coding-cn", id: "glm-5.3-flash", origin: "configured" },
      { provider: "openai", id: "gpt-5-mini", origin: "title" },
      { provider: "anthropic", id: "claude-sonnet-5", origin: "session" },
    ]);
  });

  it("legacy single-entry configured list works; dedupe keeps the FIRST occurrence across all origins", () => {
    const chain = judgeModelChain({
      configured: ["moonshot/kimi-k3"],
      title: "other/m1",
      session: "moonshot/kimi-k3",
    });
    expect(chain).toEqual([
      { provider: "moonshot", id: "kimi-k3", origin: "configured" },
      { provider: "other", id: "m1", origin: "title" },
    ]);
  });

  it("duplicates inside the configured list itself are deduped in order; a configured entry beats title", () => {
    const chain = judgeModelChain({
      configured: ["a/1", "b/2", "a/1", "c/3"],
      title: "b/2",
      session: "",
    });
    expect(chain).toEqual([
      { provider: "a", id: "1", origin: "configured" },
      { provider: "b", id: "2", origin: "configured" },
      { provider: "c", id: "3", origin: "configured" },
    ]);
  });

  it("unparseable refs are skipped; empty strings/empty list are skipped", () => {
    expect(
      judgeModelChain({ configured: ["kimi-k3", ""], title: "", session: "anthropic/claude-sonnet-5" }).map(
        (r) => r.origin,
      ),
    ).toEqual(["session"]);
    expect(judgeModelChain({ configured: ["x/", "/y"], title: "", session: "" })).toEqual([]);
    expect(judgeModelChain({ configured: [], title: "", session: "" })).toEqual([]);
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

/** 带模型身份的 attempt（judgeWithFailover 输入形状）。 */
function attempt(provider: string, id: string, origin: "configured" | "title" | "session", p: JudgePort): JudgeAttempt {
  return { ref: { provider, id, origin }, port: p };
}

/** 宏任务边界：保证 fireDue 之后 judgeWithFailover 的循环体重入并武装下一次尝试的 timer。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("judgeAttemptBudgetMs", () => {
  it("per-attempt budget = min(remaining, max(floor, ceil(total/2))); never negative", () => {
    expect(JUDGE_ATTEMPT_FLOOR_MS).toBe(1_500);
    // default 6s total: cap is max(1500, 3000) = 3000
    expect(judgeAttemptBudgetMs(6_000, 6_000)).toBe(3_000);
    expect(judgeAttemptBudgetMs(6_000, 2_000)).toBe(2_000);
    expect(judgeAttemptBudgetMs(6_000, 500)).toBe(500);
    // small total: floor wins — but `remaining` still caps first when it is smaller
    expect(judgeAttemptBudgetMs(1_000, 1_000)).toBe(1_000); // min(1000, max(1500, 500)) = 1000
    expect(judgeAttemptBudgetMs(2_000, 2_000)).toBe(1_500); // min(2000, max(1500, 1000)) = 1500
    // exhausted budget clamps at 0
    expect(judgeAttemptBudgetMs(6_000, 0)).toBe(0);
    expect(judgeAttemptBudgetMs(6_000, -5)).toBe(0);
  });
});

describe("judgeWithFailover (runtime failover within the TOTAL judge budget)", () => {
  it("empty chain ⇒ no-model with zero attempts", async () => {
    const clock = new FakeClock();
    const result = await judgeWithFailover([], INPUT, 6_000, clock, new AbortController().signal);
    expect(result.verdict.kind).toBe("no-model");
    expect(result.attempts).toEqual([]);
  });

  it("first model answers ⇒ done, single attempt, attempts[] names the answering model", async () => {
    const clock = new FakeClock();
    const first = port(() => Promise.resolve('{"related": false, "confidence": 0.9}'));
    const second = port(() => Promise.resolve('{"related": true, "confidence": 0.9}'));
    const result = await judgeWithFailover(
      [attempt("a", "one", "configured", first), attempt("b", "two", "title", second)],
      INPUT,
      6_000,
      clock,
      new AbortController().signal,
    );
    expect(result.verdict).toEqual({ kind: "ok", related: false, confidence: 0.9, ms: 0 });
    expect(second.callCount()).toBe(0);
    expect(result.attempts).toEqual([{ provider: "a", id: "one", origin: "configured", kind: "ok", ms: 0 }]);
  });

  it("first model errors (429) ⇒ second answers ok (failover on error)", async () => {
    const clock = new FakeClock();
    const failing = port(() => Promise.reject(new Error("429 rate limited")));
    const backup = port(() => Promise.resolve('{"related": true, "confidence": 0.8}'));
    const result = await judgeWithFailover(
      [attempt("a", "primary", "configured", failing), attempt("b", "backup", "configured", backup)],
      INPUT,
      6_000,
      clock,
      new AbortController().signal,
    );
    expect(result.verdict.kind).toBe("ok");
    if (result.verdict.kind === "ok") expect(result.verdict.related).toBe(true);
    expect(failing.callCount()).toBe(1);
    expect(backup.callCount()).toBe(1);
    expect(result.attempts.map((a) => `${a.provider}/${a.id}:${a.kind}`)).toEqual(["a/primary:error", "b/backup:ok"]);
  });

  it("parse-error and empty reply also fail over to the next model", async () => {
    const clock = new FakeClock();
    const garbage = port(() => Promise.resolve("I cannot answer that")); // parse-error
    const empty = port(() => Promise.resolve("")); // parse-error (no balanced object)
    const backup = port(() => Promise.resolve('{"related": false, "confidence": 0.75}'));
    const result = await judgeWithFailover(
      [
        attempt("a", "garbage", "configured", garbage),
        attempt("b", "empty", "configured", empty),
        attempt("c", "backup", "session", backup),
      ],
      INPUT,
      6_000,
      clock,
      new AbortController().signal,
    );
    expect(result.verdict.kind).toBe("ok");
    expect(result.attempts.map((a) => a.kind)).toEqual(["parse-error", "parse-error", "ok"]);
  });

  it("first model hangs ⇒ per-attempt timeout (not the total) hands over; second answers within the total budget", async () => {
    const clock = new FakeClock();
    const hanging = port(
      () =>
        new Promise<string>(() => {
          /* never settles */
        }),
    );
    const backup = port(() => Promise.resolve('{"related": false, "confidence": 0.9}'));
    const pending = judgeWithFailover(
      [attempt("a", "hangs", "configured", hanging), attempt("b", "backup", "title", backup)],
      INPUT,
      6_000,
      clock,
      new AbortController().signal,
    );
    // advance ONLY the per-attempt budget (min(6000, max(1500, 3000)) = 3000 < total 6000)
    clock.nowMs += 3_000;
    clock.fireDue();
    const result = await pending;
    expect(result.verdict).toEqual({ kind: "ok", related: false, confidence: 0.9, ms: 3_000 });
    expect(backup.callCount()).toBe(1); // the second model really was reached after the per-attempt timeout
    expect(result.attempts.map((a) => `${a.provider}/${a.id}:${a.kind}:${a.ms}`)).toEqual([
      "a/hangs:timeout:3000",
      "b/backup:ok:0",
    ]);
  });

  it("budget exhaustion stops the chain: a third model is never tried once the total budget is spent", async () => {
    const clock = new FakeClock();
    const hang1 = port(
      () =>
        new Promise<string>(() => {
          /* never settles */
        }),
    );
    const hang2 = port(
      () =>
        new Promise<string>(() => {
          /* never settles */
        }),
    );
    const never = port(() => Promise.resolve('{"related": false, "confidence": 0.9}'));
    const pending = judgeWithFailover(
      [
        attempt("a", "one", "configured", hang1),
        attempt("b", "two", "configured", hang2),
        attempt("c", "three", "session", never),
      ],
      INPUT,
      6_000,
      clock,
      new AbortController().signal,
    );
    clock.nowMs += 3_000;
    clock.fireDue(); // attempt 1 timeout (budget 3000)
    await flush(); // loop resumes, arms attempt 2 (remaining 3000)
    clock.nowMs += 3_000;
    clock.fireDue(); // attempt 2 timeout (remaining 3000) ⇒ total budget exhausted
    await flush(); // loop resumes, sees remaining ≤ 0, breaks before attempt 3
    const result = await pending;
    expect(never.callCount()).toBe(0); // remaining ≤ 0 ⇒ loop breaks before the third attempt
    expect(result.verdict.kind).toBe("timeout"); // last attempt's failure kind (fail-open outcome)
    expect(result.verdict.ms).toBe(6_000); // total elapsed, not the per-attempt slice
    expect(result.attempts.map((a) => a.kind)).toEqual(["timeout", "timeout"]);
  });

  it("all attempts fail ⇒ last attempt's failure kind with total ms (existing fail-open verdict)", async () => {
    const clock = new FakeClock();
    const fourOhFour = port(() => Promise.reject(new Error("404 model not found")));
    const garbage = port(() => Promise.resolve("nope"));
    const result = await judgeWithFailover(
      [attempt("a", "one", "configured", fourOhFour), attempt("b", "two", "session", garbage)],
      INPUT,
      6_000,
      clock,
      new AbortController().signal,
    );
    expect(result.verdict.kind).toBe("parse-error"); // the LAST attempt's kind
    expect(result.verdict.ms).toBe(0);
    expect(result.attempts.map((a) => a.kind)).toEqual(["error", "parse-error"]);
  });

  it("external abort mid-attempt ⇒ aborted immediately, NO further attempts", async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    const hanging = port(
      () =>
        new Promise<string>(() => {
          /* never settles */
        }),
    );
    const never = port(() => Promise.resolve('{"related": false, "confidence": 0.9}'));
    const pending = judgeWithFailover(
      [attempt("a", "hangs", "configured", hanging), attempt("b", "never", "title", never)],
      INPUT,
      6_000,
      clock,
      ac.signal,
    );
    await Promise.resolve(); // let the first port call arm its cancel race
    ac.abort();
    const result = await pending;
    expect(result.verdict.kind).toBe("aborted");
    expect(never.callCount()).toBe(0);
    expect(result.attempts.map((a) => a.kind)).toEqual(["aborted"]);
  });

  it("pre-aborted signal ⇒ first port never called, no-model-ish aborted outcome, empty-ish attempts", async () => {
    const clock = new FakeClock();
    const ac = new AbortController();
    ac.abort();
    const never = port(() => Promise.resolve('{"related": false, "confidence": 0.9}'));
    const result = await judgeWithFailover([attempt("a", "one", "configured", never)], INPUT, 6_000, clock, ac.signal);
    expect(never.callCount()).toBe(0);
    expect(result.verdict.kind).toBe("aborted");
    expect(result.attempts.map((a) => a.kind)).toEqual(["aborted"]);
  });

  it("timers are cleared on every exit path: nothing fires after the total budget + backstop window", async () => {
    // ok path after one failure
    {
      const clock = new FakeClock();
      const failing = port(() => Promise.reject(new Error("boom")));
      const backup = port(() => Promise.resolve('{"related": false, "confidence": 0.9}'));
      await judgeWithFailover(
        [attempt("a", "one", "configured", failing), attempt("b", "two", "title", backup)],
        INPUT,
        6_000,
        clock,
        new AbortController().signal,
      );
      clock.nowMs += 6_000 + 1_000; // past the total budget and the per-attempt +500 backstop
      expect(() => clock.fireDue()).not.toThrow();
    }
    // all-fail timeout path: the leftover withDeadline backstop timers fire harmlessly and leave none pending
    {
      const clock = new FakeClock();
      const hanging = port(
        () =>
          new Promise<string>(() => {
            /* never settles */
          }),
      );
      const pending = judgeWithFailover(
        [attempt("a", "one", "configured", hanging), attempt("b", "two", "session", hanging)],
        INPUT,
        6_000,
        clock,
        new AbortController().signal,
      );
      clock.nowMs += 3_000;
      clock.fireDue();
      await flush();
      clock.nowMs += 3_000;
      clock.fireDue();
      await pending;
      clock.nowMs += 1_000; // let the abandoned +500 backstop timers fire
      clock.fireDue();
      expect(clock.pendingCount()).toBe(0);
    }
  });
});
