// @vitest-environment node
import { nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asDirHandle,
  createPreviewMachine,
  usePreview,
  type FileReaderLike,
  type PreviewMachine,
} from "../../../src/web-hub/ui/src/composables/usePreview.js";
import {
  asWindowsHandle,
  PREVIEW_WINDOW_MAX,
  usePreviewWindows,
} from "../../../src/web-hub/ui/src/composables/usePreviewWindows.js";
import type { PreviewDirListing, PreviewProbeKind } from "../../../src/web-hub/protocol/preview.js";
import type { HubState, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";
import type {
  PreviewDirOutcome,
  PreviewOutcome,
  PreviewTransport,
} from "../../../src/web-hub/ui/src/transport/types.js";

/**
 * web-hub-preview-windows plan r2 §10.1 (W1): the window manager against a fake transport —
 * every numbered case (1–13). The manager is DOM-free; the "第 2 个窗口位置错开" half of case 1
 * is pure geometry and lives in logic-preview-window-geom.test.ts (cascadeRect), and the DOM
 * half (focus landing, node identity) is W2's preview-windows.test.ts.
 */

const flush = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
/** Microtasks + a macrotask: lets view settles AND the manager's pre-flush watchers run. */
const settle = async (): Promise<void> => {
  await flush();
  await new Promise((r) => setTimeout(r, 0));
  await flush();
};
/** Fake-timer-safe variant: microtasks + nextTick only (no setTimeout). */
const settleMicro = async (): Promise<void> => {
  await flush();
  await nextTick();
  await flush();
};
const flushMacro = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await flush();
};

function makeState(
  opts: { caps?: unknown[]; selected?: string | null; session?: unknown; hub?: unknown } = {},
): Ref<HubState> {
  const {
    caps = ["preview.v1", "preview.lan.v1"],
    selected = "A",
    session = { sessionId: "s1", sessionFile: "/p/s.jsonl", cwd: "/p" },
    hub = { caps },
  } = opts;
  const agents = new Map<string, unknown>();
  if (selected !== null) {
    agents.set(selected, {
      key: selected,
      card: session !== null && typeof session === "object" ? { session } : {},
      session,
      down: false,
      prompts: [],
      fleet: [],
      items: [],
      uid: 0,
      lastSeq: -1,
      streaming: null,
      tools: [],
      history: "none",
      hasMore: false,
      needsResync: false,
      sub: null,
    });
  }
  return ref({
    clientId: "c1",
    hub,
    conn: "open",
    selected,
    agents,
    order: selected === null ? [] : [selected],
  } as unknown as HubState);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function realFileReader(): FileReaderLike {
  const listeners = new Map<string, Array<() => void>>();
  const o: FileReaderLike = {
    result: null,
    addEventListener(type: "load" | "error", listener: () => void) {
      const l = listeners.get(type) ?? [];
      l.push(listener);
      listeners.set(type, l);
    },
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then((buf) => {
        (o as { result: unknown }).result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
        for (const fn of listeners.get("load") ?? []) fn();
      });
    },
  } as FileReaderLike;
  return o;
}

function makeListing(names: string[]): PreviewDirListing {
  const entries = names.map((name) => ({
    name: name.endsWith("/") ? name.slice(0, -1) : name,
    type: name.endsWith("/") ? ("dir" as const) : ("file" as const),
    size: name.endsWith("/") ? undefined : 1,
    mtimeMs: 1_700_000_000_000,
  }));
  return {
    entries,
    total: entries.length,
    scanned: entries.length,
    complete: true,
    truncated: false,
    limits: { scan: false, entries: false, bytes: false },
    vanished: 0,
    dropped: 0,
  };
}

const TEXT_OK: PreviewOutcome = { ok: true, kind: "text", size: 5, truncated: false, text: "hello" };
const DIR_OK = (names: string[]): PreviewDirOutcome => ({ ok: true, kind: "dir", listing: makeListing(names) });
const IMAGE_OK: PreviewOutcome = {
  ok: true,
  kind: "image",
  mime: "image/png",
  size: 3,
  dims: { w: 10, h: 10 },
  blob: new Blob([new Uint8Array([80, 78, 71])], { type: "image/png" }),
};

interface Harness {
  readonly state: Ref<HubState>;
  readonly coarse: Ref<boolean>;
  readonly calls: Array<{
    req: {
      agentKey: string;
      sessionId: string;
      path: string;
      dir?: true;
      chunk?: true | { offset: number; ident: string };
    };
    opts: { signal: AbortSignal; maxPixels: number };
  }>;
  readonly waits: Array<ReturnType<typeof deferred<PreviewDirOutcome>>>;
  readonly root: ReturnType<typeof usePreviewWindows>;
  readonly face: NonNullable<ReturnType<typeof asWindowsHandle>>;
  readonly probeCalls: Array<{ paths: string[]; dirs?: true }>;
}

function makeHarness(
  stateOpts: Parameters<typeof makeState>[0] = {},
  opts: {
    mode?: "token" | "password";
    noTransport?: boolean;
    createFileReader?: () => FileReaderLike;
    probeKinds?: (path: string) => PreviewProbeKind;
    historyBudgetBytes?: number;
  } = {},
): Harness {
  const state = makeState(stateOpts);
  const coarse = ref(false);
  const calls: Harness["calls"] = [];
  const waits: Harness["waits"] = [];
  const probeCalls: Harness["probeCalls"] = [];
  const transport: PreviewTransport = {
    fetch: (req, fetchOpts) => {
      calls.push({ req, opts: fetchOpts });
      const d = deferred<PreviewDirOutcome>();
      waits.push(d);
      return d.promise;
    },
    ...(opts.probeKinds !== undefined
      ? {
          probe: (req: { paths: readonly string[]; dirs?: true }) => {
            probeCalls.push({ paths: [...req.paths], ...(req.dirs === true ? { dirs: true } : {}) });
            return Promise.resolve({ ok: true as const, results: req.paths.map((p) => opts.probeKinds!(p)) });
          },
        }
      : {}),
  };
  const root = usePreviewWindows({
    preview: opts.noTransport === true ? undefined : transport,
    mode: opts.mode ?? "token",
    state,
    coarse,
    createFileReader: opts.createFileReader ?? realFileReader,
    ...(opts.historyBudgetBytes !== undefined ? { historyBudgetBytes: opts.historyBudgetBytes } : {}),
  });
  const face = asWindowsHandle(root);
  if (face === null) throw new Error("usePreviewWindows must provide the windows face");
  return { state, coarse, calls, waits, root, face, probeCalls };
}

const win = (h: Harness, i: number) => h.face.windows.value[i]!;
const viewOf = (h: Harness, i: number) => win(h, i).handle.view.value;

describe("usePreviewWindows: routing & lifecycle (§10.1 1–3, 8)", () => {
  it("1: root open APPENDS windows (no closeAll); ids/order/focusRequest advance", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/a.ts" });
    expect(h.face.windows.value).toHaveLength(1);
    expect(h.face.order.value).toEqual([1]);
    expect(h.face.activeId.value).toBe(1);
    expect(h.face.focusRequest.value).toEqual({ id: 1, seq: 1 });
    h.waits[0]!.resolve(TEXT_OK);
    await settle();
    h.root.open({ path: "/p/b.ts" }); // the OLD behavior closed here — now it appends
    expect(h.face.windows.value).toHaveLength(2);
    expect(h.face.order.value).toEqual([1, 2]);
    expect(viewOf(h, 0)).toMatchObject({ phase: "text", path: "/p/a.ts" }); // window 1 untouched
    expect(h.face.focusRequest.value).toEqual({ id: 2, seq: 2 });
    // the placement half of case 1 (错开摆放) is cascadeRect's — see logic-preview-window-geom
  });

  it("2: in-window dir route (dir:true AND kindOf=dir) navigates in place — stackDepth+1", async () => {
    const h = makeHarness(
      { caps: ["preview.v1", "preview.dir.v1", "preview.lan.v1"] },
      { probeKinds: (p) => (p === "/p/sub" ? "dir" : "text") },
    );
    h.root.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await settle();
    h.root.probe!.ensure(["/p/sub"]);
    await flushMacro();
    expect(h.face.openWindow({ path: "/p/sub", dir: true }, 1)).toBe("in-place");
    expect(h.calls[1]!.req.dir).toBe(true);
    expect(h.face.windows.value).toHaveLength(1);
    expect(win(h, 0).handle.stackDepth.value).toBe(1);
    h.waits[1]!.resolve(DIR_OK(["x.ts"]));
    await settle();
    expect(viewOf(h, 0)).toMatchObject({ phase: "dir", path: "/p/sub" });
    // kindOf=dir alone (no explicit dir flag) routes in place too
    expect(h.face.openWindow({ path: "/p/sub" }, 1)).toBe("in-place");
    expect(h.face.windows.value).toHaveLength(1);
    expect(win(h, 0).handle.stackDepth.value).toBe(2);
  });

  it("3: file route opens a new window", async () => {
    const h = makeHarness({ caps: ["preview.v1", "preview.dir.v1", "preview.lan.v1"] }, { probeKinds: () => "text" });
    h.root.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await settle();
    h.root.probe!.ensure(["/p/b.ts"]);
    await flushMacro();
    expect(h.face.openWindow({ path: "/p/b.ts" }, 1)).toBe("opened");
    expect(h.face.windows.value).toHaveLength(2);
    expect(h.calls[1]!.req.path).toBe("/p/b.ts");
  });

  it("8: a dead fromId is a total no-op", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await settle();
    h.face.closeWindow(1);
    const callsBefore = h.calls.length;
    expect(h.face.openWindow({ path: "/p/x" }, 1)).toBe("ignored");
    expect(h.calls.length).toBe(callsBefore);
    expect(h.face.windows.value).toHaveLength(0);
  });

  it("0: no scope / no transport ⇒ ignored (nothing clickable)", () => {
    const h = makeHarness({ caps: [] });
    expect(h.face.openWindow({ path: "/p/a" }, null)).toBe("ignored");
    h.root.open({ path: "/p/a" }); // root open is a silent no-op (void face)
    expect(h.face.windows.value).toHaveLength(0);
  });
});

describe("usePreviewWindows: speculative fold-back (§3.3 / §10.1 4–5)", () => {
  async function originWindow(h: Harness): Promise<void> {
    h.root.open({ path: "/p/src", dir: true });
    h.waits[0]!.resolve(DIR_OK(["link"]));
    await settle();
  }

  it("4a: unknown first settle is a dir ⇒ folds back into A: adopt, no 2nd request, B gone, focus→A", async () => {
    const h = makeHarness();
    await originWindow(h);
    expect(h.face.openWindow({ path: "/p/src/link" }, 1)).toBe("opened"); // unknown (no probe)
    expect(h.face.windows.value).toHaveLength(2);
    const callsBefore = h.calls.length;
    h.waits[1]!.resolve(DIR_OK(["inner.ts"])); // the speculative window settles as a dir
    await settle();
    expect(h.calls.length).toBe(callsBefore); // adopt reuses B's listing — no new request
    expect(h.face.windows.value).toHaveLength(1); // B removed
    expect(h.face.order.value).toEqual([1]);
    expect(viewOf(h, 0)).toEqual({ phase: "dir", path: "/p/src/link", listing: makeListing(["inner.ts"]) });
    expect(win(h, 0).handle.stackDepth.value).toBe(1); // A's previous listing is 返回-able
    expect(h.face.focusRequest.value).toEqual({ id: 1, seq: expect.any(Number) }); // focus follows to A
    // A's navEpoch bumped by the adopt: a later epoch check still matches the NEW value
    expect(win(h, 0).handle.navEpoch.value).toBeGreaterThan(1);
  });

  it("4b: A paged away (navEpoch changed) ⇒ no fold-back, B stays a normal window", async () => {
    const h = makeHarness();
    await originWindow(h);
    expect(h.face.openWindow({ path: "/p/src/link" }, 1)).toBe("opened");
    // A navigates in place while B is in flight — its navEpoch leaves the captured epoch
    expect(h.face.openWindow({ path: "/p/other", dir: true }, 1)).toBe("in-place");
    h.waits[1]!.resolve(DIR_OK(["inner.ts"])); // B settles dir
    await settle();
    expect(h.face.windows.value).toHaveLength(2); // kept
    expect(viewOf(h, 0)).toMatchObject({ phase: "loading", path: "/p/other" }); // A kept its own nav
    h.waits[2]!.resolve(TEXT_OK);
    await settle();
    expect(viewOf(h, 0)).toMatchObject({ phase: "text", path: "/p/other" });
  });

  it("4c: A already closed ⇒ no fold-back, B stays", async () => {
    const h = makeHarness();
    await originWindow(h);
    expect(h.face.openWindow({ path: "/p/src/link" }, 1)).toBe("opened");
    h.face.closeWindow(1);
    h.waits[1]!.resolve(DIR_OK(["inner.ts"]));
    await settle();
    expect(h.face.windows.value).toHaveLength(1);
    expect(win(h, 0).id).toBe(2);
    expect(viewOf(h, 0)).toMatchObject({ phase: "dir", path: "/p/src/link" });
  });

  it("5: unknown first settle is a FILE ⇒ B is kept as a normal window", async () => {
    const h = makeHarness();
    await originWindow(h);
    expect(h.face.openWindow({ path: "/p/src/f.ts" }, 1)).toBe("opened");
    h.waits[1]!.resolve(TEXT_OK);
    await settle();
    expect(h.face.windows.value).toHaveLength(2);
    expect(viewOf(h, 1)).toMatchObject({ phase: "text", path: "/p/src/f.ts" });
    // and the settled window is no longer speculative: a later dir-ish navigate is plain
    expect(h.face.openWindow({ path: "/p/src/f.ts" }, 2)).toBe("focused"); // dedup now hits B
  });
});

describe("usePreviewWindows: dedup (§3.4 / §10.1 6)", () => {
  it("6a: a loaded window with the same path is focused (focusRequest emitted), no new request", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await settle();
    const callsBefore = h.calls.length;
    const seqBefore = h.face.focusRequest.value?.seq ?? 0;
    expect(h.face.openWindow({ path: "/p/a.ts" }, null)).toBe("focused");
    expect(h.calls.length).toBe(callsBefore);
    expect(h.face.windows.value).toHaveLength(1);
    expect(h.face.focusRequest.value).toEqual({ id: 1, seq: seqBefore + 1 });
  });

  it("6b: a LOADING window dedups too — a slow double-click produces exactly one request", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/slow.ts" }); // parked in loading
    expect(h.face.openWindow({ path: "/p/slow.ts" }, null)).toBe("focused");
    expect(h.calls.length).toBe(1); // no second fetch
    expect(h.face.windows.value).toHaveLength(1);
  });

  it("6c: error/unsupported/tooLarge phases dedup; string-exact paths only", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/e.ts" });
    h.waits[0]!.resolve({ ok: false, status: 0, error: "E_NETWORK" });
    await settle();
    expect(h.face.openWindow({ path: "/p/e.ts" }, null)).toBe("focused");
    h.root.open({ path: "/p/e.ts" }); // root open dedups as well
    expect(h.face.windows.value).toHaveLength(1);
    // ~/x and /home/u/x are different windows (no normalization — accepted)
    h.root.open({ path: "~/e.ts" });
    expect(h.face.windows.value).toHaveLength(2);
  });

  it("6d: in-window dir routing OUTRANKS dedup (§3.4)", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/src", dir: true });
    h.waits[0]!.resolve(DIR_OK([]));
    await settle();
    // /p/src is already open (window 1, view.path === /p/src) but a dir route navigates in place
    expect(h.face.openWindow({ path: "/p/src", dir: true }, 1)).toBe("in-place");
    expect(h.face.windows.value).toHaveLength(1);
    expect(win(h, 0).handle.stackDepth.value).toBe(1);
  });
});

describe("usePreviewWindows: window cap (§3.4 / §10.1 7)", () => {
  async function fillToCap(h: Harness): Promise<void> {
    for (let i = 1; i <= PREVIEW_WINDOW_MAX; i++) {
      h.root.open({ path: `/p/f${i}.ts` });
      h.waits[i - 1]!.resolve(TEXT_OK);
    }
    await settle();
    expect(h.face.windows.value).toHaveLength(PREVIEW_WINDOW_MAX);
  }

  it("7a: the 7th open from a window navigates THERE and fires limitNotice", async () => {
    const h = makeHarness();
    await fillToCap(h);
    const callsBefore = h.calls.length;
    expect(h.face.openWindow({ path: "/p/7th.ts" }, 3)).toBe("navigated");
    expect(h.face.windows.value).toHaveLength(PREVIEW_WINDOW_MAX);
    expect(h.calls.length).toBe(callsBefore + 1);
    expect(h.calls.at(-1)!.req.path).toBe("/p/7th.ts");
    expect(viewOf(h, 2)).toMatchObject({ phase: "loading", path: "/p/7th.ts" });
    expect(h.face.limitNotice.value).toEqual({ id: 3, seq: expect.any(Number) });
  });

  it("7b: the 7th open from the conversation navigates the ACTIVE window", async () => {
    const h = makeHarness();
    await fillToCap(h); // active = window 6 (the last root open)
    expect(h.face.activeId.value).toBe(6);
    expect(h.face.openWindow({ path: "/p/7th.ts" }, null)).toBe("navigated");
    expect(viewOf(h, 5)).toMatchObject({ phase: "loading", path: "/p/7th.ts" });
    expect(h.face.limitNotice.value).toEqual({ id: 6, seq: expect.any(Number) });
    // dedup still outranks the cap: an already-open path focuses instead
    expect(h.face.openWindow({ path: "/p/f1.ts" }, null)).toBe("focused");
  });

  it("7c: the notice clears on the target's next navigate (rule ①), on count < cap (rule ②) and after 8 s (rule ③)", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      for (let i = 1; i <= PREVIEW_WINDOW_MAX; i++) {
        h.root.open({ path: `/p/f${i}.ts` });
        h.waits[i - 1]!.resolve(TEXT_OK);
      }
      await settleMicro();
      expect(h.face.openWindow({ path: "/p/x1.ts" }, 1)).toBe("navigated");
      h.waits[6]!.resolve(TEXT_OK);
      await settleMicro();
      expect(h.face.limitNotice.value).toEqual({ id: 1, seq: 1 });
      // rule ①: window 1's own next navigate (an in-place dir route) clears it
      expect(h.face.openWindow({ path: "/p/d", dir: true }, 1)).toBe("in-place");
      h.waits[7]!.resolve(DIR_OK([]));
      await settleMicro();
      expect(h.face.limitNotice.value).toBeNull();
      // re-arm, then rule ②: closing ANY window drops the count below the cap
      expect(h.face.openWindow({ path: "/p/x2.ts" }, 1)).toBe("navigated");
      h.waits[8]!.resolve(TEXT_OK);
      await settleMicro();
      expect(h.face.limitNotice.value).toEqual({ id: 1, seq: 2 });
      h.face.closeWindow(6);
      expect(h.face.limitNotice.value).toBeNull();
      // back at cap, re-arm, then rule ③: the 8 s TTL
      h.root.open({ path: "/p/f6b.ts" });
      h.waits[9]!.resolve(TEXT_OK);
      await settleMicro();
      expect(h.face.openWindow({ path: "/p/x3.ts" }, 1)).toBe("navigated");
      h.waits[10]!.resolve(TEXT_OK);
      await settleMicro();
      expect(h.face.limitNotice.value).toEqual({ id: 1, seq: 3 });
      await vi.advanceTimersByTimeAsync(8000);
      expect(h.face.limitNotice.value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("7d: an unknown route at the cap navigates in place directly (§3.3 last bullet)", async () => {
    const h = makeHarness();
    await fillToCap(h);
    expect(h.face.openWindow({ path: "/p/mystery" }, 2)).toBe("navigated"); // NOT a speculative window
    expect(h.face.windows.value).toHaveLength(PREVIEW_WINDOW_MAX);
    expect(viewOf(h, 1)).toMatchObject({ phase: "loading", path: "/p/mystery" });
  });
});

describe("usePreviewWindows: close / dispose / ids (§10.1 9)", () => {
  it("9a: closeWindow aborts only that window's in-flight request", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/1" });
    h.root.open({ path: "/p/2" });
    h.root.open({ path: "/p/3" });
    h.face.closeWindow(2);
    expect(h.calls[1]!.opts.signal.aborted).toBe(true);
    expect(h.calls[0]!.opts.signal.aborted).toBe(false);
    expect(h.calls[2]!.opts.signal.aborted).toBe(false);
    expect(h.face.windows.value.map((w) => w.id)).toEqual([1, 3]);
    expect(h.face.order.value).toEqual([1, 3]);
  });

  it("9b: closeAll aborts everything; dispose is idempotent", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/1" });
    h.root.open({ path: "/p/2" });
    h.face.closeAll();
    expect(h.calls[0]!.opts.signal.aborted).toBe(true);
    expect(h.calls[1]!.opts.signal.aborted).toBe(true);
    expect(h.face.windows.value).toHaveLength(0);
    h.root.dispose();
    h.root.dispose();
    expect(h.face.windows.value).toHaveLength(0);
  });

  it("9c: ids are closure-scoped monotonic counters — never reused after a close", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/1" });
    h.waits[0]!.resolve(TEXT_OK);
    await settle();
    h.face.closeWindow(1);
    h.root.open({ path: "/p/2" });
    expect(h.face.windows.value.map((w) => w.id)).toEqual([2]);
  });

  it("9d: closeWindow of an unknown id is a no-op", () => {
    const h = makeHarness();
    h.root.open({ path: "/p/1" });
    h.face.closeWindow(99);
    expect(h.face.windows.value).toHaveLength(1);
  });
});

describe("usePreviewWindows: session-change coverage (§4.4 / §10.1 10–11)", () => {
  function switchSession(h: Harness): void {
    const agents = new Map(h.state.value.agents);
    const a = agents.get("A") as Record<string, unknown>;
    const session = { sessionId: "s2", sessionFile: "/p/s.jsonl", cwd: "/p" };
    agents.set("A", { ...a, session, card: { session } });
    h.state.value = { ...h.state.value, agents } as unknown as HubState;
  }

  it("10a: scope key change ⇒ closeAll", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/a.ts" });
    h.root.open({ path: "/p/b.ts" });
    switchSession(h);
    await nextTick();
    expect(h.face.windows.value).toHaveLength(0);
    expect(h.calls[0]!.opts.signal.aborted).toBe(true);
    expect(h.root.view.value).toEqual({ phase: "closed" });
  });

  it("10b: E_SESSION_CHANGED on a MAIN request ⇒ closeAll", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve({ ok: false, status: 409, error: "E_SESSION_CHANGED" });
    await settle();
    expect(h.face.windows.value).toHaveLength(0);
  });

  it("10c: E_SESSION_CHANGED on a continuation STREAM ⇒ closeAll", async () => {
    const h = makeHarness({ caps: ["preview.v1", "preview.lan.v1", "preview.chunk.v1"] });
    h.root.open({ path: "/p/big.log" });
    h.waits[0]!.resolve({
      ok: true,
      kind: "text",
      size: 1000 * 1024,
      truncated: true,
      text: "first\n",
      bytes: 256 * 1024,
      chunk: { offset: 0, ident: "i1.AAAAAAAAAAAAAAAAAAAAAA" },
    } as PreviewOutcome);
    await settle();
    h.root.open({ path: "/p/other.ts" }); // a second window proves closeAll (not just one)
    h.waits[1]!.resolve(TEXT_OK);
    await settle();
    expect(h.face.windows.value).toHaveLength(2);
    win(h, 0).handle.loadMore();
    h.waits[2]!.resolve({ ok: false, status: 409, error: "E_SESSION_CHANGED" });
    await settle();
    expect(h.face.windows.value).toHaveLength(0);
  });

  it("10d: E_SESSION_CHANGED on a TREE expansion ⇒ closeAll (评审 #6)", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/src", dir: true });
    h.waits[0]!.resolve(DIR_OK(["sub/"]));
    await settle();
    h.root.open({ path: "/p/other.ts" }); // second window again proves closeAll
    h.waits[1]!.resolve(TEXT_OK);
    await settle();
    win(h, 0).handle.tree.toggle("/p/src/sub");
    h.waits[2]!.resolve({ ok: false, status: 409, error: "E_SESSION_CHANGED" });
    await settle();
    expect(h.face.windows.value).toHaveLength(0);
  });

  it("11a: a tree E_SESSION_CHANGED for an already-CLOSED window closes nothing else", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/src", dir: true });
    h.waits[0]!.resolve(DIR_OK(["sub/"]));
    await settle();
    h.root.open({ path: "/p/other.ts" });
    h.waits[1]!.resolve(TEXT_OK);
    await settle();
    win(h, 0).handle.tree.toggle("/p/src/sub"); // parked
    h.face.closeWindow(1);
    h.waits[2]!.resolve({ ok: false, status: 409, error: "E_SESSION_CHANGED" });
    await settle();
    expect(h.face.windows.value.map((w) => w.id)).toEqual([2]); // untouched
    expect(viewOf(h, 0)).toMatchObject({ phase: "text", path: "/p/other.ts" });
  });

  it("11b: a tree E_SESSION_CHANGED from a superseded VISIT (visitEpoch changed) closes nothing", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/src", dir: true });
    h.waits[0]!.resolve(DIR_OK(["sub/"]));
    await settle();
    win(h, 0).handle.tree.toggle("/p/src/sub"); // parked under visit 1
    win(h, 0).handle.open({ path: "/p/next", dir: true }); // THIS window's fresh open ⇒ fresh visit (visitEpoch++, tree cleared)
    h.waits[2]!.resolve(DIR_OK([]));
    await settle();
    h.waits[1]!.resolve({ ok: false, status: 409, error: "E_SESSION_CHANGED" }); // late, old visit
    await settle();
    expect(h.face.windows.value).toHaveLength(1);
    expect(viewOf(h, 0)).toMatchObject({ phase: "dir", path: "/p/next" });
  });

  it("11c: machine-level guard — an old-scope tree error never reaches onSessionChanged", async () => {
    const scope1: PreviewPathScope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true };
    const scope2: PreviewPathScope = { agentKey: "A", sessionId: "s2", cwd: "/p", uploads: true };
    const scope = ref<PreviewPathScope | null>(scope1);
    const calls: Array<{ path: string; signal: AbortSignal }> = [];
    const waits: Array<ReturnType<typeof deferred<PreviewDirOutcome>>> = [];
    const transport: PreviewTransport = {
      fetch: (req, o) => {
        calls.push({ path: req.path, signal: o.signal });
        const d = deferred<PreviewDirOutcome>();
        waits.push(d);
        return d.promise;
      },
    };
    const onSessionChanged = vi.fn();
    const m: PreviewMachine = createPreviewMachine({
      scope,
      preview: transport,
      coarse: ref(false),
      onSessionChanged,
    });
    m.open({ path: "/p/src", dir: true });
    waits[0]!.resolve(DIR_OK(["sub/"]));
    await settle();
    m.tree.toggle("/p/src/sub"); // parked under scope1
    scope.value = scope2; // the scope moved — but the machine itself owns NO watcher
    waits[1]!.resolve({ ok: false, status: 409, error: "E_SESSION_CHANGED" });
    await settle();
    expect(onSessionChanged).not.toHaveBeenCalled(); // old scope ⇒ guarded out
    m.tree.toggle("/p/src/sub2"); // a same-scope tree error DOES route through
    waits[2]!.resolve({ ok: false, status: 409, error: "E_SESSION_CHANGED" });
    await settle();
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    m.dispose();
  });

  it("11d: old-scope probe kinds never leak into the new scope's kindOf", async () => {
    const h = makeHarness({}, { probeKinds: () => "dir" });
    h.root.probe!.ensure(["/p/src"]);
    await flushMacro();
    expect(h.root.probe!.kindOf("/p/src")).toBe("dir");
    switchSession(h);
    await nextTick();
    expect(h.face.windows.value).toHaveLength(0); // windows gone…
    expect(h.root.probe!.kindOf("/p/src")).toBeUndefined(); // …and the kind does not follow
  });
});

describe("usePreviewWindows: history budget end-to-end (§4.5 / §10.1 12)", () => {
  const dataUrl = (n: number): string => `data:image/png;base64,${"A".repeat(n)}`;
  const imageOf = (url: string): PreviewOutcome => ({
    ok: true,
    kind: "image",
    mime: "image/png",
    size: 3,
    dims: { w: 10, h: 10 },
    blob: new Blob([new Uint8Array([80, 78, 71])], { type: "image/png" }),
  });
  /** A FileReader fake that answers a FIXED data: URL (length-controlled, no real base64). */
  const fixedReader = (url: string): (() => FileReaderLike) => {
    return () => {
      const listeners = new Map<string, Array<() => void>>();
      const o: FileReaderLike = {
        result: null,
        addEventListener(type: "load" | "error", listener: () => void) {
          const l = listeners.get(type) ?? [];
          l.push(listener);
          listeners.set(type, l);
        },
        readAsDataURL(_blob: Blob) {
          queueMicrotask(() => {
            (o as { result: unknown }).result = url;
            for (const fn of listeners.get("load") ?? []) fn();
          });
        },
      } as FileReaderLike;
      return o;
    };
  };

  it("12: over-budget history demotes the OLDEST snapshot to a stub; back() over it REFETCHES", async () => {
    const url = dataUrl(200); // 22 + 178 = 200 chars per snapshot
    const h = makeHarness({}, { createFileReader: fixedReader(url), historyBudgetBytes: 300 });
    h.root.open({ path: "/p/1.png" });
    h.waits[0]!.resolve(imageOf(url));
    await settle();
    expect(viewOf(h, 0)).toMatchObject({ phase: "image", path: "/p/1.png" });
    win(h, 0).handle.navigate({ path: "/p/2.png" });
    h.waits[1]!.resolve(imageOf(url));
    await settle();
    win(h, 0).handle.navigate({ path: "/p/3.png" });
    h.waits[2]!.resolve(imageOf(url));
    await settle();
    expect(win(h, 0).handle.stackDepth.value).toBe(2); // [P1(snap), P2(snap)] with P1 demoted
    // back to P2: a live snapshot — restored verbatim, zero requests
    const callsBefore = h.calls.length;
    win(h, 0).handle.back();
    expect(viewOf(h, 0)).toMatchObject({ phase: "image", path: "/p/2.png" });
    expect(h.calls.length).toBe(callsBefore);
    // back to P1: a STUB — refetch by identity
    win(h, 0).handle.back();
    expect(viewOf(h, 0)).toMatchObject({ phase: "loading", path: "/p/1.png" });
    expect(h.calls.length).toBe(callsBefore + 1);
    expect(h.calls.at(-1)!.req.path).toBe("/p/1.png");
    h.waits[3]!.resolve(imageOf(url));
    await settle();
    expect(viewOf(h, 0)).toMatchObject({ phase: "image", path: "/p/1.png" });
  });
});

describe("usePreviewWindows: root handle face (§4.3 / §10.1 13)", () => {
  it("13: root view mirrors the ACTIVE window; retry forwards there; asDirHandle(root) === null", async () => {
    const h = makeHarness();
    h.root.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await settle();
    h.root.open({ path: "/p/b.ts" });
    h.waits[1]!.resolve(TEXT_OK);
    await settle();
    h.face.focusWindow(1); // activate window 1 WITHOUT a focus request
    expect(h.face.activeId.value).toBe(1);
    expect(h.face.focusRequest.value).toEqual({ id: 2, seq: 2 }); // unchanged by plain focusWindow
    expect((h.root.view.value as PreviewView).phase).toBe("text");
    expect(h.root.view.value).toBe(viewOf(h, 0)); // the SAME reactive object
    // the active window falls into an error phase (its own navigate), then root.retry()
    // re-requests ITS path — not window 2's
    win(h, 0).handle.navigate({ path: "/p/a2.ts" });
    h.waits[2]!.resolve({ ok: false, status: 0, error: "E_NETWORK" });
    await settle();
    expect(viewOf(h, 0)).toMatchObject({ phase: "error", path: "/p/a2.ts" });
    const callsBefore = h.calls.length;
    h.root.retry();
    expect(h.calls.length).toBe(callsBefore + 1);
    expect(h.calls.at(-1)!.req.path).toBe("/p/a2.ts");
    h.waits.at(-1)!.resolve(TEXT_OK);
    await settle();
    // no navigation face on the root — W2 must go through asWindowsHandle
    expect(asDirHandle(h.root)).toBeNull();
    h.root.close(); // = closeAll (the privacy relock path)
    expect(h.face.windows.value).toHaveLength(0);
    expect(h.root.view.value).toEqual({ phase: "closed" });
  });

  it("13b: asWindowsHandle — a single-window usePreview handle is NOT a windows handle", async () => {
    const state = makeState();
    const single = usePreview({
      preview: { fetch: () => Promise.resolve(TEXT_OK as PreviewDirOutcome) },
      mode: "token",
      state,
      coarse: ref(false),
      createFileReader: realFileReader,
    });
    expect(asWindowsHandle(single)).toBeNull();
    expect(asDirHandle(single)).not.toBeNull(); // the single-window handle keeps ITS face
    single.dispose();
    const h = makeHarness();
    expect(asWindowsHandle(h.root)).not.toBeNull();
    h.root.dispose();
  });
});
