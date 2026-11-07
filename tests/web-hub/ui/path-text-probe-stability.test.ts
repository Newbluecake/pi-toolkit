// @vitest-environment happy-dom
/**
 * web-hub content preview — #49 (2026-11-07): PathText link stability under probe-LRU churn
 * (round4 evidence: /tmp/pi-previews/subagent-jitter/round4-report.md — a shared path flips
 * ref→plain→ref ~333 ms once >256 distinct probe candidates cross the store's global LRU).
 *
 * Everything here is the REAL stack: the real `PathText` component, the real
 * `usePreviewProbe` composable (effect-scoped), the real cap-256 `PreviewProbeStore` LRU and
 * the real `findPathRefs` recognition — ONLY the probe transport is mocked (deferred
 * promises; no fs, no network, no model, no timers). The churn producer mirrors round4's
 * mechanism: sibling mounted PathText instances settling batches of fresh distinct absolute
 * paths through the SAME scope, exactly what an open subagent run's transcript does to the
 * main transcript's shared cache.
 */
import { mount } from "@vue/test-utils";
import { effectScope, nextTick, ref, type Ref } from "vue";
import { describe, expect, it } from "vitest";
import {
  PATH_REFERENCES_SUSPENDED,
  PREVIEW_CTX,
  type PreviewContext,
} from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import PathText from "../../../src/web-hub/ui/src/components/preview/PathText.vue";
import { usePreviewProbe, type PreviewProbeHandle } from "../../../src/web-hub/ui/src/composables/usePreviewProbe.js";
import { PROBE_LRU_CAP } from "../../../src/web-hub/ui/src/logic/previewProbe.js";
import type { PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";

const SCOPE: PreviewPathScope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true };
/** The shared-path stand-in (round4's `/tmp/project/SHARED-churn-target.md`). */
const T = "/p/keep/me.md";

type Kind = "text" | "image" | "dir" | "file" | "missing";
type ProbeCall = { agentKey: string; sessionId: string; paths: string[]; dirs?: true; files?: true };

interface ProbeRig {
  handle: PreviewHandle;
  probeHandle: PreviewProbeHandle;
  calls: ProbeCall[];
  answerOldest(kind: Kind | Kind[]): void;
  answerAllWith(kind: Kind): void;
  failOldest(err: string): void;
  flush(): void;
  pending(): boolean;
  stop(): void;
}

/** The REAL controller (usePreviewProbe, default cap-256 store) + manual flush scheduler +
 * deferred recording transport — the same shape as preview-probe-path-text.test.ts's rig. */
function rig(scopeRef: Ref<PreviewPathScope | null> = ref<PreviewPathScope | null>(SCOPE)): ProbeRig {
  const calls: ProbeCall[] = [];
  const waiting: Array<{ resolve: (o: unknown) => void }> = [];
  const probeFn = (req: ProbeCall): Promise<unknown> => {
    calls.push(req);
    return new Promise((resolve) => waiting.push({ resolve }));
  };
  let flushFn: (() => void) | null = null;
  const sched = (fn: () => void): (() => void) => {
    flushFn = fn;
    return () => {
      flushFn = null;
    };
  };
  const es = effectScope();
  const probeHandle = es.run(() => usePreviewProbe({ probe: probeFn as never, scope: scopeRef, schedule: sched }))!;
  const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
  const handle: PreviewHandle = {
    view,
    scope: scopeRef,
    open: () => {},
    close: () => {},
    retry: () => {},
    dispose: () => {},
    probe: probeHandle,
  };
  let answered = 0;
  return {
    handle,
    probeHandle,
    calls,
    /** Answer the OLDEST unanswered call; a single kind is fanned out to the call's real
     * path count (a per-path array must match its call's length by construction). */
    answerOldest(kind: Kind | Kind[]): void {
      const call = calls[answered++];
      if (call === undefined) throw new Error("answerOldest: no unanswered call");
      const kinds = (Array.isArray(kind) ? kind : call.paths.map(() => kind)) as Kind[];
      if (kinds.length !== call.paths.length)
        throw new Error(`answerOldest: ${kinds.length} kinds for ${call.paths.length} paths`);
      waiting.shift()?.resolve({ ok: true, results: kinds });
    },
    answerAllWith(kind) {
      while (answered < calls.length) {
        const call = calls[answered++];
        waiting.shift()?.resolve({ ok: true, results: call.paths.map(() => kind) });
      }
    },
    failOldest(err) {
      answered = Math.min(answered + 1, calls.length);
      waiting.shift()?.resolve({ ok: false, status: 503, error: err });
    },
    flush: () => {
      const f = flushFn;
      flushFn = null;
      f?.();
    },
    pending: () => flushFn !== null,
    stop: () => es.stop(),
  };
}

function mountText(
  r: ProbeRig,
  props: { text: string; code?: boolean; noRefs?: boolean },
  provides: Record<string, unknown> = {},
): ReturnType<typeof mount> {
  const ctx: PreviewContext = { handle: r.handle, plaintext: false };
  return mount(PathText, {
    props,
    global: { provide: { [PREVIEW_CTX as symbol]: ctx, ...provides } },
  });
}

/** round4's churn condition: sibling mounted messages, each settling PREVIEW_MAX_REFS_PER_NODE
 * (100)-respecting batches of fresh distinct absolute paths through the same scope — enough
 * total to cross the store's global 256-entry LRU and evict an older confirmed entry. */
const CHURN_PRODUCERS = 7;
const CHURN_PER_PRODUCER = 90;
function churnText(producer: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `/p/churn-${producer}-${i}.md`).join(" ");
}
function mountChurn(r: ProbeRig): ReturnType<typeof mount>[] {
  return Array.from({ length: CHURN_PRODUCERS }, (_, p) => mountText(r, { text: churnText(p, CHURN_PER_PRODUCER) }));
}
/** Evict everything older via the churn producers and settle them — leaves the rig parked
 * (all churn calls answered) and the target's store entry gone (undefined). Returns the
 * producer mounts so a test can unmount them before a scope flip (a flip re-ensures every
 * STILL-MOUNTED instance's candidates into the new partition — existing behavior). */
async function churnEvict(r: ProbeRig): Promise<ReturnType<typeof mount>[]> {
  const mounts = mountChurn(r);
  expect(CHURN_PRODUCERS * CHURN_PER_PRODUCER).toBeGreaterThan(PROBE_LRU_CAP);
  r.flush();
  r.answerAllWith("text");
  await settleTick();
  return mounts;
}

async function settleTick(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

describe("PathText × probe — #49 LRU-eviction link stability (local retention)", () => {
  it("a mounted confirmed link survives >cap churn with zero extra probe traffic", async () => {
    const r = rig();
    const w = mountText(r, { text: `see ${T} for details` });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    expect(w.get(".path-ref").text()).toBe(T);

    await churnEvict(r);
    // the store REALLY evicted the entry (memory event)…
    expect(r.probeHandle.stateOf(T)).toBeUndefined();
    // …yet the already-mounted link stays — and no re-probe was ever sent for it
    expect(w.get(".path-ref").text()).toBe(T);
    expect(r.calls.filter((c) => c.paths.includes(T))).toHaveLength(1);
    // 1 target + the churn's wire batches (planProbeBatches caps at 100 paths per batch)
    expect(r.calls).toHaveLength(1 + Math.ceil((CHURN_PRODUCERS * CHURN_PER_PRODUCER) / 100));
    w.unmount();
    r.stop();
  });

  it("re-ensure goes pending ⇒ the link HOLDS through the probe (no flip), then the fresh answer decides", async () => {
    const r = rig();
    const w = mountText(r, { text: `see ${T} now` });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    await churnEvict(r);
    expect(w.get(".path-ref").text()).toBe(T);

    await w.setProps({ text: `again ${T} here` }); // candidates changed ⇒ re-ensure
    r.flush();
    await settleTick();
    // pending re-probe in flight — the retention keeps the rendered link stable…
    expect(r.probeHandle.stateOf(T)).toBe("pending");
    expect(w.get(".path-ref").text()).toBe(T);
    r.answerOldest(["text"]);
    await settleTick();
    expect(w.get(".path-ref").text()).toBe(T); // re-confirmed
    expect(r.calls.filter((c) => c.paths.includes(T))).toHaveLength(2);
    w.unmount();
    r.stop();
  });

  it("an explicit missing answer revokes the retained link (existing degrade policy wins)", async () => {
    const r = rig();
    const w = mountText(r, { text: `see ${T} now` });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    await churnEvict(r);
    expect(w.get(".path-ref").exists()).toBe(true);

    await w.setProps({ text: `once more ${T}` });
    r.flush();
    await settleTick();
    expect(w.get(".path-ref").exists()).toBe(true); // pending: held by the local positive
    r.answerOldest(["missing"]);
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // missing ⇒ plain, positive revoked
    expect(w.text()).toContain(T);
    w.unmount();
    r.stop();
  });

  it("a failed re-probe request revokes the retained link the same way", async () => {
    const r = rig();
    const w = mountText(r, { text: `see ${T} now` });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    await churnEvict(r);
    expect(w.get(".path-ref").exists()).toBe(true);

    await w.setProps({ text: `retry ${T}` });
    r.flush();
    await settleTick();
    expect(w.get(".path-ref").exists()).toBe(true);
    r.failOldest("E_BUSY");
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // failed batch ⇒ plain
    w.unmount();
    r.stop();
  });

  it("a scope switch drops the retention; an OLD-scope answer never marks the current scope", async () => {
    const scopeRef = ref<PreviewPathScope | null>(SCOPE);
    const r = rig(scopeRef);
    const w = mountText(r, { text: `at ${T} now` });
    r.flush(); // the s1 request is parked (transport deferred)
    scopeRef.value = { ...SCOPE, sessionId: "s2" }; // switch BEFORE the answer lands
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // no carryover into the new scope

    r.answerOldest(["text"]); // the parked s1 request settles confirmed — into the OLD partition
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // an old-scope answer cannot mark s2

    r.flush(); // the switch re-queued ensure under s2
    await settleTick();
    expect(r.calls.at(-1)?.sessionId).toBe("s2");
    r.answerOldest(["missing"]);
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false);

    scopeRef.value = SCOPE; // back to s1 — whose partition IS confirmed (current authority)
    await settleTick();
    expect(w.get(".path-ref").text()).toBe(T);
    expect(r.calls).toHaveLength(2); // no extra request: s1's confirmed entry was only touched
    w.unmount();
    r.stop();
  });

  it("a capability flip (dirs) is an authority change: retention drops until re-probed", async () => {
    const scopeRef = ref<PreviewPathScope | null>(SCOPE);
    const r = rig(scopeRef);
    const w = mountText(r, { text: `see ${T} now` });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    const producers = await churnEvict(r);
    expect(w.get(".path-ref").exists()).toBe(true); // held by the local positive only
    for (const p of producers) p.unmount(); // isolate the flip's re-ensure to [T] alone

    scopeRef.value = { ...SCOPE, dirs: true }; // scopeKeyOf gains |dir ⇒ new store partition
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // local state cleared synchronously
    r.flush(); // the flip re-ensures the mounted candidates (existing behavior)
    await settleTick();
    const flipCall = r.calls[1 + Math.ceil((CHURN_PRODUCERS * CHURN_PER_PRODUCER) / 100)];
    expect(flipCall?.paths).toEqual([T]);
    expect(flipCall?.dirs).toBe(true);
    r.answerOldest("text");
    await settleTick();
    expect(w.get(".path-ref").text()).toBe(T); // re-derived from the CURRENT authority only
    w.unmount();
    r.stop();
  });

  it("noRefs / streaming suppression clears retention with the bare-text DOM; return re-derives without a storm", async () => {
    const r = rig();
    const suspended = ref(false);
    const w = mountText(r, { text: `see ${T} now` }, { [PATH_REFERENCES_SUSPENDED as symbol]: suspended });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    expect(w.get(".path-ref").exists()).toBe(true);

    suspended.value = true; // §4.6 流式抑制 ⇒ bare text, local retention cleared
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false);
    expect(w.element.children).toHaveLength(0);
    expect(w.text()).toBe(`see ${T} now`);

    suspended.value = false; // settle ⇒ re-scan (existing behavior), store still confirmed
    await settleTick();
    expect(w.get(".path-ref").text()).toBe(T);
    expect(r.calls).toHaveLength(1); // markPending skipped the confirmed entry — no re-request

    await w.setProps({ text: `see ${T} now`, noRefs: true }); // setProps merges — explicit flag
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false);
    expect(w.element.children).toHaveLength(0);
    await w.setProps({ text: `see ${T} now`, noRefs: false });
    await settleTick();
    expect(w.get(".path-ref").text()).toBe(T);
    expect(r.calls).toHaveLength(1); // still zero probe storm across both suppressions
    w.unmount();
    r.stop();
  });

  it("suppression after eviction: no local carryover back — plain until the CURRENT probe re-confirms", async () => {
    const r = rig();
    const suspended = ref(false);
    const w = mountText(r, { text: `see ${T} now` }, { [PATH_REFERENCES_SUSPENDED as symbol]: suspended });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    await churnEvict(r); // store entry gone; the link is held by the LOCAL positive only
    expect(w.get(".path-ref").exists()).toBe(true);

    suspended.value = true; // suppress ⇒ local cleared with the bare-text DOM
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false);
    suspended.value = false; // return: store still evicted, local gone ⇒ NOT a link again
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // no stale carryover (#49 contract)
    r.flush(); // the return re-queued ensure (existing behavior)
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // pending ⇒ still plain
    r.answerOldest("text");
    await settleTick();
    expect(w.get(".path-ref").text()).toBe(T); // only a CURRENT confirm restores it
    w.unmount();
    r.stop();
  });

  it("a candidate that leaves the text drops its local positive (bounded — no history)", async () => {
    const r = rig();
    const A = "/p/a.md";
    const B = "/p/b.md";
    const w = mountText(r, { text: `a ${A} b ${B}` });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    expect(w.findAll(".path-ref")).toHaveLength(2);
    await churnEvict(r); // both evicted; both links held by their local positives
    expect(w.findAll(".path-ref")).toHaveLength(2);

    await w.setProps({ text: `only ${A}` }); // B leaves the candidate set ⇒ pruned
    r.flush();
    await settleTick();
    expect(w.get(".path-ref").text()).toBe(A); // A: pending re-probe, link held (stability)
    r.answerOldest(["text"]);
    await settleTick();

    await w.setProps({ text: `a ${A} b ${B}` }); // B returns — re-staged pending
    r.flush();
    await settleTick();
    // B is PLAIN while pending: its old positive was pruned with the candidate (had it
    // survived, the retention would wrongly render a link on stale evidence)
    expect(w.findAll(".path-ref")).toHaveLength(1);
    expect(w.get(".path-ref").text()).toBe(A);
    r.answerOldest(["text"]);
    await settleTick();
    expect(w.findAll(".path-ref")).toHaveLength(2);
    w.unmount();
    r.stop();
  });

  it("unmount leaves no residue: a fresh mount under the same handle re-derives from scratch", async () => {
    const r = rig();
    const w = mountText(r, { text: `see ${T} now` });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    await churnEvict(r);
    expect(w.get(".path-ref").exists()).toBe(true); // held by the dying instance's retention
    w.unmount();

    const w2 = mountText(r, { text: `see ${T} now` });
    await settleTick();
    expect(w2.find(".path-ref").exists()).toBe(false); // fresh instance: no carryover, plain
    r.flush();
    await settleTick();
    expect(w2.find(".path-ref").exists()).toBe(false); // still pending — not yet confirmed
    r.answerOldest(["text"]);
    await settleTick();
    expect(w2.get(".path-ref").text()).toBe(T);
    w2.unmount();
    r.stop();
  });

  it("inline-code CJK alternative: the alt link survives eviction; the missing full path never gains one", async () => {
    const r = rig(ref<PreviewPathScope | null>({ ...SCOPE, tilde: true }));
    const w = mountText(r, { text: "~/ai/x下执行", code: true });
    r.flush();
    await settleTick();
    expect(r.calls[0]?.paths).toEqual(["~/ai/x下执行", "~/ai/x"]);
    r.answerOldest(["missing", "dir"]);
    await settleTick();
    // full path missing ⇒ the code element stays plain `md-code`; the CONFIRMED alt renders
    // as the inner `span.path-ref` (the existing alt-split rendering — unchanged by #49)
    expect(w.get("code").classes()).toEqual(["md-code"]);
    expect(w.get("code").text()).toBe("~/ai/x下执行");
    expect(w.get("code .path-ref").text()).toBe("~/ai/x");

    await churnEvict(r);
    expect(r.probeHandle.stateOf("~/ai/x")).toBeUndefined();
    expect(w.get("code .path-ref").text()).toBe("~/ai/x"); // the alt link survives (#49)
    expect(w.get("code").classes()).toEqual(["md-code"]); // …and the full path stays plain
    w.unmount();
    r.stop();
  });

  it("same-VALUE scope object rebuilds (upstream refresh) never clear the retention — flip 0, no storm", async () => {
    // round4 rework rejection (2026-11-07 15:15): the App-level scope ref is rebuilt with
    // IDENTICAL fields on ordinary upstream status refreshes; an authority comparison on a
    // per-evaluation wrapper OBJECT cleared the whole-page retention on every rebuild.
    const scopeRef = ref<PreviewPathScope | null>(SCOPE);
    const r = rig(scopeRef);
    const w = mountText(r, { text: `see ${T} now` });
    r.flush();
    r.answerAllWith("text");
    await settleTick();
    await churnEvict(r); // 630 distinct (>256): store evicted, link held by the LOCAL set only
    expect(r.probeHandle.stateOf(T)).toBeUndefined();
    expect(w.get(".path-ref").exists()).toBe(true);

    for (let i = 0; i < 6; i++) {
      scopeRef.value = { ...SCOPE }; // SAME fields, NEW object — the upstream refresh pattern
      await settleTick();
      expect(w.get(".path-ref").text()).toBe(T); // stable at EVERY step — flip 0
    }
    expect(r.calls.filter((c) => c.paths.includes(T))).toHaveLength(1); // no probe storm

    // a REAL semantic change through the same mechanism still clears synchronously
    scopeRef.value = { ...SCOPE, sessionId: "s2" };
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // no stale carryover across scopes
    w.unmount();
    r.stop();
  });

  it("a replaced probe pipeline (fresh rig/handle) starts from zero authority — no carryover", async () => {
    const r1 = rig();
    const w1 = mountText(r1, { text: `see ${T} now` });
    r1.flush();
    r1.answerAllWith("text");
    await settleTick();
    expect(w1.get(".path-ref").exists()).toBe(true);
    w1.unmount();
    r1.stop();

    const r2 = rig(); // a NEW usePreviewProbe instance + store — nothing shared with r1
    const w2 = mountText(r2, { text: `see ${T} now` });
    await settleTick();
    expect(w2.find(".path-ref").exists()).toBe(false); // fresh authority: plain until ITS probe
    r2.flush();
    r2.answerOldest("text");
    await settleTick();
    expect(w2.get(".path-ref").text()).toBe(T);
    w2.unmount();
    r2.stop();
  });

  it("no ctx / no probe: DOM-equivalence and legacy semantics unchanged (#49 adds no authority)", async () => {
    const bare = mount(PathText, { props: { text: `see ${T} now` } });
    expect(bare.element.children).toHaveLength(0);
    expect(bare.text()).toBe(`see ${T} now`);
    bare.unmount();

    const open = () => {};
    const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
    const handle: PreviewHandle = {
      view,
      scope: ref<PreviewPathScope | null>(SCOPE),
      open,
      close: () => {},
      retry: () => {},
      dispose: () => {},
    }; // no `probe` key at all — the frozen-fake shape
    const legacy = mount(PathText, {
      props: { text: `see ${T} now` },
      global: { provide: { [PREVIEW_CTX as symbol]: { handle, plaintext: false } satisfies PreviewContext } },
    });
    expect(legacy.get(".path-ref").text()).toBe(T); // always clickable, byte-identical legacy
    legacy.unmount();
  });
});
