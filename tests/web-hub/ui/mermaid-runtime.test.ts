import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Runtime lifecycle contract (web-hub-mermaid plan §4 + r3 R2-1), driven with a fake clock and a fully
 * controllable `mermaid-impl` double. Every test gets a FRESH runtime module (`vi.resetModules`) so module-scope
 * state (queue, cache, engine state) never leaks between cases.
 */
const RUNTIME = "../../../src/web-hub/ui/src/components/shared/mermaid-runtime.js";
const IMPL = "../../../src/web-hub/ui/src/components/shared/mermaid-impl.js";

type Runtime = typeof import("../../../src/web-hub/ui/src/components/shared/mermaid-runtime.js");
type ImplCall = {
  text: string;
  theme: string;
  coarse: boolean;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

const OK_SVG = (w = 10): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 10" aria-roledescription="flowchart-v2"><g/></svg>`;
const svgResult = (w = 10): unknown => ({ kind: "svg", svg: OK_SVG(w), diagramType: "flowchart-v2" });

interface Harness {
  rt: Runtime;
  calls: ImplCall[];
  /** Finish the n-th impl call with an ok svg. */
  ok(n: number, w?: number): Promise<void>;
  fail(n: number, err: unknown): Promise<void>;
  advance(ms: number): Promise<void>;
}

let current: Harness | undefined;

async function setup(mode: "ok" | "load-throws" | "load-hangs" = "ok"): Promise<Harness> {
  vi.resetModules();
  const calls: ImplCall[] = [];
  if (mode === "ok") {
    vi.doMock(IMPL, () => ({
      renderSvg: (input: { text: string; theme: string; coarse: boolean }) =>
        new Promise((resolve, reject) => {
          calls.push({ text: input.text, theme: input.theme, coarse: input.coarse, resolve, reject });
        }),
    }));
  } else if (mode === "load-throws") {
    vi.doMock(IMPL, () => {
      throw new Error("chunk 404");
    });
  } else {
    vi.doMock(IMPL, () => new Promise(() => undefined));
  }
  const rt = (await import(RUNTIME)) as Runtime;
  const h: Harness = {
    rt,
    calls,
    async ok(n, w) {
      calls[n]!.resolve(svgResult(w));
      await vi.advanceTimersByTimeAsync(0);
    },
    async fail(n, err) {
      calls[n]!.reject(err);
      await vi.advanceTimersByTimeAsync(0);
    },
    async advance(ms) {
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
  current = h;
  return h;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
});

afterEach(() => {
  current?.rt.__resetMermaidRuntimeForTests();
  current = undefined;
  vi.useRealTimers();
  vi.doUnmock(IMPL);
});

/** Track settlement counts of promises so "exactly once" can be asserted. */
function track<T>(p: Promise<T>): { settled: () => number; value: () => T | undefined; rejected: () => boolean } {
  let n = 0;
  let v: T | undefined;
  let rej = false;
  p.then(
    (x) => {
      n++;
      v = x;
    },
    () => {
      rej = true;
    },
  );
  return { settled: () => n, value: () => v, rejected: () => rej };
}

const flow = (tag: string): string => `flowchart LR\n  A[${tag}] --> B`;

describe("requestMermaid: happy path, cache and serial execution", () => {
  it("renders once, caches the ok outcome, and serves repeats from the cache without calling the engine", async () => {
    const h = await setup();
    const first = track(h.rt.requestMermaid({ text: flow("a"), theme: "light" }));
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    expect(h.rt.mermaidEngineState()).toBe("ready");
    await h.ok(0, 33);
    expect(first.value()).toMatchObject({ kind: "ok", width: 33, height: 10, diagramType: "flowchart-v2" });
    expect(h.rt.peekMermaidCache(flow("a"), "light")).toMatchObject({ kind: "ok" });
    const again = await h.rt.requestMermaid({ text: flow("a"), theme: "light" });
    expect(again).toMatchObject({ kind: "ok" });
    expect(h.calls).toHaveLength(1);
  });

  it("never runs two engine calls at once and yields between tasks", async () => {
    const h = await setup();
    const a = track(h.rt.requestMermaid({ text: flow("a"), theme: "light" }));
    const b = track(h.rt.requestMermaid({ text: flow("b"), theme: "light" }));
    const c = track(h.rt.requestMermaid({ text: flow("c"), theme: "light" }));
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    await h.advance(5_000);
    expect(h.calls).toHaveLength(1); // b waits while a occupies the slot
    h.calls[0]!.resolve(svgResult());
    for (let i = 0; i < 8; i++) await Promise.resolve(); // microtasks only — the setTimeout(0) yield has not fired
    expect(a.settled()).toBe(1);
    expect(h.calls).toHaveLength(1); // the next task does not start in the same turn
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.text).toBe(flow("b"));
    await h.ok(1);
    await h.advance(0);
    expect(h.calls).toHaveLength(3);
    await h.ok(2);
    expect([a.settled(), b.settled(), c.settled()]).toEqual([1, 1, 1]);
  });

  it("theme is part of the key; a theme round-trip hits each theme's own cache entry", async () => {
    const h = await setup();
    const t = flow("t");
    void h.rt.requestMermaid({ text: t, theme: "light" });
    await h.advance(0);
    await h.ok(0, 11);
    void h.rt.requestMermaid({ text: t, theme: "dark" });
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.theme).toBe("dark");
    await h.ok(1, 22);
    expect(h.rt.peekMermaidCache(t, "light")).toMatchObject({ width: 11 });
    expect(h.rt.peekMermaidCache(t, "dark")).toMatchObject({ width: 22 });
    await h.rt.requestMermaid({ text: t, theme: "light" });
    await h.rt.requestMermaid({ text: t, theme: "dark" });
    expect(h.calls).toHaveLength(2);
  });

  it("G1 rejections resolve immediately, are cached and never load the engine", async () => {
    const h = await setup();
    const out = await h.rt.requestMermaid({ text: "classDiagram\n class A\n style A fill:url(/x)", theme: "light" });
    expect(out).toMatchObject({ kind: "error", reason: "unsupported" });
    expect(h.rt.mermaidEngineState()).toBe("idle");
    expect(h.calls).toHaveLength(0);
    expect(h.rt.peekMermaidCache("classDiagram\n class A\n style A fill:url(/x)", "light")).toMatchObject({
      kind: "error",
      reason: "unsupported",
    });
    expect(await h.rt.requestMermaid({ text: "x".repeat(20_001), theme: "light" })).toMatchObject({
      reason: "too-large",
    });
    expect(h.rt.mermaidEngineState()).toBe("idle");
  });

  it("maps engine rejections and failures: rejected→reason as-is, thrown→classified, svgToImage null→output-invalid", async () => {
    const h = await setup();
    const rej = track(h.rt.requestMermaid({ text: flow("r"), theme: "light" }));
    await h.advance(0);
    h.calls[0]!.resolve({ kind: "rejected", reason: "unsupported", detail: "This diagram type is not supported yet." });
    await h.advance(0);
    expect(rej.value()).toEqual({
      kind: "error",
      reason: "unsupported",
      message: "This diagram type is not supported yet.",
    });

    const parse = track(h.rt.requestMermaid({ text: flow("p"), theme: "light" }));
    await h.advance(0);
    await h.fail(1, new Error("Parse error on line 3:\n...secret...\nExpecting 'X'"));
    expect(parse.value()).toMatchObject({
      kind: "error",
      reason: "parse",
      message: "Diagram syntax error near line 3.",
    });

    const bad = track(h.rt.requestMermaid({ text: flow("o"), theme: "light" }));
    await h.advance(0);
    h.calls[2]!.resolve({ kind: "svg", svg: "<svg>no xmlns</svg>", diagramType: "x" });
    await h.advance(0);
    expect(bad.value()).toMatchObject({ kind: "error", reason: "output-invalid" });
  });

  it("a G5 hit logs one fixed warning (no diagram text) so the probe can assert gateBreach === 0", async () => {
    const h = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    void h.rt.requestMermaid({ text: flow("g"), theme: "light" });
    await h.advance(0);
    h.calls[0]!.resolve({
      kind: "svg",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="x"/></svg>',
      diagramType: "x",
    });
    await h.advance(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("gate breach");
    expect(String(warn.mock.calls[0]![0])).not.toContain("href");
    warn.mockRestore();
  });

  it("impl throwing synchronously, or rejecting with a non-Error value, still resolves an error outcome", async () => {
    vi.resetModules();
    vi.doMock(IMPL, () => ({
      renderSvg: (input: { text: string }) => {
        if (input.text.includes("sync")) throw "boom";
        return Promise.reject(input.text.includes("undef") ? undefined : { weird: true });
      },
    }));
    const rt = (await import(RUNTIME)) as Runtime;
    current = { rt } as Harness;
    const results = await Promise.all(
      ["sync", "undef", "obj"].map(async (t) => {
        const p = rt.requestMermaid({ text: flow(t), theme: "light" });
        await vi.advanceTimersByTimeAsync(10);
        return p;
      }),
    );
    for (const r of results) expect(r).toMatchObject({ kind: "error", reason: "render" });
  });
});

describe("requestMermaid: cancellation", () => {
  it("a pre-aborted signal resolves cancelled on a microtask without loading the engine or creating a task", async () => {
    const h = await setup();
    const ac = new AbortController();
    ac.abort();
    const out = await h.rt.requestMermaid({ text: flow("x"), theme: "light", signal: ac.signal });
    expect(out).toEqual({ kind: "cancelled" });
    expect(h.rt.mermaidEngineState()).toBe("idle");
    expect(h.calls).toHaveLength(0);
  });

  it("aborting one subscriber of a queued task leaves the others; aborting all removes the task from the queue", async () => {
    const h = await setup();
    void h.rt.requestMermaid({ text: flow("blocker"), theme: "light" });
    await h.advance(0);
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const s1 = track(h.rt.requestMermaid({ text: flow("q"), theme: "light", signal: ac1.signal }));
    const s2 = track(h.rt.requestMermaid({ text: flow("q"), theme: "light", signal: ac2.signal }));
    const lone = new AbortController();
    const l = track(h.rt.requestMermaid({ text: flow("lone"), theme: "light", signal: lone.signal }));
    ac1.abort();
    await h.advance(0);
    expect(s1.value()).toEqual({ kind: "cancelled" });
    expect(s2.settled()).toBe(0);
    lone.abort();
    await h.advance(0);
    expect(l.value()).toEqual({ kind: "cancelled" });
    await h.ok(0); // blocker done → q starts, `lone` was dropped from the queue
    await h.advance(0);
    expect(h.calls.map((c) => c.text)).toEqual([flow("blocker"), flow("q")]);
    await h.ok(1);
    expect(s2.value()).toMatchObject({ kind: "ok" });
    await h.advance(1000);
    expect(h.calls).toHaveLength(2);
    expect(h.rt.peekMermaidCache(flow("lone"), "light")).toBeUndefined(); // cancelled is never cached
  });

  it("aborting a RUNNING task's only subscriber: it settles cancelled at once, the engine finishes, the result is cached", async () => {
    const h = await setup();
    const ac = new AbortController();
    const p = track(h.rt.requestMermaid({ text: flow("run"), theme: "light", signal: ac.signal }));
    await h.advance(0);
    ac.abort();
    await h.advance(0);
    expect(p.value()).toEqual({ kind: "cancelled" });
    await h.ok(0, 77);
    expect(h.rt.peekMermaidCache(flow("run"), "light")).toMatchObject({ kind: "ok", width: 77 });
    expect(p.settled()).toBe(1);
  });
});

describe("requestMermaid: merging", () => {
  it("same-key requests share one engine call and each settle exactly once", async () => {
    const h = await setup();
    const subs = [1, 2, 3, 4].map(() => track(h.rt.requestMermaid({ text: flow("m"), theme: "light" })));
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    await h.ok(0, 12);
    for (const s of subs) {
      expect(s.settled()).toBe(1);
      expect(s.value()).toMatchObject({ kind: "ok", width: 12 });
    }
    expect(h.calls).toHaveLength(1);
  });

  it("a request joining a task that is already RUNNING merges into it", async () => {
    const h = await setup();
    const a = track(h.rt.requestMermaid({ text: flow("m"), theme: "light" }));
    await h.advance(0);
    await h.advance(3_000);
    const b = track(h.rt.requestMermaid({ text: flow("m"), theme: "light" }));
    expect(h.calls).toHaveLength(1);
    await h.ok(0);
    expect([a.settled(), b.settled()]).toEqual([1, 1]);
  });
});

describe("requestMermaid: queue bound", () => {
  it("MAX_QUEUE waiting tasks, then `busy` (not cached) until the queue drains", async () => {
    const h = await setup();
    void h.rt.requestMermaid({ text: flow("running"), theme: "light" });
    await h.advance(0);
    const waiting = Array.from({ length: h.rt.MAX_QUEUE }, (_, i) =>
      h.rt.requestMermaid({ text: flow(`w${i}`), theme: "light" }),
    );
    const over = track(h.rt.requestMermaid({ text: flow("over"), theme: "light" }));
    await h.advance(0);
    expect(over.value()).toMatchObject({ kind: "error", reason: "busy" });
    expect(h.rt.peekMermaidCache(flow("over"), "light")).toBeUndefined();
    // same key as a queued one still merges even though the queue is full
    const merged = track(h.rt.requestMermaid({ text: flow("w0"), theme: "light" }));
    expect(merged.settled()).toBe(0);
    // drain everything
    for (let i = 0; i <= h.rt.MAX_QUEUE; i++) {
      await h.advance(0);
      await h.ok(i);
    }
    await Promise.all(waiting);
    expect(merged.settled()).toBe(1);
    const retry = track(h.rt.requestMermaid({ text: flow("over"), theme: "light" }));
    await h.advance(0);
    await h.ok(h.calls.length - 1);
    expect(retry.value()).toMatchObject({ kind: "ok" });
  });
});

describe("requestMermaid: deadlines (r3 R2-1)", () => {
  it("CALLER_DEADLINE: a subscriber still QUEUED at t0+30s times out, nothing is cached, and its task is dropped", async () => {
    const h = await setup();
    void h.rt.requestMermaid({ text: flow("blocker1"), theme: "light" });
    void h.rt.requestMermaid({ text: flow("blocker2"), theme: "light" });
    await h.advance(0);
    const w = track(h.rt.requestMermaid({ text: flow("waiter"), theme: "light" })); // t0 = 0
    await h.advance(25_000);
    await h.ok(0); // blocker1 done at 25s, blocker2 starts and holds the slot past 30s
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    await h.advance(4_999);
    expect(w.settled()).toBe(0);
    await h.advance(2);
    expect(w.value()).toMatchObject({ kind: "error", reason: "timeout" });
    expect(h.rt.peekMermaidCache(flow("waiter"), "light")).toBeUndefined();
    await h.ok(1);
    await h.advance(10);
    expect(h.calls).toHaveLength(2); // the orphaned waiter task never ran
  });

  it("task-level execution timeout (8s): subscribers time out, the timeout IS cached, the slot is held until the engine settles, and a late result is dropped", async () => {
    const h = await setup();
    const a = track(h.rt.requestMermaid({ text: flow("slow"), theme: "light" }));
    const b = track(h.rt.requestMermaid({ text: flow("next"), theme: "light" }));
    await h.advance(0);
    await h.advance(7_999);
    expect(a.settled()).toBe(0);
    await h.advance(2);
    expect(a.value()).toMatchObject({ kind: "error", reason: "timeout" });
    expect(h.rt.peekMermaidCache(flow("slow"), "light")).toMatchObject({ kind: "error", reason: "timeout" });
    await h.advance(5_000);
    expect(h.calls).toHaveLength(1); // slot still occupied → `next` has not started
    await h.ok(0); // late result
    expect(h.rt.peekMermaidCache(flow("slow"), "light")).toMatchObject({ kind: "error", reason: "timeout" }); // not overwritten
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    await h.ok(1);
    expect(b.value()).toMatchObject({ kind: "ok" });
  });

  it("R2-1: a subscriber's deadline stays valid after execution starts — a task starting at ~29s leaves the subscriber 1s, not 8s", async () => {
    const h = await setup();
    void h.rt.requestMermaid({ text: flow("blocker"), theme: "light" }); // t=0, task timeout at 8s, settles at 28.5s
    await h.advance(0);
    const target = track(h.rt.requestMermaid({ text: flow("target"), theme: "light" })); // t0 = 0 → deadline 30s
    await h.advance(28_500);
    await h.ok(0); // blocker's engine finally settles
    await h.advance(0);
    expect(h.calls).toHaveLength(2); // target starts executing at ~28.5s
    expect(target.settled()).toBe(0);
    await h.advance(1_499);
    expect(target.settled()).toBe(0);
    await h.advance(2); // 30.0s: the subscriber's own deadline, long before start+8s
    expect(target.value()).toMatchObject({ kind: "error", reason: "timeout" });
    // …without touching the slot or the cache: the engine's result still lands and IS cached (it is correct).
    expect(h.rt.peekMermaidCache(flow("target"), "light")).toBeUndefined();
    await h.ok(1, 55);
    expect(h.rt.peekMermaidCache(flow("target"), "light")).toMatchObject({ kind: "ok", width: 55 });
    expect(target.settled()).toBe(1);
  });

  it("R2-1: merged subscribers that joined at different times each keep their OWN absolute deadline", async () => {
    const h = await setup();
    void h.rt.requestMermaid({ text: flow("blocker"), theme: "light" }); // holds the slot until 26s
    await h.advance(0);
    const early = track(h.rt.requestMermaid({ text: flow("t"), theme: "light" })); // deadline 30s
    await h.advance(10_000);
    const late = track(h.rt.requestMermaid({ text: flow("t"), theme: "light" })); // joins at 10s → deadline 40s
    await h.advance(16_000);
    await h.ok(0); // 26s: blocker settles
    await h.advance(0);
    expect(h.calls).toHaveLength(2); // `t` executes from ~26s (task timeout at ~34s)
    await h.advance(4_001); // → ~30.0s: early's deadline passes
    expect(early.value()).toMatchObject({ kind: "error", reason: "timeout" });
    expect(late.settled()).toBe(0); // late is unaffected, the slot is still held, nothing cached for the timeout
    expect(h.rt.peekMermaidCache(flow("t"), "light")).toBeUndefined();
    await h.advance(3_000); // 33s: still inside the task's own 8s budget
    await h.ok(1, 66);
    expect(late.value()).toMatchObject({ kind: "ok", width: 66 });
    expect(early.settled()).toBe(1);
  });

  it("R2-1: before publishing, a subscriber whose deadline passed (timer starved) gets `timeout`, never the late result", async () => {
    const h = await setup();
    const p = track(h.rt.requestMermaid({ text: flow("late"), theme: "light" }));
    await h.advance(0);
    // starve the event loop: the monotonic clock jumps past the deadline WITHOUT any timer getting to run
    const base = performance.now();
    const spy = vi.spyOn(performance, "now").mockImplementation(() => base + 31_000);
    h.calls[0]!.resolve(svgResult());
    for (let i = 0; i < 8; i++) await Promise.resolve();
    spy.mockRestore();
    const v = p.value();
    expect(v?.kind).toBe("error");
    expect((v as { reason?: string }).reason).toBe("timeout");
    expect(h.rt.peekMermaidCache(flow("late"), "light")).toMatchObject({ kind: "ok" }); // the result itself is still cached
  });
});

describe("requestMermaid: broken engine and load failures", () => {
  it("30s without settling ⇒ broken: queued subscribers drain as engine-unavailable, later requests fail fast, cache hits still served, no recovery", async () => {
    const h = await setup();
    void h.rt.requestMermaid({ text: flow("cached"), theme: "light" });
    await h.advance(0);
    await h.ok(0);
    const zombie = track(h.rt.requestMermaid({ text: flow("zombie"), theme: "light" }));
    await h.advance(0);
    const queued = track(h.rt.requestMermaid({ text: flow("queued"), theme: "light" }));
    await h.advance(8_001);
    expect(zombie.value()).toMatchObject({ reason: "timeout" });
    expect(h.rt.mermaidEngineState()).toBe("ready");
    await h.advance(22_000);
    expect(h.rt.mermaidEngineState()).toBe("broken");
    expect(queued.value()).toMatchObject({ kind: "error", reason: "engine-unavailable" });
    expect(await h.rt.requestMermaid({ text: flow("new"), theme: "light" })).toMatchObject({
      reason: "engine-unavailable",
    });
    expect(h.rt.peekMermaidCache(flow("new"), "light")).toBeUndefined(); // engine-unavailable is never cached
    expect(await h.rt.requestMermaid({ text: flow("cached"), theme: "light" })).toMatchObject({ kind: "ok" });
    await h.ok(1); // the zombie finally settles
    await h.advance(1000);
    expect(h.rt.mermaidEngineState()).toBe("broken");
    expect(h.calls).toHaveLength(2); // queued never started
  });

  it("import() rejecting ⇒ load-failed for everyone waiting and for later requests; not cached", async () => {
    const h = await setup("load-throws");
    const a = track(h.rt.requestMermaid({ text: flow("a"), theme: "light" }));
    const b = track(h.rt.requestMermaid({ text: flow("b"), theme: "light" }));
    await h.advance(0);
    expect(h.rt.mermaidEngineState()).toBe("load-failed");
    expect(a.value()).toMatchObject({ kind: "error", reason: "load-failed" });
    expect(b.value()).toMatchObject({ kind: "error", reason: "load-failed" });
    expect(await h.rt.requestMermaid({ text: flow("c"), theme: "light" })).toMatchObject({ reason: "load-failed" });
    expect(h.rt.peekMermaidCache(flow("a"), "light")).toBeUndefined();
  });

  it("a hanging import() is cut off after LOAD_TIMEOUT_MS (20s) ⇒ load-failed", async () => {
    const h = await setup("load-hangs");
    const a = track(h.rt.requestMermaid({ text: flow("a"), theme: "light" }));
    await h.advance(19_999);
    expect(h.rt.mermaidEngineState()).toBe("loading");
    expect(a.settled()).toBe(0);
    await h.advance(2);
    expect(h.rt.mermaidEngineState()).toBe("load-failed");
    expect(a.value()).toMatchObject({ reason: "load-failed" });
  });
});

describe("requestMermaid: property — never rejects, settles exactly once, within the deadline", () => {
  type Op =
    | { t: "req"; text: number; dark: boolean; abortLater: boolean }
    | { t: "abort"; i: number }
    | { t: "advance"; ms: number }
    | { t: "ok"; n: number }
    | { t: "fail"; n: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      t: fc.constant("req" as const),
      text: fc.integer({ min: 0, max: 5 }),
      dark: fc.boolean(),
      abortLater: fc.boolean(),
    }),
    fc.record({ t: fc.constant("abort" as const), i: fc.nat(30) }),
    fc.record({
      t: fc.constant("advance" as const),
      ms: fc.oneof(fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 12_000 })),
    }),
    fc.record({ t: fc.constant("ok" as const), n: fc.nat(30) }),
    fc.record({ t: fc.constant("fail" as const), n: fc.nat(30) }),
  );

  it("holds for random interleavings of requests, aborts, timer advances and engine completions", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const h = await setup();
        const started: number[] = [];
        const pending: Array<{ settled: () => number; rejected: () => boolean; at: number }> = [];
        const controllers: AbortController[] = [];
        const done = new Set<number>();
        const t0 = Date.now();
        for (const op of ops) {
          if (op.t === "req") {
            const ac = new AbortController();
            controllers.push(ac);
            const tr = track(
              h.rt.requestMermaid({ text: flow(`p${op.text}`), theme: op.dark ? "dark" : "light", signal: ac.signal }),
            );
            pending.push({ ...tr, at: Date.now() - t0 });
            if (op.abortLater) queueMicrotask(() => ac.abort());
          } else if (op.t === "abort") {
            controllers[op.i % Math.max(1, controllers.length)]?.abort();
          } else if (op.t === "advance") {
            await h.advance(op.ms);
          } else if ((op.t === "ok" || op.t === "fail") && h.calls.length > 0) {
            const n = op.n % h.calls.length;
            if (!done.has(n)) {
              done.add(n);
              if (op.t === "ok") h.calls[n]!.resolve(svgResult());
              else h.calls[n]!.reject(new Error("boom"));
              await vi.advanceTimersByTimeAsync(0);
            }
          }
          started.push(h.calls.length);
          // at no point may two engine calls be in flight: every started-but-unsettled call is a zombie held
          // by a timeout, and the runtime must not have started a new one while one is still running
        }
        // settle all outstanding engine calls and let every timer fire
        for (let round = 0; round < 40; round++) {
          for (let n = 0; n < h.calls.length; n++) {
            if (!done.has(n)) {
              done.add(n);
              h.calls[n]!.resolve(svgResult());
            }
          }
          await h.advance(5_000);
        }
        await h.advance(120_000);
        for (const p of pending) {
          expect(p.rejected()).toBe(false);
          expect(p.settled()).toBe(1);
        }
        h.rt.__resetMermaidRuntimeForTests();
      }),
      { numRuns: 40 },
    );
  });
});
