// @vitest-environment happy-dom
/**
 * preview-perf P5 (plan r3 §5.3) — `highlight-core`'s VIRTUAL highlight entry
 * (`createVirtualHighlighter`): worker-first with the widened gate, sticky/timeout fallback to
 * §5.1's ORIGINAL-gate idle main-thread path (real Prism loads through `loadPrism()` — the
 * same dynamic chunk the component tests use), epoch invalidation on text change, and dispose
 * cancelling pending work. The worker client is a controllable fake; the fallback leg runs the
 * real engine.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createVirtualHighlighter,
  type VirtualHighlighter,
} from "../../../src/web-hub/ui/src/components/shared/highlight-core.js";
import type { HighlightSpans } from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";
import { decodeHighlightSpans } from "../../../src/web-hub/ui/src/logic/highlight.js";
import type {
  HighlightWorkerClient,
  HighlightWorkerHandle,
  HighlightWorkerOutcome,
} from "../../../src/web-hub/ui/src/components/shared/highlight-worker-client.js";

interface FakeReq {
  readonly text: string;
  readonly lang: string;
  cancelled: boolean;
  resolve(outcome: HighlightWorkerOutcome): void;
}

interface FakeClient {
  readonly client: HighlightWorkerClient;
  readonly reqs: FakeReq[];
}

function fakeClient(): FakeClient {
  const reqs: FakeReq[] = [];
  const client: HighlightWorkerClient = {
    unavailable: false,
    request(text: string, lang: string): HighlightWorkerHandle {
      let resolveFn!: (o: HighlightWorkerOutcome) => void;
      const result = new Promise<HighlightWorkerOutcome>((res) => {
        resolveFn = res;
      });
      const req: FakeReq = {
        text,
        lang,
        cancelled: false,
        resolve: resolveFn,
      };
      reqs.push(req);
      return {
        result,
        cancel: (): void => {
          req.cancelled = true;
          resolveFn({ status: "cancelled" });
        },
      };
    },
  };
  return { client, reqs };
}

function settledClient(outcome: HighlightWorkerOutcome): HighlightWorkerClient {
  return {
    unavailable: outcome.status === "fallback",
    request: (): HighlightWorkerHandle => ({ result: Promise.resolve(outcome), cancel: (): void => undefined }),
  };
}

const TS = "const answer = 42; // comment\n";
const goodSpans: HighlightSpans = { classes: ["tok-keyword"], spans: new Uint32Array([0, 5, 0]) };

interface Harness {
  readonly highlighter: VirtualHighlighter;
  readonly applied: HighlightSpans[];
  setText(t: string): void;
  setLang(l: string | null): void;
}

function harness(
  deps: Partial<Parameters<typeof createVirtualHighlighter>[0]> & { workerClient: HighlightWorkerClient },
): Harness {
  let text = TS;
  let lang: string | null = "typescript";
  const applied: HighlightSpans[] = [];
  const highlighter = createVirtualHighlighter({
    text: () => text,
    lang: () => lang,
    active: () => true,
    apply: (spans) => applied.push(spans),
    busy: () => false,
    ...deps,
  });
  return {
    highlighter,
    applied,
    setText: (t) => {
      text = t;
    },
    setLang: (l) => {
      lang = l;
    },
  };
}

describe("createVirtualHighlighter (P5 §5.3 — highlight-core virtual entry)", () => {
  it("worker path: requests under the WIDENED gate and applies the arriving spans directly", async () => {
    const fake = fakeClient();
    const h = harness({ workerClient: fake.client });
    h.highlighter.schedule();
    expect(fake.reqs).toHaveLength(1);
    expect(fake.reqs[0]!.lang).toBe("typescript");
    fake.reqs[0]!.resolve({ status: "spans", spans: goodSpans });
    await vi.waitFor(() => {
      expect(h.applied).toEqual([goodSpans]);
    });
  });

  it("the widened gate really is wider: ~104 KiB (over BOTH §5.1 gates) is still requested", async () => {
    const fake = fakeClient();
    const h = harness({ workerClient: fake.client });
    h.setText(`${"const x = 1;\n".repeat(8_000)}`); // 104 000 B / 8 000 lines — over 100 KiB AND 3 000 lines
    h.highlighter.schedule();
    expect(fake.reqs).toHaveLength(1);
    fake.reqs[0]!.resolve({ status: "spans", spans: goodSpans });
    await vi.waitFor(() => {
      expect(h.applied).toHaveLength(1);
    });
  });

  it("over 256 KiB: no request at all — the fallback would reject it too (plain stands)", () => {
    const fake = fakeClient();
    const h = harness({ workerClient: fake.client });
    h.setText("a".repeat(256 * 1024 + 1));
    h.highlighter.schedule();
    expect(fake.reqs).toHaveLength(0);
    expect(h.applied).toHaveLength(0);
  });

  it("lang null / inactive: nothing is requested", () => {
    const fake = fakeClient();
    const h = harness({ workerClient: fake.client });
    h.setLang(null);
    h.highlighter.schedule();
    const h2 = harness({ workerClient: fake.client, active: () => false });
    h2.highlighter.schedule();
    expect(fake.reqs).toHaveLength(0);
  });

  it("worker timeout/‘fallback’ outcome ⇒ §5.1 main-thread path with the ORIGINAL gates (real Prism)", async () => {
    const h = harness({ workerClient: settledClient({ status: "fallback" }) });
    h.highlighter.schedule();
    await vi.waitFor(
      () => {
        expect(h.applied.length).toBeGreaterThan(0);
      },
      { timeout: 4_000, interval: 20 },
    );
    // the applied spans really came from the real engine (decode ⇒ a tok-keyword part)
    const parts = decodeHighlightSpans(h.applied[0]!, TS, 0, TS.length);
    expect(parts?.some((p) => p.cls.includes("tok-keyword"))).toBe(true);
  });

  it("fallback keeps the ORIGINAL byte gate: ~104 KiB stays plain (no request, no apply)", async () => {
    const h = harness({ workerClient: settledClient({ status: "fallback" }) });
    h.setText(`${"const x = 1;\n".repeat(8_000)}`); // 104 000 B > 100 KiB ⇒ §5.1 rejects ⇒ plain
    h.highlighter.schedule();
    // give the idle scheduler every chance to (wrongly) tokenize
    await new Promise((r) => setTimeout(r, 200));
    expect(h.applied).toHaveLength(0);
  });

  it("‘plain’ outcome: the file stays plain — NO main-thread retry", async () => {
    const fake = fakeClient();
    const h = harness({ workerClient: fake.client });
    h.highlighter.schedule();
    fake.reqs[0]!.resolve({ status: "plain" });
    await new Promise((r) => setTimeout(r, 200));
    expect(h.applied).toHaveLength(0);
    expect(fake.reqs).toHaveLength(1); // exactly one worker request, no fallback roundtrips
  });

  it("epoch 作废: re-scheduling drops the pending result for the OLD text", async () => {
    const fake = fakeClient();
    const h = harness({ workerClient: fake.client });
    h.highlighter.schedule();
    const first = fake.reqs[0]!;
    expect(first.cancelled).toBe(false);
    h.setText("const second = 2;\n");
    h.highlighter.schedule(); // bumps the epoch — cancels the first request
    expect(first.cancelled).toBe(true);
    first.resolve({ status: "spans", spans: goodSpans }); // a late reply anyway
    const second = fake.reqs[1]!;
    second.resolve({ status: "spans", spans: goodSpans });
    await vi.waitFor(() => {
      expect(h.applied).toHaveLength(1); // only the CURRENT epoch's spans applied
    });
  });

  it("invalidate() alone drops pending work (left the virtual path)", async () => {
    const fake = fakeClient();
    const h = harness({ workerClient: fake.client });
    h.highlighter.schedule();
    h.highlighter.invalidate();
    expect(fake.reqs[0]!.cancelled).toBe(true);
    fake.reqs[0]!.resolve({ status: "spans", spans: goodSpans });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.applied).toHaveLength(0);
  });

  it("dispose() (window close) cancels and permanently mutes the highlighter", async () => {
    const fake = fakeClient();
    const h = harness({ workerClient: fake.client });
    h.highlighter.schedule();
    h.highlighter.dispose();
    expect(fake.reqs[0]!.cancelled).toBe(true);
    fake.reqs[0]!.resolve({ status: "spans", spans: goodSpans });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.applied).toHaveLength(0);
    h.highlighter.schedule(); // disposed — a late schedule is a no-op
    expect(fake.reqs).toHaveLength(1);
  });

  it("§5.1 dodge: a busy signal re-queues the main-thread tokenize instead of running it", async () => {
    let busy = true;
    let requeues = 0;
    const deps = {
      workerClient: settledClient({ status: "fallback" }),
      busy: (): boolean => {
        requeues += 1;
        return busy;
      },
    };
    const h = harness(deps);
    h.highlighter.schedule();
    await new Promise((r) => setTimeout(r, 250));
    expect(h.applied).toHaveLength(0); // kept dodging while busy
    expect(requeues).toBeGreaterThan(1); // and it DID re-queue (not silently dropped)
    busy = false;
    await vi.waitFor(
      () => {
        expect(h.applied.length).toBeGreaterThan(0);
      },
      { timeout: 4_000, interval: 20 },
    );
  });
});
