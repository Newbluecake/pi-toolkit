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
import { join } from "node:path";
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
import { canonicalDir, listRegular, statRegularIfExists } from "./safe-fs.js";
import { accessFromTools, MetaCache, renderTiered, tieredFingerprint, TieredRenderCache } from "./tiered.js";
import type { JevRenderInfo, JevIndexV1 } from "./jev/contracts.js";
import { stripInlineMeta } from "./jev/entries.js";
import { readIndex } from "./jev/index-store.js";
// #36 P3 (arch §3.3.3/§3.4): layout dispatch — a blocks-format directory
// renders through blocks/render.ts even under a tiered/legacy setting (the
// data format wins); a files directory under layout:blocks still renders
// tiered until migration (P2's session_start hook flips it).
import { dirFormat, effectiveLayout } from "./blocks/naming.js";
import {
  corpusStampFingerprint,
  renderBlocks,
  residentRenderKey,
  type RenderBlocksInput,
  type RenderBlocksResult,
} from "./blocks/render.js";
import { readCorpus, type CorpusReaderState } from "./blocks/store.js";
import { eligible } from "./govern/eligibility.js";

export interface MemorySectionDeps {
  settings: MemorySettings; // 静态（Nit 7）
  isChildSession: boolean;
  cache: RenderCache;
  frozenBlocks: Map<string, string | undefined>;
  paths?: MemoryPaths;
  /** §2.4/§14.1 `pi.getActiveTools()` port. `wireMemory` supplies this from
   * the host; legacy layout ignores it, while the tiered path uses the real
   * `accessFromTools` computation. Direct tests may omit it; missing or
   * throwing host APIs are collapsed by the caller. */
  getActiveTools?: () => string[];
  /** Called for each non-frozen provider result so P5 can freeze the exact
   * tiered block that was last injected after a write. The third argument
   * (jev-plan J6) carries the static-core map Jev needs to skip entries that
   * are already in the system prompt; `undefined` for the legacy layout.
   * #36 P3 (arch §3.3.5): the fourth argument carries THIS render's resident
   * `id → renderKey` map — blocks layout only; the legacy/tiered branches
   * never pass it (existing 3-arg callbacks stay type-compatible). */
  onRender?: (
    cwd: string,
    block: string | undefined,
    info: JevRenderInfo | undefined,
    resident?: ReadonlyMap<string, string>,
  ) => void;
  /** jev on (jev-plan J6, jev-arch §8): strip `<!-- mem … -->` inline
   *  authority comments from the injected block. Settings-derived, constant
   *  within one activation; absent/false ⇒ byte-identical to before. */
  stripInlineMeta?: boolean;
}

const INLINE_META_PROBE_RE = /<!--[ \t]*mem\b/;
const TIERED_HEADER_PRIMARY_RE = /^## Memory \([^\n]*\) — \d+ file\(s\)\n\n### ([^\n]+)\n/;

/** Static-core map for Jev (review #10). The tiered core always starts with
 *  the primary file's `### <name>` piece when the primary was admitted
 *  (tiered.ts `buildCore` pushes it first; extra pinned files exist only when
 *  a primary exists). Level 4/5 ⇒ primary demoted / frame only ⇒ not inlined. */
export function jevRenderInfoOf(result: {
  text: string;
  level: number;
  omittedSections: readonly string[];
}): JevRenderInfo {
  const m = result.level < 4 ? TIERED_HEADER_PRIMARY_RE.exec(result.text) : null;
  const primary = m?.[1];
  return primary === undefined
    ? { omittedSections: [], coreInlined: false }
    : { primary, omittedSections: [...result.omittedSections], coreInlined: true };
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

/** `YYYY-MM-DD` local date — the blocks render cache key and the expiry
 *  filter both rotate on it (arch §3.3.3: cross-midnight re-render). */
function localTodayOf(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface TieredCaches {
  access: Map<string, MemoryAccess>;
  sessionStart: Map<string, number>;
  meta: MetaCache;
  render: TieredRenderCache;
  /** #36 P3 blocks render cache: keyed by cwd, the value's key bundles
   *  corpus fingerprint + LOCAL DATE + budget + session profile, so external
   *  writes and midnight both invalidate (fingerprint = stamps of every block
   *  file, §3.3.5). */
  blocksRender: Map<string, { key: string; result: RenderBlocksResult }>;
  /** Per-cwd no-lock reader states (arch §4.3.8) — survive session_start so
   *  a mid-read rename returns the last good corpus. */
  blocksReaders: Map<string, CorpusReaderState>;
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

/** #36 P4: stat-only stamp of the blocks sidecar index (size + mtimeMs),
 *  joining the blocks render cache key — a tagging run can change the
 *  sidecar without touching any block file, and the tag summaries must
 *  refresh anyway (root ruling 2026-11-06). Missing file ⇒ a constant (no
 *  sidecar influence); stat trouble ⇒ a unique value (render once, don't
 *  cache on a suspect state). */
function sidecarStampOf(memDir: string): string {
  try {
    const st = statRegularIfExists(join(memDir, "blocks", ".jev"), "index.json");
    return st === undefined ? "none" : `${st.size}:${st.mtimeMs}`;
  } catch {
    return `unreadable:${Date.now()}`;
  }
}

function renderLive(deps: MemorySectionDeps, cwd: string, ctx: ExtensionContext, caches: TieredCaches): Live {
  const budget: InjectBudget = {
    inlineMax: deps.settings.inlineMax,
    byteCap: deps.settings.byteCap,
    indexMax: deps.settings.indexMax,
  };
  let block: string | undefined;
  let info: JevRenderInfo | undefined;
  let resident: ReadonlyMap<string, string> | undefined;
  let usedFrozen = false;
  if (deps.frozenBlocks.has(cwd)) {
    usedFrozen = true;
    // Frozen source (§5.5): may be a captured `undefined` (R3), which flows
    // to the same "nothing to inject" exit below.
    block = deps.frozenBlocks.get(cwd);
  } else if (effectiveLayout(deps.settings.layout, dirFormat(memoryDirFor(cwd, deps.paths))) === "blocks") {
    // #36 P3 blocks branch (arch §3.3.3): resident section + one-line topic
    // index, straight from frontmatter. Cache key = corpus fingerprint +
    // LOCAL DATE + budget + profile + SIDECAR stamp — never the wall clock,
    // so an unchanged corpus renders byte-identically across turns. #36 P4
    // (root ruling 2026-11-06): the blocks SIDECAR (index-store.ts resolves
    // the blocks-layout sidecar via sidecarBase) feeds the renderer's tag
    // summaries + resident sort importance — the P2 block sidecar, never a
    // stale root `.jev`. Because tagging can change the sidecar WITHOUT any
    // block file changing, its stat (size+mtimeMs) joins the cache key so a
    // sidecar-only change still refreshes the summaries.
    const today = localTodayOf(Date.now());
    const memDir = memoryDirFor(cwd, deps.paths);
    const realDir = join(memDir, "blocks");
    // acceptance fix: STAT-only fingerprint heads the cache key — N unchanged
    // turns cost N stat passes and ZERO body reads; the full `readCorpus`
    // runs once per actual change (mtimeMs/ino flip) or date rollover.
    const stamp = corpusStampFingerprint(realDir);
    const sidecar = sidecarStampOf(memDir);
    const key = `${stamp}:${sidecar}:${today}:${deps.settings.residentBytes}:${deps.isChildSession ? "child" : "main"}`;
    const hit = caches.blocksRender.get(cwd);
    let result = hit !== undefined && hit.key === key ? hit.result : undefined;
    if (result === undefined) {
      const reader = caches.blocksReaders.get(cwd) ?? { warned: false };
      caches.blocksReaders.set(cwd, reader);
      const corpus = readCorpus(realDir, reader);
      let jevIndex: JevIndexV1 | undefined;
      try {
        jevIndex = dirFormat(memDir) === "blocks" ? readIndex(memDir).index : undefined;
      } catch {
        jevIndex = undefined; // unreadable sidecar ⇒ section-summary fallback
      }
      const input: RenderBlocksInput = {
        slug: toSlug(cwd),
        isChild: deps.isChildSession,
        residentBytes: deps.settings.residentBytes,
        today,
        ...(jevIndex === undefined ? {} : { jevIndex }),
      };
      result = renderBlocks(corpus, input);
      caches.blocksRender.set(cwd, { key, result });
    }
    block = result.text;
    info = { omittedSections: [], coreInlined: false, residentBlocks: result.resident.map((b) => b.id) };
    resident = new Map(result.resident.map((b) => [b.id, residentRenderKey(b, today)] as const));
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
    if (deps.onRender !== undefined) info = jevRenderInfoOf(result);
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
  if (deps.stripInlineMeta === true && block !== undefined && INLINE_META_PROBE_RE.test(block)) {
    block = stripInlineMeta(block);
  }
  if (!usedFrozen) deps.onRender?.(cwd, block, info, resident);
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
    blocksRender: new Map(),
    blocksReaders: new Map(),
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
    // #36 P3 (v3 tool surface): a blocks-format directory points at
    // `memory view` — the v3 read command — under ANY layout setting (the
    // data format wins). Probed per call; tiered files-layout keeps its
    // dynamic hint and legacy its ORIGINAL literal, byte-for-byte.
    pointerHint: (input: SectionProviderInput) => {
      try {
        const cwd = resolveCwd(input);
        if (effectiveLayout(deps.settings.layout, dirFormat(memoryDirFor(cwd, deps.paths))) === "blocks") {
          return "Use the memory tool (action: 'view') to read the current entries.";
        }
        if (deps.settings.layout === "tiered") {
          return tieredPointerText(deps, caches, cwd, resolveSessionKey(input.ctx));
        }
      } catch {
        /* fall through to the legacy literal */
      }
      return "Use the memory tool (action: 'list') to read the current entries.";
    },
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

/**
 * external-agent plan §5.6：导出给外部 agent run（droid）的记忆块。语义 = 子会话
 * 视角：`injectInChildSessions:false` 或 `childProfile:"none"` ⇒ undefined；tiered 用
 * `profile = childProfile`、`access = accessFromTools(["read"], toolSurface)`、同一字节
 * 预算；legacy 用 `renderMemoryBlock`；任何异常 ⇒ undefined；不读 frozenBlocks（冻结是
 * pi 会话的注入语义，外部 run 永远拿当前盘上状态）。cwd 解析沿用 B3：worktree 出身
 * 的 run（H2 之后的 cwd）注入主仓的记忆，与 `renderLive` 的 `resolveCwd` 同口径。
 *
 * P5 经 `wireMemory` 返回的 `renderForExternal` 晚绑定注入 `memoryBlock` 端口；
 * `externalAgents.droid.injectMemory` 的开关在 P5 侧判定（不传即关）。
 */
export function renderExternalMemoryBlock(
  deps: { settings: MemorySettings; cache: RenderCache },
  cwd: string,
): string | undefined {
  const settings = deps.settings;
  if (!settings.injectInChildSessions) return undefined;
  if (settings.childProfile === "none") return undefined;
  try {
    const dir = resolveWorktreeOrigin(cwd) ?? cwd;
    // #36 P3 (arch §3.3.6 接入清单): a blocks-format directory renders the
    // resident section + topic index through the blocks renderer (child
    // audience口径), never the legacy inline branch. The §3.3.6 unified
    // eligibility runs first — external is the egress-relevant layer, so
    // private/secret/audience-mismatched blocks drop out of BOTH the resident
    // set and the index counts before any byte is handed to the foreign run.
    if (effectiveLayout(settings.layout, dirFormat(memoryDirFor(dir))) === "blocks") {
      const today = localTodayOf(Date.now());
      const corpus = readCorpus(join(memoryDirFor(dir), "blocks"));
      const ctx = { today, isChild: true, ledger: new Set<string>(), layer: "external" as const };
      const visible = corpus.blocks.filter((b) => eligible(b, undefined, ctx).ok);
      const text = renderBlocks(
        { ...corpus, blocks: visible },
        { slug: toSlug(dir), isChild: true, residentBytes: settings.residentBytes, today },
      ).text;
      return text === "" ? undefined : text;
    }
    if (settings.layout === "tiered") {
      const input: TieredRenderInput = {
        cwd: dir,
        profile: settings.childProfile,
        access: accessFromTools(["read"], settings.toolSurface),
        coreBytes: settings.coreBytes,
        blockBytes: settings.blockBytes,
        indexMax: settings.indexMax,
      };
      return renderTiered(input).text || undefined;
    }
    const budget: InjectBudget = {
      inlineMax: settings.inlineMax,
      byteCap: settings.byteCap,
      indexMax: settings.indexMax,
    };
    const fingerprint = memoryFingerprint(dir);
    const cached = deps.cache.get(dir, budget, fingerprint);
    if (cached !== undefined) return cached.block;
    const block = renderMemoryBlock(dir, budget);
    deps.cache.set(dir, budget, fingerprint, block);
    return block;
  } catch {
    return undefined;
  }
}
