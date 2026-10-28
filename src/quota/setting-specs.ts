/**
 * quota · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const QUOTA_SETTING_SPECS: Record<string, SettingSpec> = {
  // Quota-aware dispatch (quota-plan §8.5): all non-live — captured at
  // activate, change ⇒ /reload. baseUrl / userAgent stay JSON-file-only
  // (same treatment as bashJobs.dir / bashJobs.shellPath): they are escape
  // hatches, not knobs the editor should invite users to touch.
  "quota.enabled": bool("quota.enabled", "Quota-aware dispatch: ladder warnings + spawn gate + HUD"),
  "quota.providers": {
    kind: "string",
    path: "quota.providers",
    description: "Comma-separated quota providers (zai-coding-cn,zai,kimi-coding,droid); empty = none",
  },
  "quota.subscriptionProviders": {
    kind: "string",
    path: "quota.subscriptionProviders",
    description: "Comma-separated extra subscription providers without a quota API (e.g. copilot-anthropic)",
  },
  "quota.refreshS": seconds("quota.refreshMs", { min: 60, max: 86_400, description: "Quota snapshot TTL" }),
  "quota.refreshHotS": seconds("quota.refreshHotMs", { min: 1, max: 86_400, description: "Hot quota snapshot TTL" }),
  "quota.staleAfterS": seconds("quota.staleAfterMs", {
    min: 60,
    max: 604_800,
    hint: "older snapshots warn but never block a spawn",
    description: "Snapshot age after which the gate stops blocking",
  }),
  "quota.l1Percent": count(
    "quota.l1Percent",
    1,
    "L1 hint threshold (used %); applies to both windows unless overridden below",
  ),
  "quota.l2Percent": count(
    "quota.l2Percent",
    1,
    "L2 advise threshold (used %); applies to both windows unless overridden below",
  ),
  "quota.l3Percent": count(
    "quota.l3Percent",
    1,
    "L3 strong threshold (used %); applies to both windows unless overridden below",
  ),
  // Per-window overrides (quota-plan 「阶梯阈值按窗口区分」): repository defaults already differ
  // per window (5h 50/75/90, week 50/95/98); these six knobs let a user override one
  // scope without touching the other. Nested dotted paths already work through
  // getPath/setPath (same mechanism as `workflow.budget.*`) — the flat editor and
  // text `set` both index by the full string key, so no special UI plumbing is needed.
  "quota.windows.5h.l1Percent": count(
    "quota.windows.5h.l1Percent",
    1,
    "5h window L1 threshold override (used %); falls back to quota.l1Percent, then the 5h default (50)",
  ),
  "quota.windows.5h.l2Percent": count(
    "quota.windows.5h.l2Percent",
    1,
    "5h window L2 threshold override (used %); falls back to quota.l2Percent, then the 5h default (75)",
  ),
  "quota.windows.5h.l3Percent": count(
    "quota.windows.5h.l3Percent",
    1,
    "5h window L3 threshold override (used %); falls back to quota.l3Percent, then the 5h default (90)",
  ),
  "quota.windows.week.l1Percent": count(
    "quota.windows.week.l1Percent",
    1,
    "week (7d) window L1 threshold override (used %); falls back to quota.l1Percent, then the week default (50)",
  ),
  "quota.windows.week.l2Percent": count(
    "quota.windows.week.l2Percent",
    1,
    "week (7d) window L2 threshold override (used %); falls back to quota.l2Percent, then the week default (95)",
  ),
  "quota.windows.week.l3Percent": count(
    "quota.windows.week.l3Percent",
    1,
    "week (7d) window L3 threshold override (used %); falls back to quota.l3Percent, then the week default (98)",
  ),
  // month window (droid pools, external-agent quota-plan r2 D9/D16): same override
  // semantics as the week window; month defaults are 50/95/98.
  "quota.windows.month.l1Percent": count(
    "quota.windows.month.l1Percent",
    1,
    "month window L1 threshold override (used %); falls back to quota.l1Percent, then the month default (50)",
  ),
  "quota.windows.month.l2Percent": count(
    "quota.windows.month.l2Percent",
    1,
    "month window L2 threshold override (used %); falls back to quota.l2Percent, then the month default (95)",
  ),
  "quota.windows.month.l3Percent": count(
    "quota.windows.month.l3Percent",
    1,
    "month window L3 threshold override (used %); falls back to quota.l3Percent, then the month default (98)",
  ),
  "quota.droidAllowExtraUsage": bool(
    "quota.droidAllowExtraUsage",
    "Let droid spawns through when the standard pool is exhausted and Factory overage spends extra usage (real money)",
  ),
  "quota.l3EtaS": seconds("quota.l3EtaMs", { max: 86_400, description: "Predicted exhaustion horizon that forces L3" }),
  "quota.tickStepPercent": count("quota.tickStepPercent", 0, "Used-% grid between L1 ticks; 0 = level latch only"),
  "quota.l1MinTurns": count(
    "quota.l1MinTurns",
    0,
    "L1 turn cooldown: min turns since the last notice before a grid step re-announces; 0 = grid only",
  ),
  "quota.minIntervalS": seconds("quota.minIntervalMs", {
    max: 86_400,
    hint: "L3 bypasses this floor",
    description: "Global minimum interval between quota messages",
  }),
  "quota.repeatS": seconds("quota.repeatMs", { max: 86_400, description: "L3 re-announce period; L2 announces once" }),
  "quota.display": bool("quota.display", "Show the injected quota line in the transcript"),
  "quota.gate": bool("quota.gate", "Fail spawns fast when the target provider's quota is exhausted"),
  "quota.gateLevel": {
    kind: "number",
    path: "quota.gateLevel",
    min: 1,
    max: 3,
    integer: true,
    description: "Minimum ladder level that blocks a spawn (3 = exhausted only, 2 = aggressive)",
  },
  "quota.hud": bool("quota.hud", "Show the quota line in the status bar"),
  "quota.requestTimeoutS": seconds("quota.requestTimeoutMs", {
    min: 1,
    max: 60,
    description: "Quota HTTP request timeout",
  }),
};
