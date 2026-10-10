/**
 * sysload plan (docs/dev/sysload/plan.md) §4 — **P0 frozen surface**.
 *
 * Zero pi imports (plan §4: "除 `hook.ts` 外零 pi import"; this module is never `hook.ts`).
 * Every shared type/constant the rest of `src/sysload/**` (P1), the pi-side admission points
 * (`spawn-service.ts` / `runtime-adapter.ts` / `workflow/*`, P2a/P2b) and the web-hub agent
 * side (`web-hub/agent/*`, P2a/P3) build against lives here — none of those packages may widen
 * or narrow a shape declared in this file without reopening this review (§10's "热点规则").
 *
 * `LoadSettings` itself (the on-disk/live settings tree) is NOT declared here: like
 * `QuotaSettings`/`CacheTtlSettings`, it lives in `src/config/settings.ts` — this module only
 * owns the pi-free DOMAIN shapes (levels, samples, verdicts, thresholds, top snapshot, the two
 * ports) plus the numeric defaults/margins §5/§6.1 freeze, which `config/settings.ts` imports.
 *
 * `LoadWire`/`LoadTopWire` (the hub↔browser wire DTOs, §7.1) are NOT declared here either —
 * following the existing `protocol/messages.ts` convention (`QuotaWire`, `BashJobsWire`, …,
 * all self-contained with no cross-feature import), they are declared directly in
 * `protocol/messages.ts` and structurally mirror (never import) the shapes below.
 */

// ---------------------------------------------------------------------------
// levels
// ---------------------------------------------------------------------------

/** §5.2/§5.3: the four-value ladder shared by every metric and the overall verdict.
 * `"unknown"` is the fail-open value (§8 I1) — never counted as "known" for gating purposes. */
export type LoadLevel = "ok" | "warn" | "crit" | "unknown";

/** The three monitored metric kinds (§1). DISK is tracked per mount (§5.2), so it is not a
 * `LoadMetricKind`-indexed singleton the way CPU/MEM are — see `LoadVerdict.metrics.disk`. */
export type LoadMetricKind = "cpu" | "mem" | "disk";

// ---------------------------------------------------------------------------
// thresholds (§5.1/§5.2/§6.1 — symbols B_L/P_L/A_L/F_L/G_crit)
// ---------------------------------------------------------------------------

export interface LoadCpuThresholds {
  /** B_L warn (busy %). */
  readonly warnPercent: number;
  /** B_L crit (busy %). */
  readonly critPercent: number;
  /** P_L warn (PSI cpu `some avg10` %). */
  readonly psiWarnPercent: number;
  /** P_L crit (PSI cpu `some avg10` %). */
  readonly psiCritPercent: number;
}

export interface LoadMemThresholds {
  /** A_L warn (MemAvailable %). */
  readonly warnAvailPercent: number;
  /** A_L crit (MemAvailable %). */
  readonly critAvailPercent: number;
}

export interface LoadDiskThresholds {
  /** F_L warn (free %, df semantics). */
  readonly warnFreePercent: number;
  /** F_L crit (free %, df semantics). */
  readonly critFreePercent: number;
  /** G_crit, in GiB (settings-layer name post §5.1 rename: `critFreeGb` → `critFreeGiB`). */
  readonly critFreeGiB: number;
}

export interface LoadThresholds {
  readonly cpu: LoadCpuThresholds;
  readonly mem: LoadMemThresholds;
  readonly disk: LoadDiskThresholds;
}

/** §5.1 "全文 GiB = 2³⁰". */
export const GIB = 2 ** 30;

/** §2 U2 / §6.1 defaults — the only place these seven numbers are written; `config/settings.ts`
 * imports this for `DEFAULT_SETTINGS.load.{cpu,mem,disk}` instead of re-stating them. */
export const DEFAULT_LOAD_THRESHOLDS: LoadThresholds = {
  cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
  mem: { warnAvailPercent: 15, critAvailPercent: 8 },
  disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
};

/** §5.2 recovery-hysteresis margins (`mCPU`/`mMEM`/`mDISK%`/`mDISKB`) — frozen constants the
 * `clear(L)` predicate (P1's `tracker.ts`) subtracts/adds to the active threshold. */
export const LOAD_RECOVERY_MARGIN = {
  /** mCPU: percentage points subtracted from the busy/PSI threshold. */
  cpuPercent: 5,
  /** mMEM: percentage points added to the avail threshold. */
  memPercent: 3,
  /** mDISK%: percentage points added to the free-percent threshold. */
  diskPercent: 1,
  /** mDISKB: bytes added to the crit byte threshold (1 GiB). */
  diskBytes: GIB,
} as const;

// ---------------------------------------------------------------------------
// timing defaults & bounds (§5.2 "上限")
// ---------------------------------------------------------------------------

export const DEFAULT_LOAD_SAMPLE_INTERVAL_MS = 5_000;
export const DEFAULT_LOAD_SUSTAIN_MS = 60_000;
export const DEFAULT_LOAD_RECOVER_MS = 30_000;

/** §5.2: `sampleIntervalMs ∈ [2000,60000]`. */
export const LOAD_SAMPLE_INTERVAL_MIN_MS = 2_000;
export const LOAD_SAMPLE_INTERVAL_MAX_MS = 60_000;

/** §5.2: `sustainMs ∈ [0, 120×interval]`, `recoverMs ∈ [interval, 120×interval]`. */
export const LOAD_SUSTAIN_RECOVER_MAX_FACTOR = 120;

/** §5.4: mountinfo ring capacity ("环最多 128 槽"). */
export const LOAD_MOUNT_RING_MAX_SLOTS = 128;

// ---------------------------------------------------------------------------
// samples (§5.1/§5.2/§5.4 — one sampler tick's raw reads; P1's `sampler.ts` produces these)
// ---------------------------------------------------------------------------

/** A metric reading that either succeeded (`"ok"`) or failed validation for this tick
 * (§5.2/§10 包注 M8: non-finite / zero-denominator / impossible-relation readings are
 * rejected BEFORE classification, same as a transport failure — both fold to `"invalid"`). */
export type LoadMetricReading<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid" };

export interface LoadCpuSample {
  readonly busyPct: number;
  /** PSI cpu `some avg10`; absent when `/proc/pressure/cpu` is missing (§5.1 — busy-only mode). */
  readonly psiPct?: number;
  readonly cores: number;
}

export interface LoadMemSample {
  readonly availPct: number;
  readonly usedPct: number;
}

/** One mount's statfs read (§5.1/§5.4). `mountId`+`dev` are the connectivity identity §5.2's
 * continuity rule compares across samples (a change breaks the series without lowering the
 * level immediately). */
export interface LoadDiskMountSample {
  readonly mountPath: string;
  readonly freePct: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly mountId: number;
  readonly dev: string;
}

/** §5.4: the two fixed display paths this feature ever tracks disk for (`~` = HOME, `/` = root;
 * no `extraPaths` in v1 — §1/§6.1). */
export type LoadDiskPathLabel = "~" | "/";

/** A disk path's per-tick outcome: a normal `LoadMetricReading`, or one of §5.4's two
 * non-participating reasons — `"skipped"` (fstype outside the whitelist, e.g. nfs/cifs/fuse.*)
 * or `"unresolved"` (symlink realpath not proven within its deadline/cache/ledger budget). Both
 * keep the path's level `unknown` without "cheating" a lexical match into a verified one. */
export type LoadDiskReading =
  | LoadMetricReading<LoadDiskMountSample>
  | { readonly kind: "skipped"; readonly reason: "remote" }
  | { readonly kind: "unresolved" };

export interface LoadDiskPathSample {
  readonly label: LoadDiskPathLabel;
  readonly reading: LoadDiskReading;
}

/** One sampler tick (§5.2/§5.4). `mono` drives every state-machine decision; `at` is
 * `Date.now()` for display only (§5.2, §10 包注 P0·M9). */
export interface LoadSample {
  readonly mono: number;
  readonly at: number;
  readonly cpu: LoadMetricReading<LoadCpuSample>;
  readonly mem: LoadMetricReading<LoadMemSample>;
  readonly disks: readonly LoadDiskPathSample[];
  /** `/proc/loadavg`'s three load averages, display-only (§6.4 文案). */
  readonly loadavg?: readonly [number, number, number];
}

// ---------------------------------------------------------------------------
// tracker state & verdict (§5.2/§5.3)
// ---------------------------------------------------------------------------

/** One metric's (or one mount's) tracked state machine (§5.2). Owned/mutated by P1's
 * `tracker.ts`; every other package only ever reads a `LoadVerdict` snapshot of it through
 * `LoadPort.verdict()` — never this shape's transition logic. */
export interface MetricState {
  readonly level: LoadLevel;
  /** mono() of the first sample in the currently-open migration window (§5.2 "每次迁移后窗口
   * 清空" — the window a pending upgrade/recovery is being proven against). `undefined` while
   * no migration is in progress (level stable, no open window). */
  readonly windowStartMono?: number;
  /** mono() when this metric's current level was most recently confirmed. */
  readonly levelSinceMono?: number;
  /** Last confirmed sample values, used for the human-readable gate diagnostic. */
  readonly busyPct?: number;
  readonly psiPct?: number;
  readonly availPct?: number;
  readonly freePct?: number;
  readonly freeBytes?: number;
  readonly mountPath?: string;
  /** mono() of the most recent valid (non-invalid, non-skipped, non-unresolved) sample folded
   * into this metric — the basis for §5.2's staleness/continuity checks. `undefined` if no
   * valid sample has ever been seen. */
  readonly lastValidMono?: number;
}

export interface LoadDiskMountState {
  readonly label: LoadDiskPathLabel;
  readonly state: MetricState;
}

/** The read-time-fresh (§5.2 "新鲜度在读取时强制") snapshot every consumer (spawn admission,
 * workflow load-wait, web-hub projection, HUD, turn_end hint) reads through `LoadPort.verdict()`
 * — never reconstructed independently (§5.3 "只读它，不各自重组"). */
export interface LoadVerdict {
  /** Overall level = the highest known metric level; `"unknown"` iff every metric is unknown
   * (§5.2). */
  readonly level: LoadLevel;
  /** §5.3's single effective gate: `load.enabled ∧ load.gate ∧ level(known) ≥ gateLevel`
   * (`false` whenever `level` is `"unknown"`). Already folds every settings switch — a consumer
   * never re-derives this from `level` + raw settings. */
  readonly gating: boolean;
  readonly metrics: {
    readonly cpu: MetricState;
    readonly mem: MetricState;
    readonly disk: readonly LoadDiskMountState[];
  };
  /** `mono()` this verdict was computed at (freshness anchor). */
  readonly mono: number;
  /** `Date.now()` this verdict was computed at (display only). */
  readonly at: number;
  /** mono() when the effective gate most recently became true. */
  readonly gatingSinceMono?: number;
  /** Display-only CPU load averages and core count from the latest sample. */
  readonly loadavg?: readonly [number, number, number];
  readonly cores?: number;
}

/** §5.3: the two migration signals a consumer may react to (computed by the tracker/port on
 * every transition, never re-derived by consumers). */
export interface LoadTransition {
  /** `gating` flipped true → false (including → unknown). The sole wake for workflow
   * `pump()` (§6.5) — fail-open, never gates anything itself. */
  readonly gateCleared: boolean;
  /** Some metric was proven recovered (§5.2 `clear(L)`) from ≥gateLevel down to a KNOWN level
   * below gateLevel, and the overall level followed it below gateLevel too. Independent of
   * `load.gate` (§5.3) — the only signal that ever produces a recovery hint (§6.4). */
  readonly provenRecovered: boolean;
  /** Set when the overall level just rose (drives the warn/crit hint ladder, §6.4). Absent on a
   * transition that is a pure recovery or a no-op re-evaluation. */
  readonly escalatedTo?: LoadLevel;
}

// ---------------------------------------------------------------------------
// top snapshot (§5.5)
// ---------------------------------------------------------------------------

export interface LoadTopPid {
  readonly pid: number;
  readonly cpuPct: number;
  readonly rssBytes: number;
}

/** One `comm`-aggregated row (§5.5): the SAME shape feeds both `byCpu` and `byRss` (sorted
 * differently), matching §5.5's single-shape output `{comm, count, cpuPct, rssBytes,
 * pids[≤8]{pid,cpuPct,rssBytes}}`. */
export interface LoadTopRow {
  readonly comm: string;
  readonly count: number;
  readonly cpuPct: number;
  readonly rssBytes: number;
  /** Set when `cpuPct` is a lifetime average (no matching previous-tick sample, §5.5) rather
   * than an instantaneous delta. */
  readonly avg?: true;
  /** ≤8, per §5.5. */
  readonly pids: readonly LoadTopPid[];
}

export interface TopSnapshot {
  readonly at: number;
  /** Set when the §5.5 time/pid-count deadline cut the enumeration short. */
  readonly partial?: true;
  /** Fixed top-5 (§5.5), sorted by `cpuPct` desc. */
  readonly byCpu: readonly LoadTopRow[];
  /** Fixed top-5 (§5.5), sorted by `rssBytes` desc. */
  readonly byRss: readonly LoadTopRow[];
}

// ---------------------------------------------------------------------------
// ports (§4 — "stack/runtime-adapter/web-hub 只见此接口")
// ---------------------------------------------------------------------------

/** The sole interface `stack.ts` / `runtime-adapter.ts` / web-hub agent code ever sees (§4) —
 * never the activation/sampler/tracker internals directly. Implemented by P1's
 * `activation.ts`. */
export interface LoadPort {
  /** Re-derives freshness from the CURRENT `mono()` on every call (§5.2 "新鲜度在读取时强
   * 制") — never a cached verdict from the last tick; a stalled sampler decays to `"unknown"`
   * on its own, it never leaves a stale `"crit"` verdict in place. */
  verdict(): LoadVerdict;
  /** The most recent top-process snapshot, or `undefined` before the first scan ever completes
   * (§5.5). */
  top(): TopSnapshot | undefined;
  /** Fire-and-forget refresh trigger (§5.5 "gating 变 true" / "每次拒绝且缓存 >30 s"). Callers
   * never await this to decide anything synchronously — it only affects what a LATER `top()`
   * call returns. */
  refreshTop(): void;
}

/** §6.5: the optional workflow host-FIFO load-wait hook (`ChildSpawner.loadAdmission`).
 * Absent ⇒ byte-identical to pre-feature behavior (no load-wait at all). */
export interface LoadAdmission {
  /** §5.3 effective gate, read-time fresh — same value `LoadPort.verdict().gating` gives at the
   * same instant. */
  blocked(): boolean;
  /** Fires once per `gateCleared` transition (§5.3). Returns an unsubscribe function; the
   * workflow engine unsubscribes on `terminate`/`stopOwned`. */
  onGateCleared(fn: () => void): () => void;
}
