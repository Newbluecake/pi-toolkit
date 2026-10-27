/**
 * StatusInfo slot projections (source-governance batch2 ⑨-H1).
 *
 * Pure extraction out of `index.ts`'s `wireWebHub` closure: the per-slot projection closures
 * that `publishStatus` / `onSnapshotReq` thread into `readStatus` — todo, bash-jobs, quota,
 * cache-keepalive, archive — plus their cap gates and never-throw wrappers. Every closure body
 * is byte-identical to its pre-extraction form; the closure-captured `conn` became an explicit
 * `conn()` getter (read at call time, exactly like the captured `let`), so reconnect/handover
 * semantics are unchanged. No module-scope mutable state (I4), no timers at all (I5 trivially).
 */
import type { ArchiveControl } from "../../archive/control.js";
import type { ProviderVerdict } from "../../quota/ladder.js";
import type { QuotaProblem } from "../../quota/types.js";
import type { TodoState } from "../../todo/state.js";
import type { ArchiveWire, BashJobsWire, CacheKeepaliveWire, QuotaWire, TodoWire } from "../protocol/messages.js";
import { QUOTA_POOLS_HUB_CAP, TODO_ARCHIVE_HUB_CAP } from "../protocol/version.js";
import { projectBashJobs, type BashJobsTails } from "./bash-jobs.js";
import type { BashJobsSource } from "./bash-jobs-sampler.js";
import { projectCacheKeepalive, type CacheKeepaliveInput } from "./cache-keepalive.js";
import type { HubConnection } from "./connection.js";
import { projectQuota } from "./quota-sampler.js";
import { projectTodo } from "./todo.js";

/** The `WebHubDeps` fields these projections read (structural — `WebHubDeps` is assignable). */
export interface StatusSlotSources {
  todo?: () => TodoState;
  bashJobs?: {
    current(): BashJobsSource | undefined;
    retentionMs(): number;
  };
  quota?: () => readonly ProviderVerdict[];
  quotaProblems?: () => readonly QuotaProblem[];
  cacheKeepalive?: () => CacheKeepaliveInput | undefined;
  archive?: () => ArchiveControl | undefined;
}

export interface StatusSlotProjectionDeps {
  sources: StatusSlotSources;
  /** Late-bound read of the current link (the pre-extraction closure's captured `conn`). */
  conn(): HubConnection | undefined;
  /** `bashSampler.tails` — reconciles rows/tails on one source generation (D3-4 ③/④). */
  bashTails(gen: object): BashJobsTails | undefined;
  now(): number;
}

export interface StatusSlotProjections {
  bashJobsProjection(): BashJobsWire | undefined;
  todoArchiveCap(): boolean;
  todoProjection(): TodoWire | undefined;
  archiveProjection(): ArchiveWire | undefined;
  cacheKeepaliveProjection(): CacheKeepaliveWire | undefined;
  quotaProjection(): QuotaWire | undefined;
  quotaProblemsSafe(): readonly QuotaProblem[];
}

export function createStatusSlotProjections(args: StatusSlotProjectionDeps): StatusSlotProjections {
  const { sources, conn, bashTails, now } = args;

  /** `readStatus`'s bash-jobs projection closure (hot path: source read + in-memory list + cache
   *  — zero fs I/O; the sampler owns every read). Rows and tails provably share one source
   *  generation: `tails(src.gen)` reconciles on mismatch (D3-4 ③/④). */
  const bashJobsProjection = (): BashJobsWire | undefined => {
    const d = sources.bashJobs;
    if (d === undefined) return undefined;
    const src = d.current();
    if (src === undefined) return undefined;
    return projectBashJobs(src.list(), bashTails(src.gen), now(), d.retentionMs());
  };

  // quota-web plan §2 (D3): pure, stateless projection — `QuotaService.verdicts()` is already a
  // synchronous in-memory read, so there is no sampler state to own here (see quota-sampler.ts's
  // module docstring). Re-evaluated fresh on every call; the 1Hz tick below only decides whether
  // a given evaluation is worth publishing.
  // todo-archive plan v2.1 §2 (D5): the todo projection closure — same PURE-read cap gate as
  // quota's `pools` below (never cached, never bound to a link generation): `completedHidden` /
  // `archived` ride the wire ONLY while the live link's hello_ack.caps carries `todo.archive.v1`
  // (an un-upgraded hub's closed TodoWireSchema would silently drop the whole status frame,
  // plan §4). B1 keeps the optional-source gate INSIDE the closure too: `deps.todo === undefined`
  // (todo.enabled=false ⇒ `wireTodo` never ran) ⇒ undefined, never a `deps.todo!()` throw.
  const todoArchiveCap = (): boolean =>
    conn()?.status().state === "live" && (conn()?.caps.includes(TODO_ARCHIVE_HUB_CAP) ?? false);
  const todoProjection = (): TodoWire | undefined =>
    sources.todo !== undefined ? projectTodo(sources.todo(), { archiveFields: todoArchiveCap() }) : undefined;
  // web-hub archive plan: projection closure (same optional-source pattern as todo/bashJobs).
  // `wire()` is a synchronous in-memory read; undefined while the control is detached (no live
  // stack) or nothing is archived — the status frame stays byte-equal in both cases.
  const archiveProjection = (): ArchiveWire | undefined => {
    try {
      return sources.archive?.()?.wire();
    } catch {
      return undefined;
    }
  };
  const cacheKeepaliveProjection = (): CacheKeepaliveWire | undefined => {
    const d = sources.cacheKeepalive;
    if (d === undefined) return undefined;
    try {
      return projectCacheKeepalive(d(), now());
    } catch {
      return undefined;
    }
  };
  const quotaProjection = (): QuotaWire | undefined => {
    const d = sources.quota;
    if (d === undefined) return undefined;
    // quota-plan r2 §9A.4 (P7wa): droid rows / month / billing / problems ride the wire ONLY
    // while the live link's hello_ack.caps carries `quota.pools.v1` — same PURE-read shape as
    // holdCap() (never cached, never bound to a link generation): a reconnect to an upgraded
    // hub flips the projection here and the 1Hz tick's fingerprint gate publishes on the next
    // tick, no extra event needed. While disconnected pools stays false, so the slot keeps the
    // legacy projection (an old hub must never decode an unknown enum and drop the frame, R7).
    const pools = conn()?.status().state === "live" && (conn()?.caps.includes(QUOTA_POOLS_HUB_CAP) ?? false);
    return projectQuota(d(), now(), {
      pools,
      problems: pools ? quotaProblemsSafe() : [], // ignored by projectQuota when pools !== true
    });
  };
  /** 端口契约永不抛；兜注入桩（§11 wiring 行：quotaProblems 抛错 ⇒ 视为无 problems）。 */
  const quotaProblemsSafe = (): readonly QuotaProblem[] => {
    const g = sources.quotaProblems;
    if (g === undefined) return [];
    try {
      return g();
    } catch {
      return [];
    }
  };

  return {
    bashJobsProjection,
    todoArchiveCap,
    todoProjection,
    archiveProjection,
    cacheKeepaliveProjection,
    quotaProjection,
    quotaProblemsSafe,
  };
}
