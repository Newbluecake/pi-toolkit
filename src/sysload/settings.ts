/**
 * sysload · settings (#56 batch 2 ⑧): the `load` block's types, frozen defaults and never-throws parser
 * (docs/dev/sysload/plan.md §6.1). The pi-free domain shapes/defaults it is built from stay frozen in `./types.ts`.
 * `src/config/settings.ts` imports ONLY this module for the block.
 */
import {
  DEFAULT_LOAD_THRESHOLDS,
  DEFAULT_LOAD_RECOVER_MS,
  DEFAULT_LOAD_SAMPLE_INTERVAL_MS,
  DEFAULT_LOAD_SUSTAIN_MS,
  LOAD_SAMPLE_INTERVAL_MAX_MS,
  LOAD_SAMPLE_INTERVAL_MIN_MS,
  LOAD_SUSTAIN_RECOVER_MAX_FACTOR,
  type LoadCpuThresholds,
  type LoadDiskThresholds,
  type LoadMemThresholds,
} from "./types.js";

/**
 * sysload plan §6.1: hint-ladder sub-block of `LoadSettings` (§6.4 notification ladder).
 * Parsed by `parseLoadSettings` below, never standalone.
 */
export interface LoadHintSettings {
  /** Master switch for the recovery-slot machinery (§6.4). `false` ⇒ no slot is ever armed,
   * and reject copy stops promising a future hint (§6.4). Default true. */
  enabled: boolean;
  /** Whether the injected `subagent:load` message is visible in the transcript. Default true. */
  display: boolean;
  /** crit re-announce period (§6.4); warn announces once per escalation. Default 600000 (10min). */
  repeatMs: number;
  /** Global floor between two load messages (crit + the recovery hint bypass it). Default 120000 (2min). */
  minIntervalMs: number;
}

/**
 * Load-aware dispatch (docs/dev/sysload/plan.md §6.1). Parsed field-by-field, never throws, by
 * `parseLoadSettings`. Non-live: captured at `session_start`, changed only by `/reload` (the hub
 * side additionally needs `/webhub restart` — §6.1). `cpu`/`mem`/`disk` reuse the pi-free
 * threshold shapes frozen in `src/sysload/types.ts` so the tracker (P1) and this settings layer
 * never drift on field names.
 */
export interface LoadSettings {
  /** Master switch (§1/§6.1). `false` ⇒ no sampler, no hook, no gate — byte-identical to
   * pre-feature (§8 I8). Default true. */
  enabled: boolean;
  /** Spawn-admission / workflow-queue gate switch (§5.3). `false` ⇒ the effective gate is
   * always false: no reject, no queue, no banner — only HUD/hint copy keeps working, worded as
   * "仅提示" (§5.3). Default true. */
  gate: boolean;
  /** Minimum overall level that counts as "gating" in §5.3's effective-gate formula. Default
   * `"crit"` (§6.1); `"warn"` is the more aggressive opt-in. */
  gateLevel: "crit" | "warn";
  /** Sampler tick period. Range `[2000,60000]` (§5.2). Default 5000. */
  sampleIntervalMs: number;
  /** §5.2 upgrade proof window; `0` = first valid sample upgrades immediately. Range
   * `[0, 120×sampleIntervalMs]`. Default 60000. */
  sustainMs: number;
  /** §5.2 recovery proof window. Range `[sampleIntervalMs, 120×sampleIntervalMs]`. Default 30000. */
  recoverMs: number;
  cpu: LoadCpuThresholds;
  mem: LoadMemThresholds;
  disk: LoadDiskThresholds;
  /** §6.4 notification ladder sub-block. */
  hint: LoadHintSettings;
  /** HUD status key (§3/§6.1). Default true. */
  hud: boolean;
}

/**
 * sysload plan §6.1: `load.*` settings block. Field-by-field tolerant, never throws (same
 * hand-written style as `parseQuotaSettings`). Interval/sustain/recover are clamped INTO range
 * (never fallback-to-default-on-out-of-range) so the §5.2 invariant `interval ≤ recover ≤
 * 120×interval` and `0 ≤ sustain ≤ 120×interval` always holds for the RETURNED value, even when
 * the caller only overrides `sampleIntervalMs` and leaves `sustainMs`/`recoverMs` at their
 * (now out-of-range) defaults — clamping the fallback itself, not just explicit input, is what
 * keeps that true unconditionally (§5.2 "parse 越界即钒").
 * Accepted semantics: out-of-range values clamp to bounds, inverted warn/crit pairs clamp monotonically,
 * and `recoverMs` is always at least `sampleIntervalMs`.
 */
export function parseLoadSettings(input: unknown): LoadSettings {
  const defaults = DEFAULT_LOAD_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      ...defaults,
      cpu: { ...defaults.cpu },
      mem: { ...defaults.mem },
      disk: { ...defaults.disk },
      hint: { ...defaults.hint },
    };
  const value = input as Record<string, unknown>;
  const bool = (raw: unknown, fallback: boolean): boolean => (typeof raw === "boolean" ? raw : fallback);
  // Clamps BOTH explicit input and the fallback into [min,max] — never returns an out-of-range
  // value even when the explicit input is garbage and the (int-derived) bounds moved since the
  // literal default was chosen (see interval-dependent sustain/recover above).
  const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const percent = (raw: unknown, fallback: number): number => clampInt(raw, fallback, 0, 100);

  const sampleIntervalMs = clampInt(
    value.sampleIntervalMs,
    defaults.sampleIntervalMs,
    LOAD_SAMPLE_INTERVAL_MIN_MS,
    LOAD_SAMPLE_INTERVAL_MAX_MS,
  );
  const sustainMaxMs = LOAD_SUSTAIN_RECOVER_MAX_FACTOR * sampleIntervalMs;
  const sustainMs = clampInt(value.sustainMs, defaults.sustainMs, 0, sustainMaxMs);
  const recoverMs = clampInt(value.recoverMs, defaults.recoverMs, sampleIntervalMs, sustainMaxMs);

  const cpuRecord =
    value.cpu && typeof value.cpu === "object" && !Array.isArray(value.cpu)
      ? (value.cpu as Record<string, unknown>)
      : undefined;
  // CPU: warn <= crit (higher busy/PSI is worse), same max()-chain style as quota's l1<=l2<=l3.
  const cpuWarnPercent = percent(cpuRecord?.warnPercent, defaults.cpu.warnPercent);
  const cpuCritPercent = Math.max(cpuWarnPercent, percent(cpuRecord?.critPercent, defaults.cpu.critPercent));
  const cpuPsiWarnPercent = percent(cpuRecord?.psiWarnPercent, defaults.cpu.psiWarnPercent);
  const cpuPsiCritPercent = Math.max(
    cpuPsiWarnPercent,
    percent(cpuRecord?.psiCritPercent, defaults.cpu.psiCritPercent),
  );

  const memRecord =
    value.mem && typeof value.mem === "object" && !Array.isArray(value.mem)
      ? (value.mem as Record<string, unknown>)
      : undefined;
  // MEM: warn >= crit (a LOWER available% is worse) — crit is clamped DOWN to warn, mirror image
  // of the CPU chain above.
  const memWarnAvailPercent = percent(memRecord?.warnAvailPercent, defaults.mem.warnAvailPercent);
  const memCritAvailPercent = Math.min(
    memWarnAvailPercent,
    percent(memRecord?.critAvailPercent, defaults.mem.critAvailPercent),
  );

  const diskRecord =
    value.disk && typeof value.disk === "object" && !Array.isArray(value.disk)
      ? (value.disk as Record<string, unknown>)
      : undefined;
  // DISK: warn >= crit (a LOWER free% is worse), same mirror-image chain as MEM.
  const diskWarnFreePercent = percent(diskRecord?.warnFreePercent, defaults.disk.warnFreePercent);
  const diskCritFreePercent = Math.min(
    diskWarnFreePercent,
    percent(diskRecord?.critFreePercent, defaults.disk.critFreePercent),
  );
  const diskCritFreeGiB = clampInt(diskRecord?.critFreeGiB, defaults.disk.critFreeGiB, 0, 1_000_000);

  const hintRecord =
    value.hint && typeof value.hint === "object" && !Array.isArray(value.hint)
      ? (value.hint as Record<string, unknown>)
      : undefined;

  return {
    enabled: bool(value.enabled, defaults.enabled),
    gate: bool(value.gate, defaults.gate),
    gateLevel: value.gateLevel === "warn" || value.gateLevel === "crit" ? value.gateLevel : defaults.gateLevel,
    sampleIntervalMs,
    sustainMs,
    recoverMs,
    cpu: {
      warnPercent: cpuWarnPercent,
      critPercent: cpuCritPercent,
      psiWarnPercent: cpuPsiWarnPercent,
      psiCritPercent: cpuPsiCritPercent,
    },
    mem: { warnAvailPercent: memWarnAvailPercent, critAvailPercent: memCritAvailPercent },
    disk: {
      warnFreePercent: diskWarnFreePercent,
      critFreePercent: diskCritFreePercent,
      critFreeGiB: diskCritFreeGiB,
    },
    hint: {
      enabled: bool(hintRecord?.enabled, defaults.hint.enabled),
      display: bool(hintRecord?.display, defaults.hint.display),
      repeatMs: clampInt(hintRecord?.repeatMs, defaults.hint.repeatMs, 0, 86_400_000),
      minIntervalMs: clampInt(hintRecord?.minIntervalMs, defaults.hint.minIntervalMs, 0, 86_400_000),
    },
    hud: bool(value.hud, defaults.hud),
  };
}

// Load-aware dispatch (docs/dev/sysload/plan.md §6.1): cpu/mem/disk reuse
// DEFAULT_LOAD_THRESHOLDS (src/sysload/types.ts) so the frozen §2/§6.1 numbers are written
// exactly once.
export const DEFAULT_LOAD_SETTINGS: LoadSettings = {
  enabled: true,
  gate: true,
  gateLevel: "crit",
  sampleIntervalMs: DEFAULT_LOAD_SAMPLE_INTERVAL_MS,
  sustainMs: DEFAULT_LOAD_SUSTAIN_MS,
  recoverMs: DEFAULT_LOAD_RECOVER_MS,
  cpu: { ...DEFAULT_LOAD_THRESHOLDS.cpu },
  mem: { ...DEFAULT_LOAD_THRESHOLDS.mem },
  disk: { ...DEFAULT_LOAD_THRESHOLDS.disk },
  hint: { enabled: true, display: true, repeatMs: 600_000, minIntervalMs: 120_000 },
  hud: true,
};
