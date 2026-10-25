// @vitest-environment happy-dom
/**
 * J1 #1 (jank-20kb) — the NON-virtual highlight pipeline through the shared worker:
 * `useHighlightParts` (HighlightedCode / NumberedCode bodies, md fences) now tokenizes in
 * the highlight WORKER after the 150 ms debounce, under the ORIGINAL admission gates
 * (100 KiB / 3000 lines / 20k tokens — the request carries `maxTokens: 20000` so the worker
 * degrades the same files the pre-J1 main-thread path degraded). A `fallback` outcome runs
 * §5.1's idle main-thread path verbatim (real Prism); epoch invalidation drops superseded
 * replies; unmount cancels the pending request.
 *
 * The worker client is a controllable fake injected through the test seam
 * (`setHighlightWorkerClientForTests`); the fallback leg exercises the REAL engine chunk.
 */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HighlightedCode from "../../../src/web-hub/ui/src/components/shared/HighlightedCode.vue";
import NumberedCode from "../../../src/web-hub/ui/src/components/shared/NumberedCode.vue";
import {
  loadPrism,
  setHighlightWorkerClientForTests,
} from "../../../src/web-hub/ui/src/components/shared/highlight-core.js";
import { encodeHighlightSpans } from "../../../src/web-hub/ui/src/logic/highlight.js";
import type { HighlightSpans } from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";
import type {
  HighlightWorkerClient,
  HighlightWorkerHandle,
  HighlightWorkerLike,
  HighlightWorkerOutcome,
} from "../../../src/web-hub/ui/src/components/shared/highlight-worker-client.js";
import { computeWorkerReplyWith } from "../../../src/web-hub/ui/src/components/shared/highlight-worker.js";
import { createHighlightWorkerClient } from "../../../src/web-hub/ui/src/components/shared/highlight-worker-client.js";

interface FakeReq {
  readonly text: string;
  readonly lang: string;
  readonly maxTokens: number | undefined;
  cancelled: boolean;
  resolve(outcome: HighlightWorkerOutcome): void;
}

function fakeClient(): { client: HighlightWorkerClient; reqs: FakeReq[] } {
  const reqs: FakeReq[] = [];
  const client: HighlightWorkerClient = {
    unavailable: false,
    request(text: string, lang: string, opts?: { readonly maxTokens?: number }): HighlightWorkerHandle {
      let resolveFn!: (o: HighlightWorkerOutcome) => void;
      const result = new Promise<HighlightWorkerOutcome>((res) => {
        resolveFn = res;
      });
      const req: FakeReq = { text, lang, maxTokens: opts?.maxTokens, cancelled: false, resolve: resolveFn };
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

/** Real-engine spans for `text` (exactly what the worker would answer). */
async function realSpans(text: string, lang: string): Promise<HighlightSpans> {
  const prism = await loadPrism();
  if (prism === null) throw new Error("engine failed to load under vitest");
  const grammar = prism.languages[lang];
  if (grammar === undefined) throw new Error(`no grammar: ${lang}`);
  const spans = encodeHighlightSpans(
    // small budgets are irrelevant here — the caller keeps texts small
    (await import("../../../src/web-hub/ui/src/logic/highlight.js")).flattenTokens(prism.tokenize(text, grammar))!,
  );
  if (spans === null) throw new Error("encode failed");
  return spans;
}

beforeEach(async () => {
  await loadPrism(); // warm the synchronous engine cache for deterministic timing
});

afterEach(() => {
  setHighlightWorkerClientForTests(null);
  document.body.innerHTML = "";
  if (
    typeof document !== "undefined" &&
    typeof (document as unknown as { selectionchange?: unknown }).selectionchange === "undefined"
  ) {
    // happy-dom: nothing to clean (selection may not exist)
  }
});

const JS = "const answer = 42; // comment\n";

describe("J1 useHighlightParts — worker-first non-virtual pipeline", () => {
  it("debounce (150 ms) → ONE worker request carrying the ORIGINAL 20k token budget", async () => {
    const fake = fakeClient();
    setHighlightWorkerClientForTests(fake.client);
    const w = mount(HighlightedCode, { props: { text: JS, lang: "javascript" }, attachTo: document.body });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.reqs).toHaveLength(0); // still inside the debounce window
    await new Promise((r) => setTimeout(r, 180));
    expect(fake.reqs).toHaveLength(1);
    expect(fake.reqs[0]!.lang).toBe("javascript");
    expect(fake.reqs[0]!.maxTokens).toBe(20_000); // the ORIGINAL budget — degrade parity (J1 choice)
    w.unmount();
  });

  it("spans reply ⇒ parts decode ⇒ highlighted DOM, textContent byte-identical", async () => {
    const fake = fakeClient();
    setHighlightWorkerClientForTests(fake.client);
    const spans = await realSpans(JS, "javascript");
    const w = mount(HighlightedCode, { props: { text: JS, lang: "javascript" }, attachTo: document.body });
    await vi.waitFor(() => {
      expect(fake.reqs).toHaveLength(1);
    });
    fake.reqs[0]!.resolve({ status: "spans", spans });
    await vi.waitFor(() => {
      expect(document.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
    });
    expect(document.body.textContent).toContain(JS);
    expect(document.querySelector("span.tok-comment")).not.toBeNull();
    w.unmount();
  });

  it("NumberedCode rides the same pipeline (per-line split after the decode)", async () => {
    const fake = fakeClient();
    setHighlightWorkerClientForTests(fake.client);
    const spans = await realSpans(JS, "javascript");
    const w = mount(NumberedCode, { props: { text: JS, lang: "javascript" } });
    await vi.waitFor(() => {
      expect(fake.reqs).toHaveLength(1);
    });
    fake.reqs[0]!.resolve({ status: "spans", spans });
    await vi.waitFor(() => {
      expect(w.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
    });
    expect(w.element.querySelectorAll(".pv-line").length).toBe(1); // one logical line (trailing \n swallowed)
    expect(w.element.textContent).toBe(JS);
    w.unmount();
  });

  it("`fallback` outcome ⇒ §5.1 idle main-thread path with the REAL engine (still highlights)", async () => {
    setHighlightWorkerClientForTests({
      unavailable: true,
      request: (): HighlightWorkerHandle => ({
        result: Promise.resolve({ status: "fallback" }),
        cancel: (): void => undefined,
      }),
    });
    const w = mount(HighlightedCode, { props: { text: JS, lang: "javascript" }, attachTo: document.body });
    await vi.waitFor(
      () => {
        expect(document.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
      },
      { timeout: 4_000, interval: 20 },
    );
    expect(document.body.textContent).toContain(JS);
    w.unmount();
  });

  it("`plain` outcome (worker-side budget/grammar degrade) ⇒ stays plain, no fallback roundtrip", async () => {
    const fake = fakeClient();
    setHighlightWorkerClientForTests(fake.client);
    const w = mount(HighlightedCode, { props: { text: JS, lang: "javascript" }, attachTo: document.body });
    await vi.waitFor(() => {
      expect(fake.reqs).toHaveLength(1);
    });
    fake.reqs[0]!.resolve({ status: "plain" });
    await new Promise((r) => setTimeout(r, 400));
    expect(document.querySelectorAll("span[class^='tok-']").length).toBe(0);
    expect(fake.reqs).toHaveLength(1);
    w.unmount();
  });

  it("epoch invalidation: a text change cancels the pending request and drops the late reply", async () => {
    const fake = fakeClient();
    setHighlightWorkerClientForTests(fake.client);
    const spans = await realSpans(JS, "javascript");
    const w = mount(HighlightedCode, { props: { text: JS, lang: "javascript" }, attachTo: document.body });
    await vi.waitFor(() => {
      expect(fake.reqs).toHaveLength(1);
    });
    const first = fake.reqs[0]!;
    await w.setProps({ text: "let second = 2;\n" }); // bumps the epoch — cancels the first request
    expect(first.cancelled).toBe(true);
    first.resolve({ status: "spans", spans }); // a late reply for the OLD text anyway
    await new Promise((r) => setTimeout(r, 60));
    expect(document.querySelectorAll("span[class^='tok-']").length).toBe(0); // dropped — plain until the NEW reply
    // the new request resolves and highlights the NEW text
    await vi.waitFor(() => {
      expect(fake.reqs).toHaveLength(2);
    });
    const secondSpans = await realSpans("let second = 2;\n", "javascript");
    fake.reqs[1]!.resolve({ status: "spans", spans: secondSpans });
    await vi.waitFor(() => {
      expect(document.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
    });
    expect(document.body.textContent).toContain("let second = 2;");
    w.unmount();
  });

  it("unmount cancels the pending worker request outright", async () => {
    const fake = fakeClient();
    setHighlightWorkerClientForTests(fake.client);
    const w = mount(HighlightedCode, { props: { text: JS, lang: "javascript" }, attachTo: document.body });
    await vi.waitFor(() => {
      expect(fake.reqs).toHaveLength(1);
    });
    w.unmount();
    expect(fake.reqs[0]!.cancelled).toBe(true);
  });

  it("over the ORIGINAL byte gate: no request at all (100 KiB admission stands — J1 choice)", async () => {
    const fake = fakeClient();
    setHighlightWorkerClientForTests(fake.client);
    const big = "const x = 1;\n".repeat(9_000); // ~117 KiB > 100 KiB
    const w = mount(HighlightedCode, { props: { text: big, lang: "javascript" }, attachTo: document.body });
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.reqs).toHaveLength(0);
    w.unmount();
  });

  it("null lang ⇒ plain, no request (unchanged)", async () => {
    const fake = fakeClient();
    setHighlightWorkerClientForTests(fake.client);
    const w = mount(HighlightedCode, { props: { text: JS, lang: null }, attachTo: document.body });
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.reqs).toHaveLength(0);
    w.unmount();
  });
});

describe("J1 worker protocol — per-request maxTokens (HighlightWorkerRequest extension)", () => {
  it("computeWorkerReplyWith honors a well-formed maxTokens override", async () => {
    const prism = await loadPrism();
    if (prism === null) throw new Error("engine failed to load");
    // a grammar that explodes into many string nodes: every char its own token via `punc`-
    // heavy JSON? Use a fake engine instead for determinism:
    const fakePrism = {
      languages: { weird: {} },
      tokenize: (): unknown[] => Array.from({ length: 10 }, () => "ab"),
    };
    const over = computeWorkerReplyWith(fakePrism as never, {
      kind: "tokenize",
      id: 1,
      text: "abcdefgh",
      lang: "weird",
      maxTokens: 5,
    });
    expect(over?.reply).toEqual({ kind: "plain", id: 1 }); // 10 nodes > budget 5 ⇒ plain (pre-J1 parity)
    const under = computeWorkerReplyWith(fakePrism as never, {
      kind: "tokenize",
      id: 2,
      text: "abcdefgh",
      lang: "weird",
      maxTokens: 10,
    });
    expect(under?.reply.kind).toBe("spans");
    // absent / invalid budgets keep the worker's own widened default (virtual path unchanged)
    const dflt = computeWorkerReplyWith(fakePrism as never, {
      kind: "tokenize",
      id: 3,
      text: "abcdefgh",
      lang: "weird",
    });
    expect(dflt?.reply.kind).toBe("spans");
    const bad = computeWorkerReplyWith(fakePrism as never, {
      kind: "tokenize",
      id: 4,
      text: "abcdefgh",
      lang: "weird",
      maxTokens: Number.NaN,
    });
    expect(bad?.reply.kind).toBe("spans");
    expect(prism.languages["typescript"]).toBeDefined(); // the real engine rode along, unpolluted
  });

  it("the shared client threads maxTokens into the posted message", () => {
    const posted: unknown[] = [];
    const worker: HighlightWorkerLike = {
      postMessage(message: unknown): void {
        posted.push(message);
      },
      terminate(): void {
        /* nothing */
      },
      addEventListener(): void {
        /* nothing */
      },
    };
    const client = createHighlightWorkerClient({ workerFactory: () => worker });
    client.request("x", "typescript", { maxTokens: 20_000 });
    client.request("y", "typescript");
    expect(posted[0]).toEqual({ kind: "tokenize", id: 1, text: "x", lang: "typescript", maxTokens: 20_000 });
    expect(posted[1]).toEqual({ kind: "tokenize", id: 2, text: "y", lang: "typescript" }); // absent field ⇒ default budget
  });
});
