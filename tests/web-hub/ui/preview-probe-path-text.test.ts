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
import { defineComponent, effectScope, h, nextTick, ref, type Ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import PathText from "../../../src/web-hub/ui/src/components/preview/PathText.vue";
import TxAssistant from "../../../src/web-hub/ui/src/components/transcript/TxAssistant.vue";
import { usePreviewProbe, type PreviewProbeHandle } from "../../../src/web-hub/ui/src/composables/usePreviewProbe.js";
import type { AssistantView } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type { HubHandle, PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";

const SCOPE: PreviewPathScope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true };

type ProbeCall = { agentKey: string; sessionId: string; paths: string[]; dirs?: true; files?: true };

interface ProbeRig {
  handle: PreviewHandle;
  probeHandle: PreviewProbeHandle;
  calls: ProbeCall[];
  answer: (kinds: Array<"text" | "image" | "dir" | "file" | "missing">) => void;
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

describe("CJK alternatives through the real probe", () => {
  it.each([false, true])("prefix-only existence preserves trailing prose (code=%s)", async (code) => {
    const r = rig(ref({ ...SCOPE, tilde: true }));
    const w = mountPathText(r, { text: "~/ai/x下执行", code });
    r.flush();
    expect(r.calls[0]?.paths).toEqual(["~/ai/x下执行", "~/ai/x"]);
    r.answer(["missing", "dir"]);
    await settleTick();
    expect(w.get(".path-ref").text()).toBe("~/ai/x");
    expect(w.text()).toBe("~/ai/x下执行");
    w.unmount();
    r.stop();
  });
  it("longest existing Chinese filename wins; neither existing stays plain", async () => {
    for (const exists of [true, false]) {
      const r = rig(ref({ ...SCOPE, abs: true, dirs: true }));
      const w = mountPathText(r, { text: "/home/u/笔记.md" });
      r.flush();
      expect(r.calls[0]?.paths).toEqual(["/home/u/笔记.md", "/home/u"]);
      r.answer(exists ? ["text", "dir"] : ["missing", "missing"]);
      await settleTick();
      expect(w.find(".path-ref").exists()).toBe(exists);
      if (exists) expect(w.get(".path-ref").text()).toBe("/home/u/笔记.md");
      w.unmount();
      r.stop();
    }
  });
  it("alternatives count toward the 100 path wire cap", () => {
    const r = rig(ref({ ...SCOPE, tilde: true }));
    const w = mountPathText(r, { text: Array.from({ length: 60 }, (_, i) => `~/ai/x${i}下执行`).join(" ") });
    r.flush();
    expect(r.calls.map((c) => c.paths.length)).toEqual([100, 20]);
    for (const c of r.calls) expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(8192);
    w.unmount();
    r.stop();
  });
  it("alternatives split on the UTF-8 body budget too", () => {
    const r = rig(ref({ ...SCOPE, tilde: true }));
    const w = mountPathText(r, {
      text: Array.from({ length: 20 }, (_, i) => `~/ai/${"x".repeat(400)}${i}下执行`).join(" "),
    });
    r.flush();
    expect(r.calls.length).toBeGreaterThan(1);
    expect(r.calls.flatMap((c) => c.paths)).toHaveLength(40);
    for (const c of r.calls) expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(8192);
    w.unmount();
    r.stop();
  });
});

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

describe("PathText × probe — files scope (preview-download)", () => {
  it("a files scope sends files:true; a file-kind answer confirms the candidate (clickable into the download offer)", async () => {
    const r = rig(ref<PreviewPathScope | null>({ ...SCOPE, files: true }));
    const w = mountPathText(r, { text: "grab /p/bundle.zip now" });
    r.flush();
    await settleTick();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.files).toBe(true); // preview-download files passthrough
    expect(r.calls[0]!.dirs).toBeUndefined();
    expect(r.calls[0]!.paths).toEqual(["/p/bundle.zip"]);
    r.answer(["file"]);
    await settleTick();
    // "file" settles as confirmed — the zip path lights up; the click opens the dialog
    // (unsupported phase → download button), per the 2026-10-12 拍板 chain
    const el = w.find(".path-ref");
    expect(el.exists()).toBe(true);
    expect(r.probeHandle.kindOf?.("/p/bundle.zip")).toBe("file");
    const open = vi.fn();
    r.handle.open = open;
    await el.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/p/bundle.zip" });
    r.stop();
  });

  it('a files-LESS scope never sends files; a misbehaving hub\'s "file" answer is folded to missing upstream', async () => {
    const r = rig(); // SCOPE without files
    const w = mountPathText(r, { text: "grab /p/bundle.zip now" });
    r.flush();
    await settleTick();
    expect(r.calls[0]!.files).toBeUndefined(); // byte-identical body
    // the client-layer fold (§1.3 mirror) already turned a "file" into "missing" — simulated
    // here by answering the folded form: the zip stays plain text
    r.answer(["missing"]);
    await settleTick();
    expect(w.find(".path-ref").exists()).toBe(false);
    expect(r.probeHandle.kindOf?.("/p/bundle.zip")).toBe("missing");
    r.stop();
  });
});

// #19 exercises REAL production PathText/usePreviewProbe and settled Markdown, not a
// stub scanner or mocked existence controller. Only the transport/scheduler are fake.
describe("#19 CJK fidelity and plain HTTP(S) exclusion through the production chain", () => {
  const C = "/fixture/project";
  const scopes: Array<[string, PreviewPathScope & { tilde?: true }]> = [
    ["L", { ...SCOPE, cwd: C }],
    ["A", { ...SCOPE, cwd: C, abs: true }],
    ["D", { ...SCOPE, cwd: C, dirs: true }],
    ["F", { ...SCOPE, cwd: C, abs: true, dirs: true, tilde: true }],
  ];
  const full = `${C}/src/中文目录/报告.md`;
  const alt = `${C}/src`;
  // A host gives fragment-root PathText a real DOM container: textContent must retain
  // CRLF/emoji (VTU .text() trims; browsers/HTML source parsing may normalize CRLF).
  function hostPath(r: ProbeRig, props: { text: string; code?: boolean; noRefs?: boolean }) {
    return mount(defineComponent({ setup: () => () => h("div", [h(PathText, props)]) }), {
      global: { provide: { [PREVIEW_CTX as symbol]: { handle: r.handle, plaintext: false } satisfies PreviewContext } },
    });
  }
  function hostAssistant(r: ProbeRig, text: string, streaming = false) {
    return mount(TxAssistant, {
      props: { assistant: assistant({ blocks: [{ kind: "text", text }], streaming }), truncated: false },
      global: { provide: { [PREVIEW_CTX as symbol]: { handle: r.handle, plaintext: false } satisfies PreviewContext } },
    });
  }
  async function activate(w: ReturnType<typeof mount>, r: ProbeRig, text: string, path: string): Promise<void> {
    const el = w.get(".path-ref");
    expect(w.findAll(".path-ref")).toHaveLength(1);
    expect(el.element.textContent).toBe(text);
    expect(el.attributes("role")).toBe("button");
    expect(el.attributes("tabindex")).toBe("0");
    const open = vi.fn();
    r.handle.open = open;
    await el.trigger("click");
    await el.trigger("keydown", { key: "Enter" });
    await el.trigger("keydown", { key: " " });
    expect(open.mock.calls).toEqual([[{ path }], [{ path }], [{ path }]]);
  }

  it.each(scopes)("%s: full Chinese interior is probed, rendered and opened intact", async (_label, scope) => {
    const r = rig(ref(scope));
    const text = "见 src/中文目录/报告.md:12:3";
    const w = hostPath(r, { text });
    try {
      expect(w.element.textContent).toBe(text);
      expect(w.find(".path-ref").exists()).toBe(false);
      r.flush();
      expect(r.calls.map((c) => c.paths)).toEqual([scope.dirs ? [full, alt] : [full]]);
      r.answer(scope.dirs ? ["text", "missing"] : ["text"]);
      await settleTick();
      expect(w.element.textContent).toBe(text);
      await activate(w, r, "src/中文目录/报告.md:12:3", full);
    } finally {
      w.unmount();
      r.stop();
    }
  });

  it.each([
    ["text", "dir", "src/中文目录/报告.md:12:3", full],
    ["missing", "dir", "src/", alt],
    ["missing", "missing", null, null],
  ] as const)(
    "main=%s alt=%s preserves existing fallback (not lexer truncation)",
    async (main, alternative, display, path) => {
      for (const [, scope] of scopes.filter(([, s]) => s.dirs)) {
        const r = rig(ref(scope));
        const text = "见 src/中文目录/报告.md:12:3";
        const w = hostPath(r, { text });
        try {
          r.flush();
          expect(r.calls.map((c) => c.paths)).toEqual([[full, alt]]);
          r.answer([main, alternative]);
          await settleTick();
          expect(w.element.textContent).toBe(text);
          if (display !== null && path !== null) await activate(w, r, display, path);
          else {
            const open = vi.fn();
            r.handle.open = open;
            expect(w.find(".path-ref").exists()).toBe(false);
            await w.trigger("click");
            expect(open).not.toHaveBeenCalled();
          }
        } finally {
          w.unmount();
          r.stop();
        }
      }
    },
  );

  it.each(scopes)(
    "%s: HTTP token candidates never reach ensure/transport/open, including plain backticks",
    async (_label, scope) => {
      for (const text of [
        "https://e.test/中文/sub/a.md",
        "HTTPS://e.test/?p=/fixture/project/a.ts",
        "https://e.test/?x=(/fixture/project/a.ts)",
        "https://e.test/?汉字=/fixture/project/a.ts",
        "`https://e.test/?p=/fixture/project/a.ts`",
      ]) {
        const r = rig(ref(scope));
        const ensure = vi.spyOn(r.probeHandle, "ensure"); // call-through to the real controller
        const open = vi.fn();
        r.handle.open = open;
        const w = hostPath(r, { text, code: false });
        try {
          await settleTick();
          expect(ensure).not.toHaveBeenCalled();
          expect(r.pending()).toBe(false);
          r.flush();
          expect(r.calls).toEqual([]); // even an existing internal path is never requested
          expect(w.element.textContent).toBe(text);
          expect(w.find(".path-ref").exists()).toBe(false);
          await w.trigger("click");
          await w.trigger("keydown", { key: "Enter" });
          expect(open).not.toHaveBeenCalled();
        } finally {
          w.unmount();
          r.stop();
        }
      }
    },
  );

  it.each(scopes)("%s: mixed URL and Chinese sibling probes/opens only the full sibling", async (_label, scope) => {
    const r = rig(ref(scope));
    const ensure = vi.spyOn(r.probeHandle, "ensure");
    const text = "https://e.test/?汉字=/fixture/project/fake.ts，见 src/中文目录/报告.md";
    const w = hostPath(r, { text });
    try {
      const expectedPaths = scope.dirs ? [full, alt] : [full];
      expect(ensure.mock.calls).toEqual([[expectedPaths]]);
      r.flush();
      expect(r.calls.map((c) => c.paths)).toEqual([expectedPaths]);
      r.answer(scope.dirs ? ["text", "dir"] : ["text"]);
      await settleTick();
      expect(w.element.textContent).toBe(text);
      await activate(w, r, "src/中文目录/报告.md", full);
    } finally {
      w.unmount();
      r.stop();
    }
  });

  it.each(scopes)("%s: CRLF/emoji DOM is verbatim; only external /tmp/b.ts is probed/opened", async (_label, scope) => {
    const r = rig(ref(scope));
    const ensure = vi.spyOn(r.probeHandle, "ensure");
    const text = "https://e.test/😀?p=/tmp/a.ts\r\n/tmp/b.ts";
    const w = hostPath(r, { text });
    try {
      expect(w.element.textContent).toBe(text);
      r.flush();
      expect(ensure.mock.calls).toEqual(scope.abs ? [[["/tmp/b.ts"]]] : []);
      expect(r.calls.map((c) => c.paths)).toEqual(scope.abs ? [["/tmp/b.ts"]] : []);
      if (scope.abs) {
        r.answer(["text"]);
        await settleTick();
        expect(w.element.textContent).toBe(text);
        await activate(w, r, "/tmp/b.ts", "/tmp/b.ts");
      } else expect(w.find(".path-ref").exists()).toBe(false);
    } finally {
      w.unmount();
      r.stop();
    }
  });

  it("settled TxAssistant → MarkdownView → MdInline → PathText keeps full Chinese text and URL noRefs", async () => {
    const r = rig(ref(scopes[3]![1]));
    const text = "见 src/中文目录/报告.md:12:3，https://e.test/?p=/tmp/fake.ts";
    const w = hostAssistant(r, text);
    try {
      expect(w.find(".path-ref").exists()).toBe(false);
      r.flush();
      expect(r.calls.map((c) => c.paths)).toEqual([[full, alt]]);
      r.answer(["text", "dir"]);
      await settleTick();
      expect(w.element.textContent).toContain(text);
      await activate(w, r, "src/中文目录/报告.md:12:3", full);
    } finally {
      w.unmount();
      r.stop();
    }
  });

  it("real Markdown code/pathlinks retain their old whole-span/normalize/href routes", async () => {
    const r = rig(ref(scopes[3]![1]));
    const open = vi.fn();
    r.handle.open = open;
    const text =
      "`中文目录/报告.md` [报告](中文目录/报告.md) [上级](../中文目录/报告.md) " +
      "[/tmp/fake.ts](https://e.test/中文/sub/a.md) `https://e.test/?p=/tmp/fake.ts`";
    const w = hostAssistant(r, text);
    try {
      r.flush();
      expect(r.calls.map((c) => c.paths)).toEqual([[`${C}/中文目录/报告.md`]]);
      const anchor = w.get("a");
      expect(anchor.attributes("href")).toBe("https://e.test/中文/sub/a.md");
      expect(anchor.text()).toBe("/tmp/fake.ts");
      expect(anchor.find(".path-ref").exists()).toBe(false);
      r.answer(["text"]);
      await settleTick();
      expect(w.get("code.path-ref").element.textContent).toBe("中文目录/报告.md");
      for (const el of w.findAll(".path-ref")) await el.trigger("click");
      expect(open.mock.calls).toEqual([
        [{ path: `${C}/中文目录/报告.md` }],
        [{ path: `${C}/中文目录/报告.md` }],
        [{ path: "/fixture/中文目录/报告.md" }],
      ]);
      expect(w.findAll("code").at(-1)?.classes()).not.toContain("path-ref");
    } finally {
      w.unmount();
      r.stop();
    }
  });

  it("Markdown literal URL code and fenced code do not generate internal fs probes", async () => {
    const r = rig(ref(scopes[3]![1]));
    const ensure = vi.spyOn(r.probeHandle, "ensure");
    const w = hostAssistant(r, "`https://e.test/?p=/fixture/project/a.ts`\n\n```txt\n/fixture/project/fake.ts\n```");
    try {
      r.flush();
      expect(r.calls).toEqual([]);
      expect(ensure).not.toHaveBeenCalled();
      expect(w.find(".path-ref").exists()).toBe(false);
      expect(w.get("code.md-code").text()).toBe("https://e.test/?p=/fixture/project/a.ts");
    } finally {
      w.unmount();
      r.stop();
    }
  });

  it("noRefs, null scope and streaming keep Chinese candidates out of the real probe", async () => {
    for (const mode of ["noRefs", "null", "streaming"] as const) {
      const r = rig(ref(mode === "null" ? null : scopes[3]![1]));
      const ensure = vi.spyOn(r.probeHandle, "ensure");
      const text = "见 src/中文目录/报告.md";
      const w = mode === "streaming" ? hostAssistant(r, text, true) : hostPath(r, { text, noRefs: mode === "noRefs" });
      try {
        r.flush();
        expect(ensure).not.toHaveBeenCalled();
        expect(r.calls).toEqual([]);
        expect(w.find(".path-ref").exists()).toBe(false);
        expect(w.element.textContent).toContain(text);
      } finally {
        w.unmount();
        r.stop();
      }
    }
  });
});
