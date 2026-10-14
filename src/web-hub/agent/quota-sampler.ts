/**
 * quota-web plan §2 (D3/D4): the `StatusInfo.quota` projection + its fingerprint gate.
 *
 * Unlike `worktree-sampler.ts`/`bash-jobs-sampler.ts`, this module owns NO timers, no
 * single-flight state, no I/O: `QuotaService.verdicts()` is already a synchronous, in-memory,
 * never-throwing read (D3 "零新采集" — the real sampling cadence lives entirely inside
 * `QuotaService.refreshIfStale()`, driven by its own existing lifecycle hooks, completely
 * independent of web-hub). `projectQuota` is therefore a pure, stateless projection — called
 * fresh on every `readStatus`/`publishStatus` — and `quotaFingerprint` is the 1Hz-tick gate
 * (same `lastTodoFp`/`lastBashFp` pattern in `agent/index.ts`) that decides whether a tick's
 * otherwise-unchanged verdict snapshot is worth publishing at all.
 *
 * The fingerprint deliberately excludes `QuotaWire.at` — `at` always moves (it is the agent
 * clock at read time), so folding it into the gate would defeat it and republish every tick.
 * `fetchedAt` IS included (unrounded): it only changes when `QuotaService` actually lands a
 * fresh snapshot, so it is a genuine edge, not per-tick jitter — and the UI needs it to update
 * the stale badge's age baseline (verification r_WV2Y9VQZ #2).
 * Per-field rounding (plan §2's fingerprint spec): level/demotedUntil?/stale are compared
 * as-is; each window's usedPct is rounded to a whole percent, resetAt/etaMs to the minute —
 * matching the smallest units the UI actually renders, so sub-percent/sub-minute jitter in the
 * underlying forecast never triggers a frame.
 */
import type { ProviderVerdict, WindowVerdict } from "../../quota/ladder.js";
import type { QuotaProviderWire, QuotaWindowWire, QuotaWire } from "../protocol/messages.js";

/**
 * P7 安全默认（external-agent quota-plan r2 §9）：droid 池 id 与 month 窗口是封闭
 * 枚举之外的新值——旧 hub 的 decodeWith 遇到它们会丢掉**整个** status 帧。P7 单独
 * 合入时 web 永远收不到 droid 数据（本守卫 + month 过滤），也不丢帧；P7wa 在此基础
 * 上加 cap 门控的 pools 模式（看到 `quota.pools.v1` 才放行）。
 */
const LEGACY_WEB_QUOTA_IDS: readonly string[] = ["zai-coding-cn", "zai", "kimi-coding"];

function isLegacyWebQuotaProviderId(value: string): value is QuotaProviderWire["id"] {
  return LEGACY_WEB_QUOTA_IDS.includes(value);
}

/** `undefined`/empty verdicts ⇒ `undefined` (field omitted entirely, byte-equal to pre-feature). */
export function projectQuota(verdicts: readonly ProviderVerdict[] | undefined, now: number): QuotaWire | undefined {
  if (verdicts === undefined || verdicts.length === 0) return undefined;
  const providers: QuotaProviderWire[] = [];
  for (const v of verdicts) {
    // Defensive only: a provider id without a matching wire union entry must not crash
    // the whole status frame, just drop that one row (same posture as WorktreeRowWire's
    // open enum). P7: droid pool ids are dropped here unconditionally (see module doc).
    if (!isLegacyWebQuotaProviderId(v.provider)) continue;
    providers.push(projectProvider(v));
  }
  if (providers.length === 0) return undefined;
  return { v: 1, at: now, providers };
}

function projectProvider(v: ProviderVerdict): QuotaProviderWire {
  const id = v.provider as QuotaProviderWire["id"]; // guarded by isLegacyWebQuotaProviderId
  const wire: QuotaProviderWire = {
    id,
    level: v.level,
    stale: v.stale,
    fetchedAt: v.fetchedAt,
    // month 窗口在封闭枚举之外 ⇒ 丢掉（防御；kimi/zai 适配器本就不产出 month）。
    windows: v.windows.filter(isLegacyWireWindow).map(projectWindow),
  };
  if (v.plan !== undefined) wire.plan = v.plan;
  if (v.demoted && v.demotedUntil !== undefined) wire.demotedUntil = v.demotedUntil;
  return wire;
}

/** 类型守卫：过滤后 scope 收窄到旧 wire 联合（"5h" | "week"）。 */
function isLegacyWireWindow(w: WindowVerdict): w is WindowVerdict & { scope: QuotaWindowWire["scope"] } {
  return w.scope !== "month";
}

function projectWindow(w: WindowVerdict & { scope: QuotaWindowWire["scope"] }): QuotaWindowWire {
  const wire: QuotaWindowWire = { scope: w.scope, usedPct: w.usedPct, level: w.level };
  if (w.resetAt !== undefined) wire.resetAt = w.resetAt;
  if (w.etaMs !== undefined) wire.etaMs = w.etaMs;
  return wire;
}

/** 1Hz-tick gate: identical fingerprints ⇒ skip `publishStatus()` (see module docstring for the
 *  per-field rounding rationale). `undefined` wire ⇒ the empty-string sentinel, so "no quota data"
 *  and "quota data with every field blank" can never collide on the same fingerprint. */
export function quotaFingerprint(wire: QuotaWire | undefined): string {
  if (wire === undefined) return "";
  return JSON.stringify(
    wire.providers.map((p) => ({
      id: p.id,
      level: p.level,
      demotedUntil: p.demotedUntil,
      stale: p.stale,
      fetchedAt: p.fetchedAt, // a real refresh landing (verification #2) is worth a frame
      windows: p.windows.map((w) => ({
        scope: w.scope,
        usedPct: Math.round(w.usedPct),
        resetAt: w.resetAt === undefined ? undefined : Math.floor(w.resetAt / 60_000),
        etaMs: w.etaMs === undefined ? undefined : Math.floor(w.etaMs / 60_000),
      })),
    })),
  );
}
