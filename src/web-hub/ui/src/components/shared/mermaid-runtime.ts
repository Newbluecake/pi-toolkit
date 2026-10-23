/**
 * Mermaid runtime — the frozen §4 contract (web-hub-mermaid plan r2 + r3 R2-1). Never imports
 * mermaid itself: the engine lives behind a single lazy `import("./mermaid-impl.js")`.
 *
 * Lifecycle summary (the contract; see plan §4):
 *  - one serial slot (mermaid's global config / ids are not concurrency-safe), FIFO, `MAX_QUEUE` waiters;
 *  - same-key requests merge as subscribers of one task;
 *  - EVERY subscriber owns an absolute deadline `t0 + CALLER_DEADLINE_MS` that stays valid after the
 *    task starts executing (r3 R2-1); a subscriber settles `timeout` at min(its deadline, start+8s).
 *    A single subscriber's expiry never frees the slot and never writes a cache entry; only the
 *    task-level 8 s execution timeout does;
 *  - results are re-checked against the monotonic clock before being published;
 *  - 30 s without settling ⇒ the engine is `broken` for the page (queue drained, fast failure);
 *  - cancelled / busy / load-failed / engine-unavailable / caller-deadline results never enter the cache.
 *
 * Time guarantees hold only while the event loop is schedulable — a synchronous layout cannot be pre-empted.
 */
import {
  ByteBudgetLru,
  CACHE_MAX_ENTRIES,
  CACHE_MAX_UNITS,
  MAX_SRC_CHARS,
  clampMessage,
  classifyMermaidError,
  normalizeFontFamily,
  precheckMermaid,
  shortMermaidError,
  svgToImage,
  type MermaidErrorReason,
  type MermaidTheme,
} from "@logic/mermaid.js";
import type { ImplResult } from "./mermaid-impl.js";
import "../../styles/mermaid-stage.css";

export type { MermaidErrorReason, MermaidTheme } from "@logic/mermaid.js";

export type MermaidOutcome =
  | { kind: "ok"; src: string; width: number; height: number; diagramType: string; title: string | null }
  | { kind: "error"; reason: MermaidErrorReason; message: string }
  | { kind: "cancelled" };

export interface MermaidRequest {
  text: string;
  theme: MermaidTheme;
  signal?: AbortSignal;
}

export type MermaidEngineState = "idle" | "loading" | "ready" | "load-failed" | "broken";

export const LOAD_TIMEOUT_MS = 20_000;
export const CALLER_DEADLINE_MS = 30_000;
/** Task execution budget (plan §4.2's `RENDER_TIMEOUT_MS`; r3 R2-1 names it EXEC_TIMEOUT_MS). */
export const EXEC_TIMEOUT_MS = 8_000;
export const RENDER_TIMEOUT_MS = EXEC_TIMEOUT_MS;
export const ZOMBIE_BREAK_MS = 30_000;
export const MAX_QUEUE = 32;

type ImplModule = { renderSvg: (input: ImplInput) => Promise<ImplResult> };
type ImplInput = Parameters<typeof import("./mermaid-impl.js").renderSvg>[0];

interface Subscriber {
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  /** Absolute monotonic deadline (`now()` units). */
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
  resolve: (o: MermaidOutcome) => void;
  task: Task;
}

interface Task {
  key: string;
  text: string;
  theme: MermaidTheme;
  subs: Set<Subscriber>;
  state: "queued" | "running" | "done";
  startedAt: number;
  execTimer: ReturnType<typeof setTimeout> | undefined;
  zombieTimer: ReturnType<typeof setTimeout> | undefined;
  /** Task-level execution timeout fired: a late result is dropped, never cached. */
  timedOut: boolean;
  /** Zombie break fired: engine is broken, a late result changes nothing. */
  zombie: boolean;
}

const cache = new ByteBudgetLru<MermaidOutcome>(CACHE_MAX_ENTRIES, CACHE_MAX_UNITS, MAX_SRC_CHARS);
const byKey = new Map<string, Task>();
let queue: Task[] = [];
let current: Task | undefined;
let state: MermaidEngineState = "idle";
let impl: ImplModule | undefined;
let loadTimer: ReturnType<typeof setTimeout> | undefined;
let pumpTimer: ReturnType<typeof setTimeout> | undefined;
let idCounter = 0;
let coarseCache: boolean | undefined;
/** Bumped by the test reset so stale async continuations of a previous "life" do nothing. */
let epoch = 0;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function isCoarse(): boolean {
  if (coarseCache === undefined) {
    try {
      coarseCache = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    } catch {
      coarseCache = false;
    }
  }
  return coarseCache;
}

function readFontFamily(): string {
  try {
    return normalizeFontFamily(getComputedStyle(document.documentElement).getPropertyValue("--font-sans"));
  } catch {
    return "sans-serif";
  }
}

function errorOutcome(reason: MermaidErrorReason, message: string): MermaidOutcome {
  return { kind: "error", reason, message: clampMessage(message) };
}

function cacheKey(text: string, theme: MermaidTheme): string {
  return `${theme}\n${text}`;
}

function cacheable(o: MermaidOutcome): boolean {
  if (o.kind === "ok") return true;
  if (o.kind === "cancelled") return false;
  return o.reason !== "busy" && o.reason !== "load-failed" && o.reason !== "engine-unavailable";
}

function storeCache(key: string, o: MermaidOutcome): void {
  if (!cacheable(o)) return;
  const payload = o.kind === "ok" ? o.src.length : o.kind === "error" ? o.message.length : 0;
  cache.set(key, o, key.length + payload);
}

/* ------------------------------------------------------------------------------- settlement */

function detach(sub: Subscriber): void {
  if (sub.timer !== undefined) clearTimeout(sub.timer);
  sub.timer = undefined;
  if (sub.signal && sub.onAbort) sub.signal.removeEventListener("abort", sub.onAbort);
  sub.onAbort = undefined;
  sub.task.subs.delete(sub);
}

function settle(sub: Subscriber, outcome: MermaidOutcome): void {
  if (sub.settled) return;
  sub.settled = true;
  detach(sub);
  try {
    sub.resolve(outcome);
  } catch {
    // a Promise resolver cannot throw; defensive only
  }
}

/** Publish with the monotonic clock re-checked: an overdue subscriber gets `timeout`, never the result. */
function publish(task: Task, outcome: MermaidOutcome): void {
  const t = now();
  for (const sub of [...task.subs]) {
    if (t >= sub.deadlineAt) settle(sub, errorOutcome("timeout", shortMermaidError("timeout")));
    else settle(sub, outcome);
  }
}

function finishTask(task: Task): void {
  task.state = "done";
  if (task.execTimer !== undefined) clearTimeout(task.execTimer);
  if (task.zombieTimer !== undefined) clearTimeout(task.zombieTimer);
  task.execTimer = undefined;
  task.zombieTimer = undefined;
  if (byKey.get(task.key) === task) byKey.delete(task.key);
}

function drainQueue(outcomeFor: () => MermaidOutcome): void {
  const waiting = queue;
  queue = [];
  for (const task of waiting) {
    finishTask(task);
    for (const sub of [...task.subs]) settle(sub, outcomeFor());
  }
}

/* ---------------------------------------------------------------------------------- loading */

function ensureLoaded(): void {
  if (state !== "idle") return;
  state = "loading";
  const myEpoch = epoch;
  loadTimer = setTimeout(() => {
    if (epoch !== myEpoch || state !== "loading") return;
    failLoad();
  }, LOAD_TIMEOUT_MS);
  let loading: Promise<ImplModule>;
  try {
    loading = import("./mermaid-impl.js") as Promise<ImplModule>;
  } catch (err) {
    loading = Promise.reject(err);
  }
  loading.then(
    (mod) => {
      if (epoch !== myEpoch || state !== "loading") return;
      if (loadTimer !== undefined) clearTimeout(loadTimer);
      loadTimer = undefined;
      impl = mod;
      state = "ready";
      pump();
    },
    () => {
      if (epoch !== myEpoch || state !== "loading") return;
      failLoad();
    },
  );
}

function failLoad(): void {
  if (loadTimer !== undefined) clearTimeout(loadTimer);
  loadTimer = undefined;
  state = "load-failed";
  drainQueue(() => errorOutcome("load-failed", shortMermaidError("load-failed")));
}

/* ----------------------------------------------------------------------------------- pumping */

function schedulePump(): void {
  if (pumpTimer !== undefined) return;
  const myEpoch = epoch;
  pumpTimer = setTimeout(() => {
    pumpTimer = undefined;
    if (epoch === myEpoch) pump();
  }, 0);
}

function pump(): void {
  if (current !== undefined || state !== "ready" || impl === undefined) return;
  while (queue.length > 0) {
    const task = queue.shift()!;
    if (task.subs.size === 0) {
      finishTask(task);
      continue;
    }
    run(task, impl);
    return;
  }
}

function run(task: Task, mod: ImplModule): void {
  const myEpoch = epoch;
  current = task;
  task.state = "running";
  task.startedAt = now();
  task.execTimer = setTimeout(() => {
    if (epoch !== myEpoch || task.state !== "running") return;
    // Task-level execution timeout: every remaining subscriber times out, the (cacheable) result is
    // remembered, but the slot stays occupied until the engine really settles.
    task.timedOut = true;
    const outcome = errorOutcome("timeout", shortMermaidError("timeout"));
    storeCache(task.key, outcome);
    if (byKey.get(task.key) === task) byKey.delete(task.key);
    for (const sub of [...task.subs]) settle(sub, outcome);
  }, EXEC_TIMEOUT_MS);
  task.zombieTimer = setTimeout(() => {
    if (epoch !== myEpoch || task.state !== "running") return;
    task.zombie = true;
    state = "broken";
    if (task.execTimer !== undefined) clearTimeout(task.execTimer);
    task.execTimer = undefined;
    const engineDown = (): MermaidOutcome =>
      errorOutcome("engine-unavailable", shortMermaidError("engine-unavailable"));
    for (const sub of [...task.subs]) settle(sub, engineDown());
    if (byKey.get(task.key) === task) byKey.delete(task.key);
    drainQueue(engineDown);
  }, ZOMBIE_BREAK_MS);

  const onSettled = (outcomeFn: () => MermaidOutcome): void => {
    if (epoch !== myEpoch || task.state !== "running") return;
    const zombie = task.zombie;
    const late = task.timedOut;
    finishTask(task);
    if (zombie) return; // broken engine never recovers, slot stays blocked
    if (current === task) current = undefined;
    if (!late) {
      let outcome: MermaidOutcome;
      try {
        outcome = outcomeFn();
      } catch (err) {
        outcome = errorOutcome("render", shortMermaidError("render", err));
      }
      storeCache(task.key, outcome); // cache first, resolve after (§4.3.9)
      publish(task, outcome);
    }
    schedulePump();
  };

  let p: Promise<ImplResult>;
  try {
    p = Promise.resolve(
      mod.renderSvg({
        id: `pwh-mmd-${idCounter++}`,
        text: task.text,
        theme: task.theme,
        fontFamily: readFontFamily(),
        coarse: isCoarse(),
      }),
    );
  } catch (err) {
    p = Promise.reject(err);
  }
  p.then(
    (res) => onSettled(() => toOutcome(res)),
    (err: unknown) =>
      onSettled(() => {
        const reason = classifyMermaidError(err);
        return errorOutcome(reason, shortMermaidError(reason, err));
      }),
  );
}

function toOutcome(res: ImplResult): MermaidOutcome {
  if (res.kind === "rejected") return errorOutcome(res.reason, res.detail);
  const img = svgToImage(res.svg, () => {
    // G5 hit: G1–G4 let something through. Fixed text only — never the diagram.
    console.warn("[pwh-mermaid] gate breach: output scan rejected a rendered diagram");
  });
  if (img === null) return errorOutcome("output-invalid", shortMermaidError("output-invalid"));
  return {
    kind: "ok",
    src: img.src,
    width: img.width,
    height: img.height,
    diagramType: res.diagramType,
    title: img.title,
  };
}

/* -------------------------------------------------------------------------------- public API */

function addSubscriber(task: Task, req: MermaidRequest, t0: number, resolve: (o: MermaidOutcome) => void): void {
  const sub: Subscriber = {
    signal: req.signal,
    onAbort: undefined,
    deadlineAt: t0 + CALLER_DEADLINE_MS,
    timer: undefined,
    settled: false,
    resolve,
    task,
  };
  task.subs.add(sub);
  const myEpoch = epoch;
  sub.timer = setTimeout(
    () => {
      if (epoch !== myEpoch) return;
      // Per-subscriber deadline: only this subscriber is affected; slot and cache untouched.
      settle(sub, errorOutcome("timeout", shortMermaidError("timeout")));
      dropIfOrphaned(task);
    },
    Math.max(0, sub.deadlineAt - now()),
  );
  if (req.signal) {
    sub.onAbort = () => {
      settle(sub, { kind: "cancelled" });
      dropIfOrphaned(task);
    };
    req.signal.addEventListener("abort", sub.onAbort, { once: true });
  }
}

function dropIfOrphaned(task: Task): void {
  if (task.state !== "queued" || task.subs.size > 0) return;
  queue = queue.filter((t) => t !== task);
  finishTask(task);
}

/** Never rejects; resolves exactly once; see the module header for the time guarantees. */
export function requestMermaid(req: MermaidRequest): Promise<MermaidOutcome> {
  const t0 = now();
  return new Promise<MermaidOutcome>((resolve) => {
    try {
      if (req.signal?.aborted) {
        void Promise.resolve().then(() => resolve({ kind: "cancelled" }));
        return;
      }
      const key = cacheKey(req.text, req.theme);
      const pre = precheckMermaid(req.text, { coarse: isCoarse() });
      if (!pre.ok) {
        const outcome = errorOutcome(pre.reason, pre.message);
        storeCache(key, outcome);
        resolve(outcome);
        return;
      }
      const hit = cache.get(key);
      if (hit !== undefined) {
        resolve(hit);
        return;
      }
      if (state === "load-failed") {
        resolve(errorOutcome("load-failed", shortMermaidError("load-failed")));
        return;
      }
      if (state === "broken") {
        resolve(errorOutcome("engine-unavailable", shortMermaidError("engine-unavailable")));
        return;
      }
      let task = byKey.get(key);
      if (task === undefined) {
        if (queue.length >= MAX_QUEUE) {
          resolve(errorOutcome("busy", shortMermaidError("busy")));
          return;
        }
        task = {
          key,
          text: req.text,
          theme: req.theme,
          subs: new Set(),
          state: "queued",
          startedAt: 0,
          execTimer: undefined,
          zombieTimer: undefined,
          timedOut: false,
          zombie: false,
        };
        byKey.set(key, task);
        queue.push(task);
        addSubscriber(task, req, t0, resolve);
        ensureLoaded();
        if (pumpTimer === undefined) pump(); // a pending yield owns the hand-over between tasks
        return;
      }
      addSubscriber(task, req, t0, resolve);
    } catch (err) {
      const reason = classifyMermaidError(err);
      resolve(errorOutcome(reason, shortMermaidError(reason, err)));
    }
  });
}

/** Synchronous, load-free: only cacheable outcomes (§4.4). */
export function peekMermaidCache(text: string, theme: MermaidTheme): MermaidOutcome | undefined {
  return cache.get(cacheKey(text, theme));
}

export function mermaidEngineState(): MermaidEngineState {
  return state;
}

/** Test-only: forget queue, cache, engine state and every timer. */
export function __resetMermaidRuntimeForTests(): void {
  epoch++;
  for (const task of byKey.values()) {
    for (const sub of [...task.subs]) {
      detach(sub);
      sub.settled = true;
    }
    if (task.execTimer !== undefined) clearTimeout(task.execTimer);
    if (task.zombieTimer !== undefined) clearTimeout(task.zombieTimer);
  }
  if (current) {
    for (const sub of [...current.subs]) {
      detach(sub);
      sub.settled = true;
    }
    if (current.execTimer !== undefined) clearTimeout(current.execTimer);
    if (current.zombieTimer !== undefined) clearTimeout(current.zombieTimer);
  }
  byKey.clear();
  queue = [];
  current = undefined;
  state = "idle";
  impl = undefined;
  if (loadTimer !== undefined) clearTimeout(loadTimer);
  loadTimer = undefined;
  if (pumpTimer !== undefined) clearTimeout(pumpTimer);
  pumpTimer = undefined;
  coarseCache = undefined;
  cache.clear();
}
