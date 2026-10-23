/**
 * Preview-perf PB probe page (docs/dev/preview-perf/plan.md §6.1). Mounts the REAL preview
 * stack — PreviewHost + usePreviewWindows + PreviewWindow/PreviewText (and, once P3 lands,
 * VirtualCode behind the `virtual=1` switch) — over an in-memory fake transport, plus a fake
 * transcript whose PathText chips open windows through the exact production click path.
 *
 * Everything here is TEST code: it may use rAF/PerformanceObserver freely (the product's
 * source-scan rules do not apply to csp-probe/), and it serves no purpose in the shipped
 * bundle (built only under `--mode csp-probe`, never in `dist/web-hub-ui/`).
 *
 * The Node runner (`scripts/web-hub/preview-perf-probe.ts`) drives this page through
 * `window.__pp` with REAL Playwright mouse/keyboard input; timings come from in-page
 * event.timeStamp → 2nd rAF (open-to-frame) and CDP metrics/tracing.
 *
 * Corpus: the six sha-pinned files under tests/fixtures/preview-perf/ are fetched once over
 * HTTP from the runner's `/corpus/*` route and cached in memory (opens measure render, not
 * network). `log-8mib` is generated at load from the seed pinned in manifest.json (plan
 * §6.1「运行时用固定种子生成」), with ONE chunk boundary deliberately splitting a surrogate
 * pair (the P3 find-differential precondition).
 */
// Global styles in the exact main.ts → App.vue order, so the preview window CSS and base
// typography match the shipped bundle.
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/primitives.css";
import "../src/styles/notices.css";
import "../src/styles/shell.css";
import "../src/styles/agents.css";
import "../src/styles/detail.css";
import "../src/styles/dock.css";
import "../src/styles/login.css";
import "../src/styles/login-2fa.css";
import "../src/styles/states.css";
import "../src/styles/control.css";
import "../src/styles/dialog.css";
import "../src/styles/ask-float.css";
import "../src/styles/preview.css";
import "../src/styles/privacy.css";
import "../src/styles/highlight.css";
import { createApp, defineComponent, h, provide, ref, type InjectionKey, type Ref } from "vue";
import IconSprite from "../src/icons/IconSprite.vue";
import PathText from "../src/components/preview/PathText.vue";
import PreviewHost from "../src/components/preview/PreviewHost.vue";
import { HUB_CTX } from "../src/components/control/controlContext.js";
import { PREVIEW_CTX } from "../src/components/preview/previewContext.js";
import { usePreviewWindows } from "../src/composables/usePreviewWindows.js";
import type { HubState } from "../src/types.js";
import type { PreviewDirOutcome, PreviewTransport } from "../src/transport/types.js";

/** /work/<file> — the fake session cwd is /work, so every corpus path is in-cwd. */
const CORPUS_FILES = ["stack-3609.ts", "hl-600.ts", "hl-601.ts", "uploads-2292.ts", "longline.js", "wide-1200.md"];
const PATH_PREFIX = "/work/";
const STREAM_PATH = PATH_PREFIX + "log-8mib";
/** must satisfy PREVIEW_IDENT_RE (`i1.` + 22 base64url chars). */
const CHUNK_IDENT = "i1.ABCDEFGHIJKLMNOPQRSTUva";
/** plan §6.1 fake hub caps: preview scope + abs + chunk (drives the real streaming machine). */
const HUB_CAPS = ["preview.v1", "preview.lan.v1", "preview.abs.v1", "preview.chunk.v1"];

/** Mirrors manifest.json's `log8mib` block (update both together — the runner verifies). */
const LOG8 = {
  seed: 0x0b1701,
  totalBytes: 8 * 1024 * 1024,
  firstChunkBytes: 256 * 1024,
  nextChunkBytes: 1024 * 1024,
  emojiLineEvery: 1024,
  /** 1-based chunk-boundary number forced to split a surrogate pair. */
  surrogateSplitBoundary: 5,
} as const;

interface CorpusEntry {
  readonly text: string;
  readonly bytes: number;
  /** streamable only for log-8mib */
  readonly streamable: boolean;
}

/** Deterministic PRNG — same algorithm as gen-corpus.mjs (manifest-pinned seed). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

interface ChunkBoundary {
  /** UTF-16 slice point into `text` (end of the chunk, exclusive). */
  readonly u16: number;
  /** cumulative UTF-8 bytes at `u16`. */
  readonly bytes: number;
  readonly splitsSurrogate: boolean;
}

/** The 8 MiB streaming log: ASCII lines, one emoji line every `emojiLineEvery` (multi-byte,
 *  so a chunk boundary can be forced to split a surrogate pair), seeded `aaaa`/`a` runs for
 *  the P3 find differential. Returns the text plus the exact chunk plan the fake serves. */
function buildLog8(): { text: string; boundaries: readonly ChunkBoundary[] } {
  const rand = mulberry32(LOG8.seed);
  const words = ["INFO", "WARN", "DEBUG", "ERROR", "preview", "window", "chunk", "stream", "session", "agent"];
  const lines: string[] = [];
  let bytes = 0;
  let idx = 0;
  while (bytes < LOG8.totalBytes) {
    idx++;
    let line: string;
    if (idx % LOG8.emojiLineEvery === 0) line = `${idx} emoji 📊🚀🧪 run ${Math.floor(rand() * 1e6)}\n`;
    else if (idx % 977 === 0) line = `${idx} aaaa a a aaaa run ${"a".repeat(3 + Math.floor(rand() * 6))}\n`;
    else {
      const parts: string[] = [];
      const n = 6 + Math.floor(rand() * 10);
      for (let i = 0; i < n; i++) parts.push(words[Math.floor(rand() * words.length)]!);
      line = `${idx} ${parts.join(" ")} t=${Math.floor(rand() * 1e9)}\n`;
    }
    const lb = utf8Len(line);
    if (bytes + lb > LOG8.totalBytes) {
      // final ASCII filler hits totalBytes exactly
      const body = LOG8.totalBytes - bytes - 1 - String(idx).length - 1;
      lines.push(`${idx} ${"x".repeat(Math.max(1, body))}\n`);
      bytes = LOG8.totalBytes;
      break;
    }
    lines.push(line);
    bytes += lb;
  }
  const text = lines.join("");
  // per-line cumulative byte/UTF-16 offsets (index = line number, length = lines+1)
  const startB: number[] = [0];
  const startU: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    startB.push(startB[i]! + utf8Len(lines[i]!));
    startU.push(startU[i]! + lines[i]!.length);
  }
  // emoji lines' UTF-16 starts (for the forced surrogate split)
  const emojiStartsU: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((i + 1) % LOG8.emojiLineEvery === 0) emojiStartsU.push(startU[i]!);
  }
  function firstSurrogateSplitAfter(fromU: number): number {
    // first surrogate pair strictly after fromU (+32, so the split lands inside this chunk)
    for (const es of emojiStartsU) {
      if (es <= fromU + 32) continue;
      for (let i = es; i < Math.min(text.length, es + 128); i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) return i + 1; // between high and low surrogate
      }
    }
    return -1;
  }
  const boundaries: ChunkBoundary[] = [];
  let prevU = 0;
  let prevB = 0;
  let chunkIdx = 0;
  while (prevB < LOG8.totalBytes) {
    const size = chunkIdx === 0 ? LOG8.firstChunkBytes : LOG8.nextChunkBytes;
    const target = prevB + size;
    let u = -1;
    let splits = false;
    if (chunkIdx === LOG8.surrogateSplitBoundary - 1 && target < LOG8.totalBytes) {
      u = firstSurrogateSplitAfter(prevU);
      splits = u > 0;
    }
    if (u <= 0) {
      if (target >= LOG8.totalBytes) u = text.length;
      else {
        // snap to the first line start at/after `target` bytes (never mid-codepoint)
        let lo = 0;
        let hi = startB.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (startB[mid]! < target) lo = mid + 1;
          else hi = mid;
        }
        u = startU[lo] ?? text.length;
        if (u <= prevU) u = Math.min(text.length, prevU + 1);
      }
    }
    const b = Math.min(LOG8.totalBytes, prevB + utf8Len(text.slice(prevU, u)));
    const last = u >= text.length || b >= LOG8.totalBytes;
    boundaries.push({ u16: last ? text.length : u, bytes: last ? LOG8.totalBytes : b, splitsSurrogate: splits });
    if (last) break;
    prevU = u;
    prevB = b;
    chunkIdx++;
  }
  return { text, boundaries };
}

const corpus = new Map<string, CorpusEntry>();
let log8: { text: string; boundaries: readonly ChunkBoundary[] } | null = null;

function textOutcome(text: string, bytes: number, size: number, truncated: boolean): PreviewDirOutcome {
  return { ok: true, kind: "text", size, truncated, text, bytes };
}

function makeTransport(): PreviewTransport {
  return {
    fetch(req): Promise<PreviewDirOutcome> {
      const entry = corpus.get(req.path);
      if (entry === undefined) return Promise.resolve({ ok: false, status: 404, error: "E_NOT_FOUND" });
      if (req.dir === true) return Promise.resolve({ ok: false, status: 415, error: "E_BAD_REQUEST" });
      if (req.chunk === undefined || !entry.streamable || log8 === null) {
        // one-shot full body (also: streamable corpus requested WITHOUT the chunk opt-in)
        return Promise.resolve(textOutcome(entry.text, entry.bytes, entry.bytes, false));
      }
      const b = log8.boundaries;
      if (req.chunk === true) {
        const first = b[0]!;
        return Promise.resolve({
          ...textOutcome(log8.text.slice(0, first.u16), first.bytes, LOG8.totalBytes, true),
          chunk: { offset: 0, ident: CHUNK_IDENT },
        } as PreviewDirOutcome);
      }
      const cont = req.chunk;
      if (cont.ident !== CHUNK_IDENT) {
        return Promise.resolve({ ok: false, status: 409, error: "E_PREVIEW_CHANGED" });
      }
      let i = b.findIndex((x) => x.bytes === cont.offset);
      if (i < 0) {
        i = b.findIndex((x) => x.bytes >= cont.offset);
        if (i < 0) return Promise.resolve({ ok: false, status: 409, error: "E_PREVIEW_CHANGED" });
      }
      const next = b[i + 1];
      const last = next === undefined;
      const out = textOutcome(
        log8.text.slice(b[i]!.u16, last ? log8.text.length : next.u16),
        (last ? LOG8.totalBytes : next.bytes) - b[i]!.bytes,
        LOG8.totalBytes,
        !last,
      );
      return Promise.resolve(
        last ? out : ({ ...out, chunk: { offset: b[i]!.bytes, ident: CHUNK_IDENT } } as PreviewDirOutcome),
      );
    },
  };
}

// --- in-page collectors (test code — rAF allowed) -------------------------------
interface GapState {
  gaps: number[];
  longtasks: number[];
  longtaskSupported: boolean;
  last: number;
  obs: PerformanceObserver | null;
}
let gapSample: GapState | null = null;
let rafRunning = false;

function gapLoop(): void {
  if (!rafRunning) return;
  const now = performance.now();
  if (gapSample !== null) {
    if (gapSample.last > 0) gapSample.gaps.push(now - gapSample.last);
    gapSample.last = now;
  }
  requestAnimationFrame(gapLoop);
}

function beginGaps(): void {
  const supported =
    typeof PerformanceObserver !== "undefined" &&
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    PerformanceObserver.supportedEntryTypes.includes("longtask");
  const s: GapState = { gaps: [], longtasks: [], longtaskSupported: supported, last: 0, obs: null };
  if (supported) {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.longtasks.push(e.duration);
    });
    obs.observe({ type: "longtask", buffered: false });
    s.obs = obs;
  }
  gapSample = s;
  if (!rafRunning) {
    rafRunning = true;
    requestAnimationFrame(gapLoop);
  }
}

function endGaps(): { p95: number; max: number; n: number; longtasks: number[]; longtaskSupported: boolean } {
  const s = gapSample;
  gapSample = null;
  if (s === null) return { p95: 0, max: 0, n: 0, longtasks: [], longtaskSupported: false };
  s.obs?.disconnect();
  const gaps = s.gaps.filter((g) => g > 0).sort((a, b) => a - b);
  const at = (p: number): number =>
    gaps.length === 0 ? 0 : gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]!;
  return {
    p95: at(0.95),
    max: gaps.length === 0 ? 0 : gaps[gaps.length - 1]!,
    n: gaps.length,
    longtasks: [...s.longtasks],
    longtaskSupported: s.longtaskSupported,
  };
}

// --- open-to-frame ---------------------------------------------------------------
let openT0 = 0;
let openArmed = false;
const OPEN_SELECTOR = ".preview-window :is(.pv-line, .preview-text-body, .preview-md, .preview-seg)";

function txId(file: string): string {
  return `pp-tx-${file.replace(/\./g, "-")}`;
}

function armOpen(path: string): boolean {
  const file = path.slice(PATH_PREFIX.length);
  const el = document.querySelector(`#${txId(file)} .path-ref`);
  if (el === null) return false;
  openT0 = 0;
  openArmed = true;
  el.addEventListener(
    "click",
    (ev) => {
      if (openArmed) openT0 = ev.timeStamp;
    },
    { capture: true, once: true },
  );
  return true;
}

function collectOpen(timeoutMs = 20_000): Promise<{ ms: number }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = (): void => {
      if (document.querySelector(OPEN_SELECTOR) !== null && openT0 > 0) {
        // the 2nd rAF after the first line element ≈ presented (plan §6.1)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve({ ms: performance.now() - openT0 }));
        });
        return;
      }
      if (performance.now() - started > timeoutMs) {
        resolve({ ms: -1 });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// --- app --------------------------------------------------------------------------
const virtualOn = new URLSearchParams(location.search).get("virtual") === "1";

const state = ref({
  clientId: "pp",
  hub: { caps: HUB_CAPS },
  conn: "open",
  selected: "A",
  agents: new Map([
    [
      "A",
      {
        key: "A",
        card: { session: { sessionId: "pp-1", sessionFile: "/pp/s.jsonl", cwd: "/work" } },
        session: { sessionId: "pp-1", sessionFile: "/pp/s.jsonl", cwd: "/work" },
      },
    ],
  ]),
  order: ["A"],
}) as unknown as Ref<HubState>;

const appTransport = makeTransport();
const handle = usePreviewWindows({ preview: appTransport, mode: "token", state, coarse: ref(false) });

const ProbeApp = defineComponent({
  name: "PreviewPerfProbe",
  setup() {
    provide(PREVIEW_CTX, { handle, plaintext: false });
    // the hub face the preview tree reads (state + preview transport); cast — the real
    // ControlHub type drags in the whole control plane the probe never exercises.
    provide(HUB_CTX as InjectionKey<unknown>, { state, preview: appTransport, dispatch: () => {} });
    // The transcript strip is pinned bottom-left ABOVE the modeless overlay (z 25/60):
    // cascading windows would otherwise cover the chips and block the real click path. A
    // :style OBJECT binding (CSSOM writes — never a style attribute) stays CSP-clean, the
    // exact construct `probe:csp` verified.
    const stripStyle = {
      position: "fixed",
      left: "8px",
      bottom: "8px",
      zIndex: 70,
      maxWidth: "430px",
      maxHeight: "40vh",
      overflow: "auto",
      padding: "6px 10px",
      background: "var(--c-surface, #fff)",
      border: "1px solid var(--c-border, #888)",
      fontSize: "12px",
    };
    const tx = (f: string) => h("p", { id: txId(f) }, [h(PathText, { text: ` see ${PATH_PREFIX}${f} for details ` })]);
    return () =>
      h("main", { class: "pp-shell", "data-pp-virtual": virtualOn ? "1" : "0" }, [
        h(IconSprite),
        h("div", { class: "pp-tx", role: "region", "aria-label": "transcript", style: stripStyle }, [
          h("p", {}, "preview-perf probe corpus:"),
          ...CORPUS_FILES.map(tx),
          h("p", { id: txId("log-8mib") }, [h(PathText, { text: ` tail ${STREAM_PATH} ` })]),
        ]),
        h(PreviewHost),
      ]);
  },
});

const violations: Array<{ directive: string; uri: string }> = [];
document.addEventListener("securitypolicyviolation", (e) => {
  violations.push({ directive: e.violatedDirective, uri: e.blockedURI });
});

function activeWindowEl(): HTMLElement | null {
  const wins = document.querySelectorAll<HTMLElement>(".preview-window");
  return wins.length === 0 ? null : (wins[wins.length - 1] as HTMLElement);
}

interface StreamInfo {
  state: string;
  chunks: number;
  loaded: number;
  total: number;
  segCount: number;
}

function streamInfo(): StreamInfo | null {
  // `handle.windows` is a shallowRef — read `.value` (the plain array), never the ref object.
  const winsRef = (handle as unknown as { windows: { value?: unknown } | unknown[] }).windows;
  const wins = (Array.isArray(winsRef) ? winsRef : (winsRef as { value: unknown[] }).value) as ReadonlyArray<{
    handle: {
      view: { value: { stream?: { state: string; chunks: readonly string[]; loaded: number; total: number } } };
    };
  }>;
  const v = wins[wins.length - 1]?.handle.view.value;
  const segCount = document.querySelectorAll(".preview-window .preview-seg").length;
  if (v === undefined || !("stream" in v) || v.stream === undefined) {
    return segCount === 0 ? null : { state: "none", chunks: 0, loaded: 0, total: 0, segCount };
  }
  const s = v.stream;
  return { state: s.state, chunks: s.chunks.length, loaded: s.loaded, total: s.total, segCount };
}

const pp = {
  virtual: virtualOn,
  async ready(): Promise<{
    corpus: string[];
    streamCorpus: string;
    virtual: boolean;
    fontFamily: string;
    fontsStatus: string;
    caps: string[];
    log8mib: { chunks: number; surrogateSplit: boolean; totalBytes: number };
  }> {
    if (document.querySelector(".pp-shell") === null) {
      await new Promise<void>((resolveP) => {
        const obs = new MutationObserver(() => {
          if (document.querySelector(".pp-shell") !== null) {
            obs.disconnect();
            resolveP();
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => resolveP(), 15_000);
      });
    }
    const probe = document.querySelector(".preview-text-body") ?? document.body;
    return {
      corpus: CORPUS_FILES.map((f) => PATH_PREFIX + f),
      streamCorpus: STREAM_PATH,
      virtual: virtualOn,
      fontFamily: getComputedStyle(probe).fontFamily,
      fontsStatus: typeof document.fonts === "undefined" ? "n/a" : document.fonts.status,
      caps: HUB_CAPS,
      log8mib: {
        chunks: log8?.boundaries.length ?? 0,
        surrogateSplit: log8?.boundaries.some((b) => b.splitsSurrogate) ?? false,
        totalBytes: LOG8.totalBytes,
      },
    };
  },
  armOpen,
  collectOpen,
  openState(): { windows: number; lines: number; content: boolean } {
    return {
      windows: document.querySelectorAll(".preview-window").length,
      lines: document.querySelectorAll(".preview-window .pv-line").length,
      content: activeWindowEl()?.querySelector(".preview-text-body, .preview-md") !== null,
    };
  },
  closeAll(): void {
    (handle as unknown as { closeAll(): void }).closeAll();
  },
  /** geometry for real-mouse gestures: window rects (+header centers) and resize handles. */
  winInfo(): {
    count: number;
    rects: Array<{ x: number; y: number; w: number; h: number; header: { x: number; y: number } }>;
    handles: Record<string, { x: number; y: number }>;
  } {
    const wins = [...document.querySelectorAll<HTMLElement>(".preview-window")];
    const rects = wins.map((w) => {
      const r = w.getBoundingClientRect();
      const hr = (w.querySelector(".preview-header") as HTMLElement | null)?.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        header:
          hr === undefined || hr === null
            ? { x: r.x + r.width / 2, y: r.y + 10 }
            : { x: hr.x + hr.width / 2, y: hr.y + Math.min(hr.height / 2, 12) },
      };
    });
    const handles: Record<string, { x: number; y: number }> = {};
    const active = activeWindowEl();
    if (active !== null) {
      for (const rz of active.querySelectorAll<HTMLElement>(".pw-rz")) {
        const dir = rz.dataset["dir"];
        const r = rz.getBoundingClientRect();
        if (dir !== undefined && r.width > 0 && r.height > 0) {
          handles[dir] = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
    }
    return { count: wins.length, rects, handles };
  },
  scrollInfo(): { scrollTop: number; scrollHeight: number; clientHeight: number } | null {
    const el = activeWindowEl()?.querySelector<HTMLElement>(".preview-text-body, .preview-md");
    if (el === null || el === undefined) return null;
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  },
  setScrollTop(v: number): void {
    const el = activeWindowEl()?.querySelector<HTMLElement>(".preview-text-body, .preview-md");
    if (el !== null && el !== undefined) el.scrollTop = v;
  },
  beginGaps,
  endGaps,
  /** click the md rendered→source toggle in the ACTIVE window (wide-1200.md). */
  toSourceView(): boolean {
    const btns = activeWindowEl()?.querySelectorAll<HTMLButtonElement>(".preview-toggle-btn");
    if (btns === undefined || btns.length < 2) return false;
    (btns[1] as HTMLButtonElement).click();
    return true;
  },
  isSourceView(): boolean {
    return activeWindowEl()?.querySelector(".preview-text-body") !== null;
  },
  streamInfo,
  tokArrived(): boolean {
    return activeWindowEl()?.querySelector('[class*="tok-"]') !== null;
  },
  lineCount(): number {
    return document.querySelectorAll(".preview-window .pv-line").length;
  },
  violations(): Array<{ directive: string; uri: string }> {
    return [...violations];
  },
};

async function boot(): Promise<void> {
  try {
    // Fetch the pinned corpus once over HTTP; after this every open is served from memory
    // (opens measure render cost, not the network).
    await Promise.all(
      CORPUS_FILES.map(async (f) => {
        const res = await fetch(`/corpus/${f}`);
        if (!res.ok) throw new Error(`corpus fetch failed: ${f} → ${res.status}`);
        const text = await res.text();
        corpus.set(PATH_PREFIX + f, { text, bytes: utf8Len(text), streamable: false });
      }),
    );
    log8 = buildLog8();
    corpus.set(STREAM_PATH, { text: log8.text, bytes: LOG8.totalBytes, streamable: true });
    createApp(ProbeApp).mount("#root");
  } catch (err) {
    console.error("preview-perf boot failed:", err);
    const el = document.getElementById("root");
    if (el !== null) el.textContent = `preview-perf boot failed: ${String(err)}`;
  }
}

void boot();

declare global {
  interface Window {
    __pp: typeof pp;
  }
}
(window as unknown as { __pp: typeof pp }).__pp = pp;
(window as unknown as { __PWH_PROBE_READY__?: boolean }).__PWH_PROBE_READY__ = true;
