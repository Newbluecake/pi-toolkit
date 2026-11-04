// `wireJev` — the Jev recall runtime (jev-plan §4 J6; jev-arch §5.3,
// §6.1.1–§6.1.6, §6.2.3, §6.3.1, §8, §9.2).
//
// Called by `wireMemory` ONLY when `resolveJevWiring` says on (I9: every
// settings-period off path never reaches this file). Everything here is
// instance state in this closure (I4); the only process-level tables are the
// two Symbol-keyed ones in health.ts.
//
// Layout (plan risk note: one pi-facing file, private sections):
//   · corpus/data helpers      — entries + sidecar + taxonomy per memory dir
//   · status                   — off(pi-api) detection, probe, notifications,
//                                recovery timer, first-full bulk tagging,
//                                pending backfill, periodic review
//   · recall                   — U (before_agent_start), A (tool_call),
//                                E (tool_result / bash-job notices), B (after
//                                compaction), segment seeding, renderer
//   · ports                    — command port (J4) wiring, doctor port,
//                                write-port factory hook (J7)
//
// The tool_call gate (jev-arch §6.4) was removed entirely (2026-11); the
// handler now only runs the A-layer fast path.
//
// Landing points follow tests/conformance/memory-jev-channels.test.ts:
//   C-J1  a `before_agent_start` message lands after the user message and
//         before the first LLM request (the handler is awaited) — U/E-wake/B
//         return it there; we NEVER return `systemPrompt` (sysprompt-stable).
//   C-J4  `sendMessage(triggerTurn:false)` from inside `tool_call` flushes at
//         turn_end: visible to this run's next LLM call, after the tool
//         results, no extra turn — the A layer and late U/E use it.
//   C-J6  idle + triggerTurn bash-job notices start a run whose
//         before_agent_start has messageType "custom" (E wake turn); idle +
//         no trigger is a plain append (message_start). The streaming steer
//         path (sendMessage while a run is in flight) ALSO emits
//         message_start for that notice once pi-agent-core drains
//         getSteeringMessages — J7 confirmed this against a real
//         AgentSession, so the existing message_start handler already
//         covers E there too (jev-arch.md §19 row 21; no separate hook
//         needed).
//   C-J9  `/skill:<name>` expands to a `<skill …>…</skill>` block in
//         event.prompt — stripped from both user and previous user messages.
//   C-J10 compaction entries + turn_end checkpoints (child switch_context).
//
// Every handler is wrapped: an exception degrades to "no injection" and is
// logged; `tool_result` always returns undefined. Every Jev call has a hard
// budget (clamped by the client), wrapped again here with +500ms (I1); every
// timer is unref'd (I5).

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  MessageStartEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { createSegmentedClock, type Clock, type TimerHandle } from "../../core/clock.js";
import { clampSpanMs } from "../../core/deadline.js";
import { resolveWorktreeOrigin } from "../../core/worktree-origin.js";
import { createGitRunner, type GitRunner } from "../../git/run.js";
import { readRegular } from "../safe-fs.js";
import type { MemorySettings } from "../settings.js";
import { createJevClient, type JevClientHandle } from "./client.js";
import { createJevCommandPort } from "./command-port.js";
import {
  MEMORY_INJECT_CUSTOM_TYPE,
  MEMORY_PREDICT_CUSTOM_TYPE,
  RECALL_MAX_CANDIDATES,
  type ClassifierRegistryLike,
  type EntryHash,
  type EntryTags,
  type InjectLayer,
  type JevAnswer,
  type JevBashJobsLitePort,
  type JevClient,
  type JevCommandPort,
  type JevConfig,
  type JevDoctorPort,
  type JevFleetPort,
  type JevIndexV1,
  type JevRenderInfo,
  type JevStatus,
  type JevTodoPort,
  type JevWritePort,
  type MemEntry,
  type MemoryInjectDetailsV1,
  type MemoryInjectPartV1,
  type SimpleCommand,
  type Taxonomy,
} from "./contracts.js";
import { decideErrorRecall, decideRecall, effectiveMeta } from "./decide.js";
import { EntryIndex, expiredEntries } from "./entries.js";
import {
  formatInjectMarker,
  formatInjectMarkerParts,
  formatInjectMessage,
  formatNotify,
  formatStatusLine,
} from "./format.js";
import { clearHealthTable, coverage, getHealthTable, notifyFor } from "./health.js";
import { readIndex, readTaxonomyFile, writeIndexPatch } from "./index-store.js";
import { matchTags, prefilter } from "./match.js";
import {
  carryFromFinal,
  carryHits,
  detectCarryClear,
  isCarryPhrase,
  isTodoReplaced,
  revalidateCarry,
  buildFinalRecord,
  type FinalRecord,
} from "./predict/carry.js";
import type { CarryState, Evidence, PathClass, ScoredHit, ToolLite } from "./predict/contracts.js";
import { readGitBranch, type GitHeadIo } from "./predict/git-head.js";
import { runPredict } from "./predict/index.js";
import { runRules } from "./predict/rules.js";
import {
  prioritizeCandidates,
  selectPEntries,
  selectSEntry,
  type Candidate as PredictCandidate,
  type PriorityCandidate,
  type SCandidate,
} from "./predict/select.js";
import { shapeOf } from "./predict/shape.js";
import { buildPredictInput, classifyPathClass } from "./predict/signals.js";
import {
  buildErrorQuestions,
  buildRecallQuestions,
  splitBatches,
  type ErrorCandidate,
  type RecallCandidate,
} from "./questions.js";
import { redactForJev } from "./redact.js";
import { markStale, runReviewPass } from "./review.js";
import { createSegmentState, recallRecord, type BranchEntryLike, type SegmentState } from "./segment.js";
import { parseShell, type ParseShellResult } from "./shell-parse.js";
import { tagBulk, taggableEntries, tagOne } from "./tagging.js";
import { mergeTaxonomy } from "./taxonomy.js";

// ───────────────────────────── constants (jev-arch §5.5) ─────────────────────────────

const RECALL_BUDGET_MS = 4_000;
const ERROR_BUDGET_MS = 4_000;
const PROBE_BUDGET_MS = 4_000;
const BACKGROUND_TOTAL_MS = 120_000;
const OUTER_SLACK_MS = 500;
const DATA_CACHE_MS = 2_000;
const A_MAX_ENTRIES = 3;
const A_MAX_BYTES = 4_096;
const E_MAX_CANDIDATES = 150;
const E_MAX_PER_SEGMENT = 10;
const BACKFILL_INTERVAL_MS = 60_000;
const BACKFILL_MAX_PER_PASS = 8;
const PARSED_CACHE_MAX = 64;
const MIN_PROMPT_CODEPOINTS = 8;
const BASH_JOB_NOTIFICATION_TYPE = "bash-job:notification";
const DAY_MS = 86_400_000;
/** Diagnostic ring-buffer capacity (failover + handler-exception lines held
 *  for `/mem jev` while a UI is attached); `/mem jev` shows only the most
 *  recent `JEV_ERROR_LOG_SHOWN` of these. */
const JEV_ERROR_LOG_MAX = 50;
const JEV_ERROR_LOG_SHOWN = 5;

/** Ack-only prompts never trigger U recall (§6.1.1 gate 3) — compared after
 *  lowercasing and dropping whitespace/punctuation. */
const ACK_PHRASES = new Set([
  "继续",
  "继续吧",
  "好",
  "好的",
  "好吧",
  "嗯",
  "嗯嗯",
  "是",
  "是的",
  "对",
  "对的",
  "行",
  "可以",
  "收到",
  "谢谢",
  "开始",
  "开始吧",
  "ok",
  "okay",
  "yes",
  "go",
  "goon",
  "goahead",
  "continue",
  "proceed",
  "thanks",
  "thankyou",
  "sure",
  "soundsgood",
  "lgtm",
]);

const SKILL_BLOCK_RE = /<skill name="[^"]*" location="[^"]*">[\s\S]*?<\/skill>\n*/g;
const EXIT_LINE_PREFIX = "Command exited with code ";

// ───────────────────────────── public surface ─────────────────────────────

/** J5's `createJevWritePort` deps shape (jev-plan §4 J5) — J7 passes the
 *  factory in; J6 only constructs on demand. */
export interface JevWritePortFactoryDeps {
  readonly client: JevClient;
  readonly entryIndex: EntryIndex;
  readonly dirFor: (cwd: string) => string | undefined;
  readonly taxonomyFor: (dir: string) => Taxonomy;
  readonly confirmTimeoutMs: number;
  readonly now: () => number;
}

export interface WireJevDeps {
  readonly config: JevConfig;
  readonly settings: MemorySettings;
  readonly isChildSession: boolean;
  readonly dirFor: (cwd: string) => string | undefined;
  readonly getRenderInfo: (cwd: string) => JevRenderInfo | undefined;
  readonly onAfterWriteHook: (fn: (cwd: string) => void) => void;
  /** memory-predict plan §2.1 signal T — absent ⇒ todo treated as empty
   *  (P1b degrades gracefully when `todo.enabled` is off). */
  readonly todo?: JevTodoPort;
  // ── seams (tests; production uses the defaults) ──
  readonly now?: () => number;
  readonly clock?: Clock;
  readonly client?: JevClientHandle;
  readonly entryIndex?: EntryIndex;
  readonly platform?: NodeJS.Platform;
  readonly log?: (line: string) => void;
  readonly createWritePort?: (deps: JevWritePortFactoryDeps) => JevWritePort;
  /** Startup-reminder "core usage" line (jev-plan J8 acceptance #3) —
   *  supplied by `wireMemory` from doctor's D19 verdict. */
  readonly coreUsageLine?: (cwd: string) => string | undefined;
}

export interface WireJevResult {
  readonly commandPort: JevCommandPort;
  makeWritePort(): JevWritePort;
  readonly doctorPort: JevDoctorPort;
  readonly client: JevClient;
  /** memory-predict plan §11.1: late-bound W-signal ports (bashJobs/fleet) —
   *  `src/index.ts` attaches these post-guard, after `activeSubagentRunCount`
   *  exists; unattached ⇒ P1b sees empty bashJobs / 0 activeSubagents. */
  attachPredictPorts(ports: { bashJobs: JevBashJobsLitePort; fleet: JevFleetPort }): void;
}

// ───────────────────────────── small pure helpers (exported for tests) ─────────────────────────────

/** Remove `/skill:` expansion blocks (C-J9). */
export function stripSkillBlocks(text: string): string {
  return text.replace(SKILL_BLOCK_RE, "");
}

/** §6.1.1 gate 3: ≥8 code points after stripping skill blocks + whitespace,
 *  and not an ack-only phrase. */
export function passesPromptGate(stripped: string): boolean {
  const compact = stripped.replace(/\s+/g, "");
  if (Array.from(compact).length < MIN_PROMPT_CODEPOINTS) return false;
  const normalized = compact.toLowerCase().replace(/[\p{P}\p{S}]/gu, "");
  return !ACK_PHRASES.has(normalized);
}

/** Static-core verdict (§6.1.1, review #10): an entry of the primary core
 *  file whose `## ` section was NOT omitted is already in the system prompt.
 *  Never rendered yet, or core not inlined (L4/L5 demotion) ⇒ not static. */
export function isStaticCore(entry: MemEntry, info: JevRenderInfo | undefined): boolean {
  if (info === undefined || !info.coreInlined || info.primary === undefined) return false;
  if (entry.file !== info.primary) return false;
  return !info.omittedSections.includes(entry.section);
}

/** Display anchor, e.g. `pitfalls-git › #3` / `core › Rules #2`. */
export function entryAnchor(entry: MemEntry): string {
  const stem = entry.file.replace(/\.md$/, "");
  return entry.heading === undefined || entry.heading === ""
    ? `${stem} › #${entry.ordinal}`
    : `${stem} › ${entry.heading} #${entry.ordinal}`;
}

/** Failure exit code: `structuredContent.exit_code` → tail line
 *  `Command exited with code N` (searched upwards) → notice
 *  `details.exitCode` (§6.1.4). */
export function failureExitCode(input: {
  structuredContent?: unknown;
  text?: string;
  detailsExitCode?: unknown;
}): number | undefined {
  const sc = input.structuredContent as { exit_code?: unknown } | undefined;
  if (sc !== null && typeof sc === "object" && typeof sc.exit_code === "number") return sc.exit_code;
  if (typeof input.text === "string") {
    const lines = input.text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line.startsWith(EXIT_LINE_PREFIX)) {
        const n = Number.parseInt(line.slice(EXIT_LINE_PREFIX.length), 10);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  if (typeof input.detailsExitCode === "number") return input.detailsExitCode;
  return undefined;
}

/** Same fingerprint `runReviewPass` stores (review.ts `corpusFingerprint` is
 *  module-private in a J4 file — mirrored here; parity pinned by
 *  tests/memory/jev/wire-status.test.ts). */
export function corpusFingerprint(entries: readonly MemEntry[]): string {
  const lines = entries
    .filter((e) => e.inline.isPrivate !== true && !e.secret)
    .map((e) => `${e.file}|${e.hash}`)
    .sort();
  return createHash("sha1").update(lines.join("\n"), "utf8").digest("hex").slice(0, 12);
}

function localToday(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TIMEOUT: unique symbol = Symbol("jev-timeout");

/** Race `p` against an unref'd timer (I1/I5). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  const span = clampSpanMs(ms);
  if (span === undefined) return Promise.resolve(TIMEOUT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), span);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, t]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      p !== null && typeof p === "object" && (p as { type?: unknown }).type === "text"
        ? String((p as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

/** `ctx.modelRegistry` with all three classifier methods, else undefined
 *  (⇒ `off(pi-api)`, jev-plan §10 #2). Never throws. */
function registryOf(ctx: unknown): ClassifierRegistryLike | undefined {
  try {
    const r = (ctx as { modelRegistry?: unknown } | undefined)?.modelRegistry as Record<string, unknown> | undefined;
    if (r === undefined || r === null || typeof r !== "object") return undefined;
    if (typeof r["classify"] !== "function" || typeof r["getAvailableOfType"] !== "function") return undefined;
    if (typeof r["getModelOfType"] !== "function") return undefined;
    return r as ClassifierRegistryLike;
  } catch {
    return undefined;
  }
}

function cwdOf(ctx: unknown): string {
  let raw: string | undefined;
  try {
    raw = (ctx as { cwd?: string } | undefined)?.cwd;
  } catch {
    raw = undefined;
  }
  const cwd = typeof raw === "string" && raw !== "" ? raw : process.cwd();
  return resolveWorktreeOrigin(cwd) ?? cwd;
}

function branchOf(ctx: unknown): readonly BranchEntryLike[] | undefined {
  try {
    const sm = (ctx as { sessionManager?: { getBranch?: () => unknown } } | undefined)?.sessionManager;
    if (sm === undefined || typeof sm.getBranch !== "function") return undefined;
    const b = sm.getBranch();
    return Array.isArray(b) ? (b as BranchEntryLike[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Previous user message on the branch (§6.1.1, review #9): newest user
 *  message other than the current prompt. */
export function previousUserMessage(branch: readonly BranchEntryLike[], currentPrompt: string): string | undefined {
  let skippedCurrent = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (e?.type !== "message" || e.message?.role !== "user") continue;
    const text = textOfContent(e.message.content);
    if (!skippedCurrent && text === currentPrompt) {
      skippedCurrent = true;
      continue;
    }
    return text;
  }
  return undefined;
}

interface Pick {
  readonly entry: MemEntry;
  readonly p?: number;
  readonly modified?: boolean;
  /** S state-constraint pick (§3.4) — rendered with the「（发版进行中）」note. */
  readonly releaseInProgress?: boolean;
}

/** Cap by count and cumulative body bytes; the first pick always survives
 *  (truncated to the budget if it alone is larger). */
function fitPicks(picks: readonly Pick[], maxEntries: number, maxBytes: number): { pick: Pick; body: string }[] {
  const out: { pick: Pick; body: string }[] = [];
  let used = 0;
  for (const pick of picks) {
    if (out.length >= maxEntries) break;
    let body = pick.entry.body;
    const size = Buffer.byteLength(body, "utf8");
    if (out.length === 0 && size > maxBytes) {
      body = `${Buffer.from(body, "utf8")
        .subarray(0, Math.max(0, maxBytes - 3))
        .toString("utf8")
        .replace(/\uFFFD+$/, "")}…`;
    } else if (used + size > maxBytes) {
      break;
    }
    used += Buffer.byteLength(body, "utf8");
    out.push({ pick, body });
  }
  return out;
}

// ───────────────────────────── predict helpers (memory-predict plan §3.3/§5.3/§7.3; wire.ts, non-pi-free) ─────────────────────────────

/** Union per-tag evidence across every `ScoredHit` that produced it (plan
 *  §3.3 final-record evidence; hits with no `tag` match or no evidence are
 *  skipped). */
export function evidenceForTag(hits: readonly ScoredHit[], tag: string): Evidence {
  const todoIds = new Set<number>();
  const jobShapes = new Set<string>();
  let branch: string | undefined;
  for (const h of hits) {
    if (h.tag !== tag || h.evidence === undefined) continue;
    for (const id of h.evidence.todoIds) todoIds.add(id);
    for (const s of h.evidence.jobShapes) jobShapes.add(s);
    if (h.evidence.branch !== undefined) branch = h.evidence.branch;
  }
  return { todoIds: [...todoIds], jobShapes: [...jobShapes], ...(branch === undefined ? {} : { branch }) };
}

/** §3.3 R2-5: restore carry **only from the newest `kind:"final"`** predict
 *  record on the branch — a `kind:"call"` record (P2) never participates,
 *  and scanning stops at the first final record found (a `cleared:"compaction"`
 *  empty final correctly caps carry at the compaction boundary). */
export function restoreCarryFromBranch(branch: readonly BranchEntryLike[]): CarryState | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as { type?: string; customType?: string; data?: unknown } | undefined;
    if (e?.type !== "custom" || e.customType !== MEMORY_PREDICT_CUSTOM_TYPE) continue;
    const d = e.data as Partial<FinalRecord> | undefined;
    if (d === undefined || d === null || typeof d !== "object" || d.v !== 1 || d.kind !== "final") continue;
    return carryFromFinal(d as FinalRecord);
  }
  return undefined;
}

export interface PredictSummary {
  readonly tags: readonly string[];
  readonly state: readonly string[];
  readonly origin: string;
}

/** §5.3 commitParts: U-only stays byte-identical to pre-P1 (returned
 *  unchanged, no `parts`/`predict`); P-only gets an optional `predict`
 *  summary attached; both present ⇒ one merged message, top layer "P",
 *  content = P body + blank line + U body, `parts` = [P, U] (C-J16 shape). */
export function mergeInjectMessages(
  p: InjectMessage | undefined,
  u: InjectMessage | undefined,
  predictSummary: PredictSummary | undefined,
): InjectMessage | undefined {
  if (p === undefined) return u;
  const pd = p.details as MemoryInjectDetailsV1;
  if (u === undefined) {
    if (predictSummary === undefined) return p;
    return { ...p, details: { ...pd, predict: predictSummary } };
  }
  const ud = u.details as MemoryInjectDetailsV1;
  const partOf = (d: MemoryInjectDetailsV1): MemoryInjectPartV1 => ({
    layer: d.layer,
    trigger: d.trigger,
    ...(d.model === undefined ? {} : { model: d.model }),
    ...(d.partial === true ? { partial: true as const } : {}),
    items: d.items,
  });
  const merged: MemoryInjectDetailsV1 = {
    v: 1,
    layer: "P",
    trigger: pd.trigger,
    items: pd.items,
    parts: [partOf(pd), partOf(ud)],
    ...(predictSummary === undefined ? {} : { predict: predictSummary }),
  };
  return {
    customType: MEMORY_INJECT_CUSTOM_TYPE,
    content: `${p.content}\n\n${u.content}`,
    display: true,
    details: merged,
  };
}

// ───────────────────────────── wireJev ─────────────────────────────

interface Corpus {
  readonly dir: string;
  readonly entries: readonly MemEntry[];
  readonly index: JevIndexV1;
  readonly taxonomy: Taxonomy;
}

type InjectMessage = NonNullable<BeforeAgentStartEventResult["message"]>;

export function wireJev(pi: ExtensionAPI, deps: WireJevDeps): WireJevResult {
  const now = deps.now ?? ((): number => Date.now());
  const clock: Clock =
    deps.clock ??
    createSegmentedClock({
      now,
      set: (ms, fn) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
      },
      clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
  // Diagnostic log sink (failover failures from client.ts + every handler's
  // catch-and-log here). Interactive TUI sessions must never write stdout/
  // stderr directly (it breaks the TUI layout) — those lines go into a
  // bounded ring buffer instead, surfaced by `/mem jev`'s report (`errors`
  // section below); status-level changes already reach the user via
  // `notify()`/`ui.notify` (TUI-safe), so this is pure diagnostic noise.
  // Non-UI **main** sessions (print mode, rpc) keep the pre-existing
  // byte-identical console.warn behavior (I9-style: no UI ⇒ unchanged).
  // Child sessions are the exception: they run IN-PROCESS, so their stdout
  // IS the host TUI's stdout — a child writing console.warn breaks the main
  // session's layout. Child diagnostics go into the ring buffer too.
  // `ui` is set by the session_start handler below once `ctx.hasUI` is
  // known; `ui !== undefined` is reused as the hasUI signal here so there is
  // no separate piece of state to keep in sync (I4).
  const errorLog: { readonly at: number; readonly line: string }[] = [];
  const pushErrorLog = (line: string): void => {
    errorLog.push({ at: now(), line });
    if (errorLog.length > JEV_ERROR_LOG_MAX) errorLog.shift();
  };
  const log =
    deps.log ??
    ((line: string): void => {
      if (ui !== undefined || isChild) {
        pushErrorLog(line);
        return;
      }
      console.warn(`[pi-subagent] jev: ${line}`);
    });
  const isChild = deps.isChildSession;
  const config = deps.config;
  const client: JevClientHandle =
    deps.client ??
    createJevClient({ config, isChild, now, log: (line) => log(line.replace(/^\[pi-subagent\] jev: /, "")) });
  const entryIndex = deps.entryIndex ?? new EntryIndex();
  const segment: SegmentState = createSegmentState();
  const platform = deps.platform ?? process.platform;

  /** Child sessions run only with `memory.jev.childSessions` AND
   *  `injectInChildSessions` (jev-arch §8); otherwise every handler is inert. */
  const runs = !isChild || (config.childSessions && deps.settings.injectInChildSessions);

  // ── closure state ──
  let registry: ClassifierRegistryLike | undefined;
  let registryOk: boolean | undefined;
  let ui: { notify(text: string, level?: "info" | "warning" | "error"): void } | undefined;
  let sessionCwd: string | undefined;
  let turnSeq = 0;
  let generation = 0;
  let recallAbort: AbortController | undefined;
  let bgAbort = new AbortController();
  let bgChain: Promise<void> = Promise.resolve();
  let bgDepth = 0;
  let statusPrev: JevStatus | undefined;
  let probeSettled = false;
  let firstFullNotified = false;
  const notifiedPartialReasons = new Set<string>();
  let bulkKicked = false;
  let reviewChecked = false;
  let lastBackfillAt = -Infinity;
  let recoveryTimer: { handle: TimerHandle; at: number } | undefined;
  let truncated: { from: number; to: number } | undefined;
  let errorSignatures = new Set<string>();
  let errorAsks = 0;
  // memory-predict plan §2.1/§11.1: P-layer closure state (I4). `recentTools`
  // rotates on every before_agent_start (prev run → current PredictInput,
  // current run resets to empty). `dirtyCache` is an async-refreshed 20s TTL
  // cell — the git subprocess runs in the background; the turn that kicked
  // the refresh uses whatever was cached before (old value or "unknown").
  let prevRunTools: ToolLite[] = [];
  let curRunTools: { tool: string; shape?: string; pathClass?: PathClass; isError?: boolean }[] = [];
  const curRunToolIndex = new Map<string, number>();
  let dirtyCache: { value: boolean | undefined; at: number } = { value: undefined, at: -Infinity };
  let dirtyGitRunner: GitRunner | undefined;
  let predictBashJobs: JevBashJobsLitePort | undefined;
  let predictFleet: JevFleetPort | undefined;
  let rulesFired = 0;
  const pStamps = new Map<EntryHash, string>();
  const parsedCache = new Map<string, ParseShellResult>();
  const dataCache = new Map<string, { at: number; corpus: Corpus }>();
  const anchors = new Map<EntryHash, { file: string; section: string; heading?: string; ordinal: number }>();
  const send = (message: InjectMessage): void => {
    try {
      if (typeof pi.sendMessage === "function") pi.sendMessage(message, { triggerTurn: false });
    } catch (err) {
      log(`sendMessage failed: ${String((err as Error)?.message ?? err)}`);
    }
  };
  const append = (data: unknown): void => {
    try {
      if (typeof pi.appendEntry === "function") pi.appendEntry("subagent:memory-recall", data);
    } catch (err) {
      log(`appendEntry failed: ${String((err as Error)?.message ?? err)}`);
    }
  };
  const appendPredict = (data: unknown): void => {
    try {
      if (typeof pi.appendEntry === "function") pi.appendEntry(MEMORY_PREDICT_CUSTOM_TYPE, data);
    } catch (err) {
      log(`appendEntry predict failed: ${String((err as Error)?.message ?? err)}`);
    }
  };

  // ───────── corpus ─────────

  const corpusFor = (cwd: string): Corpus | undefined => {
    const dir = deps.dirFor(cwd);
    if (dir === undefined) return undefined;
    const hit = dataCache.get(dir);
    if (hit !== undefined && now() - hit.at < DATA_CACHE_MS) return hit.corpus;
    const entries = entryIndex.get(dir);
    const index = readIndex(dir).index;
    const merged = mergeTaxonomy(readTaxonomyFile(dir));
    const taxonomy = merged.ok ? merged.taxonomy : (mergeTaxonomy() as { ok: true; taxonomy: Taxonomy }).taxonomy;
    const corpus: Corpus = { dir, entries, index, taxonomy };
    dataCache.set(dir, { at: now(), corpus });
    return corpus;
  };
  const invalidate = (cwd: string): void => {
    const dir = deps.dirFor(cwd);
    if (dir === undefined) {
      dataCache.clear();
      return;
    }
    dataCache.delete(dir);
    entryIndex.invalidate(dir);
  };
  deps.onAfterWriteHook((cwd) => {
    try {
      invalidate(resolveWorktreeOrigin(cwd) ?? cwd);
    } catch {
      /* never break the write path */
    }
  });

  // ───────── status ─────────

  const effectiveStatus = (): JevStatus => (registryOk === true ? client.status() : { kind: "off", reason: "pi-api" });

  const observe = (ctx: unknown): ClassifierRegistryLike | undefined => {
    const r = registryOf(ctx);
    registryOk = r !== undefined;
    if (r !== undefined) registry = r;
    return r;
  };

  const coverageOf = (cwd: string | undefined): { tagged: number; total: number } => {
    if (cwd === undefined) return { tagged: 0, total: 0 };
    const c = corpusFor(cwd);
    return c === undefined ? { tagged: 0, total: 0 } : coverage(c.entries, c.index);
  };

  /** `inactive` (§5.3): nothing to show (coverage 0, no tags= marks)
   * AND no classifier credentials at all (every model no-auth/not-found —
   * the notify table's "inactive" case). A user WITH credentials whose calls
   * fail (451/402) is a real partial, not inactive, even at coverage 0. */
  const refreshInactive = (cwd: string | undefined): void => {
    if (cwd === undefined) return;
    const c = corpusFor(cwd);
    let nothingToShow = true;
    if (c !== undefined) {
      const cov = coverage(c.entries, c.index);
      const inline = c.entries.some(
        (e) => (e.inline.tagsAdd?.length ?? 0) > 0 || (e.inline.tagsRemove?.length ?? 0) > 0,
      );
      nothingToShow = cov.tagged === 0 && !inline;
    }
    const health = getHealthTable();
    const t = now();
    const failingWithCreds = config.classifiers.some((id) => {
      const h = health.get(id);
      return h !== undefined && (h.state === "unavailable" || h.state === "transient") && (h.until ?? 0) > t;
    });
    const st = client.status();
    const noCreds =
      st.kind === "partial" && (st.reason === "no-auth" || st.reason === "not-found") && !failingWithCreds;
    client.markInactive(nothingToShow && noCreds);
  };

  const notify = (text: string, level: "info" | "warning"): void => {
    if (isChild || ui === undefined) return;
    try {
      ui.notify(text, level);
    } catch {
      /* UI gone */
    }
  };

  const onStatus = (next: JevStatus): void => {
    if (isChild || !probeSettled || registryOk !== true) return;
    const hasCredentials = !(next.kind === "partial" && (next.reason === "no-auth" || next.reason === "not-found"));
    const kind = notifyFor(statusPrev, next, { firstFullNotified, notifiedPartialReasons, hasCredentials });
    statusPrev = next;
    if (kind !== undefined) {
      const cov = coverageOf(sessionCwd);
      const info =
        next.kind === "full"
          ? { model: next.model }
          : next.kind === "partial"
            ? { reason: next.reason, tagged: cov.tagged, total: cov.total }
            : {};
      notify(formatNotify(kind, info), kind === "degraded" || kind === "startup-partial" ? "warning" : "info");
      if (kind === "first-full") firstFullNotified = true;
      if ((kind === "degraded" || kind === "startup-partial") && next.kind === "partial") {
        notifiedPartialReasons.add(next.reason);
      }
    }
    if (next.kind === "full") onFull();
    if (next.kind === "partial" && next.retryAt !== undefined) scheduleRecovery(next.retryAt);
  };
  client.onStatusChange((_prev, next) => {
    try {
      onStatus(next);
    } catch (err) {
      log(`status handler failed: ${String((err as Error)?.message ?? err)}`);
    }
  });

  /** Availability refresh + one cheap real call (§5.3 "探测"). */
  const probeOnce = async (): Promise<JevStatus> => {
    const reg = registry;
    if (reg === undefined || registryOk !== true) return effectiveStatus();
    try {
      await withTimeout(client.probe(reg, bgAbort.signal), PROBE_BUDGET_MS + OUTER_SLACK_MS);
      const st = client.status();
      if (st.kind === "probing" || st.kind === "full") {
        await withTimeout(
          client.ask({
            duty: "probe",
            registry: reg,
            state: { probe: "ok" },
            questions: {
              probe: {
                type: "bool",
                instructions: "Health check for the memory classifier. Answer true.",
                criteria: { true: "ok", false: "not ok" },
              },
            },
            budgetMs: PROBE_BUDGET_MS,
            mode: "background",
            signal: bgAbort.signal,
          }),
          PROBE_BUDGET_MS + OUTER_SLACK_MS,
        );
      }
    } catch (err) {
      log(`probe failed: ${String((err as Error)?.message ?? err)}`);
    }
    refreshInactive(sessionCwd);
    probeSettled = true;
    const st = effectiveStatus();
    onStatus(st);
    return st;
  };

  function scheduleRecovery(at: number): void {
    if (isChild) return;
    if (recoveryTimer !== undefined && recoveryTimer.at <= at && recoveryTimer.at > now()) return;
    if (recoveryTimer !== undefined) clock.clearTimer(recoveryTimer.handle);
    const delay = clampSpanMs(at - now() + 50) ?? 0;
    const handle = clock.setTimer(delay, () => {
      recoveryTimer = undefined;
      void probeOnce();
    });
    recoveryTimer = { handle, at };
  }

  /** Background task queue (bulk tagging / backfill / review): serialized,
   *  each capped at 120s, aborted on session_shutdown. Main session only. */
  const enqueue = (name: string, task: (signal: AbortSignal) => Promise<void>): void => {
    if (isChild) return;
    bgDepth += 1;
    const signal = bgAbort.signal;
    bgChain = bgChain
      .then(async () => {
        if (signal.aborted) return;
        const r = await withTimeout(task(signal), BACKGROUND_TOTAL_MS);
        if (r === TIMEOUT) log(`${name} exceeded ${BACKGROUND_TOTAL_MS}ms — abandoned`);
      })
      .catch((err: unknown) => log(`${name} failed: ${String((err as Error)?.message ?? err)}`))
      .finally(() => {
        bgDepth -= 1;
      });
  };

  const persistTags = async (dir: string, upserts: Record<EntryHash, EntryTags>): Promise<void> => {
    if (Object.keys(upserts).length === 0) return;
    const out = await writeIndexPatch(dir, { upsert: upserts, lastTaggedAt: new Date(now()).toISOString() });
    if (out === "busy") log("sidecar busy — tagging results not saved");
    dataCache.delete(dir);
  };

  /** §6.2.3 bulk tagging. `scope: "migration"` runs only when something is
   *  pending or tagged under an older taxonomy; "all" (tag add/enable) always
   *  re-asks every enabled tag. */
  const runBulk = (cwd: string, scope: "migration" | "all"): void => {
    enqueue("bulk tagging", async (signal) => {
      const reg = registry;
      const c = corpusFor(cwd);
      if (reg === undefined || c === undefined) return;
      const eligible = taggableEntries(c.entries);
      const pending = eligible.filter((e) => c.index.entries[e.hash] === undefined);
      const stale = eligible.some((e) => {
        const rec = c.index.entries[e.hash];
        return rec !== undefined && rec.taxonomyRev !== c.taxonomy.rev;
      });
      if (scope === "migration" && pending.length === 0 && !stale) return;
      const upserts: Record<EntryHash, EntryTags> = {};
      await tagBulk({
        client,
        registry: reg,
        entries: scope === "all" || stale ? eligible : pending,
        taxonomy: c.taxonomy,
        base: c.index.entries,
        signal,
        onEntryTags: (hash, tags) => {
          upserts[hash] = tags;
        },
      });
      await persistTags(c.dir, upserts);
      refreshInactive(cwd);
    });
  };

  /** Pending backfill during `full` (§6.2.3 "之后 full 期间对 pending 条目后台补打"). */
  const backfillPending = (cwd: string): void => {
    // Only after this session's probe settled (background work follows the
    // main session's own availability verdict, §5.3).
    if (isChild || !probeSettled || bgDepth > 0 || now() - lastBackfillAt < BACKFILL_INTERVAL_MS) return;
    const c = corpusFor(cwd);
    if (c === undefined) return;
    const pending = taggableEntries(c.entries).filter((e) => c.index.entries[e.hash] === undefined);
    if (pending.length === 0) return;
    lastBackfillAt = now();
    enqueue("pending backfill", async (signal) => {
      const reg = registry;
      if (reg === undefined) return;
      const upserts: Record<EntryHash, EntryTags> = {};
      for (const entry of pending.slice(0, BACKFILL_MAX_PER_PASS)) {
        if (signal.aborted || client.status().kind !== "full") break;
        const r = await tagOne({
          client,
          registry: reg,
          entry,
          taxonomy: c.taxonomy,
          compare: [],
          mode: "background",
          signal,
        });
        if (r.tags !== undefined) upserts[entry.hash] = r.tags;
        else if (!r.outcome.ok) break;
      }
      await persistTags(c.dir, upserts);
      refreshInactive(cwd);
    });
  };

  /** §6.3.1 periodic review: full ∧ ≥ intervalDays since last run ∧ corpusFp
   *  changed; intervalDays = 0 never runs. */
  const maybePeriodicReview = (cwd: string): void => {
    if (isChild || config.reviewIntervalDays <= 0) return;
    const c = corpusFor(cwd);
    if (c === undefined) return;
    const last = c.index.review?.lastRunAt;
    const lastMs = last === undefined ? Number.NaN : Date.parse(last);
    if (Number.isFinite(lastMs) && now() - lastMs < config.reviewIntervalDays * DAY_MS) return;
    if (c.index.review !== undefined && c.index.review.corpusFp === corpusFingerprint(c.entries)) return;
    enqueue("periodic review", async (signal) => {
      const reg = registry;
      if (reg === undefined || client.status().kind !== "full") return;
      const outcome = await runReviewPass({
        client,
        registry: reg,
        entries: c.entries,
        index: c.index,
        today: localToday(now()),
        project: c.dir.split("/").filter(Boolean).pop() ?? "",
        signal,
      });
      if ("ok" in outcome) {
        log(`periodic review failed (${outcome.reason})`);
        return;
      }
      const out = await writeIndexPatch(c.dir, { review: outcome });
      if (out === "busy") log("sidecar busy — review results not saved");
      dataCache.delete(c.dir);
    });
  };

  function onFull(): void {
    if (isChild || sessionCwd === undefined) return;
    if (!bulkKicked) {
      bulkKicked = true;
      runBulk(sessionCwd, "migration");
    }
    if (!reviewChecked) {
      reviewChecked = true;
      maybePeriodicReview(sessionCwd);
    }
  }

  // ───────── message building ─────────

  const buildMessage = (
    layer: InjectLayer,
    fitted: readonly { pick: Pick; body: string }[],
    trigger: string,
    opts: { model?: string; partial?: boolean } = {},
  ): InjectMessage => {
    const today = localToday(now());
    const items = fitted.map(({ pick, body }) => ({
      anchor: entryAnchor(pick.entry),
      body,
      ...(pick.p === undefined ? {} : { p: pick.p }),
      ...(expiredEntries([pick.entry], today).length > 0 ? { expired: true } : {}),
      ...(pick.modified === true ? { modified: true } : {}),
      ...(pick.releaseInProgress === true ? { releaseInProgress: true } : {}),
    }));
    const details: MemoryInjectDetailsV1 = {
      v: 1,
      layer,
      trigger,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.partial === true ? { partial: true as const } : {}),
      items: fitted.map(({ pick }) => ({
        file: pick.entry.file,
        anchor: entryAnchor(pick.entry),
        hash: pick.entry.hash,
        authority: pick.entry.authority,
        ...(pick.p === undefined ? {} : { p: pick.p }),
      })),
    };
    return {
      customType: MEMORY_INJECT_CUSTOM_TYPE,
      content: formatInjectMessage(layer, items),
      display: true,
      details,
    };
  };

  /** Dedup + cap + durable record, then the message (or undefined when
   *  nothing survived). */
  const commit = (
    layer: InjectLayer,
    picks: readonly Pick[],
    maxEntries: number,
    maxBytes: number,
    trigger: string,
    opts: { model?: string; partial?: boolean; bFor?: string } = {},
  ): InjectMessage | undefined => {
    const fresh = picks.filter((p) => !segment.isInjected(p.entry.hash));
    const fitted = fitPicks(fresh, maxEntries, maxBytes);
    if (fitted.length === 0) return undefined;
    const accepted = new Set(
      segment.markInjected(
        layer,
        fitted.map((f) => f.pick.entry.hash),
      ),
    );
    const kept = fitted.filter((f) => accepted.has(f.pick.entry.hash));
    if (kept.length === 0) return undefined;
    append(
      recallRecord(
        layer,
        kept.map((k) => k.pick.entry.hash),
        opts.bFor === undefined ? {} : { bFor: opts.bFor },
      ),
    );
    for (const k of kept) {
      const e = k.pick.entry;
      anchors.set(e.hash, {
        file: e.file,
        section: e.section,
        ...(e.heading === undefined ? {} : { heading: e.heading }),
        ordinal: e.ordinal,
      });
    }
    return buildMessage(layer, kept, trigger, opts);
  };

  const zeroCallAllowed = (): { ok: boolean; partial: boolean } => {
    const st = effectiveStatus();
    if (st.kind === "off") return { ok: false, partial: false };
    if (st.kind === "partial" && st.inactive) return { ok: false, partial: true };
    return { ok: true, partial: st.kind === "partial" };
  };

  const judgedAllowed = (): boolean => {
    const st = effectiveStatus();
    return st.kind === "full" || st.kind === "probing";
  };

  // ───────── U layer ─────────

  const recallCandidates = (
    c: Corpus,
    cwd: string,
    query: string,
    predicted?: ReadonlyMap<string, number>,
  ): { cands: RecallCandidate[]; entries: Map<string, MemEntry> } => {
    const info = deps.getRenderInfo(cwd);
    const eligible = c.entries.filter(
      (e) => e.inline.isPrivate !== true && !e.secret && !segment.isInjected(e.hash) && !isStaticCore(e, info),
    );
    let pool = eligible;
    if (eligible.length > RECALL_MAX_CANDIDATES) {
      // §5.4 优先入池：带预测 tag（score ≥0.5）的条目最多保留 40 槽（排序
      // 用户令 → max p × importance → file），其余 320 槽交给现有 prefilter
      // （tieBreak 仍是 user-first），两段合并后按 hash 去重。
      let priorityEntries: MemEntry[] = [];
      if (predicted !== undefined && predicted.size > 0) {
        const prio: { entry: MemEntry; cand: PriorityCandidate }[] = [];
        for (const e of eligible) {
          const record = c.index.entries[e.hash];
          const meta = effectiveMeta(e, record, c.taxonomy);
          let p = 0;
          for (const t of meta.tags) {
            const s = predicted.get(t);
            if (s === undefined || s < 0.5) continue;
            const tp = record?.tags[t]?.p ?? (e.inline.tagsAdd?.includes(t) === true ? 1 : 0);
            p = Math.max(p, tp);
          }
          if (p <= 0) continue;
          prio.push({
            entry: e,
            cand: {
              hash: e.hash,
              file: e.file,
              p,
              importance: meta.pending ? 2 : (meta.importance ?? 0),
              isUserAuthority: e.authority === "user",
            },
          });
        }
        const byHash = new Map(prio.map((x) => [x.cand.hash, x.entry] as const));
        priorityEntries = prioritizeCandidates(prio.map((x) => x.cand)).map((k) => byHash.get(k.hash)!);
      }
      const priorityHashes = new Set(priorityEntries.map((e) => e.hash));
      const rest = prefilter(
        eligible.filter((e) => !priorityHashes.has(e.hash)),
        (e) => e.body,
        query,
        RECALL_MAX_CANDIDATES - priorityEntries.length,
        (a, b) => (a.authority === b.authority ? 0 : a.authority === "user" ? -1 : 1),
      );
      const seen = new Set<string>();
      const merged: MemEntry[] = [];
      for (const e of [...priorityEntries, ...rest]) {
        if (seen.has(e.hash)) continue;
        seen.add(e.hash);
        merged.push(e);
      }
      pool = merged;
      truncated = { from: eligible.length, to: pool.length };
    } else {
      truncated = undefined;
    }
    const entries = new Map<string, MemEntry>();
    const cands = pool.map((e, i): RecallCandidate => {
      const id = `e${i + 1}`;
      entries.set(id, e);
      const meta = effectiveMeta(e, c.index.entries[e.hash], c.taxonomy);
      return {
        id,
        file: e.file,
        excerpt: redactForJev(e.body, "entry"),
        authority: e.authority,
        ...(meta.type === undefined ? {} : { type: meta.type }),
        ...(meta.importance === undefined ? {} : { importance: meta.importance }),
        ...(meta.tags.length === 0 ? {} : { tags: meta.tags }),
      };
    });
    return { cands, entries };
  };

  /** Ask all batches in parallel under one budget; merged answers or
   *  undefined when every batch failed. */
  const askAll = async (
    duty: "recall" | "error",
    reg: ClassifierRegistryLike,
    state: Record<string, unknown>,
    questions: Parameters<JevClient["ask"]>[0]["questions"],
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<{ answers: Record<string, JevAnswer>; model: string } | undefined> => {
    const batches = splitBatches(state, questions);
    const all = Promise.all(
      batches.map((b) =>
        client.ask({ duty, registry: reg, state: b.state, questions: b.questions, budgetMs, mode: "sync", signal }),
      ),
    );
    const outcomes = await withTimeout(all, budgetMs + OUTER_SLACK_MS);
    if (outcomes === TIMEOUT) return undefined;
    const answers: Record<string, JevAnswer> = {};
    let model: string | undefined;
    for (const o of outcomes) {
      if (!o.ok) continue;
      Object.assign(answers, o.answers);
      model ??= o.model;
    }
    if (model === undefined) {
      const first = outcomes.find((o) => !o.ok);
      if (first !== undefined && !first.ok) log(`${duty} failed (${first.reason}): ${first.detail.slice(0, 160)}`);
      return undefined;
    }
    return { answers, model };
  };

  /** Settle a judged layer: inside `waitMs` ⇒ returned for the
   *  before_agent_start message; later ⇒ sendMessage if still current. */
  const settle = async (
    work: Promise<(() => InjectMessage | undefined) | undefined>,
    gen: number,
    controller: AbortController,
    waitMs: number,
  ): Promise<InjectMessage | undefined> => {
    const late = (finalize: (() => InjectMessage | undefined) | undefined): void => {
      if (finalize === undefined || gen !== generation || controller.signal.aborted) return;
      const m = finalize();
      if (m !== undefined) send(m);
    };
    if (waitMs > 0) {
      const r = await withTimeout(work, waitMs);
      if (r !== TIMEOUT) return r?.();
    }
    work.then(late).catch((err: unknown) => log(`late recall failed: ${String((err as Error)?.message ?? err)}`));
    return undefined;
  };

  const recallU = async (
    prompt: string,
    ctx: ExtensionContext,
    cwd: string,
    reg: ClassifierRegistryLike,
    predicted?: ReadonlyMap<string, number>,
  ): Promise<InjectMessage | undefined> => {
    if (!judgedAllowed() || segment.full()) return undefined;
    const stripped = stripSkillBlocks(prompt).trim();
    if (!passesPromptGate(stripped)) return undefined;
    const c = corpusFor(cwd);
    if (c === undefined) return undefined;
    const userMessage = redactForJev(stripped, "user");
    let previous: string | undefined;
    if (!isChild) {
      const branch = branchOf(ctx);
      const prevRaw = branch === undefined ? undefined : previousUserMessage(branch, prompt);
      const prevStripped = prevRaw === undefined ? "" : stripSkillBlocks(prevRaw).trim();
      if (prevStripped !== "") previous = redactForJev(prevStripped, "previousUser");
    }
    const { cands, entries: byId } = recallCandidates(c, cwd, `${userMessage}\n${previous ?? ""}`, predicted);
    if (cands.length === 0) return undefined;
    const { state, questions } = buildRecallQuestions({
      userMessage,
      ...(previous === undefined ? {} : { previousUserMessage: previous }),
      session: isChild ? "child" : "main",
      today: localToday(now()),
      candidates: cands,
    });
    recallAbort?.abort();
    const controller = new AbortController();
    recallAbort = controller;
    const gen = ++generation;
    const work = (async (): Promise<(() => InjectMessage | undefined) | undefined> => {
      const res = await askAll("recall", reg, state, questions, RECALL_BUDGET_MS, controller.signal);
      if (res === undefined) return undefined;
      const decided = decideRecall(res.answers, cands, config);
      const picks: Pick[] = [];
      for (const d of decided) {
        const entry = byId.get(d.id);
        if (entry !== undefined) picks.push({ entry, p: d.p });
      }
      if (picks.length === 0) return undefined;
      return () => commit("U", picks, config.recall.maxEntries, config.recall.maxBytes, "user", { model: res.model });
    })();
    return settle(work, gen, controller, config.recall.waitMs);
  };

  // ───────── E layer ─────────

  const recallE = (input: {
    cwd: string;
    tool: string;
    command: string;
    exitCode: number | undefined;
    errorText: string;
    hitTags: readonly string[];
  }): Promise<(() => InjectMessage | undefined) | undefined> | undefined => {
    const reg = registry;
    if (reg === undefined || !judgedAllowed() || segment.full() || errorAsks >= E_MAX_PER_SEGMENT) return undefined;
    const firstErrorLine = input.errorText.split("\n").find((l) => l.trim() !== "") ?? "";
    const signature = createHash("sha1")
      .update(
        `${input.tool}\u0000${input.command.split(/\s+/)[0] ?? ""}\u0000${String(input.exitCode)}\u0000${firstErrorLine.slice(0, 200)}`,
      )
      .digest("hex")
      .slice(0, 16);
    if (errorSignatures.has(signature)) return undefined;
    const c = corpusFor(input.cwd);
    if (c === undefined) return undefined;
    const hit = new Set(input.hitTags);
    let pool = c.entries.filter((e) => {
      if (e.inline.isPrivate === true || e.secret || segment.isInjected(e.hash)) return false;
      const meta = effectiveMeta(e, c.index.entries[e.hash], c.taxonomy);
      // Pending entries (no sidecar record yet) have no known type — they stay
      // candidates rather than being silently excluded (untagged corpora
      // would otherwise never get E recall).
      return meta.pending || meta.type === "pitfall" || meta.type === "procedure" || meta.tags.some((t) => hit.has(t));
    });
    if (pool.length === 0) return undefined;
    if (pool.length > E_MAX_CANDIDATES) pool = prefilter(pool, (e) => e.body, input.errorText, E_MAX_CANDIDATES);
    errorSignatures.add(signature);
    errorAsks += 1;
    const cands: ErrorCandidate[] = pool.map((e, i) => {
      const meta = effectiveMeta(e, c.index.entries[e.hash], c.taxonomy);
      return {
        id: `x${i + 1}`,
        file: e.file,
        excerpt: redactForJev(e.body, "entry"),
        ...(meta.type === undefined ? {} : { type: meta.type }),
      };
    });
    const { state, questions } = buildErrorQuestions({
      tool: input.tool,
      command: redactForJev(input.command, "command"),
      exitCode: input.exitCode,
      errorExcerpt: redactForJev(input.errorText, "error"),
      candidates: cands,
    });
    const signal = bgAbort.signal;
    return (async () => {
      const res = await askAll("error", reg, state, questions, ERROR_BUDGET_MS, signal);
      if (res === undefined) return undefined;
      const picks: Pick[] = [];
      for (const d of decideErrorRecall(res.answers, cands)) {
        const idx = cands.findIndex((x) => x.id === d.id);
        const entry = pool[idx];
        if (entry !== undefined) picks.push({ entry, p: d.p });
      }
      if (picks.length === 0) return undefined;
      return () => commit("E", picks, 2, config.recall.maxBytes, input.tool, { model: res.model });
    })();
  };

  const bashNotice = (message: { customType?: unknown; content?: unknown; details?: unknown }) => {
    if (message.customType !== BASH_JOB_NOTIFICATION_TYPE) return undefined;
    const text = textOfContent(message.content);
    const d = message.details as { exitCode?: unknown; status?: unknown } | undefined;
    const exitCode = failureExitCode({ detailsExitCode: d?.exitCode });
    const failed = (exitCode !== undefined && exitCode !== 0) || d?.status === "failed";
    if (!failed) return undefined;
    const cmd = /\(\$ (.+?)\) finished/.exec(text)?.[1] ?? "";
    return { command: cmd, exitCode, text };
  };

  // ───────── B layer ─────────

  const reinject = (cwd: string): InjectMessage | undefined => {
    const pending = segment.pendingReinject();
    if (pending === undefined) return undefined;
    const allowed = zeroCallAllowed();
    if (!allowed.ok) return undefined;
    const c = corpusFor(cwd);
    segment.markReinjected(pending.compactionId);
    if (c === undefined) return undefined;
    const picks: Pick[] = [];
    for (const hash of pending.hashes) {
      const same = c.entries.find((e) => e.hash === hash);
      if (same !== undefined) {
        if (same.inline.isPrivate !== true) picks.push({ entry: same });
        continue;
      }
      const a = anchors.get(hash);
      if (a === undefined) continue; // deleted (or unknown after reload) ⇒ skip
      const moved = c.entries.find(
        (e) => e.file === a.file && e.section === a.section && e.heading === a.heading && e.ordinal === a.ordinal,
      );
      if (moved !== undefined && moved.inline.isPrivate !== true) picks.push({ entry: moved, modified: true });
    }
    return commit("B", picks, 3, A_MAX_BYTES, "compaction", { bFor: pending.compactionId, partial: allowed.partial });
  };

  const onCompaction = (compactionId: string, cwd: string): void => {
    segment.resetOnCompaction(compactionId);
    errorSignatures = new Set();
    errorAsks = 0;
    parsedCache.clear();
    // memory-predict plan §3.3: compaction always clears carry — write an
    // empty `cleared:"compaction"` final record so the next branch scan
    // (restoreCarryFromBranch) stops here instead of reviving pre-compaction
    // carry state.
    if (config.predict.enabled) appendPredict(buildFinalRecord(turnSeq, [], 0, "compaction"));
    const m = reinject(cwd);
    if (m !== undefined) send(m);
  };

  const lastCompactionId = (branch: readonly BranchEntryLike[]): string | undefined => {
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i]?.type === "compaction") return branch[i]?.id ?? `idx:${i}`;
    }
    return undefined;
  };

  /** Parsed-shell cache for tool_call/tool_result tag matching (bounded,
   *  cleared on compaction/session_start). */
  const parseResultFor = (event: ToolCallEvent): ParseShellResult | undefined => {
    const input = event.input as Record<string, unknown>;
    if (typeof input["command"] !== "string" || event.toolName === "memory") return undefined;
    let res = parsedCache.get(event.toolCallId);
    if (res === undefined) {
      res = parseShell(input["command"]);
      if (parsedCache.size >= PARSED_CACHE_MAX) parsedCache.clear();
      parsedCache.set(event.toolCallId, res);
    }
    return res;
  };

  const parsedFor = (event: ToolCallEvent): readonly SimpleCommand[] | undefined => parseResultFor(event)?.commands;

  // ───────── A layer ─────────

  /** A-layer admission (2026-11-03 noise fix, run r_YE7XM20Q: generic tags
   *  — testing/ci/docs/workflow/shell-env/build/background-jobs — hit nearly
   *  every session and fired ~71% of all injections with zero judgment).
   *  Only risk:"high" tags (plus the allow list, minus the deny list) may
   *  trigger a zero-judgment injection. */
  const fastPathEligibleTags = (tax: Taxonomy): ReadonlySet<string> => {
    const allow = new Set(config.fastPath.allowTags);
    const deny = new Set(config.fastPath.denyTags);
    const out = new Set<string>();
    for (const t of tax.tags) {
      if ((t.risk === "high" || allow.has(t.id)) && !deny.has(t.id)) out.add(t.id);
    }
    return out;
  };

  /** Session-local overlay of A-injection stamps (the on-disk
   *  `index.aInjectedAt` lags by the async write + the 2s data cache). */
  const aStamps = new Map<EntryHash, string>();

  /** Cross-session cooldown verdict: true ⇒ the entry was A-injected
   *  recently enough to skip. U-layer judgment never consults this. */
  const aCoolingDown = (c: Corpus, hash: EntryHash): boolean => {
    const cooldownMs = config.fastPath.cooldownMs;
    if (cooldownMs <= 0) return false;
    const stamp = aStamps.get(hash) ?? c.index.aInjectedAt?.[hash];
    if (stamp === undefined) return false;
    const at = Date.parse(stamp);
    return Number.isFinite(at) && now() - at < cooldownMs;
  };

  /** Persist the A-injection stamps of a sent message (fire-and-forget;
   *  lock-busy drops the patch — the next tagging run or injection rewrites
   *  it, and a lost stamp merely costs one extra injection). */
  const recordAInjection = (c: Corpus, m: InjectMessage): void => {
    const details = m.details as MemoryInjectDetailsV1 | undefined;
    if (details === undefined || details.items.length === 0) return;
    const at = new Date(now()).toISOString();
    const upsert: Record<EntryHash, string> = {};
    for (const item of details.items) {
      aStamps.set(item.hash, at);
      upsert[item.hash] = at;
    }
    void writeIndexPatch(c.dir, { aInjectedAt: upsert })
      .then((out) => {
        if (out === "busy") log("sidecar busy — A-injection cooldown stamps not saved");
      })
      .catch((err: unknown) => log(`A-injection stamp write failed: ${String((err as Error)?.message ?? err)}`));
  };

  const fastPath = (event: ToolCallEvent, cwd: string): void => {
    const allowed = zeroCallAllowed();
    if (!allowed.ok || segment.full()) return;
    const c = corpusFor(cwd);
    if (c === undefined) return;
    const input = event.input as Record<string, unknown>;
    const parsed = parsedFor(event);
    const hits = matchTags({ tool: event.toolName, input, ...(parsed === undefined ? {} : { parsed }) }, c.taxonomy);
    if (hits.length === 0) return;
    const eligible = fastPathEligibleTags(c.taxonomy);
    const hit = new Set(hits.filter((t) => eligible.has(t)));
    if (hit.size === 0) return;
    const info = deps.getRenderInfo(cwd);
    const scored: { pick: Pick; score: number }[] = [];
    for (const e of c.entries) {
      if (e.inline.isPrivate === true || segment.isInjected(e.hash) || isStaticCore(e, info)) continue;
      const record = c.index.entries[e.hash];
      const meta = effectiveMeta(e, record, c.taxonomy);
      const shared = meta.tags.filter((t) => hit.has(t));
      if (shared.length === 0) continue;
      if (aCoolingDown(c, e.hash)) continue;
      const manualOnly = meta.pending;
      if (!manualOnly) {
        if ((meta.importance ?? 0) < 2) continue;
        if (meta.type !== "rule" && meta.type !== "pitfall" && meta.type !== "procedure") continue;
      }
      let p = 0;
      for (const t of shared) {
        const tp = record?.tags[t]?.p ?? (e.inline.tagsAdd?.includes(t) === true ? 1 : 0);
        p = Math.max(p, tp);
      }
      const importance = manualOnly ? 2 : (meta.importance ?? 2);
      scored.push({ pick: { entry: e }, score: p * importance });
    }
    if (scored.length === 0) return;
    scored.sort((a, b) => b.score - a.score || (a.pick.entry.file < b.pick.entry.file ? -1 : 1));
    const m = commit(
      "A",
      scored.map((s) => s.pick),
      A_MAX_ENTRIES,
      A_MAX_BYTES,
      event.toolName,
      {
        ...(allowed.partial ? { partial: true } : {}),
      },
    );
    if (m !== undefined) {
      send(m);
      recordAInjection(c, m);
    }
  };

  // ───────── P layer (memory-predict plan §1/§5/§7/§8.3, P1b: no model) ─────────

  const predictGitIo: GitHeadIo = {
    readTextFile(path) {
      try {
        return readRegular(dirname(path), basename(path)).text;
      } catch {
        return undefined;
      }
    },
  };

  const DIRTY_TTL_MS = 20_000;
  const invalidateDirty = (): void => {
    dirtyCache = { value: undefined, at: -Infinity };
  };
  const refreshDirtyAsync = (cwd: string): void => {
    if (now() - dirtyCache.at < DIRTY_TTL_MS) return;
    dirtyCache = { value: dirtyCache.value, at: now() }; // debounce concurrent kicks
    const runner = dirtyGitRunner ?? (dirtyGitRunner = createGitRunner());
    void runner(["status", "--porcelain", "-uno"], { cwd, timeoutMs: 150, maxStdoutBytes: 4_096 })
      .then((r) => {
        if (r.spawnError !== undefined || r.killed !== undefined) return;
        dirtyCache = { value: r.stdout.trim().length > 0, at: now() };
      })
      .catch(() => {
        /* leave the old/unknown value */
      });
  };
  /** §7.3: kicks an async refresh when stale, returns whatever is cached NOW
   *  (old value or "unknown" — never blocks the turn). */
  const dirtyValue = (cwd: string): boolean | undefined => {
    refreshDirtyAsync(cwd);
    return dirtyCache.value;
  };

  const PATH_INPUT_KEYS = ["path", "file_path", "filePath"] as const;
  const pathOfToolInput = (input: Record<string, unknown>): string | undefined => {
    for (const k of PATH_INPUT_KEYS) {
      const v = input[k];
      if (typeof v === "string") return v;
    }
    return undefined;
  };

  /** §2.1 H signal: 20-slot ring per run, rotated at the start of the NEXT
   *  run (`rotateRecentTools`, called from before_agent_start). */
  const rotateRecentTools = (): void => {
    prevRunTools = curRunTools.map((t) => ({
      tool: t.tool,
      ...(t.shape === undefined ? {} : { shape: t.shape }),
      ...(t.pathClass === undefined ? {} : { pathClass: t.pathClass }),
      ...(t.isError === undefined ? {} : { isError: t.isError }),
    }));
    curRunTools = [];
    curRunToolIndex.clear();
  };

  /** Cross-session P-injection cooldown (mirrors `aCoolingDown`/`recordAInjection`
   *  above, independent map — plan §2.1/§5.3). */
  const pCoolingDown = (c: Corpus, hash: EntryHash): boolean => {
    const cooldownMs = config.predict.cooldownMs;
    if (cooldownMs <= 0) return false;
    const stamp = pStamps.get(hash) ?? c.index.pInjectedAt?.[hash];
    if (stamp === undefined) return false;
    const at = Date.parse(stamp);
    return Number.isFinite(at) && now() - at < cooldownMs;
  };
  const recordPInjection = (c: Corpus, m: InjectMessage): void => {
    const details = m.details as MemoryInjectDetailsV1 | undefined;
    if (details === undefined || details.items.length === 0) return;
    const at = new Date(now()).toISOString();
    const upsert: Record<EntryHash, string> = {};
    for (const item of details.items) {
      pStamps.set(item.hash, at);
      upsert[item.hash] = at;
    }
    void writeIndexPatch(c.dir, { pInjectedAt: upsert })
      .then((out) => {
        if (out === "busy") log("sidecar busy — P-injection cooldown stamps not saved");
      })
      .catch((err: unknown) => log(`P-injection stamp write failed: ${String((err as Error)?.message ?? err)}`));
  };

  /** §5.1 candidate materialization: same exclusion/meta pipeline as the A
   *  layer (`fastPath` above), reshaped into `predict/select.ts`'s pure
   *  `Candidate`/`SCandidate` input shapes. */
  const predictCandidatesFor = (
    c: Corpus,
    cwd: string,
  ): { pCands: PredictCandidate[]; sCands: SCandidate[]; byHash: Map<EntryHash, MemEntry> } => {
    const info = deps.getRenderInfo(cwd);
    const byHash = new Map<EntryHash, MemEntry>();
    const pCands: PredictCandidate[] = [];
    const sCands: SCandidate[] = [];
    for (const e of c.entries) {
      if (e.inline.isPrivate === true || e.secret || segment.isInjected(e.hash) || isStaticCore(e, info)) continue;
      byHash.set(e.hash, e);
      const record = c.index.entries[e.hash];
      const meta = effectiveMeta(e, record, c.taxonomy);
      const tagP: Record<string, number> = {};
      for (const t of meta.tags) {
        const p = record?.tags[t]?.p ?? (e.inline.tagsAdd?.includes(t) === true ? 1 : 0);
        if (p > 0) tagP[t] = p;
      }
      const byteLength = Buffer.byteLength(e.body, "utf8");
      // select.ts's Candidate.authority is "user"|"model"|"none" (only "user"
      // affects scoring, §5.1); map the entry's "user"|"agent" authority.
      const selectAuthority: "user" | "model" = meta.authority === "user" ? "user" : "model";
      pCands.push({
        hash: e.hash,
        isPrivate: false,
        isSecret: false,
        isInjected: false,
        isStaticCore: false,
        coolingDown: pCoolingDown(c, e.hash),
        pending: meta.pending,
        ...(meta.importance === undefined ? {} : { importance: meta.importance }),
        ...(meta.type === undefined ? {} : { type: meta.type }),
        authority: selectAuthority,
        tagP,
        byteLength,
      });
      sCands.push({
        hash: e.hash,
        isPrivate: false,
        isSecret: false,
        authority: selectAuthority,
        ...(meta.type === undefined ? {} : { type: meta.type }),
        hasReleaseTag: meta.tags.includes("release"),
        byteLength,
      });
    }
    return { pCands, sCands, byHash };
  };

  /** §8.3 P1b orchestration (no model branch): rules + S + carry, zero-call,
   *  fully synchronous. Returns `undefined` when P did not even attempt to
   *  run this turn (off/partial-inactive/segment-full/no corpus/predict
   *  disabled) — distinct from "ran but produced nothing to inject". */
  const runPredictTurn = (
    prompt: string,
    ctx: ExtensionContext,
    cwd: string,
  ):
    | { message: InjectMessage | undefined; predictSummary: PredictSummary; predicted: ReadonlyMap<string, number> }
    | undefined => {
    const allowed = zeroCallAllowed();
    if (!allowed.ok || segment.full()) return undefined;
    const c = corpusFor(cwd);
    if (c === undefined) return undefined;
    rulesFired += 1;
    const branch = branchOf(ctx) ?? [];
    // §3.3 触发门：carry 每轮都从分支恢复（清空簿记——cancel/todo-replaced/
    // empty 在非承接轮同样生效，承接状态随之失效），但只有承接短语当轮才把
    // carry 传入 PredictInput 参与投票/注入；无关新指令不承接。
    const carryIn = restoreCarryFromBranch(branch);
    const stripped = stripSkillBlocks(prompt).trim();
    const carryActive = carryIn !== undefined && isCarryPhrase(stripped) ? carryIn : undefined;
    const prevRaw = previousUserMessage(branch, prompt);
    const prevStripped = prevRaw === undefined ? "" : stripSkillBlocks(prevRaw).trim();
    const gitBranch = readGitBranch(cwd, predictGitIo);
    const dirty = dirtyValue(cwd);
    const input = buildPredictInput({
      prompt: stripped,
      ...(prevStripped === "" ? {} : { previousPrompt: prevStripped }),
      todo: deps.todo?.list() ?? [],
      recentTools: prevRunTools,
      git: { ...(gitBranch === undefined ? {} : { branch: gitBranch }), ...(dirty === undefined ? {} : { dirty }) },
      bashJobs: predictBashJobs?.list() ?? [],
      activeSubagents: predictFleet?.activeRuns() ?? 0,
      session: isChild ? "child" : "main",
      ...(carryActive === undefined ? {} : { carry: carryActive }),
    });
    const result = runPredict(input, c.taxonomy);
    const { hits: ruleHits, modifiers } = runRules(input, c.taxonomy);
    const revalidatedCarry = input.carry === undefined ? undefined : revalidateCarry(input.carry, input);
    const hits = [...ruleHits, ...carryHits(revalidatedCarry)];
    const tagsWithEvidence = result.tags.map((t) => ({ ...t, evidence: evidenceForTag(hits, t.tag) }));
    const cancelled = modifiers.some((m) => m.kind === "cancel");
    const prevTodoIds = (carryIn?.tags ?? []).flatMap((t) => t.evidence.todoIds);
    const currentInProgressIds = input.todo.filter((t) => t.status === "in_progress").map((t) => t.id);
    const todoReplaced = isTodoReplaced(prevTodoIds, currentInProgressIds);
    const clearedReason = detectCarryClear({
      cancelled,
      compacted: false,
      todoReplaced,
      finalTagsEmpty: tagsWithEvidence.length === 0,
    });
    const newCarries = clearedReason !== undefined ? 0 : (revalidatedCarry?.carries ?? 0);
    const hadCarryBefore = carryIn !== undefined;
    if (tagsWithEvidence.length > 0 || hadCarryBefore) {
      appendPredict(
        buildFinalRecord(turnSeq, clearedReason === undefined ? tagsWithEvidence : [], newCarries, clearedReason),
      );
    }
    // Selection runs off `result.tags`/`result.state` regardless of
    // `clearedReason` — that flag only governs what gets WRITTEN to the
    // final record (carry housekeeping for the NEXT turn), not whether THIS
    // turn injects. Negated/readonly tags are already scored to 0 and
    // dropped by `tally()`, so there is nothing left to over-inject here;
    // the S constraint in particular must survive even when the turn's
    // carry resolves to "empty" (no tag-level carry to keep).
    let message: InjectMessage | undefined;
    {
      const eligible = fastPathEligibleTags(c.taxonomy);
      const { pCands, sCands, byHash } = predictCandidatesFor(c, cwd);
      const selected = selectPEntries({
        tags: result.tags,
        eligibleTags: eligible,
        candidates: pCands,
        maxEntries: config.predict.maxEntries,
        maxBytes: config.predict.maxBytes,
      });
      const usedBytes = selected.reduce((sum, s) => sum + s.byteLength, 0);
      const sSelected = selectSEntry(result.state, sCands, Math.max(0, config.predict.maxBytes - usedBytes));
      const picks: Pick[] = [];
      for (const s of selected) {
        const e = byHash.get(s.hash);
        if (e !== undefined) picks.push({ entry: e });
      }
      if (sSelected !== undefined) {
        const e = byHash.get(sSelected.hash);
        if (e !== undefined) picks.push({ entry: e, releaseInProgress: true });
      }
      if (picks.length > 0) {
        message = commit("P", picks, picks.length, config.predict.maxBytes, "predict", {
          ...(allowed.partial ? { partial: true } : {}),
        });
        if (message !== undefined) recordPInjection(c, message);
      }
    }
    return {
      message,
      predictSummary: {
        tags: result.tags.map((t) => t.tag),
        state: result.state.map((s) => s.kind),
        origin: result.origin,
      },
      // §5.4 优先入池原料：本轮预测 tag → finalScore（≥0.5 的由
      // recallCandidates 筛）。predict.enabled=false / P 未跑时本对象不存在。
      predicted: new Map(result.tags.map((t) => [t.tag, t.score] as const)),
    };
  };

  // ───────── hooks ─────────

  const seedFrom = (ctx: unknown): void => {
    const branch = branchOf(ctx);
    if (branch !== undefined) segment.seed(branch);
  };

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    if (!runs) return undefined;
    try {
      const reg = observe(ctx);
      if (reg === undefined) return undefined; // off(pi-api): zero work
      const cwd = cwdOf(ctx);
      if (!isChild) sessionCwd = cwd;
      turnSeq += 1;
      recallAbort?.abort();
      if (config.predict.enabled) rotateRecentTools();
      seedFrom(ctx);
      const b = reinject(cwd);
      if (b !== undefined) send(b);
      if (event.messageType === "custom") {
        const customType = (event.message as { customType?: unknown } | undefined)?.customType;
        const notice = bashNotice(event.message as { customType?: unknown; content?: unknown; details?: unknown });
        if (notice === undefined) return undefined;
        const work = recallE({
          cwd,
          tool: "bash",
          command: notice.command,
          exitCode: notice.exitCode,
          errorText: notice.text,
          hitTags: [],
        });
        if (work === undefined) return undefined;
        const controller = new AbortController();
        recallAbort = controller;
        const gen = ++generation;
        const m = await settle(work, gen, controller, config.recall.waitMs);
        return m === undefined ? undefined : { message: m };
      }
      if (!isChild && judgedAllowed() && client.status().kind === "full") backfillPending(cwd);
      // §5.3/§8.3: P 与 U 互不拖累——P 抛异常只放弃 P（记诊断日志），U 仍按
      // 原路径返回/合并；U 的异常仍由外层 catch 兕底（原行为不变）。
      let pMessage: ReturnType<typeof runPredictTurn>;
      if (config.predict.enabled && (!isChild || config.predict.childSessions)) {
        try {
          pMessage = runPredictTurn(event.prompt, ctx, cwd);
        } catch (err) {
          log(`predict turn failed: ${String((err as Error)?.message ?? err)}`);
          pMessage = undefined;
        }
      }
      const uMessage = await recallU(event.prompt, ctx, cwd, reg, pMessage?.predicted);
      const merged = mergeInjectMessages(pMessage?.message, uMessage, pMessage?.predictSummary);
      return merged === undefined ? undefined : { message: merged };
    } catch (err) {
      log(`before_agent_start failed: ${String((err as Error)?.message ?? err)}`);
      return undefined;
    }
  });

  // tool_call: the A layer only (the interception gate was removed with the
  // gate feature, 2026-11). Fully synchronous — returns `undefined` with ZERO
  // awaits. Everything is wrapped: an exception never blocks the call (C-J2 —
  // a throwing handler would block the tool).
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (!runs) return undefined;
    try {
      if (observe(ctx) === undefined) return undefined;
      fastPath(event, cwdOf(ctx));
      if (config.predict.enabled) {
        try {
          const input = event.input as Record<string, unknown>;
          const entry: { tool: string; shape?: string; pathClass?: PathClass; isError?: boolean } = {
            tool: event.toolName,
          };
          if (event.toolName === "bash" && typeof input["command"] === "string") {
            entry.shape = shapeOf(input["command"]);
          }
          const path = pathOfToolInput(input);
          if (path !== undefined) entry.pathClass = classifyPathClass(path);
          if (curRunTools.length < 20) {
            curRunToolIndex.set(event.toolCallId, curRunTools.length);
            curRunTools.push(entry);
          }
        } catch {
          /* H signal is best-effort — never block the tool */
        }
      }
    } catch (err) {
      log(`tool_call failed: ${String((err as Error)?.message ?? err)}`);
    }
    return undefined;
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (!runs) return undefined;
    try {
      if (observe(ctx) === undefined) return undefined;
      if (config.predict.enabled) {
        if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash") invalidateDirty();
        if (event.isError === true) {
          const idx = curRunToolIndex.get(event.toolCallId);
          if (idx !== undefined && curRunTools[idx] !== undefined) curRunTools[idx]!.isError = true;
        }
      }
      const text = textOfContent(event.content);
      const exitCode = failureExitCode({ structuredContent: event.structuredContent, text });
      if (!event.isError && (exitCode === undefined || exitCode === 0)) return undefined;
      const cwd = cwdOf(ctx);
      const command = typeof event.input["command"] === "string" ? event.input["command"] : "";
      const c = corpusFor(cwd);
      const hitTags =
        c === undefined
          ? []
          : matchTags(
              {
                tool: event.toolName,
                input: event.input,
                ...(parsedCache.has(event.toolCallId) ? { parsed: parsedCache.get(event.toolCallId)!.commands } : {}),
              },
              c.taxonomy,
            );
      const work = recallE({ cwd, tool: event.toolName, command, exitCode, errorText: text, hitTags });
      if (work !== undefined) {
        const gen = generation;
        work
          .then((finalize) => {
            if (finalize === undefined || gen !== generation) return;
            const m = finalize();
            if (m !== undefined) send(m);
          })
          .catch((err: unknown) => log(`error recall failed: ${String((err as Error)?.message ?? err)}`));
      }
    } catch (err) {
      log(`tool_result failed: ${String((err as Error)?.message ?? err)}`);
    }
    return undefined;
  });

  pi.on("message_start", (event: MessageStartEvent, ctx: ExtensionContext) => {
    if (!runs) return;
    try {
      const msg = event.message as { role?: string; customType?: unknown; content?: unknown; details?: unknown };
      if (msg.customType !== BASH_JOB_NOTIFICATION_TYPE) return;
      if (observe(ctx) === undefined) return;
      const notice = bashNotice(msg);
      if (notice === undefined) return;
      const work = recallE({
        cwd: cwdOf(ctx),
        tool: "bash",
        command: notice.command,
        exitCode: notice.exitCode,
        errorText: notice.text,
        hitTags: [],
      });
      work
        ?.then((finalize) => {
          const m = finalize?.();
          if (m !== undefined) send(m);
        })
        .catch((err: unknown) => log(`notice recall failed: ${String((err as Error)?.message ?? err)}`));
    } catch (err) {
      log(`message_start failed: ${String((err as Error)?.message ?? err)}`);
    }
  });

  // Main session only: children never probe/notify/bulk-tag/review (§8) and
  // reseed the segment on every before_agent_start anyway.
  if (!isChild)
    pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
      if (!runs) return;
      try {
        const reg = observe(ctx);
        generation += 1;
        errorSignatures = new Set();
        errorAsks = 0;
        parsedCache.clear();
        dataCache.clear();
        bgAbort = new AbortController();
        seedFrom(ctx);
        if (reg === undefined) return; // off(pi-api)
        const cwd = cwdOf(ctx);
        sessionCwd = cwd;
        try {
          ui = (ctx as { hasUI?: boolean }).hasUI === true ? (ctx.ui as typeof ui) : undefined;
        } catch {
          ui = undefined;
        }
        refreshInactive(cwd);
        void probeOnce();
      } catch (err) {
        log(`session_start failed: ${String((err as Error)?.message ?? err)}`);
      }
    });

  pi.on("session_compact", (event: SessionCompactEvent, ctx: ExtensionContext) => {
    if (!runs) return;
    try {
      if (observe(ctx) === undefined) return;
      const id = event.compactionEntry?.id;
      if (typeof id === "string") onCompaction(id, cwdOf(ctx));
    } catch (err) {
      log(`session_compact failed: ${String((err as Error)?.message ?? err)}`);
    }
  });

  pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
    if (!runs) return undefined;
    try {
      if (observe(ctx) === undefined) return undefined;
      turnSeq += 1;
      const branch = branchOf(ctx);
      if (branch === undefined) return undefined;
      const id = lastCompactionId(branch);
      // Checkpoint (child switch_context, v4.1 §2.5): a compaction we did not
      // see through session_compact.
      if (id !== undefined && id !== segment.compactionId()) onCompaction(id, cwdOf(ctx));
    } catch (err) {
      log(`turn_end failed: ${String((err as Error)?.message ?? err)}`);
    }
    return undefined;
  });

  pi.on("session_shutdown", (event: SessionShutdownEvent) => {
    try {
      recallAbort?.abort();
      bgAbort.abort();
      client.abortBackground();
      if (recoveryTimer !== undefined) {
        clock.clearTimer(recoveryTimer.handle);
        recoveryTimer = undefined;
      }
      if (!isChild && event.reason === "reload") clearHealthTable();
    } catch (err) {
      log(`session_shutdown failed: ${String((err as Error)?.message ?? err)}`);
    }
  });

  if (typeof pi.registerMessageRenderer === "function") {
    const renderer: MessageRenderer<MemoryInjectDetailsV1> = (message, options, theme) => {
      const d = message.details;
      if (d === undefined || d === null || typeof d !== "object" || !Array.isArray(d.items)) return undefined;
      const padX = typeof options?.outputPad === "number" && options.outputPad >= 0 ? options.outputPad : 1;
      // memory-predict plan §5.3: a merged P+U message carries `details.parts`
      // — render the combined marker (one segment per part) instead of the
      // single-layer line; a plain (pre-P1) message has no `parts` and keeps
      // the original rendering byte-identical.
      const parts = d.parts;
      const line = Array.isArray(parts)
        ? formatInjectMarkerParts(
            parts.map((part: MemoryInjectPartV1) => ({
              layer: part.layer,
              items: part.items.map((i: { anchor: string; p?: number }) => ({
                anchor: i.anchor,
                ...(i.p === undefined ? {} : { p: i.p }),
              })),
              ...(part.partial === true ? { partial: true } : {}),
            })),
          )
        : formatInjectMarker(
            d.layer,
            d.items.map((i) => ({ anchor: i.anchor, ...(i.p === undefined ? {} : { p: i.p }) })),
            { partial: d.partial === true },
          );
      return new Text(theme.fg("dim", line), padX, 0);
    };
    pi.registerMessageRenderer(MEMORY_INJECT_CUSTOM_TYPE, renderer);
  }

  // ───────── ports ─────────

  const statusClient: JevClient = {
    status: effectiveStatus,
    ask: (req) => client.ask(req),
    probe: async (reg) => {
      if (registryOf({ modelRegistry: reg }) !== undefined) {
        registry = reg;
        registryOk = true;
      }
      return probeOnce();
    },
  };

  const basePort = createJevCommandPort({
    client: statusClient,
    entryIndex,
    dirFor: (cwd) => deps.dirFor(resolveWorktreeOrigin(cwd) ?? cwd),
    now,
    isChildSession: isChild,
    triggerBulk: (cwd) => runBulk(resolveWorktreeOrigin(cwd) ?? cwd, "all"),
    config,
    usage: () => client.usage(),
    segment: () => {
      const s = segment.stats();
      return { injectedByLayer: s.byLayer, injectedTotal: s.total };
    },
    health: getHealthTable(),
  });
  const recentErrorsText = (): string | undefined => {
    if (errorLog.length === 0) return undefined;
    const fmt = (ms: number): string => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    return errorLog
      .slice(-JEV_ERROR_LOG_SHOWN)
      .map((e, i) => `${i === 0 ? "errors   " : "         "}${fmt(e.at)} ${e.line}`)
      .join("\n");
  };
  const commandPort: JevCommandPort = {
    ...basePort,
    report: async (cwd, reg) => {
      const text = await basePort.report(cwd, reg);
      const withTrunc =
        truncated === undefined ? text : `${text}\nrecall   recall truncated ${truncated.from}→${truncated.to}`;
      const errors = recentErrorsText();
      const withErrors = errors === undefined ? withTrunc : `${withTrunc}\n${errors}`;
      // memory-predict plan §9.4 P1b slice: rule-fire count only (no model/
      // cost columns yet — those land with P2, §11.2); absent entirely when
      // predict.enabled=false (I9).
      return config.predict.enabled ? `${withErrors}\npredict  rules ${rulesFired}` : withErrors;
    },
  };

  const doctorPort: JevDoctorPort = {
    extraReminder(cwd) {
      const out: string[] = [];
      try {
        const c = corpusFor(resolveWorktreeOrigin(cwd) ?? cwd);
        if (c !== undefined) {
          const expired = expiredEntries(c.entries, localToday(now())).length;
          if (expired > 0) out.push(`memory: ${expired} expired entr${expired === 1 ? "y" : "ies"} → /mem expired`);
        }
        // J7 (J8 acceptance #3): core usage — the reminder's own filter keeps
        // only errors/D01, so D19 (warn) surfaces here instead.
        try {
          const core = deps.coreUsageLine?.(resolveWorktreeOrigin(cwd) ?? cwd);
          if (core !== undefined && core !== "") out.push(core);
        } catch (err) {
          log(`core usage line failed: ${String((err as Error)?.message ?? err)}`);
        }
        if (c !== undefined) {
          const live = new Set(c.entries.map((e) => e.hash));
          const open = markStale(c.index.review?.suggestions ?? [], live).filter((s) => !s.stale).length;
          if (open > 0) out.push(`memory: ${open} review suggestion${open === 1 ? "" : "s"} open → /mem review`);
        }
        const st = effectiveStatus();
        if (st.kind === "partial" && !st.inactive) {
          const cov = c === undefined ? { tagged: 0, total: 0 } : coverage(c.entries, c.index);
          out.push(
            formatStatusLine(st, {
              tagged: cov.tagged,
              total: cov.total,
              ...(c?.index.lastTaggedAt === undefined ? {} : { lastTaggedAt: c.index.lastTaggedAt }),
            }),
          );
        }
      } catch (err) {
        log(`doctor reminder failed: ${String((err as Error)?.message ?? err)}`);
      }
      return out;
    },
  };

  return {
    commandPort,
    makeWritePort(): JevWritePort {
      if (deps.createWritePort === undefined) {
        throw new Error("jev write port factory not attached (wired by J7 via createJevWritePort)");
      }
      const port = deps.createWritePort({
        client,
        entryIndex,
        dirFor: deps.dirFor,
        taxonomyFor: (dir) => {
          const merged = mergeTaxonomy(readTaxonomyFile(dir));
          return merged.ok ? merged.taxonomy : (mergeTaxonomy() as { ok: true; taxonomy: Taxonomy }).taxonomy;
        },
        confirmTimeoutMs: config.confirmTimeoutMs,
        now,
      });
      // J7: one off(pi-api) verdict for the whole runtime — tool-v2's own
      // registry check (classify + getAvailableOfType) is narrowed here to
      // this file's three-method check, so a registry the hooks treat as
      // off(pi-api) never gets a tagging call through the write path either.
      // After tagging, drop the 2s corpus cache so the new sidecar tags are
      // visible to the very next A-layer lookup.
      return {
        ...port,
        checkInline: (file, before, after) => port.checkInline(file, before, after),
        touchedUserEntries: (file, before, after, handWritten) =>
          port.touchedUserEntries(file, before, after, handWritten),
        afterWrite: async (input) => {
          const reg = input.registry === undefined ? undefined : registryOf({ modelRegistry: input.registry });
          try {
            return await port.afterWrite({ ...input, registry: reg });
          } finally {
            try {
              invalidate(resolveWorktreeOrigin(input.cwd) ?? input.cwd);
            } catch {
              /* never break the write path */
            }
          }
        },
      };
    },
    doctorPort,
    client,
    attachPredictPorts(ports) {
      predictBashJobs = ports.bashJobs;
      predictFleet = ports.fleet;
    },
  };
}
