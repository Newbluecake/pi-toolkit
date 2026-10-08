// @vitest-environment node
import { nextTick, ref, type Ref } from "vue";
import { describe, expect, it } from "vitest";
import {
  asDirHandle,
  PREVIEW_NAV_STACK_MAX,
  usePreview,
  type FileReaderLike,
  type PreviewHandleDir,
} from "../../../src/web-hub/ui/src/composables/usePreview.js";
import type { PreviewDirListing, PreviewProbeKind } from "../../../src/web-hub/protocol/preview.js";
import type { HubState, PreviewView } from "../../../src/web-hub/ui/src/types.js";
import type {
  PreviewDirOutcome,
  PreviewOutcome,
  PreviewTransport,
} from "../../../src/web-hub/ui/src/transport/types.js";

/**
 * web-hub-preview plan v3 §3.2 (package PV4): the usePreview state machine — every phase
 * transition, the seq-guarded interrupts (new open / close / 作用域失效), the scope truth
 * table at the composable level (incl. 默认 on ⇒ password 模式能拿到作用域), the image
 * data-URL conversion with its prefix check, and retry.
 *
 * dir-plan v3.1 §0.2 A3/§5 P3 (appended): the dir phase + in-dialog navigation — open 清栈,
 * navigate push / back pop (snapshot restore, cap 64 FIFO), up's parentPreviewPath boundary,
 * the probe-kind `dir` hint, the one-shot 415 not-regular ⇒ dir=1 fallback, and retry/作用域
 * 失效 keeping the stack honest.
 */

const flush = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function makeState(
  opts: { caps?: unknown[]; selected?: string | null; session?: unknown; hub?: unknown } = {},
): Ref<HubState> {
  const {
    caps = ["preview.v1", "preview.lan.v1"], // 默认 mode:"on" — BOTH caps declared (U1)
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

/** Real base64 conversion through the same readAsDataURL shape the browser's FileReader has. */
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

interface Harness {
  readonly state: Ref<HubState>;
  readonly coarse: Ref<boolean>;
  readonly calls: Array<{
    req: { agentKey: string; sessionId: string; path: string; dir?: true };
    opts: { signal: AbortSignal; maxPixels: number };
  }>;
  readonly waits: Array<ReturnType<typeof deferred<PreviewDirOutcome>>>;
  readonly handle: ReturnType<typeof usePreview>;
  /** The P3 navigation face — `usePreview` always provides it; `asDirHandle` recovers it. */
  readonly nav: PreviewHandleDir;
  /** Settled probe calls (present only when the harness transport carries a probe fn). */
  readonly probeCalls: Array<{ paths: string[]; dirs?: true }>;
}

function makeHarness(
  stateOpts: Parameters<typeof makeState>[0] = {},
  opts: {
    mode?: "token" | "password";
    noTransport?: boolean;
    createFileReader?: () => FileReaderLike;
    probeKinds?: (path: string) => PreviewProbeKind;
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
            return Promise.resolve({
              ok: true as const,
              results: req.paths.map((p) => opts.probeKinds!(p)),
            });
          },
        }
      : {}),
  };
  const handle = usePreview({
    preview: opts.noTransport === true ? undefined : transport,
    mode: opts.mode ?? "token",
    state,
    coarse,
    createFileReader: opts.createFileReader ?? realFileReader,
  });
  const nav = asDirHandle(handle);
  if (nav === null) throw new Error("usePreview must provide the P3 navigation face");
  return { state, coarse, calls, waits, handle, nav, probeCalls };
}

const TEXT_OK: PreviewOutcome = { ok: true, kind: "text", size: 5, truncated: false, text: "hello" };
const IMAGE_OK: PreviewOutcome = {
  ok: true,
  kind: "image",
  mime: "image/png",
  size: 3,
  dims: { w: 10, h: 10 },
  blob: new Blob([new Uint8Array([80, 78, 71])], { type: "image/png" }),
};

describe("usePreview: scope derivation (§4.6 作用域真值表)", () => {
  it("token mode with preview.v1 ⇒ scope {agentKey, sessionId, cwd, uploads}", () => {
    const h = makeHarness();
    expect(h.handle.scope.value).toEqual({ agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true });
  });

  it("password mode under the default caps (preview.v1 + preview.lan.v1, U1 默认 on) ⇒ scope", () => {
    const h = makeHarness({}, { mode: "password" });
    expect(h.handle.scope.value).toEqual({ agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true });
  });

  it("password mode with only preview.v1 (mode loopback) ⇒ null", () => {
    const h = makeHarness({ caps: ["preview.v1"] }, { mode: "password" });
    expect(h.handle.scope.value).toBeNull();
  });

  it("no transport.preview / no caps / no session / nothing selected ⇒ null", () => {
    expect(makeHarness({}, { noTransport: true }).handle.scope.value).toBeNull();
    expect(makeHarness({ caps: [] }).handle.scope.value).toBeNull();
    expect(makeHarness({ hub: null }).handle.scope.value).toBeNull();
    expect(makeHarness({ session: null }).handle.scope.value).toBeNull();
    expect(makeHarness({ selected: null }).handle.scope.value).toBeNull();
  });

  it("open() without a scope is a no-op (nothing clickable)", async () => {
    const h = makeHarness({ caps: [] });
    h.handle.open({ path: "/p/a.ts" });
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(h.handle.view.value.phase).toBe("closed");
  });
});

describe("usePreview: open → loading → text / image (§3.2)", () => {
  it("text outcome flips loading → text; the request carries scope identity + desktop budget", async () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.ts" });
    expect(h.handle.view.value).toEqual({ phase: "loading", path: "/p/a.ts" });
    expect(h.calls[0]!.req).toEqual({ agentKey: "A", sessionId: "s1", path: "/p/a.ts" });
    expect(h.calls[0]!.opts.maxPixels).toBe(40_000_000);
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    expect(h.handle.view.value).toEqual({ phase: "text", path: "/p/a.ts", text: "hello", truncated: false, size: 5 });
  });

  it("coarse pointer (touch) sends the 20MP budget (§0/P2-13)", async () => {
    const h = makeHarness();
    h.coarse.value = true;
    h.handle.open({ path: "/p/a.png" });
    expect(h.calls[0]!.opts.maxPixels).toBe(20_000_000);
    h.handle.dispose();
  });

  it("image outcome converts Blob → data: URL (D1, never blob:) and flips to image", async () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.png" });
    h.waits[0]!.resolve(IMAGE_OK);
    await flush();
    const v = h.handle.view.value;
    expect(v.phase).toBe("image");
    if (v.phase === "image") {
      expect(v.dataUrl).toBe(`data:image/png;base64,${Buffer.from([80, 78, 71]).toString("base64")}`);
      expect(v.dims).toEqual({ w: 10, h: 10 });
      expect(v.size).toBe(3);
    }
  });

  it("a data-URL prefix mismatch (server/FileReader disagreement) ⇒ error E_BAD_DATA_URL", async () => {
    const badReader = (): FileReaderLike => {
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
            (o as { result: unknown }).result = "data:image/gif;base64,AAAA";
            for (const fn of listeners.get("load") ?? []) fn();
          });
        },
      } as FileReaderLike;
      return o;
    };
    const h = makeHarness({}, { createFileReader: badReader });
    h.handle.open({ path: "/p/a.png" });
    h.waits[0]!.resolve(IMAGE_OK);
    await flush();
    expect(h.handle.view.value).toEqual({
      phase: "error",
      path: "/p/a.png",
      error: "E_BAD_DATA_URL",
      retryable: false,
    });
  });
});

describe("usePreview: error taxonomy (§3.2 classifyPreviewError → phase)", () => {
  const open1 = async (h: Harness, outcome: PreviewOutcome): Promise<PreviewView> => {
    h.handle.open({ path: "/p/a.bin" });
    h.waits[0]!.resolve(outcome);
    await flush();
    return h.handle.view.value;
  };

  it("415 E_PREVIEW_UNSUPPORTED ⇒ unsupported (reason/size ride through)", async () => {
    const h = makeHarness();
    expect(
      await open1(h, { ok: false, status: 415, error: "E_PREVIEW_UNSUPPORTED", reason: "binary", size: 42 }),
    ).toEqual({
      phase: "unsupported",
      path: "/p/a.bin",
      reason: "binary",
      size: 42,
    });
  });

  it("E_PREVIEW_TOO_LARGE (server 413 or client budget) ⇒ tooLarge with dims", async () => {
    const h = makeHarness();
    expect(
      await open1(h, {
        ok: false,
        status: 0,
        error: "E_PREVIEW_TOO_LARGE",
        reason: "pixels",
        size: 9,
        max: 20_000_000,
        dims: { w: 8000, h: 4000 },
      }),
    ).toEqual({
      phase: "tooLarge",
      path: "/p/a.bin",
      reason: "pixels",
      size: 9,
      max: 20_000_000,
      dims: { w: 8000, h: 4000 },
    });
  });

  it("E_SESSION_CHANGED ⇒ closes directly (the transcript itself is reloading)", async () => {
    const h = makeHarness();
    expect(await open1(h, { ok: false, status: 409, error: "E_SESSION_CHANGED" })).toEqual({ phase: "closed" });
  });

  it("retryable transport failures ⇒ error with retryable:true; denials ⇒ retryable:false", async () => {
    const h1 = makeHarness();
    expect(await open1(h1, { ok: false, status: 0, error: "E_DEADLINE" })).toEqual({
      phase: "error",
      path: "/p/a.bin",
      error: "E_DEADLINE",
      retryable: true,
    });
    const h2 = makeHarness();
    expect(await open1(h2, { ok: false, status: 403, error: "E_PREVIEW_DENIED", reason: "denylist" })).toEqual({
      phase: "error",
      path: "/p/a.bin",
      error: "E_PREVIEW_DENIED",
      retryable: false,
    });
    const h3 = makeHarness();
    expect(await open1(h3, { ok: false, status: 429, error: "E_RATE", retryAfterS: 2 })).toEqual({
      phase: "error",
      path: "/p/a.bin",
      error: "E_RATE",
      retryable: true,
      retryAfterS: 2,
    });
  });

  it("retry() re-opens the same path under a fresh request; non-error phases can't retry", async () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve({ ok: false, status: 0, error: "E_NETWORK" });
    await flush();
    expect(h.handle.view.value.phase).toBe("error");
    h.handle.retry();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.req.path).toBe("/p/a.ts");
    expect(h.handle.view.value).toEqual({ phase: "loading", path: "/p/a.ts" });
    h.waits[1]!.resolve(TEXT_OK);
    await flush();
    expect(h.handle.view.value.phase).toBe("text");
    h.handle.retry(); // no-op now
    expect(h.calls).toHaveLength(2);
  });
});

describe("usePreview: interrupts (§3.2 — abort + seq drop)", () => {
  it("a new open aborts the in-flight fetch and drops its late outcome", async () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.ts" });
    h.handle.open({ path: "/p/b.ts" });
    expect(h.calls[0]!.opts.signal.aborted).toBe(true);
    h.waits[0]!.resolve(TEXT_OK); // late — must be dropped
    await flush();
    expect(h.handle.view.value).toEqual({ phase: "loading", path: "/p/b.ts" });
    h.waits[1]!.resolve(TEXT_OK);
    await flush();
    expect(h.handle.view.value).toMatchObject({ phase: "text", path: "/p/b.ts" });
  });

  it("close() aborts the in-flight fetch and drops its late outcome", async () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.ts" });
    h.handle.close();
    expect(h.calls[0]!.opts.signal.aborted).toBe(true);
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    expect(h.handle.view.value).toEqual({ phase: "closed" });
  });

  it("作用域失效: sessionId change ⇒ abort + close (§3.2 watch(scopeKey))", async () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.ts" });
    expect(h.handle.view.value.phase).toBe("loading");
    const agents = new Map(h.state.value.agents);
    const a = agents.get("A") as Record<string, unknown>;
    const session = { ...(a.session as Record<string, unknown>), sessionId: "s2" };
    agents.set("A", { ...a, session, card: { session } });
    h.state.value = { ...h.state.value, agents } as unknown as HubState;
    await nextTick();
    expect(h.calls[0]!.opts.signal.aborted).toBe(true);
    expect(h.handle.view.value).toEqual({ phase: "closed" });
    h.waits[0]!.resolve(TEXT_OK); // late — dropped
    await flush();
    expect(h.handle.view.value).toEqual({ phase: "closed" });
  });

  it("作用域失效: cwd drift with the SAME sessionId (v3-2 双保险) ⇒ abort + close", async () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.ts" });
    const agents = new Map(h.state.value.agents);
    const a = agents.get("A") as Record<string, unknown>;
    const session = { ...(a.session as Record<string, unknown>), cwd: "/q" };
    agents.set("A", { ...a, session, card: { session } });
    h.state.value = { ...h.state.value, agents } as unknown as HubState;
    await nextTick();
    expect(h.calls[0]!.opts.signal.aborted).toBe(true);
    expect(h.handle.view.value).toEqual({ phase: "closed" });
  });

  it("an aborted in-flight image conversion is dropped even after the fetch resolved", async () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.png" });
    h.waits[0]!.resolve(IMAGE_OK);
    h.handle.close(); // close while readAsDataURL is still pending
    await flush();
    expect(h.handle.view.value).toEqual({ phase: "closed" });
  });

  it("dispose() aborts in-flight work and is idempotent", () => {
    const h = makeHarness();
    h.handle.open({ path: "/p/a.ts" });
    h.handle.dispose();
    h.handle.dispose();
    expect(h.calls[0]!.opts.signal.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 §0.2 A3/§5 P3 — dir phase + in-dialog navigation
// ---------------------------------------------------------------------------

function makeListing(names: string[], opts: Partial<PreviewDirListing> = {}): PreviewDirListing {
  const entries = names.map((name) => ({
    name,
    type: name.endsWith("/") ? ("dir" as const) : ("file" as const),
    size: name.endsWith("/") ? undefined : 1,
    mtimeMs: 1_700_000_000_000,
  }));
  return {
    entries: entries.map((e) => (e.type === "dir" ? { ...e, name: e.name.slice(0, -1) } : e)),
    total: entries.length,
    scanned: entries.length,
    complete: true,
    truncated: false,
    limits: { scan: false, entries: false, bytes: false },
    vanished: 0,
    dropped: 0,
    ...opts,
  };
}

const DIR_OK = (names: string[]): PreviewDirOutcome => ({ ok: true, kind: "dir", listing: makeListing(names) });

const flushMacro = async (): Promise<void> => {
  // the probe pipeline flushes on a setTimeout(0) macrotask; then settle the microtasks
  await new Promise((r) => setTimeout(r, 0));
  await flush();
};

describe("usePreview: dir phase + navigation (dir-plan §0.2 A3, P3)", () => {
  it("a dir:true request resolves the dir phase (exhaustive narrowing of PreviewDirOutcome)", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/src", dir: true });
    expect(h.calls[0]!.req.dir).toBe(true);
    h.waits[0]!.resolve(DIR_OK(["a.ts", "b/"]));
    await flush();
    expect(h.nav.view.value).toEqual({ phase: "dir", path: "/p/src", listing: makeListing(["a.ts", "b/"]) });
  });

  it("navigate pushes the current content view; back() restores the snapshot with NO refetch", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    expect(h.nav.view.value.phase).toBe("text");
    expect(h.nav.stackDepth.value).toBe(0);

    h.nav.navigate({ path: "/p/b.ts" });
    expect(h.nav.stackDepth.value).toBe(1);
    expect(h.nav.view.value).toEqual({ phase: "loading", path: "/p/b.ts" });
    h.waits[1]!.resolve({ ok: true, kind: "text", size: 2, truncated: false, text: "bb" });
    await flush();
    expect(h.nav.view.value).toMatchObject({ phase: "text", path: "/p/b.ts" });

    const callsBefore = h.calls.length;
    h.nav.back();
    expect(h.nav.stackDepth.value).toBe(0);
    // the snapshot is restored verbatim — byte-identical view object, zero new requests
    expect(h.nav.view.value).toEqual({ phase: "text", path: "/p/a.ts", text: "hello", truncated: false, size: 5 });
    expect(h.calls.length).toBe(callsBefore);
    h.nav.back(); // bottom — no-op
    expect(h.nav.view.value.phase).toBe("text");
    expect(h.calls.length).toBe(callsBefore);
  });

  it("下钻 → 文件 → 返回 → 返回 (D3): every hop is one back away", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/src", dir: true });
    h.waits[0]!.resolve(DIR_OK(["sub/"]));
    await flush();
    h.nav.navigate({ path: "/p/src/sub", dir: true }); // 下钻
    h.waits[1]!.resolve(DIR_OK(["f.ts"]));
    await flush();
    h.nav.navigate({ path: "/p/src/sub/f.ts" }); // 打开文件
    h.waits[2]!.resolve({ ok: true, kind: "text", size: 1, truncated: false, text: "f" });
    await flush();
    expect(h.nav.stackDepth.value).toBe(2);
    h.nav.back(); // → sub listing
    expect(h.nav.view.value).toMatchObject({ phase: "dir", path: "/p/src/sub" });
    h.nav.back(); // → src listing
    expect(h.nav.view.value).toMatchObject({ phase: "dir", path: "/p/src" });
    expect(h.nav.stackDepth.value).toBe(0);
  });

  it("open() clears the history stack (a transcript click starts a fresh visit)", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    h.nav.navigate({ path: "/p/b.ts" });
    expect(h.nav.stackDepth.value).toBe(1);
    h.nav.open({ path: "/p/c.ts" });
    expect(h.nav.stackDepth.value).toBe(0);
    h.nav.back();
    expect(h.nav.view.value).toEqual({ phase: "loading", path: "/p/c.ts" }); // nothing to pop
  });

  it("close() and 作用域失效 clear the stack too", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    h.nav.navigate({ path: "/p/b.ts" });
    h.nav.close();
    expect(h.nav.stackDepth.value).toBe(0);
    expect(h.nav.view.value).toEqual({ phase: "closed" });

    h.nav.open({ path: "/p/a.ts" });
    h.waits[1]!.resolve(TEXT_OK);
    await flush();
    h.nav.navigate({ path: "/p/b.ts" });
    const agents = new Map(h.state.value.agents);
    const a = agents.get("A") as Record<string, unknown>;
    const session = { ...(a.session as Record<string, unknown>), sessionId: "s2" };
    agents.set("A", { ...a, session, card: { session } });
    h.state.value = { ...h.state.value, agents } as unknown as HubState;
    await nextTick();
    expect(h.nav.stackDepth.value).toBe(0);
    expect(h.nav.view.value).toEqual({ phase: "closed" });
  });

  it("the stack is capped at 64 — the oldest snapshot falls out (FIFO)", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/v0" });
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    for (let i = 1; i <= PREVIEW_NAV_STACK_MAX + 1; i++) {
      h.nav.navigate({ path: `/p/v${i}` });
      h.waits[i]!.resolve({ ok: true, kind: "text", size: 1, truncated: false, text: `v${i}` });
      await flush();
    }
    expect(h.nav.stackDepth.value).toBe(PREVIEW_NAV_STACK_MAX);
    for (let i = 0; i < PREVIEW_NAV_STACK_MAX; i++) h.nav.back();
    // v0 fell out: the deepest restorable snapshot is v1
    expect(h.nav.view.value).toMatchObject({ phase: "text", path: "/p/v1" });
    expect(h.nav.stackDepth.value).toBe(0);
    h.nav.back(); // bottom — no-op
    expect(h.nav.view.value).toMatchObject({ phase: "text", path: "/p/v1" });
  });

  it("back() during loading aborts the in-flight fetch and drops its late outcome", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    h.nav.navigate({ path: "/p/b.ts" }); // stays loading (deferred parked)
    expect(h.nav.view.value.phase).toBe("loading");
    h.nav.back();
    expect(h.calls[1]!.opts.signal.aborted).toBe(true);
    expect(h.nav.view.value).toMatchObject({ phase: "text", path: "/p/a.ts" });
    h.waits[1]!.resolve(TEXT_OK); // late — dropped
    await flush();
    expect(h.nav.view.value).toMatchObject({ phase: "text", path: "/p/a.ts" });
  });

  it("retry() re-loads the same path WITHOUT touching the history stack", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    h.nav.navigate({ path: "/p/b.ts" });
    h.waits[1]!.resolve({ ok: false, status: 0, error: "E_NETWORK" });
    await flush();
    expect(h.nav.view.value.phase).toBe("error");
    expect(h.nav.stackDepth.value).toBe(1);
    h.handle.retry();
    expect(h.calls[2]!.req.path).toBe("/p/b.ts");
    expect(h.nav.stackDepth.value).toBe(1); // untouched
    h.waits[2]!.resolve(TEXT_OK);
    await flush();
    h.nav.back();
    expect(h.nav.view.value).toMatchObject({ phase: "text", path: "/p/a.ts" });
  });

  it("up() navigates to parentPreviewPath with dir:true; a one-segment path greys out (no-op)", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/home/u/proj", dir: true });
    h.waits[0]!.resolve(DIR_OK([]));
    await flush();
    h.nav.up();
    expect(h.nav.stackDepth.value).toBe(1); // up is a navigation — the listing is 返回-able
    expect(h.calls[1]!.req).toMatchObject({ path: "/home/u", dir: true });
    h.waits[1]!.resolve(DIR_OK([]));
    await flush();
    h.nav.up();
    h.waits[2]!.resolve(DIR_OK([]));
    await flush();
    expect(h.calls[2]!.req).toMatchObject({ path: "/home", dir: true });
    h.nav.up(); // parent of /home is / — not listable: no-op
    expect(h.calls).toHaveLength(3);
    h.nav.back();
    h.nav.back();
    h.nav.back();
    expect(h.nav.view.value).toMatchObject({ phase: "dir", path: "/home/u/proj" });
  });

  it("up() from a closed view is a no-op; navigate without a scope never pushes", async () => {
    const h = makeHarness();
    h.nav.up();
    expect(h.calls).toHaveLength(0);
    h.state.value = { ...h.state.value, selected: null } as unknown as HubState;
    await nextTick();
    h.nav.navigate({ path: "/p/x" });
    expect(h.nav.stackDepth.value).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it("a navigate from a transient phase (error) pushes nothing — nothing to return to", async () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve({ ok: false, status: 403, error: "E_PREVIEW_DENIED" });
    await flush();
    expect(h.nav.view.value.phase).toBe("error");
    h.nav.navigate({ path: "/p/b.ts" }); // defensive: error bodies render no refs
    expect(h.nav.stackDepth.value).toBe(0);
    h.waits[1]!.resolve(TEXT_OK);
    await flush();
    expect(h.nav.view.value).toMatchObject({ phase: "text", path: "/p/b.ts" });
  });

  it('probe kind "dir" sets the dir=1 opt-in directly (no discovery round trip)', async () => {
    const h = makeHarness(
      { caps: ["preview.v1", "preview.dir.v1"] },
      { probeKinds: (p) => (p === "/p/src" ? "dir" : "text") },
    );
    // settle the probe pipeline first (flush is on a macrotask)
    h.handle.probe!.ensure(["/p/src"]);
    await flushMacro();
    expect(h.probeCalls[0]!.dirs).toBe(true); // dirs passthrough (§5 P3)
    h.nav.open({ path: "/p/src" }); // no explicit dir flag — the hint decides
    expect(h.calls[0]!.req.dir).toBe(true);
    h.waits[0]!.resolve(DIR_OK(["x.ts"]));
    await flush();
    expect(h.nav.view.value).toMatchObject({ phase: "dir", path: "/p/src" });
  });

  it("a non-dir kind never sets dir; an unknown kind falls back to a plain fetch", async () => {
    const h = makeHarness({ caps: ["preview.v1", "preview.dir.v1"] }, { probeKinds: () => "text" });
    h.handle.probe!.ensure(["/p/a.ts"]);
    await flushMacro();
    h.nav.open({ path: "/p/a.ts" });
    expect(h.calls[0]!.req.dir).toBeUndefined();
    h.waits[0]!.resolve(TEXT_OK);
    await flush();
    expect(h.nav.view.value.phase).toBe("text");
  });

  it("415 not-regular + dirs scope ⇒ ONE re-fetch with dir=1 ⇒ dir phase (the fallback)", async () => {
    const h = makeHarness({ caps: ["preview.v1", "preview.dir.v1"] });
    h.nav.open({ path: "/p/src" });
    expect(h.calls[0]!.req.dir).toBeUndefined();
    h.waits[0]!.resolve({ ok: false, status: 415, error: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" });
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.req).toMatchObject({ path: "/p/src", dir: true });
    h.waits[1]!.resolve(DIR_OK(["a.ts"]));
    await flush();
    expect(h.nav.view.value).toMatchObject({ phase: "dir", path: "/p/src" });
    expect(h.nav.stackDepth.value).toBe(0); // the fallback is internal — no history entry
  });

  it("a REAL non-regular file 415s again — the error phase surfaces, exactly one retry", async () => {
    const h = makeHarness({ caps: ["preview.v1", "preview.dir.v1"] });
    h.nav.open({ path: "/dev/pipe0" });
    h.waits[0]!.resolve({ ok: false, status: 415, error: "E_PREVIEW_UNSUPPORTED", reason: "not-regular", size: 0 });
    await flush();
    h.waits[1]!.resolve({ ok: false, status: 415, error: "E_PREVIEW_UNSUPPORTED", reason: "not-regular", size: 0 });
    await flush();
    expect(h.calls).toHaveLength(2); // never a third
    expect(h.nav.view.value).toEqual({ phase: "unsupported", path: "/dev/pipe0", reason: "not-regular", size: 0 });
  });

  it("no dirs cap ⇒ no fallback: the 415 surfaces directly; an explicit dir fetch never re-falls-back", async () => {
    const h1 = makeHarness(); // default caps: no preview.dir.v1
    h1.nav.open({ path: "/p/src" });
    h1.waits[0]!.resolve({ ok: false, status: 415, error: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" });
    await flush();
    expect(h1.calls).toHaveLength(1);
    expect(h1.nav.view.value).toMatchObject({ phase: "unsupported" });

    const h2 = makeHarness({ caps: ["preview.v1", "preview.dir.v1"] });
    h2.nav.open({ path: "/p/src", dir: true });
    h2.waits[0]!.resolve({ ok: false, status: 415, error: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" });
    await flush();
    expect(h2.calls).toHaveLength(1); // wantDir — the fallback is one-shot only
    expect(h2.nav.view.value).toMatchObject({ phase: "unsupported" });
  });

  it("dispose() clears the stack and is idempotent", () => {
    const h = makeHarness();
    h.nav.open({ path: "/p/a.ts" });
    h.waits[0]!.resolve(TEXT_OK);
    h.nav.navigate({ path: "/p/b.ts" });
    h.nav.dispose();
    h.nav.dispose();
    expect(h.nav.stackDepth.value).toBe(0);
    expect(h.calls[1]!.opts.signal.aborted).toBe(true);
  });
});
