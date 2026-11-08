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
import { toSlug } from "../paths.js";
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
  type PredictCallEntry,
  type SimpleCommand,
  type Taxonomy,
} from "./contracts.js";
import { decideErrorRecall, decideRecall, effectiveMeta } from "./decide.js";
import { appendDiagLine, readDiagLines } from "./diag-log.js";
import { EntryIndex, expiredEntries } from "./entries.js";
import {
  formatInjectMarker,
  formatInjectMarkerParts,
  formatInjectMessage,
  formatNotify,
  formatPredictStatsLine,
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
import type {
  CarryState,
  Evidence,
  Modifier,
  PathClass,
  PredictInput,
  PredictResult,
  ScoredHit,
  TagScore,
  ToolLite,
} from "./predict/contracts.js";
import { PredictCache, turnKey } from "./predict/cache.js";
import { readGitBranch, type GitHeadIo } from "./predict/git-head.js";
import { runPredict } from "./predict/index.js";
import {
  createPredictFlight,
  type PredictFlight,
  type PredictFlightInput,
  type PredictFlightModel,
  type PredictFlightOutcome,
  type PredictFlightPort,
} from "./predict/flight.js";
import {
  createPredictLedger,
  type PredictLedgerTable,
  type PredictPrice,
  type PredictUsage,
} from "./predict/ledger.js";
import { buildPredictSystemPrompt, parsePredictReply } from "./predict/llm.js";
import { buildPredictOutbound, serializePredictOutbound, type PredictOutboundV1 } from "./predict/outbound.js";
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
import { tally, type ModelHit } from "./predict/vote.js";
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
// #36 P3 (arch §3.3.5/§3.3.6): blocks-layout residency — snapshot+ledger R
// layer, the unified eligibility verdict, and the blocks corpus/rev probes.
import { join } from "node:path";
import {
  corpusStampFingerprint,
  parseResidentSection,
  renderBlocks,
  residentBlocksOf,
  residentEntryText,
  residentRenderKey,
} from "../blocks/render.js";
import { readCorpus, type BlockCorpus } from "../blocks/store.js";
import { eligible, type EligibilityLayer } from "../govern/eligibility.js";
// #36 P6b（arch §6.1/§6.2）：受众三级判定 + 时效降权/点名要求，纯函数内核
// 在 govern/；wire 只做接线（tags 来源 = 侧车 index）。TOPIC_USER_POOL_CAP
// 唯一定义在 govern/decay.ts（PG 的 G2 调参只改那里，plan r3 裁定 12）。
import { audienceMatches, effectiveAudience } from "../govern/audience.js";
import { TOPIC_USER_POOL_CAP, decayFactor, decaySubjectOf, isDecayTarget, namesSubject } from "../govern/decay.js";
import type { MemoryWriteGate } from "../contracts.js";
import { parseBlockFile, type ParsedBlock } from "../blocks/format.js";

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
/** #36 §6.3（arch r5 §6.3）：只读工具的失败不走 E 层——失败文本几乎不含动作
 *  语义，撞词注入全是噪音（评测 2026-11-05：E 层 54% irrelevant 基本全部来自
 *  read/grep/ls/find 失败的撞词）。命中即直接返回，也不消耗 E_MAX_PER_SEGMENT。 */
const E_READONLY_TOOLS = new Set(["read", "grep", "ls", "find"]);
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
  readonly now: () => number;
  /** #36 P4 修复轮：生产 writeGate — 传给 write port 的侧车写入。 */
  readonly gate?: MemoryWriteGate;
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
  /** #36 P3 (arch §3.3.5): read the hub's persisted `pi_project_memory`
   *  state — `{ snapshot, stale }`. Production wiring lands in P4
   *  (`src/memory/index.ts` passes `sections._state`); while absent the R
   *  layer falls back to THIS turn's provider output (wire re-renders the
   *  blocks corpus with the same renderer, byte-identical for an unchanged
   * corpus). Blocks layout is not production until P5b flips the default. */
  readonly getSectionSnapshot?: () => { snapshot: string | undefined; stale: boolean } | undefined;
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
  /** #36 P4 修复轮（root 2026-11-06）：wireMemory 的生产 writeGate —— 本层与
   *  command-port、write-port 的全部侧车写入（打标/冷却戳/建议/taxonomy）都
   *  经 writeIndexPatch/writeTaxonomyFile 的逐原语 gateCheck 复检；缺省无
   *  gate 时行为与此前逐字节相同（I9，off-golden 不变）。 */
  readonly writeGate?: MemoryWriteGate;
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
 *  Never rendered yet, or core not inlined (L4/L5 demotion) ⇒ not static.
 *  #36 P3 (arch §3.3.4): blocks layout — `residentBlocks` (the §3.3.5 ledger
 *  ids) replaces the primary/omitted machinery entirely; compare block ids,
 *  never `entry.file`. */
export function isStaticCore(entry: MemEntry, info: JevRenderInfo | undefined): boolean {
  if (info?.residentBlocks !== undefined) {
    return info.residentBlocks.includes(entry.block?.id ?? "");
  }
  if (info === undefined || !info.coreInlined || info.primary === undefined) return false;
  if (entry.file !== info.primary) return false;
  return !info.omittedSections.includes(entry.section);
}

/** Display anchor, e.g. `pitfalls-git › #3` / `core › Rules #2`.
 *  #36 P3 (arch §4.2): block entries anchor on the block id itself — the
 *  model can act on it directly (`memory view quota.007`). */
export function entryAnchor(entry: MemEntry): string {
  if (entry.block !== undefined) return entry.block.id;
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
  /** #36 P3 (arch §3.3.5): the block rev recorded at SELECTION time; the
   *  async U/E/P commits drop picks whose rev changed while waiting. */
  readonly rev?: string;
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
  /** #36 §6.4：本轮 P 注入用过冷却饿死 bypass（≤1 条/轮）。 */
  readonly bypass?: true;
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

// ───────────────────────────── P2 model wiring helpers (memory-predict plan §6.2/§9.2; wire.ts, non-pi-free) ─────────────────────────────

/** §9.2: the day-ledger table is the ONE process-level shared table beyond
 *  the two health tables (an I4 exception, deliberately) — cap 8 days is
 *  enforced by the ledger itself; it survives `/reload` and is shared by
 *  every wireJev closure in this process (per-process day caps, §9.3). */
const PREDICT_LEDGER_SYMBOL = Symbol.for("pi-subagent:memory-predict-ledger");

function globalPredictLedgerTable(): PredictLedgerTable {
  const g = globalThis as unknown as Record<symbol, PredictLedgerTable | undefined>;
  let table = g[PREDICT_LEDGER_SYMBOL];
  if (table === undefined) {
    table = new Map();
    g[PREDICT_LEDGER_SYMBOL] = table;
  }
  return table;
}

/** Tests only: wipe the process-level predict ledger table between cases
 *  (production never resets it — §9.2 explicitly survives `/reload`). */
export function clearPredictLedgerTable(): void {
  (globalThis as unknown as Record<symbol, PredictLedgerTable | undefined>)[PREDICT_LEDGER_SYMBOL] = undefined;
}

/** Minimal structural mirror of pi's ModelRegistry for the P2 predict call
 *  (§6.2): `find` is required; `streamSimple`/`complete` follow topic-switch's
 *  `runJudge` binding. Read fresh from ctx every turn (never cached across
 *  activations), mirroring the classifier-registry discipline. */
interface PredictModelRegistryLike {
  find(provider: string, id: string): unknown;
  streamSimple?(
    model: unknown,
    context: unknown,
    options?: { signal?: AbortSignal; maxTokens?: number; reasoning?: string },
  ): { result(): Promise<PredictReplyMessage> };
  complete?(
    model: unknown,
    context: unknown,
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<PredictReplyMessage>;
}

interface PredictReplyMessage {
  readonly content?: unknown;
  readonly usage?: unknown;
  readonly errorMessage?: string;
}

function predictRegistryOf(ctx: unknown): PredictModelRegistryLike | undefined {
  try {
    const r = (ctx as { modelRegistry?: unknown } | undefined)?.modelRegistry;
    if (r === undefined || r === null || typeof r !== "object") return undefined;
    if (typeof (r as Record<string, unknown>)["find"] !== "function") return undefined;
    return r as PredictModelRegistryLike;
  } catch {
    return undefined;
  }
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** pi-ai `Usage` ({input, cacheRead, output, …}) → ledger `PredictUsage`
 *  (§9.2 usage passthrough); any missing/invalid component ⇒ undefined (the
 *  flight then settles that attempt at the reserved amount). */
function predictUsageOf(message: PredictReplyMessage): PredictUsage | undefined {
  const u = message.usage as Record<string, unknown> | undefined;
  if (u === undefined || u === null || typeof u !== "object") return undefined;
  const input = finiteNonNeg(u["input"]);
  const cacheRead = finiteNonNeg(u["cacheRead"]);
  const output = finiteNonNeg(u["output"]);
  if (input === undefined || cacheRead === undefined || output === undefined) return undefined;
  return { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output };
}

/** Catalog price off the bound model object (`cost.{input,cacheRead,output}`
 *  $/1M — §9.2 "usage × registry 价目"); missing/invalid ⇒ undefined (the
 *  settlement stays at the reserved amount). */
function predictPriceOf(model: unknown): PredictPrice | undefined {
  const cost = (model as { cost?: Record<string, unknown> } | undefined)?.cost;
  if (cost === undefined || cost === null || typeof cost !== "object") return undefined;
  const input = finiteNonNeg(cost["input"]);
  const cacheRead = finiteNonNeg(cost["cacheRead"]);
  const output = finiteNonNeg(cost["output"]);
  if (input === undefined || cacheRead === undefined || output === undefined) return undefined;
  return { inputPerM: input, cacheReadPerM: cacheRead, outputPerM: output };
}

/** Text blocks of an assistant message; throws on errorMessage/empty reply so
 *  the flight records a failed attempt and fails over (the same semantics as
 *  topic-switch's `assistantMessageText`). */
function predictTextOf(message: PredictReplyMessage): string {
  if (typeof message.errorMessage === "string" && message.errorMessage !== "") {
    throw new Error(message.errorMessage);
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .map((b) =>
      b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .join(" ");
  if (text.trim() === "") throw new Error("predict model: empty reply");
  return text;
}

/** §6.2 model binding (topic-switch `runJudge` style): `streamSimple` with
 *  `reasoning:"minimal"` when the registry has it, else plain `complete`;
 *  `maxTokens: 384` both ways; usage passed through for §9.2 settlement. */
function bindPredictModel(raw: PredictModelRegistryLike, provider: string, id: string): PredictFlightModel | undefined {
  let found: unknown;
  try {
    found = raw.find(provider, id);
  } catch {
    return undefined;
  }
  if (found === undefined || found === null) return undefined;
  if (typeof raw.streamSimple !== "function" && typeof raw.complete !== "function") return undefined;
  const price = predictPriceOf(found);
  const port: PredictFlightPort = {
    complete: async (system, user, signal) => {
      const context = {
        systemPrompt: system,
        messages: [{ role: "user" as const, content: user, timestamp: Date.now() }],
      };
      let message: PredictReplyMessage;
      if (typeof raw.streamSimple === "function") {
        message = await raw.streamSimple(found, context, { signal, maxTokens: 384, reasoning: "minimal" }).result();
      } else {
        message = await raw.complete!(found, context, { signal, maxTokens: 384 });
      }
      const usage = predictUsageOf(message);
      return { text: predictTextOf(message), ...(usage === undefined ? {} : { usage }) };
    },
  };
  return { provider, id, ...(price === undefined ? {} : { price }), port };
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
  /** Session memory dir for the diagnostic sidecar — `undefined` until
   *  session_start (or when this cwd has no memory dir); lines logged before
   *  then stay ring-only. */
  const diagDirFor = (): string | undefined => {
    if (sessionCwd === undefined) return undefined;
    try {
      return deps.dirFor(resolveWorktreeOrigin(sessionCwd) ?? sessionCwd);
    } catch {
      return undefined;
    }
  };
  const pushErrorLog = (line: string): void => {
    errorLog.push({ at: now(), line });
    if (errorLog.length > JEV_ERROR_LOG_MAX) errorLog.shift();
    // Persist the same (already ring-bound) line to the on-disk diag ring —
    // fire-and-forget, fail-soft (diag-log.ts swallows lock/fs errors).
    const dir = diagDirFor();
    if (dir !== undefined) appendDiagLine(dir, now(), line);
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
  // #36 P6b（arch §6.2 点名要求）：当前这一轮的用户 prompt（剥 skill 块后），
  // before_agent_start 开轮时更新；A 层（tool_call 时点）用它判定降权对象
  // 块是否被本轮文本“点名”。未开轮前为空串 ⇒ 降权对象一律不入选（对过期
  // 事实 fail closed）。
  let curTurnPrompt = "";
  let predictBashJobs: JevBashJobsLitePort | undefined;
  let predictFleet: JevFleetPort | undefined;
  let rulesFired = 0;
  // memory-predict plan §2.2/§9.2/§11.2 P2 model state (I4: closure-owned;
  // the Symbol-keyed ledger table above is the only cross-activation share).
  // `predictTurnSeq` is a dedicated per-P-turn counter — the shared `turnSeq`
  // also advances on turn_end, so it cannot express the §7.2 adjacency check.
  const predictLedger = createPredictLedger(globalPredictLedgerTable(), {
    maxCallsPerDay: config.predict.model.maxCallsPerDay,
    maxUsdPerDay: config.predict.model.maxUsdPerDay,
  });
  const predictCache = new PredictCache({ ttlMs: config.predict.cacheTtlMin * 60_000, clock: () => now() });
  const predictFlight: PredictFlight = createPredictFlight(predictLedger, {
    requestBudgetMs: config.predict.model.requestBudgetMs,
    maxCallsPerDay: config.predict.model.maxCallsPerDay,
    maxUsdPerDay: config.predict.model.maxUsdPerDay,
    clock,
  });
  let predictDisposed = false;
  let modelCalls = 0;
  let modelTimely = 0;
  let modelCached = 0;
  let predictTurnSeq = 0;
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
      blocksCorpusCache.clear();
      return;
    }
    dataCache.delete(dir);
    entryIndex.invalidate(dir);
    blocksCorpusCache.delete(dir);
  };
  deps.onAfterWriteHook((cwd) => {
    try {
      invalidate(resolveWorktreeOrigin(cwd) ?? cwd);
    } catch {
      /* never break the write path */
    }
  });

  // ───────── #36 P3 blocks corpus + residency (arch §3.3.5/§3.3.6) ─────────

  /** Blocks corpus cache gated by the STAT-ONLY fingerprint (acceptance
   *  fix: every turn used to re-read every body + hash the legacy root).
   *  `corpusStampFingerprint` stats name/size/mtimeMs/ino of `blocks/*.md`
   *  and nothing else; the expensive `readCorpus` (body parse + legacy
   *  drift hash) runs ONCE per actual change. Reads are lock-free (store.ts
   *  §4.3.8 reader rules still apply inside that one read). */
  const blocksCorpusCache = new Map<string, { stamp: string; corpus: BlockCorpus }>();
  const blocksCorpusFor = (dir: string): BlockCorpus => {
    const realDir = join(dir, "blocks");
    let stamp: string;
    try {
      stamp = `${corpusStampFingerprint(realDir)}\u0000${localToday(now())}`;
    } catch {
      stamp = `unreadable\u0000${now()}`; // stat trouble ⇒ read once, don't cache
    }
    const hit = blocksCorpusCache.get(dir);
    if (hit !== undefined && hit.stamp === stamp) return hit.corpus;
    const corpus = readCorpus(realDir);
    blocksCorpusCache.set(dir, { stamp, corpus });
    return corpus;
  };

  /** One R-layer ledger per memory dir (I4: closure state). */
  interface ResidentState {
    recomputeKey: string;
    snapshotKey: string;
    want: Map<string, { key: string; block: ParsedBlock }>;
    ledger: Map<string, string>;
    restored: boolean;
  }
  const residentStates = new Map<string, ResidentState>();

  const ledgerOf = (dir: string): ReadonlySet<string> => new Set(residentStates.get(dir)?.ledger.keys() ?? []);

  /** Selection-time eligibility for a MemEntry: files-layout entries (no
   *  `block`) keep their existing predicates untouched; block entries run
   * the unified verdict. A block that vanished from `blocks/` mid-cache is
   *  ineligible (the next corpus refresh drops it). */
  const entryEligible = (e: MemEntry, dir: string, layer: EligibilityLayer, tags?: EntryTags): boolean => {
    // #36 P6b: files-layout entries keep their existing per-layer predicates
    // (private/secret/static/injected live in the callers) EXCEPT the new
    // two-way audience filter (arch §6.1 — inline `audience:` key first,
    // then the sidecar tag tier).
    if (e.block === undefined) return audienceMatches(effectiveAudience(e.inline.audience, tags), isChild);
    const parsed = blocksCorpusFor(dir).blocks.find((b) => b.id === e.block?.id);
    if (parsed === undefined) return false;
    return eligible(parsed, undefined, {
      today: localToday(now()),
      isChild: isChild,
      ledger: ledgerOf(dir),
      layer,
      // #36 P6b: the full three-tier audience (frontmatter → sidecar tag
      // inference) — the same verdict the files path applies directly above.
      audienceOf: (b) => effectiveAudience(b.meta.audience, tags),
    }).ok;
  };

  /** Commit-time recheck (arch §3.3.6 两处校验 + §3.3.5 异步 rev 丢弃),
   *  reading ONLY the picked block's file (acceptance fix: no full-corpus
   *  re-read per pick): existence, rev, then the unified verdict against
   *  the fresh parse. */
  const commitEligible = (
    e: MemEntry,
    dir: string,
    layer: EligibilityLayer,
    rev: string | undefined,
    cwd?: string,
  ): boolean => {
    // #36 P6b: the commit-time audience verdict is the SAME three-tier
    // `effectiveAudience` as selection time — the recheck can never
    // contradict the candidate filter (sidecar tags come from the
    // 2s-cached corpus index; a tag write racing the commit at worst keeps
    // the selection-time verdict one more message).
    const tags = cwd === undefined ? undefined : corpusFor(cwd)?.index.entries[e.hash];
    if (e.block === undefined) return audienceMatches(effectiveAudience(e.inline.audience, tags), isChild);
    const name = `${e.block.id}.md`;
    let raw: string | undefined;
    try {
      raw = readRegular(join(dir, "blocks"), name).text;
    } catch {
      return false; // deleted / rolled back mid-wait
    }
    const parsed = parseBlockFile(name, raw);
    if ("stray" in parsed) return false;
    if (rev !== undefined && parsed.rev !== rev) return false;
    return eligible(parsed, undefined, {
      today: localToday(now()),
      isChild: isChild,
      ledger: ledgerOf(dir),
      layer,
      audienceOf: (b) => effectiveAudience(b.meta.audience, tags),
    }).ok;
  };

  const parsedRevOf = (e: MemEntry, dir: string): string | undefined => {
    if (e.block === undefined) return undefined;
    return blocksCorpusFor(dir).blocks.find((b) => b.id === e.block?.id)?.rev;
  };

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
    const out = await writeIndexPatch(
      dir,
      { upsert: upserts, lastTaggedAt: new Date(now()).toISOString() },
      deps.writeGate,
    );
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
      const out = await writeIndexPatch(c.dir, { review: outcome, reviewBase: c.index.review ?? null }, deps.writeGate);
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

  /** #36 P3 (arch §3.3.4): `JevRenderInfo.residentBlocks` = the §3.3.5
   *  LEDGER ids (what the model has been told), never this turn's render —
   *  overlay it on whatever the onRender callback recorded. */
  const renderInfoFor = (cwd: string): JevRenderInfo | undefined => {
    const info = deps.getRenderInfo(cwd);
    const dir = safeDirFor(cwd);
    const rs = dir === undefined ? undefined : residentStates.get(dir);
    if (rs === undefined) return info;
    return {
      ...(info ?? { omittedSections: [], coreInlined: false }),
      residentBlocks: [...rs.ledger.keys()],
    };
  };

  const safeDirFor = (cwd: string): string | undefined => {
    try {
      return deps.dirFor(cwd);
    } catch {
      return undefined;
    }
  };

  /** R-layer removal reason (arch §3.3.5 差分表). */
  const residentRemoveWhy = (corpus: BlockCorpus, id: string): string => {
    const b = corpus.blocks.find((x) => x.id === id);
    if (b === undefined) return "已删除或已归档";
    if (b.meta.supersededBy !== undefined) return `已取代 → 见 ${b.meta.supersededBy}`;
    if (b.meta.authority !== "user" || (b.meta.scope ?? "topic") !== "global") return "降为 topic";
    return "受众不符";
  };

  /** #36 P3 R layer (arch §3.3.5, r5 裁定 8): snapshot + ledger 差分，每轮
   *  before_agent_start 重算判定 = (corpusFingerprint, today, snapshotKey)。
   *  snapshot 取 hub 持久化文本（P4 接线 getSectionSnapshot）；未接线或
   *  stale 时用本轮 provider 输出（同一渲染器重算，字节一致）。通知经
   *  sendMessage(triggerTurn:false) 下发——与 hub 尾部更新同延迟量级，
   *  送达后 ledger 即视为已告知（并集无遗漏）。 */
  const residentTurn = (cwd: string, ctx: ExtensionContext): void => {
    try {
      const dir = safeDirFor(cwd);
      if (dir === undefined) return;
      // acceptance fix: the stat-only fingerprint inside blocksCorpusFor gates
      // the body reads — N unchanged turns cost N stat passes, zero reads.
      const corpus = blocksCorpusFor(dir);
      if (corpus.blocks.length === 0 && corpus.archivedByTopic.size === 0) {
        residentStates.delete(dir);
        return;
      }
      const today = localToday(now());
      const fallback = renderBlocks(corpus, {
        slug: toSlug(cwd),
        isChild: isChild,
        residentBytes: deps.settings.residentBytes,
        today,
      }).text;
      const hubState = (() => {
        try {
          return deps.getSectionSnapshot?.();
        } catch {
          return undefined;
        }
      })();
      const snapshotText =
        hubState !== undefined && !hubState.stale && hubState.snapshot !== undefined ? hubState.snapshot : fallback;
      const snapshotKey = createHash("sha1").update(snapshotText, "utf8").digest("hex");
      const wantBlocks = residentBlocksOf(corpus.blocks, { isChild, today }).filter(
        (b) => eligible(b, undefined, { today, isChild, ledger: ledgerOf(dir), layer: "R" }).ok,
      );
      const want = new Map(wantBlocks.map((b) => [b.id, { key: residentRenderKey(b, today), block: b }] as const));
      const recomputeKey = `${corpus.fingerprint}\u0000${today}\u0000${snapshotKey}`;
      let st = residentStates.get(dir);
      if (st === undefined || st.recomputeKey !== recomputeKey) {
        const snapshotMap = parseResidentSection(snapshotText);
        const ledger = st === undefined || st.snapshotKey !== snapshotKey ? new Map(snapshotMap) : new Map(st.ledger);
        st = { recomputeKey, snapshotKey, want, ledger, restored: st?.restored ?? false };
        residentStates.set(dir, st);
      } else {
        st.want = want;
      }
      // resume/reload/tree: restore the ledger from the newest R message on
      // the branch carrying the SAME snapshotKey (arch §3.3.5 恢复).
      if (!st.restored) {
        st.restored = true;
        const branch = branchOf(ctx);
        if (branch !== undefined) {
          for (let i = branch.length - 1; i >= 0; i--) {
            const e = branch[i] as
              | {
                  type?: string;
                  customType?: unknown;
                  details?: { layer?: unknown; resident?: { snapshotKey?: unknown; ledger?: unknown } };
                }
              | undefined;
            if (e?.type !== "custom_message" || e.customType !== MEMORY_INJECT_CUSTOM_TYPE) continue;
            const d = e.details;
            if (d === undefined || d.layer !== "R" || d.resident === undefined) continue;
            if (d.resident.snapshotKey !== snapshotKey || !Array.isArray(d.resident.ledger)) continue;
            const restored = new Map<string, string>();
            for (const pair of d.resident.ledger as unknown[]) {
              if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string")
                restored.set(pair[0], pair[1]);
            }
            st.ledger = restored;
            break;
          }
        }
      }
      const adds: ParsedBlock[] = [];
      const changes: ParsedBlock[] = [];
      const removes: { id: string; why: string }[] = [];
      for (const [id, w] of st.want) {
        const prev = st.ledger.get(id);
        if (prev === undefined) adds.push(w.block);
        else if (prev !== w.key) changes.push(w.block);
      }
      for (const id of st.ledger.keys()) if (!st.want.has(id)) removes.push({ id, why: residentRemoveWhy(corpus, id) });
      if (adds.length + changes.length + removes.length > 0) {
        const lines = [
          ...adds.map((b) => `- 新增 ${b.id}：${residentEntryText(b, today)}`),
          ...changes.map((b) => `- 已变更 ${b.id}（以此为准）：${residentEntryText(b, today)}`),
          ...removes.map((r) => `- 已移除 ${r.id}（${r.why}）`),
        ];
        for (const b of [...adds, ...changes]) {
          const w = st.want.get(b.id);
          if (w !== undefined) st.ledger.set(b.id, w.key);
        }
        for (const r of removes) st.ledger.delete(r.id);
        send({
          customType: MEMORY_INJECT_CUSTOM_TYPE,
          content: `[memory · R] 常驻规则已变更（以此为准）：\n${lines.join("\n")}`,
          display: true,
          details: {
            v: 1,
            layer: "R",
            trigger: "resident",
            items: [],
            resident: { snapshotKey, ledger: [...st.ledger.entries()] },
          },
        });
      }
    } catch (err) {
      log(`resident turn failed: ${String((err as Error)?.message ?? err)}`);
    }
  };

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
   *  nothing survived). #36 P3: `opts.cwd` enables the commit-time recheck
   *  (arch §3.3.6 两处校验) — fresh corpus eligibility + async rev guard —
   *  which drops block picks that were superseded/deleted/expired/demoted
   *  (or rewritten while an async layer was waiting) between selection and
   *  this commit. */
  const commit = (
    layer: InjectLayer,
    picks: readonly Pick[],
    maxEntries: number,
    maxBytes: number,
    trigger: string,
    opts: { model?: string; partial?: boolean; bFor?: string; cwd?: string } = {},
  ): InjectMessage | undefined => {
    const recheckDir = opts.cwd !== undefined ? safeDirFor(opts.cwd) : undefined;
    const survived =
      recheckDir === undefined
        ? picks
        : picks.filter((p) => commitEligible(p.entry, recheckDir, layer, p.rev, opts.cwd));
    const fresh = survived.filter((p) => !segment.isInjected(p.entry.hash));
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
    const info = renderInfoFor(cwd);
    const dir = safeDirFor(cwd);
    const eligiblePool = c.entries.filter(
      (e) =>
        e.inline.isPrivate !== true &&
        !e.secret &&
        !segment.isInjected(e.hash) &&
        !isStaticCore(e, info) &&
        // #36 P6b: sidecar tags feed the audience tag tier (arch §6.1).
        (dir === undefined || entryEligible(e, dir, "U", c.index.entries[e.hash])),
    );
    let pool = eligiblePool;
    if (eligiblePool.length > RECALL_MAX_CANDIDATES) {
      // §5.4 优先入池：带预测 tag（score ≥0.5）的条目最多保留 40 槽（排序
      // 用户令 → max p × importance → file），其余 320 槽交给现有 prefilter
      // （tieBreak 仍是 user-first），两段合并后按 hash 去重。
      // #36 P6b（arch §3.3.1/§6.2）：topic 类用户令（authority=user 且非
      // global）在裁剪时最先入池，上限 TOPIC_USER_POOL_CAP（唯一常量定义在
      // govern/decay.ts，PG 的 G2 调参只改那里）；超额时按与 query 的词法
      // 重合度取前 cap 条。不放宽阈值（arch §3.3.1）。已优先入池的 topic
      // 用户令不再占 40 预测槽（验改 #3：防 hash 去重后挤占其它预测条目、
      // 合并池计数缩水）。
      const topicUsers = eligiblePool.filter((e) => e.authority === "user" && e.inline.scope !== "global");
      const claimed = new Set<string>();
      const topicKept =
        topicUsers.length > TOPIC_USER_POOL_CAP
          ? prefilter(topicUsers, (e) => e.body, query, TOPIC_USER_POOL_CAP)
          : topicUsers;
      for (const e of topicKept) claimed.add(e.hash);
      let priorityEntries: MemEntry[] = [];
      if (predicted !== undefined && predicted.size > 0) {
        const prio: { entry: MemEntry; cand: PriorityCandidate }[] = [];
        for (const e of eligiblePool) {
          if (claimed.has(e.hash)) continue; // 验改 #3：topic 用户令已占先入池槽
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
        eligiblePool.filter((e) => !claimed.has(e.hash) && !priorityHashes.has(e.hash)),
        (e) => e.body,
        query,
        RECALL_MAX_CANDIDATES - topicKept.length - priorityEntries.length,
        (a, b) => (a.authority === b.authority ? 0 : a.authority === "user" ? -1 : 1),
      );
      const seen = new Set<string>();
      const merged: MemEntry[] = [];
      for (const e of [...topicKept, ...priorityEntries, ...rest]) {
        if (seen.has(e.hash)) continue;
        seen.add(e.hash);
        merged.push(e);
      }
      pool = merged;
      truncated = { from: eligiblePool.length, to: pool.length };
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
   *  before_agent_start message; later ⇒ sendMessage if still current.
   *  `deferCommit` (§8.3 model branch only) hands the FINALIZE back instead
   *  of invoking it, so P can claim shared entries before U's commit — the
   *  late path below is unchanged either way. */
  const settle = async (
    work: Promise<(() => InjectMessage | undefined) | undefined>,
    gen: number,
    controller: AbortController,
    waitMs: number,
    deferCommit = false,
  ): Promise<InjectMessage | (() => InjectMessage | undefined) | undefined> => {
    const late = (finalize: (() => InjectMessage | undefined) | undefined): void => {
      if (finalize === undefined || gen !== generation || controller.signal.aborted) return;
      const m = finalize();
      if (m !== undefined) send(m);
    };
    if (waitMs > 0) {
      const r = await withTimeout(work, waitMs);
      if (r !== TIMEOUT) return deferCommit ? r : r?.();
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
    opts: { deferCommit?: boolean } = {},
  ): Promise<InjectMessage | (() => InjectMessage | undefined) | undefined> => {
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
    // #36 P6b：候选池里存在降权对象时，askAll 返回后需要 p×m 调整。
    let poolDecays = false;
    for (const e of byId.values()) {
      if (isDecayTarget(decaySubjectOf(e, c.index.entries[e.hash]))) {
        poolDecays = true;
        break;
      }
    }
    const { state, questions } = buildRecallQuestions({
      userMessage,
      ...(previous === undefined ? {} : { previousUserMessage: previous }),
      session: isChild ? "child" : "main",
      today: localToday(now()),
      candidates: cands,
    });
    recallAbort?.abort();
    const controller = new AbortController();
    // §8.3 model branch (deferCommit): this U work is awaited by the
    // in-flight before_agent_start handler itself, so it must NOT be
    // reachable through `recallAbort` — session_shutdown aborts that slot
    // (§8.2 disposes only the P flight) and would otherwise abort U's
    // in-flight classify, dragging U down with a mid-flight shutdown. The
    // work stays bounded either way: askAll's budget + settle's waitMs (I1).
    if (opts.deferCommit !== true) recallAbort = controller;
    const gen = ++generation;
    const dir = safeDirFor(cwd);
    // #36 P3: record every candidate's block rev at SELECTION time (before
    // the classifier wait) — the commit-time recheck drops picks whose rev
    // changed while we waited (arch §3.3.5 异步结果).
    const revsById = new Map<string, string | undefined>();
    for (const [id, e] of byId) revsById.set(id, dir === undefined ? undefined : parsedRevOf(e, dir));
    const work = (async (): Promise<(() => InjectMessage | undefined) | undefined> => {
      const res = await askAll("recall", reg, state, questions, RECALL_BUDGET_MS, controller.signal);
      if (res === undefined) return undefined;
      // #36 P6b（arch §6.2 U 层 p×m）：降权对象（agent、无期限、快照/
      // temporal）的布尔概率先乘 m 再进阈值与排序——decide.ts 不动，这里
      // 只调整传入的 answers；非降权轮零额外分配。
      let answers = res.answers;
      if (poolDecays) {
        const adjusted: Record<string, JevAnswer> = {};
        for (const [id, a] of Object.entries(res.answers)) {
          const e = byId.get(id);
          const m = e === undefined ? 1 : decayFactor(decaySubjectOf(e, c.index.entries[e.hash]), localToday(now()));
          adjusted[id] = a.type === "bool" && m < 1 ? { ...a, probability: a.probability * m } : a;
        }
        answers = adjusted;
      }
      const decided = decideRecall(answers, cands, config);
      const picks: Pick[] = [];
      for (const d of decided) {
        const entry = byId.get(d.id);
        const rev = revsById.get(d.id);
        if (entry !== undefined) picks.push({ entry, p: d.p, ...(rev === undefined ? {} : { rev }) });
      }
      if (picks.length === 0) return undefined;
      return () =>
        commit("U", picks, config.recall.maxEntries, config.recall.maxBytes, "user", { model: res.model, cwd });
    })();
    return settle(work, gen, controller, config.recall.waitMs, opts.deferCommit === true);
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
    if (E_READONLY_TOOLS.has(input.tool)) return undefined; // #36 §6.3：只读工具失败零 E 注入
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
    // #36 §6.3：高危动作类 tag 集合（TagDef.risk==="high"）——标签全部属于该
    // 集合且与失败命令 hitTags 无交集的块从候选池剔除（动作类条目对无关
    // 失败只可能是撞词）；pending 条目无标签，不适用此剔除。
    const highRiskTagIds = new Set(c.taxonomy.tags.filter((t) => t.risk === "high").map((t) => t.id));
    const dir = safeDirFor(input.cwd);
    let pool = c.entries.filter((e) => {
      if (e.inline.isPrivate === true || e.secret || segment.isInjected(e.hash)) return false;
      if (dir !== undefined && !entryEligible(e, dir, "E", c.index.entries[e.hash])) return false;
      const meta = effectiveMeta(e, c.index.entries[e.hash], c.taxonomy);
      // Pending entries (no sidecar record yet) have no known type — they stay
      // candidates rather than being silently excluded (untagged corpora
      // would otherwise never get E recall).
      if (
        !meta.pending &&
        meta.tags.length > 0 &&
        meta.tags.every((t) => highRiskTagIds.has(t)) &&
        !meta.tags.some((t) => hit.has(t))
      ) {
        return false; // #36 §6.3：纯高危动作类标签且与失败命令无交集
      }
      return meta.pending || meta.type === "pitfall" || meta.type === "procedure" || meta.tags.some((t) => hit.has(t));
    });
    if (pool.length === 0) return undefined;
    if (pool.length > E_MAX_CANDIDATES) pool = prefilter(pool, (e) => e.body, input.errorText, E_MAX_CANDIDATES);
    // #36 P3: revs recorded at selection time (before the classifier wait).
    const revsAtSelection = pool.map((e) => (dir === undefined ? undefined : parsedRevOf(e, dir)));
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
        const rev = revsAtSelection[idx];
        if (entry !== undefined) picks.push({ entry, p: d.p, ...(rev === undefined ? {} : { rev }) });
      }
      if (picks.length === 0) return undefined;
      return () => commit("E", picks, 2, config.recall.maxBytes, input.tool, { model: res.model, cwd: input.cwd });
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
    const dir = safeDirFor(cwd);
    const picks: Pick[] = [];
    for (const hash of pending.hashes) {
      const same = c.entries.find((e) => e.hash === hash);
      if (same !== undefined) {
        // #36 P3 (arch §3.3.6): B-layer re-found entries re-run the unified
        // eligibility — a block superseded during compaction drops out.
        if (
          same.inline.isPrivate !== true &&
          (dir === undefined || entryEligible(same, dir, "B", c.index.entries[same.hash]))
        )
          picks.push({ entry: same });
        continue;
      }
      const a = anchors.get(hash);
      if (a === undefined) continue; // deleted (or unknown after reload) ⇒ skip
      const moved = c.entries.find(
        (e) => e.file === a.file && e.section === a.section && e.heading === a.heading && e.ordinal === a.ordinal,
      );
      if (
        moved !== undefined &&
        moved.inline.isPrivate !== true &&
        (dir === undefined || entryEligible(moved, dir, "B", c.index.entries[moved.hash]))
      )
        picks.push({ entry: moved, modified: true });
    }
    return commit("B", picks, 3, A_MAX_BYTES, "compaction", {
      bFor: pending.compactionId,
      partial: allowed.partial,
      cwd,
    });
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
    void writeIndexPatch(c.dir, { aInjectedAt: upsert }, deps.writeGate)
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
    const info = renderInfoFor(cwd);
    const dir = safeDirFor(cwd);
    const scored: { pick: Pick; score: number }[] = [];
    for (const e of c.entries) {
      if (e.inline.isPrivate === true || segment.isInjected(e.hash) || isStaticCore(e, info)) continue;
      const record = c.index.entries[e.hash];
      if (dir !== undefined && !entryEligible(e, dir, "A", record)) continue;
      // #36 P6b（arch §6.2 点名要求，A 层）：降权对象（agent、无期限、
      // 快照/temporal）没被本轮文本点名（首行无区分性 token 重合）⇒ 不入
      // 候选；点名后照常参与打分（A 层不乘 m，arch §6.2 只规定 U/P 乘）。
      const subject = decaySubjectOf(e, record);
      if (isDecayTarget(subject) && !namesSubject(curTurnPrompt, subject)) continue;
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
        cwd,
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
    void writeIndexPatch(c.dir, { pInjectedAt: upsert }, deps.writeGate)
      .then((out) => {
        if (out === "busy") log("sidecar busy — P-injection cooldown stamps not saved");
      })
      .catch((err: unknown) => log(`P-injection stamp write failed: ${String((err as Error)?.message ?? err)}`));
  };

  /** §5.1 candidate materialization: same exclusion/meta pipeline as the A
   *  layer (`fastPath` above), reshaped into `predict/select.ts`'s pure
   *  `Candidate`/`SCandidate` input shapes. #36 P6b (arch §6.2): decay
   *  targets must be NAMED by `turnText` to enter the pool, and scored
   *  candidates carry their decay multiplier (select.ts sorts ×m). */
  const predictCandidatesFor = (
    c: Corpus,
    cwd: string,
    turnText: string | undefined,
  ): { pCands: PredictCandidate[]; sCands: SCandidate[]; byHash: Map<EntryHash, MemEntry> } => {
    const info = renderInfoFor(cwd);
    const dir = safeDirFor(cwd);
    const byHash = new Map<EntryHash, MemEntry>();
    const pCands: PredictCandidate[] = [];
    const sCands: SCandidate[] = [];
    const today = localToday(now());
    for (const e of c.entries) {
      if (e.inline.isPrivate === true || e.secret || segment.isInjected(e.hash) || isStaticCore(e, info)) continue;
      const record = c.index.entries[e.hash];
      // #36 P3: the unified eligibility runs per layer shape — P for the
      // scored candidates, S for the release-state constraint.
      if (dir !== undefined && !entryEligible(e, dir, "P", record)) continue;
      if (dir !== undefined && !entryEligible(e, dir, "S", record)) continue;
      // #36 P6b（arch §6.2 点名要求，仅 P）：降权对象没被本轮文本点名 ⇒
      // 不进 P 候选（turnText 缺失同样 fail closed）；S 状态候选不受此门
      // （验改 #2：S 与 P 各自独立入池，未点名的降权对象仍可作 S 注入）。
      const subject = decaySubjectOf(e, record);
      const pExcluded = isDecayTarget(subject) && (turnText === undefined || !namesSubject(turnText, subject));
      byHash.set(e.hash, e);
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
      const decay = decayFactor(subject, today); // #36 §6.2：排序键 ×m
      sCands.push({
        hash: e.hash,
        isPrivate: false,
        isSecret: false,
        authority: selectAuthority,
        ...(meta.type === undefined ? {} : { type: meta.type }),
        hasReleaseTag: meta.tags.includes("release"),
        byteLength,
      });
      if (pExcluded) continue; // P-only naming gate (验改 #2)
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
        ...(decay < 1 ? { decay } : {}),
      });
    }
    return { pCands, sCands, byHash };
  };

  /** Shared r0 bundle (§8.3): everything both the sync path and the model
   *  branch need — computed once per P turn, before any model work. */
  interface PredictR0 {
    readonly c: Corpus;
    readonly cwd: string;
    readonly partial: boolean;
    readonly input: PredictInput;
    readonly result: PredictResult;
    readonly hits: readonly ScoredHit[];
    readonly modifiers: readonly Modifier[];
    readonly cancelled: boolean;
    readonly todoReplaced: boolean;
    readonly hadCarryBefore: boolean;
    readonly revalidatedCarry: CarryState | undefined;
  }

  type PredictCommit = {
    message: InjectMessage | undefined;
    predictSummary: PredictSummary;
    predicted: ReadonlyMap<string, number>;
  };

  /** §5.1/§5.3/§3.3 P commit: final record + select + commit — the exact P1
   *  body, parameterized over the (possibly model-merged) tag list. Selection
   *  runs off `tags`/`result.state` regardless of `clearedReason` — that flag
   *  only governs what gets WRITTEN to the final record (carry housekeeping
   *  for the NEXT turn), not whether THIS turn injects. Negated/readonly tags
   *  are already scored to 0 and dropped by `tally()`, so there is nothing
   *  left to over-inject here; the S constraint in particular must survive
   *  even when the turn's carry resolves to "empty". */
  const commitPredictParts = (r0: PredictR0, tags: readonly TagScore[], origin: string): PredictCommit => {
    const { c, cwd, partial, result, hits, cancelled, todoReplaced, hadCarryBefore, revalidatedCarry } = r0;
    const dir = safeDirFor(cwd);
    const tagsWithEvidence = tags.map((t) => ({ ...t, evidence: evidenceForTag(hits, t.tag) }));
    const clearedReason = detectCarryClear({
      cancelled,
      compacted: false,
      todoReplaced,
      finalTagsEmpty: tagsWithEvidence.length === 0,
    });
    const newCarries = clearedReason !== undefined ? 0 : (revalidatedCarry?.carries ?? 0);
    if (tagsWithEvidence.length > 0 || hadCarryBefore) {
      appendPredict(
        buildFinalRecord(turnSeq, clearedReason === undefined ? tagsWithEvidence : [], newCarries, clearedReason),
      );
    }
    let message: InjectMessage | undefined;
    let bypassed = false;
    {
      const eligible = fastPathEligibleTags(c.taxonomy);
      // #36 §6.4：高危 tag 集合交给 select 做冷却饿死出口。
      const highRiskTagIds = new Set(c.taxonomy.tags.filter((t) => t.risk === "high").map((t) => t.id));
      // #36 P6b（arch §6.2 点名）：本轮文本（剥 skill 块、4000 码点截断后
      // 的 prompt）作为 P 层点名判定的基准。
      const { pCands, sCands, byHash } = predictCandidatesFor(c, cwd, r0.input.prompt);
      const selected = selectPEntries({
        tags,
        eligibleTags: eligible,
        candidates: pCands,
        maxEntries: config.predict.maxEntries,
        maxBytes: config.predict.maxBytes,
        ...(highRiskTagIds.size > 0 ? { highRiskTags: highRiskTagIds } : {}),
      });
      // #36 P6b 收口（P6a 遗留）：bypass 只在“选择带 bypass 标记”且“该条
      // 最终被 commit 接受（进入消息 items）”时才上报——commit 阶段的
      // segment 容量/去重/复检仍可能拒绝它，选择层命中不等于注入。
      const bypassHash = selected.find((s) => s.bypass === true)?.hash;
      const usedBytes = selected.reduce((sum, s) => sum + s.byteLength, 0);
      const sSelected = selectSEntry(result.state, sCands, Math.max(0, config.predict.maxBytes - usedBytes));
      const picks: Pick[] = [];
      const revOf = (e: MemEntry): string | undefined => (dir === undefined ? undefined : parsedRevOf(e, dir));
      for (const s of selected) {
        const e = byHash.get(s.hash);
        const rev = e === undefined ? undefined : revOf(e);
        if (e !== undefined) picks.push({ entry: e, ...(rev === undefined ? {} : { rev }) });
      }
      if (sSelected !== undefined) {
        const e = byHash.get(sSelected.hash);
        const rev = e === undefined ? undefined : revOf(e);
        if (e !== undefined) picks.push({ entry: e, releaseInProgress: true, ...(rev === undefined ? {} : { rev }) });
      }
      if (picks.length > 0) {
        message = commit("P", picks, picks.length, config.predict.maxBytes, "predict", {
          ...(partial ? { partial: true } : {}),
          cwd,
        });
        if (message !== undefined) recordPInjection(c, message);
      }
      bypassed =
        bypassHash !== undefined &&
        message !== undefined &&
        (message.details as MemoryInjectDetailsV1).items.some((i) => i.hash === bypassHash);
    }
    return {
      message,
      predictSummary: {
        tags: tags.map((t) => t.tag),
        state: result.state.map((s) => s.kind),
        origin,
        ...(bypassed ? { bypass: true as const } : {}),
      },
      // §5.4 优先入池原料：本轮预测 tag → finalScore（≥0.5 的由
      // recallCandidates 筛）。predict.enabled=false / P 未跑时本对象不存在。
      predicted: new Map(tags.map((t) => [t.tag, t.score] as const)),
    };
  };

  type BegunPredictTurn =
    | { readonly kind: "sync"; readonly result: PredictCommit }
    | {
        readonly kind: "model";
        readonly r0: PredictR0;
        readonly mergedTags: readonly TagScore[];
        readonly modelExtras: readonly ModelHit[];
        readonly origin: string;
        readonly key: string;
        readonly knownTags: ReadonlySet<string>;
        readonly threshold: number;
        readonly waitMs: number;
        readonly turnSeqAtStart: number;
        readonly chain: readonly string[];
        /** #36 §6.5：本轮 beginPredictTurn 入口时钟（windowMs =
         *  max(waitMs, U 实际完成时刻) 的基准）。 */
        readonly turnStartClock: number;
        readonly flightPromise: Promise<PredictFlightOutcome>;
        readonly predicted: ReadonlyMap<string, number>;
      };

  /** §8.3 r0 (rules + carry + pendingModel redemption + turnKey cache) plus
   *  §4.4 flight admission. The sync kinds commit immediately (P1 byte
   *  behavior); the model kind defers the commit to the wait-window merge.
   *  Returns `undefined` when P did not even attempt to run this turn
   *  (off/partial-inactive/segment-full/no corpus/predict disabled) —
   *  distinct from "ran but produced nothing to inject". */
  const beginPredictTurn = (prompt: string, ctx: ExtensionContext, cwd: string): BegunPredictTurn | undefined => {
    const turnStartClock = clock.now();
    const allowed = zeroCallAllowed();
    if (!allowed.ok || segment.full()) return undefined;
    const c = corpusFor(cwd);
    if (c === undefined) return undefined;
    rulesFired += 1;
    predictTurnSeq += 1;
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
    const cancelled = modifiers.some((m) => m.kind === "cancel");
    const prevTodoIds = (carryIn?.tags ?? []).flatMap((t) => t.evidence.todoIds);
    const currentInProgressIds = input.todo.filter((t) => t.status === "in_progress").map((t) => t.id);
    const todoReplaced = isTodoReplaced(prevTodoIds, currentInProgressIds);
    const r0: PredictR0 = {
      c,
      cwd,
      partial: allowed.partial,
      input,
      result,
      hits,
      modifiers,
      cancelled,
      todoReplaced,
      hadCarryBefore: carryIn !== undefined,
      revalidatedCarry,
    };
    // §7.2 pendingModel redemption — synchronous, before any new call; the
    // redeemed tags ride into this turn's tally as source M at their §7.2
    // weight (full on carry phrases, capped at 0.6 otherwise).
    const redeemed = predictCache.redeemPending({
      turnSeq: predictTurnSeq,
      prompt: stripped,
      currentTags: result.tags,
      modifiers,
      ...(result.state.length > 0 ? { stateSupportedTags: new Set(["release"]) } : {}),
    });
    const pendingHits: readonly ModelHit[] =
      redeemed.kind === "full" || redeemed.kind === "capped" ? redeemed.tags : [];
    let modelExtras: ModelHit[] = [...pendingHits];
    let mergedTags = result.tags;
    let origin = result.origin;
    if (pendingHits.length > 0) {
      mergedTags = tally({ hits, modifiers, modelHits: pendingHits });
      origin = "rules+model";
    }
    // §6.2/§7.1 model path gates: predict.model.enabled, main session, prompt
    // gate, and a bindable model chain (predict.model.models only — never the
    // session model; unbindable chains degrade silently to the sync path).
    const modelCfg = config.predict.model;
    const raw = predictRegistryOf(ctx);
    const modelWanted = modelCfg.enabled && !isChild && raw !== undefined && passesPromptGate(stripped);
    let dto: PredictOutboundV1 | undefined;
    let key: string | undefined;
    let boundModels: PredictFlightModel[] = [];
    let chain: string[] = [];
    let cacheHit = false;
    if (modelWanted) {
      for (const spec of modelCfg.models) {
        const slash = spec.indexOf("/");
        if (slash <= 0 || slash >= spec.length - 1) continue;
        const bound = bindPredictModel(raw, spec.slice(0, slash), spec.slice(slash + 1));
        if (bound !== undefined) {
          boundModels.push(bound);
          chain.push(spec);
        }
      }
      if (boundModels.length > 0) {
        dto = buildPredictOutbound(input, {
          ruleGuess: mergedTags.map((t) => ({ tag: t.tag, score: t.score })),
        });
        key = turnKey({ dto, models: chain, taxonomyRev: c.taxonomy.rev, threshold: modelCfg.threshold });
        const cachedTags = predictCache.get(key);
        if (cachedTags !== undefined) {
          cacheHit = true;
          modelCached += 1;
          if (cachedTags.length > 0) {
            modelExtras = [...modelExtras, ...cachedTags];
            mergedTags = tally({ hits, modifiers, modelHits: modelExtras });
            origin = "rules+cache";
          }
        }
      }
    }
    // §4.4 flight gates — uncertain is evaluated over the MERGED r0 tags
    // (§8.3 r0 already includes pendingModel/cache; mirrors runPredict's
    // §4.4 conditions 3–5), then admit() covers the day caps/breaker/zombies.
    const uncertain =
      modelExtras.length > 0
        ? !mergedTags.some((t) => t.score >= 0.85) &&
          (!mergedTags.some((t) => t.score >= 0.5) || Array.from(input.prompt).length >= 40) &&
          !cancelled
        : result.uncertain;
    if (!(modelWanted && dto !== undefined && key !== undefined && boundModels.length > 0 && !cacheHit && uncertain)) {
      return { kind: "sync", result: commitPredictParts(r0, mergedTags, origin) };
    }
    const system = buildPredictSystemPrompt(c.taxonomy.tags);
    const user = serializePredictOutbound(dto);
    const flightInput: PredictFlightInput = { system, user, models: boundModels };
    if (predictDisposed || !predictFlight.admit(flightInput)) {
      return { kind: "sync", result: commitPredictParts(r0, mergedTags, origin) };
    }
    modelCalls += 1;
    return {
      kind: "model",
      r0,
      mergedTags,
      modelExtras,
      origin,
      key,
      knownTags: new Set(c.taxonomy.tags.map((t) => t.id)),
      threshold: modelCfg.threshold,
      waitMs: Math.max(0, Math.min(1500, modelCfg.waitMs)),
      turnSeqAtStart: predictTurnSeq,
      chain,
      turnStartClock,
      flightPromise: predictFlight.start(flightInput),
      predicted: new Map(mergedTags.map((t) => [t.tag, t.score] as const)),
    };
  };

  /** §8.3 wait window: the flight wins the race only while BOTH the `waitMs`
   *  timer is still pending AND U has not settled — i.e. window =
   *  max(waitMs, U's actual settle moment), with U itself already capped by
   *  `recall.waitMs` inside recallU's settle. `waitMs <= 0` has no timer at
   *  all: the window is exactly U's settle moment, so when U runs the flight
   * can still merge inside it, and when U is already settled (or never
   * ran) the race settles on the uDone microtask — zero real waiting added
   * (§12.3). The timer rides the injected clock (I1/I5: unref'd in prod). */
  const racePredictWindow = (
    flightPromise: Promise<PredictFlightOutcome>,
    uDone: Promise<unknown>,
    waitMs: number,
  ): Promise<{ timely: true; outcome: PredictFlightOutcome } | { timely: false }> =>
    new Promise((resolve) => {
      let settled = false;
      let timer: TimerHandle | undefined;
      let uSettled = false;
      let timerFired = waitMs <= 0;
      const finish = (r: { timely: true; outcome: PredictFlightOutcome } | { timely: false }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clock.clearTimer(timer);
        resolve(r);
      };
      // waitMs <= 0 ⇒ the clock side of the window is already elapsed; only
      // U's settle can extend it (§8.3 max(waitMs, U settle)).
      const onU = (): void => {
        uSettled = true;
        if (timerFired) finish({ timely: false });
      };
      uDone.then(onU, onU);
      if (waitMs > 0) {
        timer = clock.setTimer(waitMs, () => {
          timerFired = true;
          timer = undefined;
          if (uSettled) finish({ timely: false });
        });
      }
      flightPromise.then(
        (outcome) => finish({ timely: true, outcome }),
        () => finish({ timely: false }),
      );
    });

  /** #36 §6.5：本次实际生效的等待窗口 = max(waitMs, U 实际完成时刻)。U 的
   *  settle 观察先于 handler 的 `await uDone` 续延挂上（微任务序保证先写
   *  入），未跑 U（partial 等）时保持 undefined ⇒ 窗口退化为 waitMs。 */
  interface PredictWindowState {
    uSettleElapsedMs?: number;
  }

  const effectiveWindowMs = (b: Extract<BegunPredictTurn, { kind: "model" }>, ws: PredictWindowState): number =>
    Math.max(b.waitMs, ws.uSettleElapsedMs ?? 0);

  /** §9.4 `kind:"call"` ledger entry — one per STARTED flight (denied
   *  admissions never reserved and never record). #36 §6.5 追加
   *  `windowMs`/`attempts`（实际生效窗口与 failover 尝试档数）。 */
  const appendPredictCall = (
    chain: readonly string[],
    outcome: PredictFlightOutcome,
    timely: boolean,
    windowMs: number,
  ): void => {
    const reason = outcome.kind === "ok" ? undefined : outcome.kind;
    const entry: PredictCallEntry = {
      v: 1,
      kind: "call",
      at: new Date(now()).toISOString(),
      model: outcome.kind === "ok" ? outcome.model : chain.join(","),
      ms: outcome.ms,
      ok: outcome.kind === "ok",
      ...(reason === undefined ? {} : { reason }),
      reserveUsd: outcome.cost.reserveUsd,
      costUsd: outcome.cost.costUsd,
      costSource: outcome.cost.costSource,
      timely,
      windowMs: Math.max(0, Math.round(windowMs)),
      attempts: outcome.attempts.length,
    };
    appendPredict(entry);
  };

  /** §7.2 late path: the flight settled only after the window closed — the
   *  parsed result seeds the exact-key cache + pendingModel and NOTHING is
   *  delivered (P never calls sendMessage), plus the §9.4 call record. */
  const latePredictOutcome = (
    b: Extract<BegunPredictTurn, { kind: "model" }>,
    outcome: PredictFlightOutcome,
    ws: PredictWindowState,
  ): void => {
    if (predictDisposed) return;
    if (outcome.kind === "ok") {
      const parsed = parsePredictReply(outcome.text, b.knownTags);
      if (parsed.ok) {
        predictCache.set(b.key, parsed.tags);
        predictCache.setPending(parsed.tags, undefined, b.turnSeqAtStart);
      }
    }
    appendPredictCall(b.chain, outcome, false, effectiveWindowMs(b, ws));
  };

  /** §8.3 finish: merge a timely M into r0, write the final record, then
   *  select and commit — P claims shared entries BEFORE U's deferred commit
   *  (§5.3 P-first dedup; the caller invokes uFin after this). */
  const finishPredictModelTurn = (
    b: Extract<BegunPredictTurn, { kind: "model" }>,
    raced: Awaited<ReturnType<typeof racePredictWindow>>,
    ws: PredictWindowState,
  ): PredictCommit => {
    let tags = b.mergedTags;
    let origin = b.origin;
    if (raced.timely) {
      if (raced.outcome.kind === "ok") {
        const parsed = parsePredictReply(raced.outcome.text, b.knownTags);
        if (parsed.ok) {
          modelTimely += 1;
          const passing = parsed.tags.filter((t) => t.p >= b.threshold);
          if (passing.length > 0) {
            tags = tally({ hits: b.r0.hits, modifiers: b.r0.modifiers, modelHits: [...b.modelExtras, ...passing] });
            origin = "rules+model";
          }
        }
        if (!predictDisposed) appendPredictCall(b.chain, raced.outcome, parsed.ok, effectiveWindowMs(b, ws));
      } else if (!predictDisposed) {
        // fast failure/abort/timeout inside the window — no merge, still a call
        appendPredictCall(b.chain, raced.outcome, false, effectiveWindowMs(b, ws));
      }
    } else {
      void b.flightPromise.then(
        (outcome) => latePredictOutcome(b, outcome, ws),
        () =>
          latePredictOutcome(
            b,
            {
              kind: "failed",
              ms: 0,
              cost: { reserveUsd: 0, costUsd: 0, costSource: "reserve" },
              attempts: [],
            },
            ws,
          ),
      );
    }
    return commitPredictParts(b.r0, tags, origin);
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
      // #36 P3 R layer (arch §3.3.5): runs on EVERY before_agent_start turn
      // (custom/wake turns included) BEFORE the recall layers — the ledger it
      // maintains feeds `renderInfoFor`'s residentBlocks exclusion below.
      residentTurn(cwd, ctx);
      const b = reinject(cwd);
      if (b !== undefined) send(b);
      if (event.messageType === "custom") {
        const customType = (event.message as { customType?: unknown } | undefined)?.customType;
        const notice = bashNotice(event.message as { customType?: unknown; content?: unknown; details?: unknown });
        // #36 P6b：自定义消息轮没有用户 prompt——非 bash 通知的早返回也必须
        // 先清空点名基准，不能继承上一轮的 prompt（旧词不能替本轮“点名”）。
        curTurnPrompt = notice === undefined ? "" : notice.text;
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
        return m === undefined || typeof m === "function" ? undefined : { message: m };
      }
      if (!isChild && judgedAllowed() && client.status().kind === "full") backfillPending(cwd);
      // #36 P6b（arch §6.2 点名要求）：记录本轮用户 prompt（剥 skill 块），
      // 供本轮后续 tool_call 的 A 层点名判定使用。
      curTurnPrompt = stripSkillBlocks(event.prompt).trim();
      // §5.3/§8.3: P 与 U 互不拖累——P 抛异常只放弃 P（记诊断日志），U 仍按
      // 原路径返回/合并；U 的异常仍由外层 catch 兜底（原行为不变）。
      let begun: BegunPredictTurn | undefined;
      if (config.predict.enabled && (!isChild || config.predict.childSessions)) {
        try {
          begun = beginPredictTurn(event.prompt, ctx, cwd);
        } catch (err) {
          log(`predict turn failed: ${String((err as Error)?.message ?? err)}`);
          begun = undefined;
        }
      }
      if (begun !== undefined && begun.kind === "model") {
        // §8.3 model branch: U settles with its own semantics (recall.waitMs
        // cap + the unchanged late sendMessage path), but its COMMIT is
        // deferred until P has claimed shared entries (§5.3 P-first dedup).
        // P never breaks U: any failure here degrades to U's message alone.
        const uDone = recallU(event.prompt, ctx, cwd, reg, begun.predicted, { deferCommit: true });
        // #36 §6.5 windowMs：先挂 U-settle 观察器（微任务序早于下方
        // `await uDone` 的续延），finishPredictModelTurn/latePredictOutcome
        // 据此计算实际生效窗口 max(waitMs, U 实际完成时刻)。
        const windowState: PredictWindowState = {};
        const onUSettled = (): void => {
          if (windowState.uSettleElapsedMs === undefined) {
            windowState.uSettleElapsedMs = Math.max(0, clock.now() - begun.turnStartClock);
          }
        };
        uDone.then(onUSettled, onUSettled);
        try {
          const raced = await racePredictWindow(begun.flightPromise, uDone, begun.waitMs);
          const uFin = await uDone;
          let pRes: PredictCommit | undefined;
          try {
            pRes = finishPredictModelTurn(begun, raced, windowState);
          } catch (err) {
            log(`predict model finish failed: ${String((err as Error)?.message ?? err)}`);
          }
          const uMessage = typeof uFin === "function" ? uFin() : uFin;
          const merged =
            pRes === undefined ? uMessage : mergeInjectMessages(pRes.message, uMessage, pRes.predictSummary);
          return merged === undefined ? undefined : { message: merged };
        } catch (err) {
          log(`predict model turn failed: ${String((err as Error)?.message ?? err)}`);
          const uFin = await uDone;
          const uMessage = typeof uFin === "function" ? uFin() : uFin;
          return uMessage === undefined ? undefined : { message: uMessage };
        }
      }
      const pMessage = begun?.kind === "sync" ? begun.result : undefined;
      const uRaw = await recallU(event.prompt, ctx, cwd, reg, pMessage?.predicted);
      const uMessage = typeof uRaw === "function" ? uRaw() : uRaw;
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
        // #36 P3: a resume/reload reentry re-reads the ledger from the
        // branch on the next turn (arch §3.3.5 恢复) — reset the restored
        // flags so residentTurn rescans instead of trusting in-memory state.
        for (const st of residentStates.values()) st.restored = false;
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
      // memory-predict plan §8.2: abort the in-flight predict request, clear
      // its timers, and mark the P2 model state disposed — late settles then
      // produce no side effects (no cache writes, no call records).
      predictDisposed = true;
      predictFlight.shutdown();
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
      // #36 P3: R notices carry no items — render the one-line marker.
      if (d.layer === "R" && !Array.isArray(parts)) {
        return new Text(theme.fg("dim", "[memory · R] resident rules changed"), padX, 0);
      }
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
    ...(deps.writeGate === undefined ? {} : { gate: deps.writeGate }),
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
    const fmt = (ms: number): string => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    let shown: readonly { at: number; line: string }[] = errorLog.slice(-JEV_ERROR_LOG_SHOWN);
    if (shown.length === 0 && (ui !== undefined || isChild)) {
      // Fresh activation (restart or /reload) with the in-memory ring empty:
      // fall back to the persisted diag ring so `/mem jev` still shows the
      // most recent errors. No-UI main sessions never used the ring and keep
      // their byte-identical ring-less report.
      const dir = diagDirFor();
      if (dir !== undefined) {
        try {
          shown = readDiagLines(dir, JEV_ERROR_LOG_SHOWN)
            .map((r) => {
              const at = Date.parse(r.at);
              return Number.isFinite(at) ? { at, line: r.line } : undefined;
            })
            .filter((r): r is { at: number; line: string } => r !== undefined);
        } catch {
          /* fail-soft — no errors section on read trouble */
        }
      }
    }
    if (shown.length === 0) return undefined;
    return shown.map((e, i) => `${i === 0 ? "errors   " : "         "}${fmt(e.at)} ${e.line}`).join("\n");
  };
  const commandPort: JevCommandPort = {
    ...basePort,
    report: async (cwd, reg) => {
      const text = await basePort.report(cwd, reg);
      const withTrunc =
        truncated === undefined ? text : `${text}\nrecall   recall truncated ${truncated.from}→${truncated.to}`;
      const errors = recentErrorsText();
      const withErrors = errors === undefined ? withTrunc : `${withTrunc}\n${errors}`;
      // memory-predict plan §9.4: the predict line grows the P2 model slice
      // (calls/timely/cached/day estimate/breaker) only while model.enabled —
      // `predict.model.enabled=false` keeps the exact P1 rules-only line, and
      // `predict.enabled=false` drops the line entirely (I9).
      if (!config.predict.enabled) return withErrors;
      if (!config.predict.model.enabled) return `${withErrors}\npredict  rules ${rulesFired}`;
      return `${withErrors}\n${formatPredictStatsLine({
        rules: rulesFired,
        model: modelCalls,
        timely: modelTimely,
        cached: modelCached,
        spentUsd: predictLedger.snapshot(now()).spent,
        maxUsdPerDay: config.predict.model.maxUsdPerDay,
        breakerOpen: predictFlight.isBreakerOpen(),
      })}`;
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
        ...(deps.writeGate === undefined ? {} : { gate: deps.writeGate }),
        dirFor: deps.dirFor,
        taxonomyFor: (dir) => {
          const merged = mergeTaxonomy(readTaxonomyFile(dir));
          return merged.ok ? merged.taxonomy : (mergeTaxonomy() as { ok: true; taxonomy: Taxonomy }).taxonomy;
        },
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
