/**
 * P1 functional (plan §10 P1-1 … P1-10): merge window, quiet period, re-ask dwell, parameter
 * parsing, batch interrupts, pre-open deferral, interrupt budget, in-dialog notices — all
 * through the REAL registered tool with a fake port + fake clock (bg-harness).
 */
import { describe, expect, it } from "vitest";
import { AskUserComponent } from "../../src/ask-user/component.js";
import {
  DEFAULT_INTERRUPT_SETTINGS,
  DEFER_CAP,
  computeDue,
  normalizeInterruptSettings,
} from "../../src/ask-user/interrupt.js";
import { mockTui, stubTheme, singleQ } from "./fixtures.js";
import { PARAMS, createBgHarness, flush, renderText, tuiContext } from "./bg-harness.js";

function settleFlag(pending: Promise<unknown>): { readonly settled: boolean } {
  const flag = { settled: false };
  void pending.then(() => {
    flag.settled = true;
  });
  return flag;
}

describe("1. open dialog + one completion", () => {
  it("interrupts after delayMs, resolves done exactly once, closes (background, aborted)", async () => {
    const h = createBgHarness();
    let doneCalls = 0;
    const c = tuiContext(undefined, () => {
      doneCalls += 1;
    });
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    const flag = settleFlag(pending);
    h.clock.advance(999);
    await flush();
    expect(flag.settled).toBe(false);
    h.clock.advance(1);
    const result = await pending;
    expect(doneCalls).toBe(1);
    expect(result.details.cancelled).toBe(true);
    expect(result.details.interrupted.kind).toBe("background");
    expect(result.details.interrupted.completions).toEqual([{ kind: "subagent", count: 1 }]);
    expect(result.details.interrupted.attempt).toBe(1);
    expect(result.details.interrupted.limit).toBe(3);
    expect(result.content[0].text).toContain("[interrupt 1/3]");
    expect(h.session!.closed).toEqual(["background", "aborted"]);
    expect(h.clock.pending).toBe(0);
    expect(h.port.listeners.size).toBe(0);
  });
});

describe("2. merge window", () => {
  it("batches 3 completions into one interrupt and never extends the fixed window", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(400);
    h.port.fire("bash", 1);
    h.clock.advance(400);
    h.port.fire("workflow", 1);
    const flag = settleFlag(pending);
    // t=800: windowFire stays at 1000 (fixed window; later completions only accumulate).
    h.clock.advance(199);
    await flush();
    expect(flag.settled).toBe(false);
    h.clock.advance(1);
    const result = await pending;
    expect(result.details.interrupted.completions).toEqual([
      { kind: "subagent", count: 1 },
      { kind: "workflow", count: 1 },
      { kind: "bash", count: 1 },
    ]);
    expect(h.clock.t).toBe(1000);
  });

  it("merges same-kind counts", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire("subagent", 2);
    h.clock.advance(100);
    h.port.fire("subagent", 1);
    h.clock.advance(1000);
    const result = await pending;
    expect(result.details.interrupted.completions).toEqual([{ kind: "subagent", count: 3 }]);
    expect(result.content[0].text).toContain("3 background tasks (3 subagent)");
  });
});

describe("3. quiet period", () => {
  it("postpones while typing and lands quietMs after the last keystroke", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(900);
    c.created[0]!.handleInput("x"); // keystroke at t=900 → quiet due 4900
    const flag = settleFlag(pending);
    h.clock.advance(100); // t=1000: old timer fires, re-evaluates, reschedules
    await flush();
    expect(flag.settled).toBe(false);
    h.clock.advance(3899); // t=4899
    await flush();
    expect(flag.settled).toBe(false);
    h.clock.advance(1); // t=4900
    await pending;
    expect(h.clock.t).toBe(4900);
  });

  it("caps the postponement at windowFire + maxDeferMs under continuous typing", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    const flag = settleFlag(pending);
    for (let t = 900; t <= 18900; t += 3000) {
      h.clock.advance(t - h.clock.t);
      c.created[0]!.handleInput("x");
      await flush();
      expect(flag.settled).toBe(false);
    }
    // last keystroke t=18900 → min(18900+4000, 1000+20000) = 21000
    h.clock.advance(2099); // t=20999
    await flush();
    expect(flag.settled).toBe(false);
    h.clock.advance(1); // t=21000
    await pending;
    expect(h.clock.t).toBe(21000);
  });

  it("a submit during the postponement wins and stays answered", async () => {
    const h = createBgHarness();
    let doneCalls = 0;
    const c = tuiContext(undefined, () => {
      doneCalls += 1;
    });
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(900);
    c.created[0]!.handleInput("x");
    c.created[0]!.handleInput("\r"); // submit beats the pending interrupt
    const result = await pending;
    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers.Q.selected).toEqual(["A"]);
    expect(h.session!.closed).toEqual(["tui", "answered"]);
    h.clock.advance(60_000); // nothing left to fire
    await flush();
    expect(doneCalls).toBe(1);
  });
});

describe("4. re-ask dwell", () => {
  it("does not interrupt a re-asked dialog before mountedAt + reaskDwellMs", async () => {
    const h = createBgHarness();
    // First round: interrupt once so the question is parked.
    const first = tuiContext();
    const p1 = h.tool.execute("one", PARAMS, undefined, undefined, first.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    await p1; // t=1000, interrupts=1
    // Second round (same question → re-ask): mounted at t=1000.
    const second = tuiContext();
    const p2 = h.tool.execute("two", PARAMS, undefined, undefined, second.ctx);
    await flush();
    expect(renderText(second.created[0]!)).toContain("resumed · draft restored");
    h.port.fire(); // t=1000 → windowFire=2000, dwell=1000+10000=11000
    const flag = settleFlag(p2);
    h.clock.advance(10000); // t=11000
    await p2;
    expect(h.clock.t).toBe(11000);
    const result = await p2;
    expect(result.content[0].text).toContain("[interrupt 2/3]");
  });

  it("computeDue implements the §5.2.2 formula and priorities", () => {
    const base = { windowFire: 1000, reaskDwellMs: 10_000, quietMs: 4000, maxDeferMs: 20_000 };
    // queued ask: no activity, no mount → due = windowFire
    expect(computeDue({ ...base, mountedAt: undefined, isReask: false, lastActivityAt: undefined })).toBe(1000);
    // dwell dominates
    expect(computeDue({ ...base, mountedAt: 500, isReask: true, lastActivityAt: 900 })).toBe(10_500);
    // quiet dominates
    expect(computeDue({ ...base, mountedAt: undefined, isReask: false, lastActivityAt: 15_000 })).toBe(19_000);
    // quiet capped by windowFire + maxDefer
    expect(computeDue({ ...base, mountedAt: undefined, isReask: false, lastActivityAt: 19_000 })).toBe(21_000);
    // maxDeferMs = 0 → no activity postponement at all
    expect(computeDue({ ...base, maxDeferMs: 0, mountedAt: undefined, isReask: false, lastActivityAt: 900 })).toBe(
      1000,
    );
  });
});

describe("5. parameters", () => {
  it("parses per field with fallback for NaN / non-integer / out-of-range / wrong type", () => {
    const d = DEFAULT_INTERRUPT_SETTINGS;
    expect(normalizeInterruptSettings(undefined)).toEqual(d);
    expect(normalizeInterruptSettings({})).toEqual(d);
    expect(normalizeInterruptSettings({ delayMs: 0 })).toEqual({ ...d, delayMs: 0 });
    expect(normalizeInterruptSettings({ delayMs: 10_000 })).toEqual({ ...d, delayMs: 10_000 });
    expect(normalizeInterruptSettings({ delayMs: 10_001 }).delayMs).toBe(d.delayMs);
    expect(normalizeInterruptSettings({ delayMs: -1 }).delayMs).toBe(d.delayMs);
    expect(normalizeInterruptSettings({ delayMs: 1.5 }).delayMs).toBe(d.delayMs);
    expect(normalizeInterruptSettings({ delayMs: Number.NaN }).delayMs).toBe(d.delayMs);
    expect(normalizeInterruptSettings({ delayMs: "1000" }).delayMs).toBe(d.delayMs);
    expect(normalizeInterruptSettings({ delayMs: Number.POSITIVE_INFINITY }).delayMs).toBe(d.delayMs);
    expect(normalizeInterruptSettings({ quietMs: 30_000 }).quietMs).toBe(30_000);
    expect(normalizeInterruptSettings({ quietMs: 30_001 }).quietMs).toBe(d.quietMs);
    expect(normalizeInterruptSettings({ maxPerQuestion: 0 }).maxPerQuestion).toBe(d.maxPerQuestion);
    expect(normalizeInterruptSettings({ maxPerQuestion: 11 }).maxPerQuestion).toBe(d.maxPerQuestion);
    expect(normalizeInterruptSettings({ maxPerQuestion: 10 }).maxPerQuestion).toBe(10);
    expect(normalizeInterruptSettings({ reaskDwellMs: 60_001 }).reaskDwellMs).toBe(d.reaskDwellMs);
    expect(normalizeInterruptSettings({ enabled: 1 }).enabled).toBe(true);
    expect(normalizeInterruptSettings({ rpc: "yes" }).rpc).toBe(false);
    // A bad field leaves the others parsed.
    expect(normalizeInterruptSettings({ delayMs: Number.NaN, quietMs: 100 }).quietMs).toBe(100);
  });

  it("clamps maxDeferMs up to quietMs, except the explicit 0 (never postpone)", () => {
    expect(normalizeInterruptSettings({ quietMs: 4000, maxDeferMs: 2000 }).maxDeferMs).toBe(4000);
    expect(normalizeInterruptSettings({ quietMs: 4000, maxDeferMs: 0 }).maxDeferMs).toBe(0);
    expect(normalizeInterruptSettings({ maxDeferMs: 120_001 }).maxDeferMs).toBe(DEFAULT_INTERRUPT_SETTINGS.maxDeferMs);
  });

  it("delayMs = 0 interrupts on the next macrotask (setTimeout 0)", async () => {
    const h = createBgHarness({ delayMs: 0 });
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    const flag = settleFlag(pending);
    await flush();
    expect(flag.settled).toBe(false); // not synchronously
    h.clock.advance(0);
    await pending;
    expect(h.clock.t).toBe(0);
  });

  it("quietMs = 0 removes activity protection", async () => {
    const h = createBgHarness({ quietMs: 0 });
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(900);
    c.created[0]!.handleInput("x");
    h.clock.advance(100);
    await pending; // settles at windowFire despite the keystroke
    expect(h.clock.t).toBe(1000);
  });

  it("maxDeferMs = 0 never postpones for activity", async () => {
    const h = createBgHarness({ maxDeferMs: 0 });
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(900);
    c.created[0]!.handleInput("x");
    h.clock.advance(100);
    await pending;
    expect(h.clock.t).toBe(1000);
  });
});

describe("6. a whole batch is interrupted together", () => {
  it("two queued ask_user calls both settle interrupted; the queued one never opens", async () => {
    const h = createBgHarness();
    const c1 = tuiContext();
    const c2 = tuiContext();
    const p1 = h.tool.execute("a", PARAMS, undefined, undefined, c1.ctx);
    const p2 = h.tool.execute(
      "b",
      { questions: [{ question: "Q2", options: [{ label: "C" }, { label: "D" }] }] },
      undefined,
      undefined,
      c2.ctx,
    );
    await flush();
    expect(c1.customCalls).toBe(1);
    expect(c2.customCalls).toBe(0);
    h.port.fire();
    h.clock.advance(1000);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.details.interrupted.kind).toBe("background");
    expect(r2.details.interrupted.kind).toBe("background");
    expect(c2.customCalls).toBe(0); // never presented
    expect(r2.details.interrupted.draftSaved).toBe(false);
    expect(h.port.listeners.size).toBe(0);
    expect(h.clock.pending).toBe(0);
  });
});

describe("7. pre-open deferred check", () => {
  it("defers while pendingTokens > 0, up to DEFER_CAP times per question", async () => {
    const h = createBgHarness();
    h.port.tokens = 2;
    for (let attempt = 1; attempt <= DEFER_CAP; attempt++) {
      const c = tuiContext();
      const result = await h.tool.execute(`d${attempt}`, PARAMS, undefined, undefined, c.ctx);
      expect(c.customCalls).toBe(0); // dialog never opened
      expect(result.details.cancelled).toBe(true);
      expect(result.details.interrupted.kind).toBe("deferred");
      expect(result.details.interrupted.attempt).toBe(attempt);
      expect(result.details.interrupted.limit).toBe(DEFER_CAP);
      expect(result.content[0].text).toContain("2 background completion notice(s)");
      expect(h.session!.closed).toEqual(["background", "aborted"]);
    }
    // 4th call: deferral cap reached → the dialog shows (blocking like today).
    const c4 = tuiContext();
    const p4 = h.tool.execute("d4", PARAMS, undefined, undefined, c4.ctx);
    await flush();
    expect(c4.customCalls).toBe(1);
    c4.created[0]!.handleInput("\r");
    const r4 = await p4;
    expect(r4.details.answers.Q.selected).toEqual(["A"]);
  });

  it("does not defer when pendingTokens() is 0", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    expect(c.customCalls).toBe(1);
    c.created[0]!.handleInput("\r");
    await pending;
  });
});

describe("9. interrupt budget (accepted degradation)", () => {
  it("the 4th interrupt attempt blocks like today, shows 'answer to continue', and an answer resets the budget", async () => {
    const h = createBgHarness();
    for (let round = 1; round <= 3; round++) {
      const c = tuiContext();
      const pending = h.tool.execute(`r${round}`, PARAMS, undefined, undefined, c.ctx);
      await flush();
      h.port.fire();
      h.clock.advance(11_000); // covers the re-ask dwell from round 2 on
      const result = await pending;
      expect(result.content[0].text).toContain(`[interrupt ${round}/3]`);
    }
    // Round 4: budget exhausted → no interrupt, no timer, blocking dialog with the notice.
    const c4 = tuiContext();
    const p4 = h.tool.execute("r4", PARAMS, undefined, undefined, c4.ctx);
    await flush();
    h.port.fire();
    const flag = settleFlag(p4);
    h.clock.advance(120_000);
    await flush();
    expect(flag.settled).toBe(false);
    expect(renderText(c4.created[0]!)).toContain("⏸ 1 bg done · answer to continue");
    // The user answers; the budget resets (parked entries resolved).
    c4.created[0]!.handleInput("\r");
    const r4 = await p4;
    expect(r4.details.answers.Q.selected).toEqual(["A"]);
    const last = h.appended[h.appended.length - 1]!.data as { items: unknown[] };
    expect(last.items).toEqual([]);
    // And the next round is interruptible again.
    const c5 = tuiContext();
    const p5 = h.tool.execute("r5", PARAMS, undefined, undefined, c5.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    const r5 = await p5;
    expect(r5.content[0].text).toContain("[interrupt 1/3]");
  });
});

describe("10. in-dialog notices", () => {
  it("shows 'pausing when idle' while waiting, with the running count", async () => {
    const h = createBgHarness();
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    expect(renderText(c.created[0]!)).toContain("⏸ 1 bg done · pausing when idle");
    h.port.fire();
    expect(renderText(c.created[0]!)).toContain("⏸ 2 bg done · pausing when idle");
    h.clock.advance(1000);
    await pending;
  });

  it("restores the draft and shows the resumed marker on re-ask", async () => {
    const h = createBgHarness();
    const first = tuiContext();
    const p1 = h.tool.execute("one", PARAMS, undefined, undefined, first.ctx);
    await flush();
    first.created[0]!.handleInput("\x1b[B"); // cursor onto option B (also starts the quiet period)
    const snapshotBefore = first.created[0]!.snapshotDraft();
    h.port.fire();
    h.clock.advance(4000); // quiet period after the keystroke, then the interrupt lands
    const r1 = await p1;
    expect(r1.details.interrupted.draftSaved).toBe(true);
    // Re-ask: same questions → draft restored, marker as the first content line.
    const second = tuiContext();
    const p2 = h.tool.execute("two", PARAMS, undefined, undefined, second.ctx);
    await flush();
    const rendered = second.created[0]!.render(100);
    expect(rendered[1]).toContain("resumed · draft restored");
    expect(second.created[0]!.snapshotDraft()).toEqual(snapshotBefore);
    second.created[0]!.handleInput("\r"); // submits the restored cursor position (B)
    const r2 = await p2;
    expect(r2.details.answers.Q.selected).toEqual(["B"]);
  });

  it("setNotice(undefined) keeps render output byte-identical to the legacy component", () => {
    const results: unknown[] = [];
    const component = new AskUserComponent([singleQ], mockTui, stubTheme, (result) => results.push(result));
    const baseline = component.render(100);
    component.setNotice(undefined); // no-op
    expect(component.render(100)).toEqual(baseline);
    component.setNotice("⏸ 1 bg done · pausing when idle");
    expect(component.render(100)).not.toEqual(baseline);
    component.setNotice(undefined);
    expect(component.render(100)).toEqual(baseline);
    expect(results).toEqual([]);
  });
});

describe("RPC opt-in (backgroundInterrupt.rpc = true)", () => {
  function rpcCtx(onSignal: (signal: AbortSignal | undefined) => void) {
    let resolveSelect!: (value: string | undefined) => void;
    const ctx = {
      mode: "rpc" as const,
      hasUI: true,
      ui: {
        select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
          onSignal(opts?.signal);
          return new Promise<string | undefined>((resolve) => {
            resolveSelect = resolve;
            opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          });
        },
      },
    };
    return {
      ctx,
      resolve: (value: string | undefined) => resolveSelect(value),
    };
  }

  it("interrupts an in-flight RPC dialog via localAbort", async () => {
    const h = createBgHarness({ rpc: true });
    const rpc = rpcCtx(() => undefined);
    const pending = h.tool.execute("call", PARAMS, undefined, undefined, rpc.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    const result = await pending;
    expect(result.details.interrupted.kind).toBe("background");
    expect(result.content[0].text).toContain("[interrupt 1/3]");
    expect(h.session!.closed).toEqual(["background", "aborted"]);
  });

  it("applies the deferred check before the RPC select", async () => {
    const h = createBgHarness({ rpc: true });
    h.port.tokens = 1;
    let selectCalled = false;
    const rpc = rpcCtx(() => {
      selectCalled = true;
    });
    const result = await h.tool.execute("call", PARAMS, undefined, undefined, rpc.ctx);
    expect(selectCalled).toBe(false);
    expect(result.details.interrupted.kind).toBe("deferred");
    expect(h.session!.closed).toEqual(["background", "aborted"]);
  });
});

describe("ask_user inline status texts keep wide-risk glyphs clear (emoji-terminal overlap)", () => {
  it("every ⏸-bearing marker is followed by a space or ends the line", async () => {
    const { findGlyphCollisions } = await import("../../src/ui/fleet-widget.js");
    const mod = await import("../../src/ask-user/interrupt.js");
    for (const text of [
      mod.parkedStatusText(1),
      mod.parkedStatusText(12),
      mod.pauseNoticeText(3),
      mod.exhaustedNoticeText(3),
      mod.INTERRUPTED_RENDER_TEXT,
    ]) {
      expect(findGlyphCollisions(text), text).toEqual([]);
    }
    expect(mod.parkedStatusText(1)).toBe("ask⏸ 1");
  });
});
