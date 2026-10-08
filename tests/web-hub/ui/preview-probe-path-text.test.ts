// @vitest-environment happy-dom
/**
 * web-hub content preview — PathText × the probe pipeline (web-hub-preview 2026-10-07 修订
 * 「先探测后标记」): a recognized candidate renders PLAIN TEXT until the backend probe
 * confirms it (`pending`/`missing`/`failed` all stay plain); a handle WITHOUT `probe` keeps
 * the legacy always-clickable rendering; a relative candidate is probed by its RESOLVED
 * absolute path; and a whole message's candidates leave in ONE batched request.
 *
 * The probe handle here is the REAL `usePreviewProbe` (effect-scoped) over a manual scheduler
 * + recording transport — the same composable App.vue mounts.
 */
import { mount } from "@vue/test-utils";
import { effectScope, nextTick, ref, type Ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import PathText from "../../../src/web-hub/ui/src/components/preview/PathText.vue";
import TxAssistant from "../../../src/web-hub/ui/src/components/transcript/TxAssistant.vue";
import { usePreviewProbe, type PreviewProbeHandle } from "../../../src/web-hub/ui/src/composables/usePreviewProbe.js";
import type { AssistantView } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type { HubHandle, PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";

const SCOPE: PreviewPathScope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true };

type ProbeCall = { agentKey: string; sessionId: string; paths: string[]; dirs?: true };

interface ProbeRig {
  handle: PreviewHandle;
  probeHandle: PreviewProbeHandle;
  calls: ProbeCall[];
  answer: (kinds: Array<"text" | "image" | "dir" | "missing">) => void;
  failRequest: (err: string) => void;
  flush(): void;
  pending(): boolean;
  stop(): void;
}

/** The REAL controller (usePreviewProbe) with a manual flush scheduler + deferred transport. */
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
  const open = () => {};
  const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
  const handle: PreviewHandle = {
    view,
    scope: scopeRef,
    open,
    close: () => {},
    retry: () => {},
    dispose: () => {},
    probe: probeHandle,
  };
  return {
    handle,
    probeHandle,
    calls,
    answer(kinds) {
      const w = waiting.shift();
      w?.resolve({ ok: true, results: kinds });
    },
    failRequest(err) {
      const w = waiting.shift();
      w?.resolve({ ok: false, status: 503, error: err });
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

function mountPathText(r: ProbeRig, props: { text: string; code?: boolean }): ReturnType<typeof mount> {
  const ctx: PreviewContext = { handle: r.handle, plaintext: false };
  return mount(PathText, {
    props,
    global: { provide: { [PREVIEW_CTX as symbol]: ctx } },
  });
}

function assistant(partial: Partial<AssistantView> & Pick<AssistantView, "blocks">): AssistantView {
  return { model: "", costUsd: undefined, streaming: false, errorText: "", timestamp: undefined, ...partial };
}

async function settleTick(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

describe("PathText × probe (2026-10-07 修订「先探测后标记」)", () => {
  it("pending/unknown render plain text; confirmed upgrades to .path-ref; click opens the stripped path", async () => {
    const r = rig();
    const w = mountPathText(r, { text: "see /p/src/a.ts:12 for details" });
    expect(w.find(".path-ref").exists()).toBe(false); // pending ⇒ plain, DOM-equivalent
    expect(w.text()).toContain("/p/src/a.ts:12"); // adjacent text nodes: text() drops separators
    r.flush();
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false); // still pending (transport parked)

    r.answer(["text"]);
    await settleTick();
    const el = w.get(".path-ref");
    expect(el.text()).toBe("/p/src/a.ts:12"); // display keeps the suffix (§4.6 rule 3)
    const open = vi.fn();
    r.handle.open = open;
    await el.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/p/src/a.ts" });
    r.stop();
  });

  it("missing keeps the candidate plain forever (no .path-ref, no re-probe)", async () => {
    const r = rig();
    const w = mountPathText(r, { text: "gone /p/old.ts already" });
    r.flush();
    r.answer(["missing"]);
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false);
    expect(w.text()).toContain("/p/old.ts");
    expect(r.calls).toHaveLength(1); // terminal — never re-probed
    r.stop();
  });

  it("a failed probe request degrades the batch to plain text (no retry storm)", async () => {
    const r = rig();
    const w = mountPathText(r, { text: "a /p/a.ts b /p/b.ts" });
    r.flush();
    r.failRequest("E_BUSY");
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false);
    expect(r.calls).toHaveLength(1);
    r.stop();
  });

  it("inline-code candidate: plain code until confirmed, then code.md-code.path-ref", async () => {
    const r = rig();
    const w = mountPathText(r, { text: "/p/code/x.ts", code: true });
    const code = w.get("code");
    expect(code.classes()).toEqual(["md-code"]); // plain code — DOM-identical to MdInline
    r.flush();
    r.answer(["text"]);
    await settleTick();
    expect(w.get("code").classes()).toContain("path-ref");
    r.stop();
  });

  it("a RELATIVE candidate is probed by its resolved absolute path (resolveRelativePath parity)", async () => {
    const r = rig();
    const w = mountPathText(r, { text: 'wrote "src/deep/mod.ts" ok' });
    r.flush();
    await settleTick();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.paths).toEqual(["/p/src/deep/mod.ts"]); // scope.cwd + "/" + candidate
    r.answer(["image"]);
    await settleTick();
    expect(w.get(".path-ref").text()).toBe("src/deep/mod.ts"); // display stays relative
    r.stop();
  });

  it("a handle WITHOUT probe keeps the legacy always-clickable rendering (frozen fakes stay valid)", async () => {
    const open = vi.fn();
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
    const handle: PreviewHandle = { view, scope, open, close: () => {}, retry: () => {}, dispose: () => {} };
    const w = mount(PathText, {
      props: { text: "see /p/src/a.ts now" },
      global: { provide: { [PREVIEW_CTX as symbol]: { handle, plaintext: false } satisfies PreviewContext } },
    });
    const el = w.get(".path-ref"); // clickable immediately — no probe pipeline at all
    await el.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/p/src/a.ts" });
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 §5 P3 — dirs 透传 × PathText (a "dir" answer confirms the candidate)
// ---------------------------------------------------------------------------

describe("PathText × probe — dirs scope (dir-plan A5/P3)", () => {
  it("a dirs scope sends dirs:true; a dir-kind answer confirms the candidate (clickable)", async () => {
    const r = rig(ref<PreviewPathScope | null>({ ...SCOPE, dirs: true }));
    const w = mountPathText(r, { text: "browse /p/src/ when done" }); // trailing-slash candidate (rule a)
    r.flush();
    await settleTick();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.dirs).toBe(true); // P3 dirs passthrough
    expect(r.calls[0]!.paths).toEqual(["/p/src"]); // trailing / stripped in the resolved path
    r.answer(["dir"]);
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(true); // a directory ref is clickable — it opens a listing
    expect(r.probeHandle.kindOf?.("/p/src")).toBe("dir"); // the composable's kind hint
    r.stop();
  });

  it("a dirs-LESS scope never sends dirs and never confirms a directory (§1.3 fold ⇒ missing)", async () => {
    const r = rig(); // SCOPE without dirs
    // the trailing-slash dir candidate is not even recognized without the dirs scope —
    // a plain file candidate is, and its request must stay dirs-less (byte-identical body)
    const wSlash = mountPathText(r, { text: "browse /p/src/ when done" });
    expect(wSlash.find(".path-ref").exists()).toBe(false);
    expect(r.pending()).toBe(false); // nothing queued
    const w = mountPathText(r, { text: "see /p/a.ts now" });
    r.flush();
    await settleTick();
    expect(r.calls[0]!.dirs).toBeUndefined();
    // a misbehaving hub answering "dir" to a dirs-less request is folded to missing by the
    // transport's single fold point (§1.3) — simulated here by answering the folded form
    r.answer(["missing"]);
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false);
    expect(r.probeHandle.kindOf?.("/p/a.ts")).toBe("missing");
    r.stop();
  });
});

describe("TxAssistant × probe — one batched request per message", () => {
  function mountAssistant(r: ProbeRig, blocks: AssistantView["blocks"], streaming = false): ReturnType<typeof mount> {
    return mount(TxAssistant, {
      props: { assistant: assistant({ blocks, streaming }), truncated: false },
      global: { provide: { [PREVIEW_CTX as symbol]: { handle: r.handle, plaintext: false } satisfies PreviewContext } },
    });
  }

  it("a settled message's MANY candidates merge into ONE probe request", async () => {
    const r = rig();
    mountAssistant(r, [
      { kind: "text", text: "start /p/one.ts" },
      { kind: "text", text: "mid /p/two.ts and /p/three.ts" },
    ]);
    expect(r.pending()).toBe(true);
    r.flush(); // the single scheduled flush carries every PathText's candidates
    await settleTick();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.paths).toEqual(["/p/one.ts", "/p/two.ts", "/p/three.ts"]);
    r.answer(["text", "missing", "image"]);
    await settleTick();
    r.stop();
  });

  it("streaming stays un-probed (§4.6 流式抑制); settling re-scans and probes once", async () => {
    const r = rig();
    const w = mountAssistant(r, [{ kind: "text", text: "reading /p/src/a.ts now" }], true);
    expect(r.pending()).toBe(false); // suspended ⇒ no candidates submitted
    expect(w.find(".path-ref").exists()).toBe(false);

    await w.setProps({
      assistant: assistant({ blocks: [{ kind: "text", text: "read /p/src/a.ts now" }], streaming: false }),
    });
    expect(r.pending()).toBe(true);
    r.flush();
    await settleTick();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.paths).toEqual(["/p/src/a.ts"]);
    r.answer(["text"]);
    await settleTick();
    expect(w.get(".path-ref").text()).toBe("/p/src/a.ts");
    r.stop();
  });
});
