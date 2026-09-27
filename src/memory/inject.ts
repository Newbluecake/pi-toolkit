/**
 * `pi_project_memory` section registration (memory-plan §5.2, sysprompt-stable
 * plan §4.6): a `SectionRegistration` whose provider renders the `## Memory`
 * block for the current cwd. `wireMemory` (src/memory/index.ts) registers it
 * into the shared `PromptSectionHub`, which folds it into `event.systemPrompt`
 * — memory no longer owns its own `before_agent_start` hook (M3).
 *
 * Semantics carried over unchanged from the pre-M3 `createMemoryInjectHook`:
 * - settings are a STATIC object captured at activate() (Nit 7) — the
 *   `enabled` gate lives in the assembly layer, so there is deliberately no
 *   enabled check here;
 * - empty directory / no directory → `""` (Live: "no content this turn" —
 *   the hub treats this as a `removed` update if a block was previously
 *   announced, and as "nothing to fold" otherwise; sysprompt-stable §4.1);
 * - frozen blocks (freezeInjectionAfterWrite) are a block SOURCE, not an
 *   early return: frozen and fresh blocks both flow through the same
 *   double-injection guard (R2);
 * - double-injection guard (Nit 12): our own HTML-comment sentinel plus a
 *   compatibility check for the original plugin's `## Memory (<slug>)`
 *   banner (coexistence period, §6.2) — implemented as the registration's
 *   `skipIf`, checked against the ACCUMULATED prompt text at this point in
 *   the fold chain (today: the raw `event.systemPrompt`, since memory folds
 *   first; sysprompt-stable §4.2);
 * - cwd resolution keeps the three-level fallback (review-2 #12):
 *   `optionsCwd ?? ctx.cwd (may throw — assertActive) ?? process.cwd()`,
 *   then resolves worktree origin (B3);
 * - the provider NEVER throws: any failure degrades to `SKIP` (hub keeps the
 *   last-known snapshot, sysprompt-stable I5) — same "never crash" contract
 *   as before, expressed through the hub's error semantics instead of a
 *   local try/catch returning `undefined`.
 */

import { SKIP, type Live } from "../prompt-sections/stable-section.js";
import type { SectionProviderInput, SectionRegistration } from "../sysprompt/hub.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import type { ChildProfile, MemoryAccess, TieredRenderInput } from "./contracts.js";
import { memoryDirFor, toSlug, type MemoryPaths } from "./paths.js";
import {
  injectionSentinel,
  memoryFingerprint,
  renderMemoryBlock,
  type InjectBudget,
  type RenderCache,
} from "./render.js";
import { canonicalDir, listRegular } from "./safe-fs.js";
import { accessFromTools, MetaCache, renderTiered, tieredFingerprint, TieredRenderCache } from "./tiered.js";

export interface MemorySectionDeps {
  settings: MemorySettings; // 静态（Nit 7）
  isChildSession: boolean;
  cache: RenderCache;
  frozenBlocks: Map<string, string | undefined>;
  paths?: MemoryPaths;
  /**
   * 方案 §2.4/§14.1的 `pi.getActiveTools()` 端口：P0-b 只把它从装配骨架（`wireMemory`）
   * 传递到这里并保存（本接口字段本身就是存储处）；tiered layout 的
   * `accessFromTools` 真实计算属于 P1（真实实现之前 `renderTiered` 本身就会 `throw`，
   * 传什么 `access` 都不受影响）；legacy layout 不消费它。可选（未接入的旧调用方/测试
   * fixture 无需追加）—— `wireMemory` 总是会传。调用方必须自己抓异常（`pi.getActiveTools`
   * 缺失/抛错时的容错是调用方的职责，同 `context-switch/child.ts:470`）。
   */
  getActiveTools?: () => string[];
}

/** `ctx.cwd` is an `assertActive()`-guarded getter (pc87:runner.js:565-568);
 *  reading it outside an active run throws — fall back to `undefined` so the
 *  caller can continue down the three-level chain (review-2 #12). */
function tryCtxCwd(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.cwd;
  } catch {
    return undefined;
  }
}

/** §2.4's access sticky-cache / §2.6's pointer "changed this session" clock
 *  are both keyed by the session's stable id (`ctx.sessionManager.
 *  getSessionId()`). A same-id key alone is NOT enough to reproduce "cleared
 *  on session_start", though: a `/resume`/`/reload`/cron-wake reentry into
 *  the SAME session id must still throw away whatever `access`/`sessionStart`
 *  were memoized from the PREVIOUS run — reusing them would keep an access
 *  level computed under a now-gone tool scope, and would keep a pointer
 *  baseline anchored to the wrong (previous) run's clock (verification
 *  fallout #1). `memorySection()` has no `pi.on` of its own to subscribe to
 *  `session_start` directly (wireMemory owns that registration, outside
 *  this package's P1 scope) — instead it piggybacks on the ONE session_start
 *  side effect it already receives by reference: `wireMemory`'s
 *  `pi.on("session_start", () => frozenBlocks.clear())` call
 *  (src/memory/index.ts) fires unconditionally for every reason (`new` /
 *  `resume` / `reload`), including a same-session-id reentry. `memorySection`
 *  shadows `deps.frozenBlocks.clear` with a wrapper that also resets the
 *  tiered `access`/`sessionStart` caches, so the existing call site resets
 *  three pieces of per-session state through the one hook it already owns. */
function resolveSessionKey(ctx: ExtensionContext): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

const STICKY_CACHE_CAPACITY = 32;

function stickyGetOrCompute<T>(cache: Map<string, T>, key: string | undefined, compute: () => T): T {
  if (key === undefined) return compute();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = compute();
  if (!cache.has(key) && cache.size >= STICKY_CACHE_CAPACITY) cache.clear();
  cache.set(key, value);
  return value;
}

/** §2.4 point 1: `pi.getActiveTools()` missing, throwing, or returning a
 *  non-array all collapse to `undefined` here — the one place that decides
 *  "can't tell" — so `accessFromTools` itself never has to guess. */
function safeGetActiveTools(deps: MemorySectionDeps): string[] | undefined {
  if (typeof deps.getActiveTools !== "function") return undefined;
  try {
    const result = deps.getActiveTools();
    return Array.isArray(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

function resolveAccess(deps: MemorySectionDeps, caches: TieredCaches, sessionKey: string | undefined): MemoryAccess {
  return stickyGetOrCompute(caches.access, sessionKey, () =>
    accessFromTools(safeGetActiveTools(deps), deps.settings.toolSurface),
  );
}

function listChangedFileNames(cwd: string, sinceMs: number): string[] {
  try {
    const display = memoryDirFor(cwd);
    const canon = canonicalDir(display);
    const dir = canon ? canon.real : display;
    const { files } = listRegular(dir, { names: "v2" });
    return files
      .filter((f) => f.mtimeMs > sinceMs)
      .map((f) => f.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

function actionPartFor(access: MemoryAccess, dirDisplay: string): string {
  switch (access) {
    case "memory+read":
      return `Current index: memory view; a file: memory view <file>; without the memory tool: read ${dirDisplay}/<file>.`;
    case "memory":
      return "Current index: memory view; a file: memory view <file>.";
    case "read":
      return `Current index: read ${dirDisplay}/; a file: read ${dirDisplay}/<file>.`;
    case "none":
    default:
      return "Current index: not openable in this session.";
  }
}

/** §2.6's `sessionStartedAt` clock: the FIRST call of any kind (provider
 *  render or pointer text) for a given session id anchors the baseline —
 *  in practice this is `renderLive`'s call on the session's very first turn
 *  (the provider runs every turn; the pointer function only runs once the
 *  section enters POINTED, which can be turns later, cf. §2.6/H3's "4th
 *  distinct change"). Deferring the stamp to the first POINTER call (as
 *  before this fix) would silently miss every file that changed between
 *  the real session start and that later moment — `sticky`'s cache-miss
 *  semantics make whichever caller asks FIRST the one that sets the clock,
 *  so `renderLive` calling this ahead of `tieredPointerText` fixes the bug
 *  without either function needing to know which one runs first. */
function ensureSessionStart(caches: TieredCaches, sessionKey: string | undefined): number {
  return stickyGetOrCompute(caches.sessionStart, sessionKey, () => Date.now());
}

/** §2.6's memory pointer function: "Changed this session: …" (mtime after
 *  this session's first render, name-sorted, capped at 8) plus an
 *  access-appropriate action phrase. Never throws on its own — a failure
 *  inside `listChangedFileNames` degrades to an empty change list rather
 *  than propagating (the hub's own try/catch around a pointerHint function
 *  is the last-resort safety net, §2.6's hub spec). */
function tieredPointerText(
  deps: MemorySectionDeps,
  caches: TieredCaches,
  cwd: string,
  sessionKey: string | undefined,
): string {
  const startedAt = ensureSessionStart(caches, sessionKey);
  const changed = listChangedFileNames(cwd, startedAt);
  const changedPart =
    changed.length === 0
      ? "Changed this session: (none yet)."
      : `Changed this session: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ` (+${changed.length - 8} more)` : ""}.`;
  const access = resolveAccess(deps, caches, sessionKey);
  return `${changedPart} ${actionPartFor(access, memoryDirFor(cwd))}`;
}

interface TieredCaches {
  access: Map<string, MemoryAccess>;
  sessionStart: Map<string, number>;
  meta: MetaCache;
  render: TieredRenderCache;
}

/** `## Memory (<slug>)` is the stable prefix of the block's real first line
 *  (`## Memory (<slug>) — N file(s)`, render.ts:154) — used both as the
 *  double-injection guard needle and as the update-message title (§4.3). */
export function memoryTitle(slug: string): string {
  return `## Memory (${slug})`;
}

function resolveCwd(input: SectionProviderInput): string {
  const rawCwd = input.optionsCwd ?? tryCtxCwd(input.ctx) ?? process.cwd();
  // B3: worktree child sessions inject the MAIN repository's memory.
  return resolveWorktreeOrigin(rawCwd) ?? rawCwd;
}

function renderLive(deps: MemorySectionDeps, cwd: string, ctx: ExtensionContext, caches: TieredCaches): Live {
  const budget: InjectBudget = {
    inlineMax: deps.settings.inlineMax,
    byteCap: deps.settings.byteCap,
    indexMax: deps.settings.indexMax,
  };
  let block: string | undefined;
  if (deps.frozenBlocks.has(cwd)) {
    // Frozen source (§5.5): may be a captured `undefined` (R3), which flows
    // to the same "nothing to inject" exit below.
    block = deps.frozenBlocks.get(cwd);
  } else if (deps.settings.layout === "tiered") {
    // todo #22 optimize-plan §2 (P1): the tiered renderer. `access` is
    // computed once per session (§2.4's sticky rule — same tools mid-session
    // never changes the block) and `profile` follows §2.4's table
    // (`childProfile` only applies to child sessions; main session is always
    // "full"). `injectInChildSessions=false` and `childProfile="none"` are
    // both filtered out by the provider before this function is ever
    // reached, so `profile` here is only ever "core" or "full" in practice —
    // `renderTiered`'s own "none" short-circuit still exists for direct unit
    // tests and defense-in-depth.
    const sessionKey = resolveSessionKey(ctx);
    // Anchor §2.6's pointer clock HERE, on every turn's live render, not
    // lazily inside `tieredPointerText` (which only runs once the section
    // reaches POINTED — turns after the real session start, per the H3
    // "4th distinct change" threshold). `ensureSessionStart` is a sticky
    // no-op after the first call for this session id.
    ensureSessionStart(caches, sessionKey);
    const access = resolveAccess(deps, caches, sessionKey);
    const profile: ChildProfile = deps.isChildSession ? deps.settings.childProfile : "full";
    const input: TieredRenderInput = {
      cwd,
      profile,
      access,
      coreBytes: deps.settings.coreBytes,
      blockBytes: deps.settings.blockBytes,
      indexMax: deps.settings.indexMax,
    };
    const fingerprint = tieredFingerprint(cwd);
    const cached = caches.render.get(input, deps.settings.toolSurface, fingerprint);
    const result = cached ?? renderTiered(input, { metaCache: caches.meta });
    if (!cached) caches.render.set(input, deps.settings.toolSurface, fingerprint, result);
    block = result.text;
  } else {
    const fingerprint = memoryFingerprint(cwd, deps.paths);
    const cached = deps.cache.get(cwd, budget, fingerprint);
    if (cached !== undefined) {
      block = cached.block;
    } else {
      block = renderMemoryBlock(cwd, budget, deps.paths);
      deps.cache.set(cwd, budget, fingerprint, block);
    }
  }
  return block ?? "";
}

/**
 * Build the `pi_project_memory` section registration. The provider is
 * synchronous (review-2 already confirmed `memoryFingerprint` /
 * `renderMemoryBlock` are sync) — required by the hub's provider contract
 * (I7: no async IO on the request path).
 */
export function memorySection(deps: MemorySectionDeps): SectionRegistration {
  // Per-"activate()" state, NOT per-cwd: `memorySection()` is called exactly
  // once (from `wireMemory`), so these closures live for the whole process
  // lifetime until the next `/reload`. Keyed by session id (§2.4/§2.6) —
  // see `resolveSessionKey`'s doc comment for why this substitutes for an
  // explicit `session_start` subscription this module has no way to make.
  const caches: TieredCaches = {
    access: new Map(),
    sessionStart: new Map(),
    meta: new MetaCache(),
    render: new TieredRenderCache(),
  };
  // `wireMemory` (src/memory/index.ts) already does
  // `pi.on("session_start", () => frozenBlocks.clear())` for EVERY reason
  // (new / resume / reload), including a `/reload`-free reentry into the
  // same session id. `memorySection()` has no `pi.on` of its own (that
  // registration lives outside this module's scope) — shadow the SAME
  // `Map`'s `clear()` with a wrapper that also resets the tiered
  // access/pointer-baseline caches, so the one existing session_start
  // signal resets all three pieces of per-session state together. A no-op
  // for callers that never clear `frozenBlocks` (e.g. direct unit tests
  // that construct `memorySection()` without a session_start hookup at
  // all) — those already get fresh caches per fixture.
  const baseFrozenBlocksClear = deps.frozenBlocks.clear.bind(deps.frozenBlocks);
  deps.frozenBlocks.clear = (): void => {
    baseFrozenBlocksClear();
    caches.access.clear();
    caches.sessionStart.clear();
  };
  return {
    provider: (input) => {
      if (deps.isChildSession) {
        if (!deps.settings.injectInChildSessions) return "";
        // §2.4's table: under `layout:"legacy"`, `childProfile` only takes
        // effect for "none" (every other value keeps injecting the old
        // block) — applying this check BEFORE the layout branch means it
        // covers both layouts uniformly with one guard.
        if (deps.settings.childProfile === "none") return "";
      }
      try {
        const cwd = resolveCwd(input);
        return renderLive(deps, cwd, input.ctx, caches);
      } catch {
        return SKIP; // never crash the session
      }
    },
    title: (input) => {
      try {
        return memoryTitle(toSlug(resolveCwd(input)));
      } catch {
        return memoryTitle("unknown");
      }
    },
    // §2.6: legacy layout keeps the ORIGINAL literal string byte-for-byte
    // (never invoked under `mode:"legacy"`/zero-update golden scenarios
    // anyway, but kept literal out of caution for the frozen legacy golden);
    // tiered layout gets the dynamic "changed this session" hint.
    pointerHint:
      deps.settings.layout === "tiered"
        ? (input: SectionProviderInput) => {
            const cwd = resolveCwd(input);
            const sessionKey = resolveSessionKey(input.ctx);
            return tieredPointerText(deps, caches, cwd, sessionKey);
          }
        : "Use the memory tool (action: 'list') to read the current entries.",
    skipIf: (input) => {
      try {
        const slug = toSlug(resolveCwd(input));
        return input.promptText.includes(injectionSentinel(slug)) || input.promptText.includes(memoryTitle(slug));
      } catch {
        return false;
      }
    },
  };
}
