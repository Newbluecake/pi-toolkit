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
 *
 * P7wa (external-agent quota-plan r2 §9A.4): `opts.pools === true` (the live link's
 * hello_ack.caps carried `quota.pools.v1`, decided by the caller) widens the guard to the two
 * droid pool ids, keeps `month` windows, projects D20's billing fields and the top-level
 * `problems` list. Anything else — `pools` unset/false — keeps P7's filtered output
 * byte-identical (old hubs decode closed unions and would drop the WHOLE status frame).
 */
import type { ProviderVerdict, WindowVerdict } from "../../quota/ladder.js";
import type { QuotaProblem } from "../../quota/types.js";
import type {
  QuotaBillingWire,
  QuotaProblemWire,
  QuotaProviderWire,
  QuotaWindowWire,
  QuotaWire,
} from "../protocol/messages.js";

/** P7wa 投影选项（quota-plan r2 §9A.4）。 */
export interface QuotaProjectionOptions {
  /** hello_ack.caps ∋ quota.pools.v1；缺省/false ⇒ P7 的过滤行为（字节不变）。 */
  readonly pools?: boolean;
  /** `QuotaService.problems()` 的当前值；pools !== true 时忽略。 */
  readonly problems?: readonly QuotaProblem[];
}

/**
 * P7 安全默认（external-agent quota-plan r2 §9）：droid 池 id 与 month 窗口是封闭
 * 枚举之外的新值——旧 hub 的 decodeWith 遇到它们会丢掉**整个** status 帧。P7 单独
 * 合入时 web 永远收不到 droid 数据（本守卫 + month 过滤），也不丢帧；P7wa 在此基础
 * 上加 cap 门控的 pools 模式（看到 `quota.pools.v1` 才放行，§9A.4）。
 */
const LEGACY_WEB_QUOTA_IDS: readonly string[] = ["zai-coding-cn", "zai", "kimi-coding"];
const POOLS_WEB_QUOTA_IDS: readonly string[] = [...LEGACY_WEB_QUOTA_IDS, "droid-standard", "droid-core"];

function isLegacyWebQuotaProviderId(value: string): value is QuotaProviderWire["id"] {
  return LEGACY_WEB_QUOTA_IDS.includes(value);
}

function isPoolsWebQuotaProviderId(value: string): value is QuotaProviderWire["id"] {
  return POOLS_WEB_QUOTA_IDS.includes(value);
}

/** `undefined`/empty verdicts ⇒ `undefined` (field omitted entirely, byte-equal to pre-feature);
 * pools 模式下空 verdicts + 非空 problems 仍要出帧（§9A.4「只有 problems」）。 */
export function projectQuota(
  verdicts: readonly ProviderVerdict[] | undefined,
  now: number,
  opts?: QuotaProjectionOptions,
): QuotaWire | undefined {
  if (verdicts === undefined) return undefined;
  const pools = opts?.pools === true;
  if (!pools && verdicts.length === 0) return undefined;
  const providers: QuotaProviderWire[] = [];
  for (const v of verdicts) {
    // Defensive only: a provider id without a matching wire union entry must not crash
    // the whole status frame, just drop that one row (same posture as WorktreeRowWire's
    // open enum). P7 默认（pools !== true）: droid pool ids are dropped here (see module doc).
    const known = pools ? isPoolsWebQuotaProviderId(v.provider) : isLegacyWebQuotaProviderId(v.provider);
    if (!known) continue;
    providers.push(projectProvider(v, pools));
  }
  if (!pools) {
    if (providers.length === 0) return undefined;
    return { v: 1, at: now, providers };
  }
  const problems = projectProblems(opts?.problems);
  // §9A.4：providers 为空但有 problems ⇒ `{ v:1, at, providers: [], problems }`；两者都空 ⇒ undefined。
  if (providers.length === 0 && problems.length === 0) return undefined;
  const wire: QuotaWire = { v: 1, at: now, providers };
  if (problems.length > 0) wire.problems = problems;
  return wire;
}

function projectProvider(v: ProviderVerdict, pools: boolean): QuotaProviderWire {
  const id = v.provider as QuotaProviderWire["id"]; // guarded by is{Legacy,Pools}WebQuotaProviderId
  const wire: QuotaProviderWire = {
    id,
    level: v.displayLevel ?? v.level, // 展示级别：不含 forecast-before-reset 抬升
    stale: v.stale,
    fetchedAt: v.fetchedAt,
    // pools !== true：month 窗口在封闭枚举之外 ⇒ 丢掉（防御；kimi/zai 适配器本就不产出 month）。
    // pools === true：`month` 来自 droid 快照，wire 已放宽（quota.pools.v1 门控，§9A.4）。
    windows: (pools ? v.windows : v.windows.filter(isLegacyWireWindow)).map(projectWindow),
  };
  if (v.plan !== undefined) wire.plan = v.plan;
  if (v.demoted && v.demotedUntil !== undefined) wire.demotedUntil = v.demotedUntil;
  // D20：billing 只带 overage / extraUsageBalanceCents / gateOpen（仅 true 时出现）；
  // kind/pool/extraUsageAllowed 是 agent 内部语义，不上 wire。kimi/zai verdict 永不设置 billing。
  if (pools && v.billing !== undefined) {
    const billing: QuotaBillingWire = {
      overage: v.billing.overage,
      extraUsageBalanceCents: v.billing.extraUsageBalanceCents,
    };
    if (v.billing.gateOpen === true) billing.gateOpen = true;
    wire.billing = billing;
  }
  return wire;
}

/** 只收 family === "droid"（§9A.4），最多 4 条（QuotaWireSchema.problems maxItems）。
 * status 限定整数 100..599：service 只产 401/402/403，这里纯防御——非法值会让新 hub
 * 丢掉整帧，宁可不上。 */
function projectProblems(problems: readonly QuotaProblem[] | undefined): QuotaProblemWire[] {
  if (problems === undefined) return [];
  const out: QuotaProblemWire[] = [];
  for (const p of problems) {
    if (out.length >= 4) break;
    if (p.family !== "droid") continue;
    if (!Number.isInteger(p.status) || p.status < 100 || p.status > 599) continue;
    out.push({ family: "droid", status: p.status });
  }
  return out;
}

/** 类型守卫：过滤后 scope 收窄到旧 wire 联合（"5h" | "week"）。 */
function isLegacyWireWindow(w: WindowVerdict): w is WindowVerdict & { scope: QuotaWindowWire["scope"] } {
  return w.scope !== "month";
}

function projectWindow(w: WindowVerdict & { scope: QuotaWindowWire["scope"] }): QuotaWindowWire {
  const wire: QuotaWindowWire = { scope: w.scope, usedPct: w.usedPct, level: w.displayLevel ?? w.level };
  if (w.resetAt !== undefined) wire.resetAt = w.resetAt;
  if (w.etaMs !== undefined) wire.etaMs = w.etaMs;
  return wire;
}

/** 1Hz-tick gate: identical fingerprints ⇒ skip `publishStatus()` (see module docstring for the
 *  per-field rounding rationale). `undefined` wire ⇒ the empty-string sentinel, so "no quota data"
 *  and "quota data with every field blank" can never collide on the same fingerprint.
 *  P7wa（§9A.4）：每行追加 billing（overage/cents/gateOpen），顶层追加 problems——legacy wire
 *  上这些键都缺席，`JSON.stringify` 省略 undefined 值 ⇒ 旧指纹字符串逐字节不变（golden 钉死）。 */
export function quotaFingerprint(wire: QuotaWire | undefined): string {
  if (wire === undefined) return "";
  const body = JSON.stringify(
    wire.providers.map((p) => ({
      id: p.id,
      level: p.level,
      demotedUntil: p.demotedUntil,
      stale: p.stale,
      fetchedAt: p.fetchedAt, // a real refresh landing (verification #2) is worth a frame
      billing:
        p.billing === undefined
          ? undefined // omitted by JSON.stringify ⇒ legacy fingerprints keep their exact bytes
          : {
              overage: p.billing.overage,
              extraUsageBalanceCents: p.billing.extraUsageBalanceCents,
              gateOpen: p.billing.gateOpen,
            },
      windows: p.windows.map((w) => ({
        scope: w.scope,
        usedPct: Math.round(w.usedPct),
        resetAt: w.resetAt === undefined ? undefined : Math.floor(w.resetAt / 60_000),
        etaMs: w.etaMs === undefined ? undefined : Math.floor(w.etaMs / 60_000),
      })),
    })),
  );
  if (wire.problems === undefined || wire.problems.length === 0) return body;
  return `${body}|${JSON.stringify(wire.problems)}`;
}
