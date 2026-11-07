// @vitest-environment happy-dom
/**
 * 2026-11-03 transcript-flood fix — the three `highlight-core.ts`/`highlight-worker-client.ts`
 * guards against the sub-agent detail-page freeze (root cause: ~300 history CodeBlocks mount at
 * once, every 150 ms debounce fires into the ONE shared worker's sequential queue, the queue
 * tail outlives the 3 s deadline ⇒ killWorker()+failAllPending() stampedes every request onto
 * the main-thread idle tokenize; the engine chunk's late arrival used to re-fire the watcher
 * and double the flood):
 *
 *  1. in-flight cap: at most HIGHLIGHT_MAX_IN_FLIGHT concurrent worker requests process-wide;
 *     over-cap blocks stay plain (no silent retry when a slot frees — the 2026-11-03 ruling).
 *  2. the request carries `onTimeout: "plain"` — a deadline resolves plain, never the
 *     main-thread fallback (sticky unavailability still falls back, and is EXEMPT from the cap).
 *  3. `prism.value` is no longer a watcher dependency — the engine's late arrival must NOT
 *     dropPending()+re-issue an in-flight worker request.
 *
 * The engine chunk (`highlight-impl.js`) is vi.mock'd behind a manually released gate so test 3
 * controls the exact arrival moment; the fake worker client never talks to a real Worker.
 * Module state (prismPromise / the in-flight counter) is per test FILE, so tests settle every
 * request they start (unmount ⇒ cancel ⇒ resolve) and run in file order: the arrival test goes
 * first while the engine is still pending; later tests run with the engine already resolved.
 */
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import type {
  HighlightWorkerClient,
  HighlightWorkerHandle,
  HighlightWorkerOutcome,
  HighlightWorkerRequestOptions,
} from "../../../src/web-hub/ui/src/components/shared/highlight-worker-client.js";

/* vi.mock factories are hoisted — every shared binding lives in vi.hoisted. */
const hoisted = vi.hoisted(() => {
  const fakePrism = {
    languages: { javascript: {} },
    tokenize: (): unknown[] => [],
  };
  const gate: { promise: Promise<void>; release: () => void } = {
    promise: Promise.resolve(),
    release: (): void => undefined,
  };
  gate.promise = new Promise<void>((r) => {
    gate.release = r;
  });
  return { fakePrism, gate };
});

vi.mock("../../../src/web-hub/ui/src/components/shared/highlight-impl.js", async () => {
  await hoisted.gate.promise;
  return { default: hoisted.fakePrism };
});

import {
  HIGHLIGHT_MAX_IN_FLIGHT,
  useHighlightParts,
} from "../../../src/web-hub/ui/src/components/shared/highlight-core.js";

interface FakeReq {
  readonly text: string;
  readonly lang: string;
  readonly opts: HighlightWorkerRequestOptions | undefined;
  cancelled: boolean;
  settled: boolean;
  resolve(outcome: HighlightWorkerOutcome): void;
}

function fakeClient(overrides?: { readonly unavailable?: boolean }): {
  client: HighlightWorkerClient;
  reqs: FakeReq[];
} {
  const reqs: FakeReq[] = [];
  const client: HighlightWorkerClient = {
    unavailable: overrides?.unavailable === true,
    request(text: string, lang: string, opts?: HighlightWorkerRequestOptions): HighlightWorkerHandle {
      let resolveFn!: (o: HighlightWorkerOutcome) => void;
      const result = new Promise<HighlightWorkerOutcome>((res) => {
        resolveFn = res;
      });
      const req: FakeReq = {
        text,
        lang,
        opts,
        cancelled: false,
        settled: false,
        resolve(outcome: HighlightWorkerOutcome): void {
          req.settled = true;
          resolveFn(outcome);
        },
      };
      reqs.push(req);
      return {
        result,
        cancel: (): void => {
          req.cancelled = true;
          req.resolve({ status: "cancelled" });
        },
      };
    },
  };
  return { client, reqs };
}

/** Mounts a bare probe component riding `useHighlightParts` with the per-call client seam. */
function mountProbe(
  client: HighlightWorkerClient,
  source: { text: string; lang: string | null } = { text: "const a = 1; // probe\n", lang: "javascript" },
): { wrapper: VueWrapper; source: { text: string; lang: string | null } } {
  const reactiveSource = ref(source);
  const Probe = defineComponent({
    setup() {
      const parts = useHighlightParts(() => reactiveSource.value, { workerClient: client });
      return () => h("div", parts.value === null ? "plain" : "hl");
    },
  });
  const wrapper = mount(Probe, { attachTo: document.body });
  return {
    wrapper,
    get source() {
      return reactiveSource.value;
    },
    set source(v: { text: string; lang: string | null }) {
      reactiveSource.value = v;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const mounted: VueWrapper[] = [];

afterEach(async () => {
  // settle everything still in flight so the module-level in-flight counter stays balanced
  for (const w of mounted.splice(0)) w.unmount();
  await nextTick();
  document.body.innerHTML = "";
});

describe("2026-11-03 transcript-flood fix — useHighlightParts guards", () => {
  it("engine arrival does NOT cancel/re-issue the in-flight worker request (flood amplifier removed)", async () => {
    // This test runs first in the file: the mocked engine chunk is still gated, so
    // `prism.value` flips null → engine mid-flight — exactly the old ×2 amplifier trigger.
    const fake = fakeClient();
    const probe = mountProbe(fake.client);
    mounted.push(probe.wrapper);
    await vi.waitFor(() => {
      expect(fake.reqs).toHaveLength(1); // debounce fired, request in flight, engine pending
    });
    hoisted.gate.release(); // the engine chunk lands NOW (old code: dropPending + re-request)
    await sleep(400); // well past a second 150 ms debounce
    expect(fake.reqs).toHaveLength(1); // no re-issue
    expect(fake.reqs[0]!.cancelled).toBe(false); // the in-flight request was not dropped
    // the text/lang watcher still works: a text change re-requests (and cancels the old one)
    probe.source = { text: "let changed = 2;\n", lang: "javascript" };
    await vi.waitFor(() => {
      expect(fake.reqs).toHaveLength(2);
    });
    expect(fake.reqs[0]!.cancelled).toBe(true); // epoch invalidation still works on TEXT changes
    fake.reqs[1]!.resolve({ status: "plain" });
  });

  it("in-flight cap: at most HIGHLIGHT_MAX_IN_FLIGHT worker requests; over-cap blocks stay plain, no silent retry", async () => {
    const fake = fakeClient();
    for (let i = 0; i < 6; i++) {
      mounted.push(mountProbe(fake.client, { text: `const v${i} = ${i};\n`, lang: "javascript" }).wrapper);
    }
    await sleep(250); // all six 150 ms debounces fired
    expect(fake.reqs).toHaveLength(HIGHLIGHT_MAX_IN_FLIGHT);
    expect(HIGHLIGHT_MAX_IN_FLIGHT).toBe(3);
    // the requests carry the ORIGINAL 20k token budget (J1 parity) AND the flood fix's
    // onTimeout:"plain" (a deadline must never stampede the main-thread fallback)
    for (const r of fake.reqs) {
      expect(r.opts?.maxTokens).toBe(20_000);
      expect(r.opts?.onTimeout).toBe("plain");
    }
    // a slot freeing up does NOT retro-highlight the over-cap blocks (the 2026-11-03 ruling:
    // plain stands until the block's own next invalidation)
    fake.reqs[0]!.resolve({ status: "plain" });
    await sleep(250);
    expect(fake.reqs).toHaveLength(HIGHLIGHT_MAX_IN_FLIGHT);
    // a text change on an over-cap block IS a fresh invalidation — it may request again
    fake.reqs.slice(1).forEach((r) => r.resolve({ status: "plain" }));
    await sleep(50);
  });

  it("sticky-dead client (unavailable) is EXEMPT from the cap — the §5.1/K10 main-thread degrade is not strangled", async () => {
    const fake = fakeClient({ unavailable: true });
    // resolve fallback synchronously, mirroring the real client's dead path
    const realRequest = fake.client.request;
    fake.client = {
      unavailable: true,
      request(text: string, lang: string, opts?: HighlightWorkerRequestOptions): HighlightWorkerHandle {
        const h = realRequest(text, lang, opts);
        fake.reqs[fake.reqs.length - 1]!.resolve({ status: "fallback" });
        return h;
      },
    };
    for (let i = 0; i < 5; i++) {
      mounted.push(mountProbe(fake.client, { text: `const w${i} = ${i};\n`, lang: "javascript" }).wrapper);
    }
    await sleep(250);
    expect(fake.reqs).toHaveLength(5); // every block got its (synchronously settled) request
    // the fallback leg scheduled idle main-thread tokenizes — the fake engine tokenizes to []
    // without throwing; nothing highlights (empty parts) and nothing throws.
    await sleep(300);
  });
});
