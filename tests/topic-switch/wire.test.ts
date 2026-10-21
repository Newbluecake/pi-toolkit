import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { wireTopicSwitch, type TopicSwitchDeps } from "../../src/topic-switch/wire.js";
import { DEFAULT_TOPIC_SWITCH_SETTINGS, type TopicSwitchSettings } from "../../src/topic-switch/settings.js";
import { ENTRY_TYPE } from "../../src/topic-switch/records.js";
import { JUDGE_MAX_TOKENS, JUDGE_REASONING } from "../../src/topic-switch/judge.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Minimal fake `ExtensionAPI` + `ExtensionContext` harness (no real pi). */
class FakePi {
  handlers = new Map<string, Handler[]>();
  sent: Array<{ content: unknown; options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean } }> =
    [];
  entries: Array<{ customType: string; data: unknown }> = [];
  commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  sessionName: string | undefined;
  ctx: FakeCtx = makeCtx();

  on(event: string, handler: Handler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      /* not needed by these tests */
    };
  }

  /** Simulates real pi: a plain-text/content `sendUserMessage` call (not a slash-command
   *  trampoline) synchronously fires the registered `input` handlers with `source:"extension"`
   *  (I1) against the CURRENT fake ctx. A slash-command trampoline (text starts with "/",
   *  expandPromptTemplates:true) never reaches `input` (S3) — only recorded here. */
  sendUserMessage(
    content: unknown,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): void {
    this.sent.push({ content, ...(options === undefined ? {} : { options }) });
    const isSlash = typeof content === "string" && content.startsWith("/") && options?.expandPromptTemplates === true;
    if (isSlash) return;
    const text = typeof content === "string" ? content : extractText(content);
    const images = typeof content === "string" ? undefined : extractImages(content);
    this.emit(
      "input",
      { type: "input", text, images, source: "extension", streamingBehavior: options?.deliverAs },
      this.ctx,
    );
  }

  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ customType, data });
  }

  registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
    this.commands.set(name, options);
  }

  getSessionName(): string | undefined {
    return this.sessionName;
  }

  emit(event: string, payload: unknown, ctx: unknown): unknown {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      result = handler(payload, ctx);
    }
    return result;
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const block = content.find((b: { type?: string }) => b?.type === "text") as { text?: string } | undefined;
  return block?.text ?? "";
}
function extractImages(content: unknown): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content.filter((b: { type?: string }) => b?.type === "image");
  return images.length > 0 ? images : undefined;
}

interface FakeCtx {
  hasUI: boolean;
  mode: "tui" | "rpc" | "json" | "print";
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  model?: { provider: string; id: string; cost: unknown };
  modelRegistry: { find: (p: string, id: string) => unknown; complete: (...args: unknown[]) => Promise<unknown> };
  sessionManager: { getBranch: () => unknown[]; getSessionId: () => string };
  ui: {
    setStatus: (key: string, text: string | undefined) => void;
    notify: (message: string, level?: string) => void;
    setEditorText: (text: string) => void;
    select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
  };
}

function makeCtx(over: Partial<FakeCtx> = {}): FakeCtx {
  return {
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000, percent: 50 }),
    model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
    modelRegistry: { find: () => undefined, complete: () => Promise.reject(new Error("not used")) },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" },
        },
      ],
      getSessionId: () => "s1",
    },
    ui: { setStatus: () => {}, notify: () => {}, setEditorText: () => {} },
    ...over,
  };
}

function makeDeps(over: Partial<TopicSwitchDeps> = {}, clock = new FakeClock()): TopicSwitchDeps {
  const settings: TopicSwitchSettings = {
    ...DEFAULT_TOPIC_SWITCH_SETTINGS,
    judgeTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
  };
  return {
    settings: () => settings,
    titleModel: "",
    warmth: { assess: () => ({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" }) },
    stack: () => ({ activeRuns: () => 0, backgroundBash: () => 0, goalBusy: () => false }),
    remote: () => undefined,
    clock,
    ...over,
  };
}

/** Flush pending microtasks (judge's `no-model` resolution happens inside a `queueMicrotask`). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const EXPENSIVE_TEXT = "please refactor the entire billing subsystem to support multi-currency ledgers";

const TRANSFER_KEY = Symbol.for("pi-subagent:topic-switch-transfer");
beforeEach(() => {
  // The transfer store is a true process global (same key real separate activations share) —
  // several tests below (gen1/gen2 simulation, transfer cap/TTL/FIFO) depend on starting clean.
  delete (globalThis as Record<symbol, unknown>)[TRANSFER_KEY];
});

describe("wireTopicSwitch: registration", () => {
  it("registers the input handler, the lifecycle hooks, and the /topic-switch command", () => {
    const pi = new FakePi();
    const wiring = wireTopicSwitch(pi as never, makeDeps());
    expect(pi.handlers.has("input")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.handlers.has("session_before_compact")).toBe(true);
    expect(pi.handlers.has("session_compact")).toBe(true);
    expect(pi.handlers.has("session_compact_failed")).toBe(true);
    expect(pi.handlers.has("agent_start")).toBe(true);
    expect(pi.commands.has("topic-switch")).toBe(true);
    expect(typeof wiring.webGate.tryClaim).toBe("function");
  });

  it("m4: session_shutdown clears the 'topic-switch' status-bar entry", () => {
    const pi = new FakePi();
    wireTopicSwitch(pi as never, makeDeps());
    const statusCalls: Array<string | undefined> = [];
    const ctx = makeCtx({
      ui: { setStatus: (_k, text) => statusCalls.push(text), notify: () => {}, setEditorText: () => {} },
    });
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    expect(statusCalls).toContain("topic check…");
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    expect(statusCalls[statusCalls.length - 1]).toBeUndefined();
  });
});

describe("wireTopicSwitch: input handler — gate failures are zero-side-effect", () => {
  it("a throwing ctx (fact-error) yields {action:'continue'} and appends nothing", () => {
    const pi = new FakePi();
    wireTopicSwitch(pi as never, makeDeps());
    const badCtx = makeCtx({
      sessionManager: {
        getBranch: () => {
          throw new Error("boom");
        },
        getSessionId: () => "s1",
      },
    });
    const result = pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, badCtx);
    expect(result).toEqual({ action: "continue" });
    expect(pi.entries).toEqual([]);
    expect(pi.sent).toEqual([]);
  });

  it("a short/continuation message never reaches the judge (synchronous continue, not a Promise)", () => {
    const pi = new FakePi();
    wireTopicSwitch(pi as never, makeDeps());
    const result = pi.emit("input", { type: "input", text: "好的", source: "interactive" }, makeCtx());
    expect(result).toEqual({ action: "continue" });
    expect(result).not.toBeInstanceOf(Promise);
    expect(pi.entries).toEqual([]);
  });

  it("a cheap request (below the cost threshold) is skipped — no hold, no appendEntry", () => {
    const pi = new FakePi();
    wireTopicSwitch(pi as never, makeDeps());
    const ctx = makeCtx({ getContextUsage: () => ({ tokens: 10, contextWindow: 1_000_000, percent: 1 }) });
    const result = pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    expect(result).toEqual({ action: "continue" });
    expect(pi.entries).toEqual([]);
  });

  it("an extension-sourced fresh input never claims a hold (I1: input only ever holds interactive/rpc)", () => {
    const pi = new FakePi();
    wireTopicSwitch(pi as never, makeDeps());
    const result = pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "extension" }, makeCtx());
    expect(result).toEqual({ action: "continue" });
    expect(pi.entries).toEqual([]);
  });
});

describe("wireTopicSwitch: hold lifecycle — judge no-model ⇒ exactly one release, I1 echo not re-captured", () => {
  it("held content is delivered exactly once via sendUserMessage; the echo gets {action:'continue'}; an outcome record is appended", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = makeCtx(); // modelRegistry.find() returns undefined ⇒ judge chain resolves to no-model
    pi.ctx = ctx;
    const handled = pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    expect(handled).toEqual({ action: "handled" });
    await flush(); // let the queued judge microtask run (synchronous no-model feed)
    clock.advance(2_000); // let the release-queue barrier time out
    await flush();

    // Exactly one content delivery, carrying the original (untouched) request text.
    const delivered = pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.options?.deliverAs).toBe("followUp");

    // Exactly one outcome record, no "pending"/"delivering" records (nothing crashed).
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes).toHaveLength(1);
    expect((outcomes[0]!.data as { outcome?: string }).outcome).toBe("no-model");
  });

  it("a second input right after the hold has drained can start a brand-new hold (not blocked forever)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = makeCtx();
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    await flush();
    clock.advance(2_000);
    await flush();
    pi.entries.length = 0;
    pi.sent.length = 0;
    const second = pi.emit("input", { type: "input", text: EXPENSIVE_TEXT + " again", source: "interactive" }, ctx);
    expect(second).toEqual({ action: "handled" });
  });
});

describe("wireTopicSwitch: newcomer during judging ends the hold (held first, newcomer after)", () => {
  it("an interactive newcomer while judging is pending ends the hold (newcomer outcome) and queues both items in order", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    let resolveComplete: ((text: string) => void) | undefined;
    const ctx = makeCtx({
      model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude" }),
        complete: () =>
          new Promise((resolve) => {
            resolveComplete = (text: string) => resolve({ content: [{ type: "text", text }], errorMessage: undefined });
          }),
      },
    });
    pi.ctx = ctx;
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const first = pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    expect(first).toEqual({ action: "handled" });
    await flush(); // judge call is now in flight (model resolved, port.complete() pending)

    const second = pi.emit("input", { type: "input", text: "newcomer text", source: "interactive" }, ctx);
    expect(second).toEqual({ action: "handled" }); // newcomer handled too, ends the hold

    clock.advance(2_000); // held item's barrier
    await flush();
    clock.advance(2_000); // newcomer's barrier
    await flush();

    const texts = pi.sent.map((s) => extractText(s.content)).filter((t) => t.length > 0);
    expect(texts).toEqual([EXPENSIVE_TEXT, "newcomer text"]); // held strictly first

    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toEqual(["newcomer"]);

    // The late judge result (resolved AFTER the newcomer already ended the hold) must be a no-op:
    // feeding it must not append a second outcome record.
    resolveComplete?.("ignored, too late");
    await flush();
    const outcomesAfter = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomesAfter).toHaveLength(1);
  });
});

describe("wireTopicSwitch: watchdog ends a stuck hold exactly once (zero-hang)", () => {
  it("a judge call that never resolves is ended by the watchdog", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    const ctx = makeCtx({
      model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude" }),
        complete: () => new Promise(() => {}), // never resolves
      },
    });
    pi.ctx = ctx;
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    await flush();

    // watchdog = judgeTimeoutMs(1000) + confirmTimeoutMs(1000) + 15000 = 17000
    clock.advance(17_000);
    await flush();
    clock.advance(2_000); // release barrier
    await flush();

    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toEqual(["watchdog"]);
  });
});

describe("wireTopicSwitch: webGate.tryClaim", () => {
  it("claims a fresh idle web prompt when the gate passes, and routes the held item through release.current()", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    const wiring = wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = makeCtx();
    pi.ctx = ctx;
    let currentCalls = 0;
    const release = {
      current: () => {
        currentCalls += 1;
        return "dispatched" as const;
      },
      elsewhere: () => {},
    };
    const claimed = wiring.webGate.tryClaim({ cmdId: "c1", text: EXPENSIVE_TEXT }, ctx, release);
    expect(claimed).toBe(true);
    await flush();
    clock.advance(2_000);
    await flush();
    expect(currentCalls).toBe(1);
  });

  it("a cheap web prompt is NOT claimed (gate fails, native path runs)", () => {
    const pi = new FakePi();
    const wiring = wireTopicSwitch(pi as never, makeDeps());
    const ctx = makeCtx({ getContextUsage: () => ({ tokens: 10, contextWindow: 1_000_000, percent: 1 }) });
    const release = { current: () => "dispatched" as const, elsewhere: () => {} };
    const claimed = wiring.webGate.tryClaim({ cmdId: "c2", text: EXPENSIVE_TEXT }, ctx, release);
    expect(claimed).toBe(false);
  });

  it("while judging/confirming/hopping, a web claim returns true and appends a newcomer item (ends the hold)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    const ctx = makeCtx({
      model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
      modelRegistry: { find: () => ({ provider: "anthropic", id: "claude" }), complete: () => new Promise(() => {}) },
    });
    pi.ctx = ctx;
    const wiring = wireTopicSwitch(pi as never, makeDeps({}, clock));
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    await flush(); // now judging, judge call pending forever

    const release = { current: () => "dispatched" as const, elsewhere: () => {} };
    const claimed = wiring.webGate.tryClaim({ cmdId: "c3", text: "web newcomer" }, ctx, release);
    expect(claimed).toBe(true);

    clock.advance(2_000);
    await flush();
    clock.advance(2_000);
    await flush();
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toEqual(["newcomer"]);
  });
});

describe("wireTopicSwitch: /topic-switch status command never throws and reports a sane shape", () => {
  it("responds via ctx.ui.notify with on/off + threshold + judge chain text", async () => {
    const pi = new FakePi();
    wireTopicSwitch(pi as never, makeDeps());
    const notified: string[] = [];
    const ctx = makeCtx({ ui: { setStatus: () => {}, notify: (m) => notified.push(m), setEditorText: () => {} } });
    await pi.commands.get("topic-switch")!.handler("", ctx as never);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("topic-switch:");
  });

  it("m3: shows the last 5 outcome records (newest first) once some have been recorded; '(none yet)' before any exist", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const notified: string[] = [];
    const ctx = makeCtx({ ui: { setStatus: () => {}, notify: (m) => notified.push(m), setEditorText: () => {} } });

    await pi.commands.get("topic-switch")!.handler("", ctx as never);
    expect(notified[0]).toContain("recent outcomes: (none yet)");

    // Drive one hold through to a recorded outcome (no-model ⇒ "no-model"), then re-check status
    // against a ctx whose branch now carries that outcome record (as a real `getBranch()` would).
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    await flush();
    clock.advance(2_000);
    await flush();
    const branchCtx = makeCtx({
      ui: { setStatus: () => {}, notify: (m) => notified.push(m), setEditorText: () => {} },
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => pi.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data })),
      },
    });
    await pi.commands.get("topic-switch")!.handler("", branchCtx as never);
    expect(notified[1]).toContain("recent outcomes: no-model");
  });

  it("'/topic-switch __go <bad-nonce>' reports an expired link and never throws", async () => {
    const pi = new FakePi();
    wireTopicSwitch(pi as never, makeDeps());
    const notified: string[] = [];
    const ctx = makeCtx({ ui: { setStatus: () => {}, notify: (m) => notified.push(m), setEditorText: () => {} } });
    await expect(
      pi.commands.get("topic-switch")!.handler("__go not-a-real-nonce", ctx as never),
    ).resolves.toBeUndefined();
    expect(notified.some((m) => m.includes("失效"))).toBe(true);
  });
});

describe("wireTopicSwitch: /topic-switch __go PONR command paths", () => {
  function hoppingCtx(): FakeCtx {
    return makeCtx({
      model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude" }),
        complete: () =>
          Promise.resolve({
            content: [{ type: "text", text: '{"related":false,"confidence":0.95}' }],
            errorMessage: undefined,
          }),
      },
      ui: {
        setStatus: () => {},
        notify: () => {},
        setEditorText: () => {},
        select: (_title: string, options: string[]) => Promise.resolve(options[0]),
      },
    });
  }

  /** Drives a fresh hold all the way through judge(related:false) + confirm(switch) to hopping,
   *  returning the hop nonce recorded on the slash-command trampoline (S3: never reaches `input`). */
  async function driveToHopping(pi: FakePi, ctx: FakeCtx): Promise<string> {
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    for (let i = 0; i < 8; i += 1) await flush();
    const hop = pi.sent.find(
      (s) => typeof s.content === "string" && (s.content as string).startsWith("/topic-switch __go "),
    );
    if (hop === undefined) throw new Error("test setup did not reach hopping");
    return (hop.content as string).slice("/topic-switch __go ".length);
  }

  it("preflight failure (not idle) routes back to the current session, never calls newSession", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);
    let newSessionCalled = false;
    const commandCtx = {
      ...ctx,
      isIdle: () => false,
      newSession: async () => {
        newSessionCalled = true;
        return { cancelled: false };
      },
    };
    await pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    expect(newSessionCalled).toBe(false);
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toContain("preflight");
  });

  // CRITICAL TEST HYGIENE (verifier B1/M1 round): real pi's S1 order is
  // `session_shutdown(new)` on the OLD activation → `session_start(new)` on a BRAND-NEW
  // activation (re-activation, not a re-used closure — confirmed by
  // `tests/conformance/topic-switch-runtime-harness.ts`'s gen1/gen2 probe) → `withSession`. This
  // helper reproduces exactly that: two independent `wireTopicSwitch()` instances sharing the
  // SAME process-global transfer store (`Symbol.for`, just like real separate activations do).
  function driveFullSwitch(
    pi1: FakePi,
    ctx: FakeCtx,
    clock: FakeClock,
    nonce: string,
  ): Promise<{
    delivered: unknown[];
    notified: string[];
    gen2: FakePi;
    gen2Ctx: FakeCtx;
    gen2Notified: string[];
    gen2EditorTexts: string[];
  }> {
    const delivered: unknown[] = [];
    const notified: string[] = [];
    const gen2Notified: string[] = [];
    const gen2EditorTexts: string[] = [];
    const gen2 = new FakePi();
    const gen2Ctx = makeCtx({
      sessionManager: { getBranch: () => [], getSessionId: () => "new-session" },
      ui: {
        setStatus: () => {},
        notify: (m) => gen2Notified.push(m),
        setEditorText: (t) => gen2EditorTexts.push(t),
      },
    });
    const commandCtx = {
      ...ctx,
      newSession: async (opts: { withSession?: (rctx: unknown) => Promise<void> }) => {
        // 1. session_shutdown fires on the OLD (gen1) activation.
        pi1.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
        // 2. a brand-new activation (gen2) wires up and gets session_start — B1: must NOT see this
        //    holdId's transfer as recoverable (still "pending", mid-switch).
        gen2.ctx = gen2Ctx;
        wireTopicSwitch(gen2 as never, makeDeps({}, clock));
        gen2.emit("session_start", { type: "session_start", reason: "new" }, gen2Ctx);
        // 3. withSession, still on gen1's closure (the callback `command.ts` built).
        const rctx = {
          sendUserMessage: async (content: unknown) => {
            delivered.push(content);
          },
          ui: { notify: (m: string) => notified.push(m) },
        };
        await opts.withSession?.(rctx);
        return { cancelled: false };
      },
    };
    return pi1.commands
      .get("topic-switch")!
      .handler("__go " + nonce, commandCtx as never)
      .then(() => ({ delivered, notified, gen2, gen2Ctx, gen2Notified, gen2EditorTexts }));
  }

  it("B1/M1: a successful switch (real gen1→gen2→withSession order) delivers exactly once, never touches gen2's editor, never false-warns, and records 'switched'", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);

    const { delivered, notified, gen2, gen2Notified, gen2EditorTexts } = await driveFullSwitch(pi, ctx, clock, nonce);

    // Delivered exactly once, into the NEW session (gen1's rctx stub).
    expect(delivered).toHaveLength(1);

    // B1: gen2's `session_start` recovery must have done NOTHING for this in-flight holdId — no
    // false "未能送达, 已放回输入框" warning, no editor fill, and gen2 itself recorded no
    // resolved/notice entries for it.
    expect(gen2EditorTexts).toEqual([]);
    expect(gen2Notified).toEqual([]);
    expect(gen2.entries).toEqual([]);
    expect(notified).toEqual([]); // no "原请求未能在新会话送达" fallback either — the send succeeded

    // M1: the "switched" outcome IS persisted somewhere real — gen1's (OLD session's) own entries,
    // since that is the only activation that ever knew this holdId succeeded.
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toContain("switched");
    const handoffs = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "handoff",
    );
    expect(handoffs).toHaveLength(1);
  });

  it("{cancelled:true} before any withSession call rolls back to the current session (switch-cancelled)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);
    const commandCtx = { ...ctx, newSession: async () => ({ cancelled: true }) };
    await pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toContain("switch-cancelled");
  });

  it("a thrown newSession BEFORE this activation's own session_shutdown fires is treated like cancelled (r3 N2)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);
    const commandCtx = {
      ...ctx,
      newSession: async () => {
        throw new Error("rpc boom");
      },
    };
    await pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toContain("switch-cancelled");
  });

  it("a thrown newSession AFTER session_shutdown already fired never rolls back (notify + /topic-switch last only, r3 N2)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);
    const notified: string[] = [];
    const commandCtx = {
      ...ctx,
      ui: { ...ctx.ui, notify: (m: string) => notified.push(m) },
      newSession: async () => {
        pi.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
        throw new Error("rpc boom after teardown");
      },
    };
    await pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).not.toContain("switch-cancelled");
    expect(notified.some((m) => m.includes("last"))).toBe(true);
  });

  it("the hop trampoline nonce expires after 5s if never consumed (hop-timeout ⇒ current session)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    await driveToHopping(pi, ctx); // nonce armed, never consumed
    clock.advance(5_000);
    await flush();
    clock.advance(2_000); // release barrier
    await flush();
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toEqual(["hop-timeout"]);
  });
});

describe("wireTopicSwitch: confirm outcomes (stay/cancel/timeout/unavailable/error)", () => {
  /** Same judge setup as `hoppingCtx()` (related:false, confidence 0.95 ⇒ reaches "confirming"),
   *  but with a caller-supplied `ui` so each test can drive `confirmSwitch` to a specific
   *  non-switch `ConfirmOutcome`. */
  function judgingCtx(ui: FakeCtx["ui"]): FakeCtx {
    return makeCtx({
      model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude" }),
        complete: () =>
          Promise.resolve({
            content: [{ type: "text", text: '{"related":false,"confidence":0.95}' }],
            errorMessage: undefined,
          }),
      },
      ui,
    });
  }

  /** Drives a fresh hold through judge(related:false) up to (and including) the confirm call
   *  itself — i.e. up to, but not through, the confirm-phase resolution driven by each test. */
  async function driveToConfirming(pi: FakePi, ctx: FakeCtx): Promise<void> {
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    for (let i = 0; i < 8; i += 1) await flush();
  }

  function outcomeRecords(pi: FakePi): string[] {
    return pi.entries
      .filter((e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome")
      .map((e) => (e.data as { outcome?: string }).outcome ?? "");
  }
  function cooldownRecordCount(pi: FakePi): number {
    return pi.entries.filter((e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "cooldown")
      .length;
  }
  function neverHopped(pi: FakePi): boolean {
    return !pi.sent.some(
      (s) => typeof s.content === "string" && (s.content as string).startsWith("/topic-switch __go"),
    );
  }

  it("stay (user picks the stay option) ⇒ 'declined', cooldown recorded, delivered exactly once, never hops", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = judgingCtx({
      setStatus: () => {},
      notify: () => {},
      setEditorText: () => {},
      select: (_title: string, options: string[]) => Promise.resolve(options[1]), // stayLabel
    });
    await driveToConfirming(pi, ctx);
    clock.advance(2_000); // release-queue barrier
    await flush();

    const delivered = pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.options?.deliverAs).toBe("followUp");
    expect(outcomeRecords(pi)).toEqual(["declined"]);
    expect(cooldownRecordCount(pi)).toBe(1);
    expect(neverHopped(pi)).toBe(true);
  });

  it("cancel (select resolves undefined well before the timeout) ⇒ 'confirm-cancel', cooldown recorded, delivered exactly once, never hops", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = judgingCtx({
      setStatus: () => {},
      notify: () => {},
      setEditorText: () => {},
      select: () => Promise.resolve(undefined),
    });
    await driveToConfirming(pi, ctx);
    clock.advance(2_000);
    await flush();

    const delivered = pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.options?.deliverAs).toBe("followUp");
    expect(outcomeRecords(pi)).toEqual(["confirm-cancel"]);
    expect(cooldownRecordCount(pi)).toBe(1);
    expect(neverHopped(pi)).toBe(true);
  });

  it("timeout (select never settles; confirmTimeoutMs elapses) ⇒ 'confirm-timeout', cooldown recorded, delivered exactly once, never hops", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = judgingCtx({
      setStatus: () => {},
      notify: () => {},
      setEditorText: () => {},
      select: () => new Promise<string | undefined>(() => {}), // never settles on its own
    });
    await driveToConfirming(pi, ctx);
    clock.advance(1_000); // confirmTimeoutMs (makeDeps()) — fires confirmSwitch's own timer
    await flush();
    clock.advance(2_000); // release-queue barrier
    await flush();

    const delivered = pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.options?.deliverAs).toBe("followUp");
    expect(outcomeRecords(pi)).toEqual(["confirm-timeout"]);
    expect(cooldownRecordCount(pi)).toBe(1);
    expect(neverHopped(pi)).toBe(true);
  });

  it("unavailable (no select, no remote channel) ⇒ 'ui-unavailable', NO cooldown, delivered exactly once, never hops", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = judgingCtx({ setStatus: () => {}, notify: () => {}, setEditorText: () => {} }); // no `select` key at all
    await driveToConfirming(pi, ctx);
    clock.advance(2_000);
    await flush();

    const delivered = pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.options?.deliverAs).toBe("followUp");
    expect(outcomeRecords(pi)).toEqual(["ui-unavailable"]);
    expect(cooldownRecordCount(pi)).toBe(0);
    expect(neverHopped(pi)).toBe(true);
  });

  it("error (select rejects synchronously) ⇒ 'ui-unavailable', NO cooldown, delivered exactly once, never hops", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = judgingCtx({
      setStatus: () => {},
      notify: () => {},
      setEditorText: () => {},
      select: () => Promise.reject(new Error("boom")),
    });
    await driveToConfirming(pi, ctx);
    clock.advance(2_000);
    await flush();

    const delivered = pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.options?.deliverAs).toBe("followUp");
    expect(outcomeRecords(pi)).toEqual(["ui-unavailable"]);
    expect(cooldownRecordCount(pi)).toBe(0);
    expect(neverHopped(pi)).toBe(true);
  });
});

describe("wireTopicSwitch: m1/m2 — late-withSession notify, §6.6 CAS races, PONR watchdog, transfer store", () => {
  function hoppingCtx(): FakeCtx {
    return makeCtx({
      model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude" }),
        complete: () =>
          Promise.resolve({
            content: [{ type: "text", text: '{"related":false,"confidence":0.95}' }],
            errorMessage: undefined,
          }),
      },
      ui: {
        setStatus: () => {},
        notify: () => {},
        setEditorText: () => {},
        select: (_title: string, options: string[]) => Promise.resolve(options[0]),
      },
    });
  }
  async function driveToHopping(pi: FakePi, ctx: FakeCtx): Promise<string> {
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    for (let i = 0; i < 8; i += 1) await flush();
    const hop = pi.sent.find(
      (s) => typeof s.content === "string" && (s.content as string).startsWith("/topic-switch __go "),
    );
    if (hop === undefined) throw new Error("test setup did not reach hopping");
    return (hop.content as string).slice("/topic-switch __go ".length);
  }

  it("m1: a late withSession whose CAS loses (something already advanced the transfer) notifies '手动取回', never double-delivers", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);
    const delivered: unknown[] = [];
    const notified: string[] = [];
    const commandCtx = {
      ...ctx,
      newSession: async (opts: { withSession?: (rctx: unknown) => Promise<void> }) => {
        // Something else (here: the test itself, standing in for the PONR watchdog) already moved
        // the transfer off "pending" before this (late) withSession gets a chance to run.
        const g = globalThis as Record<symbol, { entries: Map<string, { state: string }> }>;
        const transferStore = g[Symbol.for("pi-subagent:topic-switch-transfer")]!;
        for (const entry of transferStore.entries.values()) entry.state = "manual";
        const rctx = {
          sendUserMessage: async (content: unknown) => {
            delivered.push(content);
          },
          ui: { notify: (m: string) => notified.push(m) },
        };
        await opts.withSession?.(rctx);
        return { cancelled: false };
      },
    };
    await pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    expect(delivered).toEqual([]);
    expect(notified.some((m) => m.includes("手动取回"))).toBe(true);
  });

  it("withSession's rctx.sendUserMessage rejecting notifies the fallback message, still records 'switched' (the CAS already committed)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);
    const notified: string[] = [];
    const commandCtx = {
      ...ctx,
      newSession: async (opts: { withSession?: (rctx: unknown) => Promise<void> }) => {
        const rctx = {
          sendUserMessage: async () => {
            throw new Error("rpc send failed");
          },
          ui: { notify: (m: string) => notified.push(m) },
        };
        await opts.withSession?.(rctx);
        return { cancelled: false };
      },
    };
    await expect(
      pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never),
    ).resolves.toBeUndefined();
    expect(notified.some((m) => m.includes("未能在新会话送达"))).toBe(true);
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toContain("switched");
  });

  it("§6.6 pair (a): watchdog timeout → /topic-switch last --send delivers once → a late withSession afterward never double-sends", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);
    const delivered: unknown[] = [];
    const lateNotified: string[] = [];
    const commandCtx = {
      ...ctx,
      newSession: async (opts: { withSession?: (rctx: unknown) => Promise<void> }) => {
        clock.advance(30_000); // PONR watchdog fires synchronously: pending → manual
        const lastNotified: string[] = [];
        const lastCtx = { ...ctx, ui: { ...ctx.ui, notify: (m: string) => lastNotified.push(m) } };
        await pi.commands.get("topic-switch")!.handler("last --send", lastCtx as never);
        expect(lastNotified.some((m) => m.includes("已重发"))).toBe(true);
        const rctx = {
          sendUserMessage: async (content: unknown) => {
            delivered.push(content);
          },
          ui: { notify: (m: string) => lateNotified.push(m) },
        };
        await opts.withSession?.(rctx); // the "late" withSession, arriving after /last --send already won
        return { cancelled: false };
      },
    };
    await pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    expect(delivered).toEqual([]); // withSession itself never sent anything
    const deliveredOverall = pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT);
    expect(deliveredOverall).toHaveLength(1); // exactly one real send, via /topic-switch last --send
    expect(lateNotified.some((m) => m.includes("手动取回"))).toBe(true);
  });

  it("§6.6 pair (b): withSession already delivering ⇒ /topic-switch last --send is refused with a notice, never double-sends", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = hoppingCtx();
    const nonce = await driveToHopping(pi, ctx);
    const delivered: unknown[] = [];
    const commandCtx = {
      ...ctx,
      newSession: async (opts: { withSession?: (rctx: unknown) => Promise<void> }) => {
        const rctx = {
          sendUserMessage: async (content: unknown) => {
            delivered.push(content);
          },
          ui: { notify: () => {} },
        };
        await opts.withSession?.(rctx);
        return { cancelled: false };
      },
    };
    await pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    expect(delivered).toHaveLength(1);
    const lastNotified: string[] = [];
    const lastCtx = { ...ctx, ui: { ...ctx.ui, notify: (m: string) => lastNotified.push(m) } };
    await pi.commands.get("topic-switch")!.handler("last --send", lastCtx as never);
    expect(lastNotified.some((m) => m.includes("无需重发"))).toBe(true);
    expect(delivered).toHaveLength(1); // still exactly one — /last --send never piled on a second send
  });

  it("PONR watchdog (30s, never taken) ⇒ notify only, never delivers anywhere (TUI stuck mid-newSession)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const notified: string[] = [];
    const ctx = hoppingCtx();
    ctx.ui = { ...ctx.ui, notify: (m) => notified.push(m) };
    const nonce = await driveToHopping(pi, ctx); // sets ctxRef.current = ctx via the input dispatch
    const neverResolves = new Promise<never>(() => {});
    const commandCtx = { ...ctx, newSession: () => neverResolves as never };
    void pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    await flush();
    clock.advance(30_000);
    await flush();
    expect(notified.some((m) => m.includes("切换未完成"))).toBe(true);
    expect(pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT)).toEqual([]);
  });

  it("M2: an already-sent held item is never re-persisted on a shutdown that races the release barrier (no double-send on reload)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    const ctx = makeCtx(); // modelRegistry.find() undefined ⇒ no-model ⇒ immediate release
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    await flush(); // judge resolves no-model, release effect fires, queue delivers + onSent, then
    // suspends mid-barrier (no clock.advance yet) — exactly the window M2 cares about.
    const deliveredBeforeShutdown = pi.sent.filter((s) => extractText(s.content) === EXPENSIVE_TEXT);
    expect(deliveredBeforeShutdown).toHaveLength(1); // confirms we really are past the send already
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    const pendings = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "pending",
    );
    expect(pendings).toEqual([]);
    const g = globalThis as Record<symbol, { entries: Map<string, unknown> } | undefined>;
    const transferStore = g[Symbol.for("pi-subagent:topic-switch-transfer")];
    expect(transferStore === undefined ? 0 : transferStore.entries.size).toBe(0);
  });
});

describe("wireTopicSwitch: transfer store cap/TTL/FIFO (I5)", () => {
  const STORE_KEY = Symbol.for("pi-subagent:topic-switch-transfer");
  interface Store {
    entries: Map<string, { holdId: string; at: number; state: string }>;
    order: string[];
  }
  function store(): Store {
    return (globalThis as Record<symbol, unknown>)[STORE_KEY] as Store;
  }
  function hoppingCtx(): FakeCtx {
    return makeCtx({
      model: { provider: "anthropic", id: "claude", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude" }),
        complete: () =>
          Promise.resolve({
            content: [{ type: "text", text: '{"related":false,"confidence":0.95}' }],
            errorMessage: undefined,
          }),
      },
      ui: {
        setStatus: () => {},
        notify: () => {},
        setEditorText: () => {},
        select: (_title: string, options: string[]) => Promise.resolve(options[0]),
      },
    });
  }
  async function driveThroughPonrCancelled(pi: FakePi, clock: FakeClock): Promise<void> {
    const ctx = hoppingCtx();
    pi.ctx = ctx;
    const baseline = pi.sent.length;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    for (let i = 0; i < 8; i += 1) await flush();
    const hop = pi.sent
      .slice(baseline)
      .find((s) => typeof s.content === "string" && (s.content as string).startsWith("/topic-switch __go "));
    if (hop === undefined) throw new Error("test setup did not reach hopping");
    const nonce = (hop.content as string).slice("/topic-switch __go ".length);
    const commandCtx = { ...ctx, newSession: async () => ({ cancelled: true }) };
    await pi.commands.get("topic-switch")!.handler("__go " + nonce, commandCtx as never);
    // Let the (now-releasing) hold fully drain so the NEXT drive-to-hopping can start a fresh one.
    await flush();
    clock.advance(2_000);
    await flush();
  }

  it("cap: a 5th transfer evicts the oldest (FIFO), never exceeding TRANSFER_CAP=4", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    for (let i = 0; i < 4; i += 1) {
      await driveThroughPonrCancelled(pi, clock);
    }
    expect(store().order.length).toBe(4);
    const oldestHoldId = store().order[0]!;

    await driveThroughPonrCancelled(pi, clock);
    expect(store().order.length).toBe(4);
    expect(store().entries.has(oldestHoldId)).toBe(false);
  });

  it("TTL: a transfer older than 10 minutes is pruned on the next store access (/topic-switch last)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, makeDeps({}, clock));
    await driveThroughPonrCancelled(pi, clock);
    expect(store().order.length).toBe(1);
    const holdId = store().order[0]!;
    const entry = store().entries.get(holdId)!;
    entry.at = Date.now() - 11 * 60_000; // age it past TRANSFER_TTL_MS (wall-clock Date.now()-based)
    const notified: string[] = [];
    const lastCtx = makeCtx({ ui: { setStatus: () => {}, notify: (m) => notified.push(m), setEditorText: () => {} } });
    await pi.commands.get("topic-switch")!.handler("last", lastCtx as never);
    expect(store().entries.has(holdId)).toBe(false);
    expect(notified.some((m) => m.includes("没有已知"))).toBe(true);
  });
});

describe("wireTopicSwitch: judge model chain with runtime failover", () => {
  /** ctx whose registry has BOTH x/one and x/two; `complete` rejects (429) for the x/one model
   *  object and answers related:false/0.95 for x/two. Returns the per-call model dispatch log. */
  function failoverCtx(uiOver: Partial<FakeCtx["ui"]>): { ctx: FakeCtx; calls: string[] } {
    const calls: string[] = [];
    const ctx = makeCtx({
      modelRegistry: {
        find: (p: string, id: string) =>
          p === "x" && (id === "one" || id === "two") ? { provider: p, id } : undefined,
        complete: (...args: unknown[]) => {
          const model = args[0] as { provider: string; id: string };
          const key = `${model.provider}/${model.id}`;
          calls.push(key);
          if (key === "x/one") return Promise.reject(new Error("429 rate limited"));
          return Promise.resolve({
            content: [{ type: "text", text: '{"related":false,"confidence":0.95}' }],
            errorMessage: undefined,
          });
        },
      },
      ui: { setStatus: () => {}, notify: () => {}, setEditorText: () => {}, ...uiOver },
    });
    return { ctx, calls };
  }

  function failoverDeps(clock: FakeClock): TopicSwitchDeps {
    return makeDeps(
      {
        settings: () => ({
          ...DEFAULT_TOPIC_SWITCH_SETTINGS,
          models: ["x/one", "x/two"],
          judgeTimeoutMs: 1_000,
          confirmTimeoutMs: 1_000,
        }),
      },
      clock,
    );
  }

  it("first model 429s ⇒ second model answers ⇒ confirm dialog still reached (declined outcome)", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, failoverDeps(clock));
    const selectCalls: string[] = [];
    const { ctx, calls } = failoverCtx({
      select: (title: string, options: string[]) => {
        selectCalls.push(title);
        return Promise.resolve(options[1]); // stayLabel — declined, no hop
      },
    });
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    for (let i = 0; i < 8; i += 1) await flush(); // judge attempt 1 (429) → attempt 2 (ok) → confirm
    expect(calls).toEqual(["x/one", "x/two"]); // both models tried, in chain order
    expect(selectCalls).toHaveLength(1); // the confirm dialog really was reached — via the SECOND model
    clock.advance(2_000); // release barrier
    await flush();
    const outcomes = pi.entries.filter(
      (e) => e.customType === ENTRY_TYPE && (e.data as { kind?: string }).kind === "outcome",
    );
    expect(outcomes.map((e) => (e.data as { outcome?: string }).outcome)).toEqual(["declined"]);
  });

  it("prefers streamSimple with reasoning=minimal (JUDGE_REASONING) and JUDGE_MAX_TOKENS when the registry has it", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, failoverDeps(clock));
    const streamOpts: unknown[] = [];
    const selectCalls: string[] = [];
    const ctx = makeCtx({
      modelRegistry: {
        find: (p: string, id: string) => (p === "x" && id === "one" ? { provider: p, id } : undefined),
        complete: () => Promise.reject(new Error("complete must not be used when streamSimple exists")),
        streamSimple: (_model: unknown, _context: unknown, opts: unknown) => {
          streamOpts.push(opts);
          return {
            result: () =>
              Promise.resolve({
                content: [{ type: "text", text: '{"related":false,"confidence":0.9}' }],
                errorMessage: undefined,
              }),
          };
        },
      } as FakeCtx["modelRegistry"],
      ui: {
        setStatus: () => {},
        notify: () => {},
        setEditorText: () => {},
        select: (title: string, options: string[]) => {
          selectCalls.push(title);
          return Promise.resolve(options[1]);
        },
      },
    });
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    for (let i = 0; i < 8; i += 1) await flush();
    expect(streamOpts).toHaveLength(1);
    expect(streamOpts[0]).toMatchObject({ reasoning: JUDGE_REASONING, maxTokens: JUDGE_MAX_TOKENS });
    expect(JUDGE_REASONING).toBe("minimal");
    expect(selectCalls).toHaveLength(1); // the streamSimple verdict drove the confirm dialog
    clock.advance(2_000);
    await flush();
  });

  it("status shows the configured chain, the model that answered, and per-model failure counts", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    wireTopicSwitch(pi as never, failoverDeps(clock));
    const notified: string[] = [];
    const { ctx } = failoverCtx({ notify: (m: string) => notified.push(m) });
    pi.ctx = ctx;
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, ctx);
    for (let i = 0; i < 8; i += 1) await flush(); // judge failover completes: x/one fails, x/two answers
    clock.advance(2_000);
    await flush();
    await pi.commands.get("topic-switch")!.handler("", ctx as never);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("judge chain: x/one(configured) → x/two(configured) → anthropic/claude(session)");
    expect(notified[0]).toContain("judge: answered x/two · fails x/one×1");
  });
});

describe("wireTopicSwitch: T1 read-only fenceActive() (phase2-plan §7.2)", () => {
  it("false when idle; true while a hold is pending (judging AND releasing); false once resolved", async () => {
    const pi = new FakePi();
    const clock = new FakeClock();
    const wiring = wireTopicSwitch(pi as never, makeDeps({}, clock));
    expect(wiring.fenceActive()).toBe(false);
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, makeCtx());
    expect(wiring.fenceActive()).toBe(true); // judging phase — a hold is pending
    await flush(); // no judge model ⇒ no-model verdict, hold moves to releasing
    expect(wiring.fenceActive()).toBe(true); // still pending — the release queue is draining
    clock.advance(2_000); // release-queue barrier
    await flush();
    expect(wiring.fenceActive()).toBe(false);
    // read-only: repeated calls change nothing
    expect(wiring.fenceActive()).toBe(false);
    expect(wiring.fenceActive()).toBe(false);
  });

  it("true while a B1 mid-switch marker is live in the process-global transfer store", () => {
    const pi = new FakePi();
    const wiring = wireTopicSwitch(pi as never, makeDeps());
    expect(wiring.fenceActive()).toBe(false); // also lazily creates the transfer store
    const store = (globalThis as Record<symbol, unknown>)[TRANSFER_KEY] as {
      inFlight: Set<string>;
    };
    store.inFlight.add("hold-1");
    expect(wiring.fenceActive()).toBe(true);
    store.inFlight.delete("hold-1");
    expect(wiring.fenceActive()).toBe(false);
  });

  it("false after this activation's session_shutdown even if a hold reference lingers", () => {
    const pi = new FakePi();
    const wiring = wireTopicSwitch(pi as never, makeDeps());
    pi.emit("input", { type: "input", text: EXPENSIVE_TEXT, source: "interactive" }, makeCtx());
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, makeCtx());
    expect(wiring.fenceActive()).toBe(false);
  });
});
