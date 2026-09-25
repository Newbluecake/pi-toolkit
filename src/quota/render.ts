/**
 * Quota copy templates (quota-plan §3.11 / §5.5): pure text builders for the
 * injected `[quota]` blocks and the HUD status line. Zero pi imports.
 *
 * UI text language split (AGENTS.md): compact inline markers (`5h`/`7d`,
 * `·stale Nm`, `⤓demoted(→HH:MM)`, `⚠`) are English tokens only; Chinese is
 * reserved for the prose blocks aimed at the model (L2/L3 paragraphs).
 * Alternative-model lists are supplied by the caller — this file only templates.
 *
 * M1（评审修订）：stale verdict 完全不进注入流（只进 HUD，HUD 行带 `·stale Nm`），
 * 所以 L3 文案里的「会被 spawn 拦下」承诺永远不会对着陈旧快照说出。
 */

import type { WindowScope } from "./types.js";
import type { Millis } from "../core/types.js";
import {
  DEFAULT_THRESHOLDS,
  isDemotionFloorOnly,
  type ProviderVerdict,
  type QuotaRecoveryEvent,
  type WindowVerdict,
} from "./ladder.js";

const MINUTE_MS = 60_000;

export function formatScope(scope: WindowScope): string {
  return scope === "week" ? "7d" : "5h";
}

/**
 * "02:11"（本地钟面时刻，与 now 同一天）或 "9/30 15:48"（跨天带日期——7d 窗口只报
 * HH:MM 会被读成「今天」）；`resetAt` 未知/非法 ⇒ "未知"。
 */
export function formatResetAt(resetAt: Millis | undefined, now: Millis): string {
  if (resetAt === undefined || !Number.isFinite(resetAt)) return "未知";
  const d = new Date(resetAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const n = Number.isFinite(now) ? new Date(now) : undefined;
  const sameDay =
    n !== undefined &&
    n.getFullYear() === d.getFullYear() &&
    n.getMonth() === d.getMonth() &&
    n.getDate() === d.getDate();
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function etaSpanText(etaMs: number): string {
  const totalMinutes = Math.round(etaMs / MINUTE_MS);
  if (totalMinutes < 1) return "不足 1 分钟";
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const rem = totalMinutes % 60;
  return rem > 0 ? `${hours} 小时 ${rem} 分钟` : `${hours} 小时`;
}

/** "约 24 分钟" / "约 1 小时 30 分钟"；无预测 ⇒ "未知"。 */
export function formatEta(etaMs: Millis | undefined): string {
  if (etaMs === undefined || !Number.isFinite(etaMs) || etaMs < 0) return "未知";
  return `约 ${etaSpanText(etaMs)}`;
}

function pctOf(pct: number): number {
  return Math.round(Math.min(100, Math.max(0, pct)));
}

/** 重置时刻已过（读数过期，等下一次拉取刷新）的紧凑英文标记（AGENTS.md UI split）。 */
function resetSuffix(w: WindowVerdict): string {
  return w.reason === "reset-elapsed" ? "·reset" : "";
}

function windowText(w: WindowVerdict): string {
  const mark = w.level >= 2 ? " ⚠" : "";
  return `${formatScope(w.scope)} ${pctOf(w.usedPct)}%${resetSuffix(w)}${mark}`;
}

function demotedSuffix(v: ProviderVerdict, now: Millis): string {
  if (!v.demoted) return "";
  // 降位记录自己的到期时刻优先（Kimi 周耗尽时 5h 的 resetAt 更早，拿它当解除时刻是错的）。
  if (v.demotedUntil !== undefined && Number.isFinite(v.demotedUntil)) {
    return ` ⤓demoted(→${formatResetAt(v.demotedUntil, now)})`;
  }
  const resets = v.windows.map((w) => w.resetAt).filter((r): r is Millis => r !== undefined && Number.isFinite(r));
  if (resets.length === 0) return " ⤓demoted";
  return ` ⤓demoted(→${formatResetAt(Math.min(...resets), now)})`;
}

/** 单 provider 的一行摘要（进 tick 块与 HUD）。空窗口为防御分支（适配器层不产出）。 */
export function renderProviderLine(v: ProviderVerdict, now: Millis): string {
  if (v.windows.length === 0) return `${v.provider}${demotedSuffix(v, now)}`;
  return `${v.provider} ${v.windows.map(windowText).join(" · ")}${demotedSuffix(v, now)}`;
}

/** L1 合并块（多个 provider 一个段落，` | ` 分隔）。 */
export function buildQuotaTickText(verdicts: readonly ProviderVerdict[], now: Millis): string {
  const rows = dedupeVerdicts(verdicts);
  if (rows.length === 0) return "";
  return `[quota] ${rows.map((v) => renderProviderLine(v, now)).join(" | ")}`;
}

/** 触发窗口：等级最高者（并列取 usedPct 更高者）。 */
function triggerWindow(v: ProviderVerdict): WindowVerdict | undefined {
  let best: WindowVerdict | undefined = undefined;
  for (const w of v.windows) {
    if (best === undefined || w.level > best.level || (w.level === best.level && w.usedPct > best.usedPct)) {
      best = w;
    }
  }
  return best;
}

/**
 * 阈值文案取 DEFAULT_THRESHOLDS（plan §5.5 模板按默认 50/75/90 书写；
 * ProviderVerdict 不携带运行时阈值——见偏差记录，仅在 reason==="pct" 时展示，
 * forecast 抬级时让速率子句自己解释原因）。
 */
function thresholdText(level: number): number {
  return level >= 3 ? DEFAULT_THRESHOLDS.l3 : level === 2 ? DEFAULT_THRESHOLDS.l2 : DEFAULT_THRESHOLDS.l1;
}

/**
 * 替代建议（L3 块与 spawn 闸门共用）。额度层只知道「谁还有额度」，不知道当前任务
 * 要什么能力——所以只给**候选**（订阅优先排序），由派单方结合任务需求取舍：候选
 * 胜任就优先用（订阅额度不用会作废），不胜任就按路由表另选，不硬凑。
 */
export interface AlternativeSelection {
  readonly providers: readonly string[];
  /** true when the selected pool is tier 0/1 subscription providers. */
  readonly subscription: boolean;
}

export type AlternativeInput = AlternativeSelection | readonly string[];

function normalizeAlternatives(input: AlternativeInput): AlternativeSelection {
  if (Array.isArray(input)) return { providers: input as readonly string[], subscription: true };
  return input as AlternativeSelection;
}

export function alternativesAdvice(input: AlternativeInput): string {
  const { providers, subscription } = normalizeAlternatives(input);
  if (providers.length === 0) return "暂无替代候选，按路由表另选合适模型（可检查 pi /model）。";
  const heading = subscription ? "替代候选（订阅优先）" : "无可用订阅；按量计费 provider";
  return `${heading}：${providers.join("、")}。\n按任务需求选：在这些 provider 下按任务需求选择合适模型；${subscription ? "订阅额度不用会作废；" : ""}不胜任就按路由表另选合适模型，不必硬凑。`;
}

/**
 * 禁用句 + 闸门承诺 + 替代候选。闸门承诺必须内嵌在点名的禁用句里：
 * 放在替代候选之后写「该 provider」时，最近的先行词是候选（如 zai），读起来像
 * 候选会被拦（2026-09 现场反馈）。
 */
function directUseText(provider: string, alternatives: AlternativeInput): string {
  return `本轮不要把新任务派给 ${provider}（${GATE_PROMISE}）。\n${alternativesAdvice(alternatives)}`;
}

/** 已耗尽的窗口没有「还剩多久耗尽」可言——ETA 子句只给未耗尽窗口。 */
function liveEtaMs(w: WindowVerdict): number | undefined {
  if (w.reason === "exhausted" || w.usedPct >= 100) return undefined;
  return w.etaMs !== undefined && Number.isFinite(w.etaMs) && w.etaMs >= 0 ? w.etaMs : undefined;
}

/** 紧凑读数串（英文 token）：`5h 0% · 7d 0%`。 */
function readingsText(v: ProviderVerdict): string {
  return v.windows.map((w) => `${formatScope(w.scope)} ${pctOf(w.usedPct)}%`).join(" · ");
}

/**
 * 等级只来自降位地板时的一句话（L2 预警块与 spawn 闸门文案共用）：仍在降位期、何时解除、
 * 最新读数与降位矛盾、已按降位处理。
 */
export function demotionFloorClause(v: ProviderVerdict, now: Millis): string {
  const until = v.demotedUntil === undefined ? "预计解除时间未知" : `预计 ${formatResetAt(v.demotedUntil, now)} 解除`;
  const readings = v.windows.length > 0 ? `最新读数（${readingsText(v)}）` : "最新读数";
  return `仍在降位期（此前额度告急触发降位，${until}），${readings}与降位矛盾，可能是上游返回的残缺数据，已按降位处理`;
}

const GATE_PROMISE = "继续派给它会在 spawn 阶段被快速失败拦下，不会消耗 run";

/**
 * L2 提示块（含 ETA / reset）。2026-09 口径修订：订阅额度窗口内不用就作废，L2 不再建议
 * 改派其它模型、不再降位——只告知走势，明确「照常优先用」，切换留给 L3。
 */
export function buildQuotaWarnText(
  v: ProviderVerdict,
  now: Millis,
  label: string = v.provider,
  alternatives: AlternativeInput = { providers: [], subscription: true },
): string {
  if (isDemotionFloorOnly(v)) {
    // 等级只来自降位地板：挑用量最高的窗口讲「已用 0% … 派单不变」是误导（2026-09-24 kimi
    // 现场：7d 实际仍耗尽）。如实说明降位状态；不承诺闸门行为（地板 L2 是否被拦取决于
    // quota.gateLevel，闸门拦下时用同一句 demotionFloorClause 解释）。
    return `[quota 预警] ${label} ${demotionFloorClause(v, now)}。\n新任务优先考虑其它订阅模型；若仍派给它，可能因额度耗尽失败。${alternativesAdvice(alternatives)}`;
  }
  const w = triggerWindow(v);
  let head: string;
  if (w === undefined) {
    // 防御分支：无窗口数据（适配器层不产出，仅类型层面可表达）。
    head = `[quota 预警] ${label}`;
  } else {
    head = `[quota 预警] ${label} ${formatScope(w.scope)} 已用 ${pctOf(w.usedPct)}%`;
    if (w.reason === "pct") head += `（阈值 ${thresholdText(w.level)}%）`;
    const etaMs = liveEtaMs(w);
    if (etaMs !== undefined) head += `，按当前速率${formatEta(etaMs)}后耗尽`;
    if (w.resetAt !== undefined) {
      if (etaMs !== undefined && now + etaMs < w.resetAt) {
        head += `，早于窗口重置（${formatResetAt(w.resetAt, now)}）`;
      } else {
        head += `（窗口 ${formatResetAt(w.resetAt, now)} 重置）`;
      }
    }
  }
  return `${head}。\n订阅额度照常优先使用，派单不变；到 L3（≥${DEFAULT_THRESHOLDS.l3}% 或即将耗尽）才会切换。`;
}

/** L3 强烈块（含本轮禁用 + 替代候选 + 按需取舍说明）。 */
export function buildQuotaBlockText(
  v: ProviderVerdict,
  alternatives: AlternativeInput,
  now: Millis,
  label: string = v.provider,
): string {
  const w = triggerWindow(v);
  let head: string;
  if (w === undefined) {
    // 防御分支：无窗口数据（适配器层不产出，仅类型层面可表达）。
    head = `[quota 严重] ${label}`;
  } else {
    head = `[quota 严重] ${label} ${formatScope(w.scope)} 已用 ${pctOf(w.usedPct)}%`;
    const etaMs = liveEtaMs(w); // 已耗尽窗口不报 ETA
    if (etaMs !== undefined) head += `，预计 ${etaSpanText(etaMs)}内耗尽`;
    if (w.resetAt !== undefined) head += `（窗口 ${formatResetAt(w.resetAt, now)} 重置）`;
  }
  return `${head}。\n${directUseText(label, alternatives)}`;
}

/**
 * 恢复播报块（额度恢复播报，一次性）：观测重置落地后由 hook 排空恢复事件时注入。
 * 与 L2/L3 同为面向模型的散文段（中文），紧凑读数仍是英文 token（`5h 0% · 7d 2%`）。
 * 闸门状态必须与 event.gateBlocked（镜像 evaluateQuotaGate 的判定，含降位当场重建）
 * 一致——另一窗口仍耗时绝不写「已放行」。
 */
export function buildQuotaRecoveryText(event: QuotaRecoveryEvent, now: Millis): string {
  const v = event.verdict;
  const readings = v.windows.length > 0 ? `，当前 ${readingsText(v)}` : "";
  const allReset = v.windows.length > 0 && v.windows.every((w) => event.resetScopes.has(w.scope));
  const resetPart = allReset ? "窗口已重置" : `${[...event.resetScopes].map(formatScope).join("、")} 窗口已重置`;
  const head = `[quota 恢复] ${v.provider} ${resetPart}${readings}`;
  if (!event.gateBlocked) return `${head}，spawn 闸门已放行，可恢复派单。`;
  // 闸门仍拦：如实写哪个窗口仍受限（未重置且 ≥ L2 者优先）；全重置但读数仍过
  // 闸门线（gateLevel 低 / 速率预测抬级）也照实说，绝不写「已放行」。
  const still = v.windows.filter((w) => !event.resetScopes.has(w.scope) && w.level >= 2);
  const stillText =
    still.length > 0
      ? still
          .map((w) =>
            w.reason === "exhausted" || w.usedPct >= 100
              ? `${formatScope(w.scope)} 仍耗尽${w.resetAt === undefined ? "" : `（${formatResetAt(w.resetAt, now)} 重置）`}`
              : `${formatScope(w.scope)} 仍 ${pctOf(w.usedPct)}% ⚠`,
          )
          .join("，")
      : `重置后读数仍触发闸门（等级 L${v.level}）`;
  return `${head}，${stillText}，spawn 闸门仍拦截，请继续避开 ${v.provider} 的新任务。`;
}

type QuotaSection = { readonly verdict: ProviderVerdict; readonly alternatives: AlternativeInput };

/**
 * 同池合并（L2/L3 注入块，与 HUD/tick 的 `dedupeVerdicts` 同一签名）：`zai-coding-cn`
 * 与 `zai` 同 key 同池时两段文案逐字相同，合并为一段，标签写成 `zai-coding-cn / zai`。
 * 等级也纳入分组键——同池但等级不同（闩锁/陈旧度差异）宁可分开说。替代链剔除组内
 * 全部成员（同池的另一个名字不是替代）。
 */
function groupSamePool(sections: readonly QuotaSection[]): { section: QuotaSection; label: string }[] {
  const groups = new Map<string, { section: QuotaSection; providers: string[] }>();
  for (const s of sections) {
    const key = `${s.verdict.level}#${poolSignature(s.verdict)}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { section: s, providers: [s.verdict.provider] });
    else g.providers.push(s.verdict.provider);
  }
  return [...groups.values()].map(({ section, providers }) => {
    const members = new Set(providers);
    const normalized = normalizeAlternatives(section.alternatives);
    const alternatives = {
      providers: normalized.providers.filter((a) => !members.has(a.split("/")[0] ?? a)),
      subscription: normalized.subscription,
    };
    return { section: { verdict: section.verdict, alternatives }, label: providers.join(" / ") };
  });
}

/** 一次 turn 的完整注入文本：至多一条，内部按各 provider 的等级分段拼装（L1 合并 tick 在前）。 */
export function buildQuotaMessage(sections: readonly QuotaSection[], now: Millis): string {
  const parts: string[] = [];
  const l1 = sections.filter((s) => s.verdict.level === 1);
  if (l1.length > 0)
    parts.push(
      buildQuotaTickText(
        l1.map((s) => s.verdict),
        now,
      ),
    );
  const grouped = groupSamePool(sections);
  for (const { section: s, label } of grouped) {
    if (s.verdict.level === 2) parts.push(buildQuotaWarnText(s.verdict, now, label, s.alternatives));
  }
  for (const { section: s, label } of grouped) {
    if (s.verdict.level === 3) parts.push(buildQuotaBlockText(s.verdict, s.alternatives, now, label));
  }
  return parts.join("\n");
}

function shortName(provider: string): string {
  return provider.split("-")[0] ?? provider;
}

function hudSegment(v: ProviderVerdict): string {
  if (v.windows.length === 0) return shortName(v.provider); // 防御分支（适配器层不产出）
  const cells = v.windows.map((w) => `${pctOf(w.usedPct)}%${resetSuffix(w)}`);
  return `${shortName(v.provider)} ${cells.join("/")}`;
}

/** The subset of pi's Theme this module needs (mirror of cache-ttl's CacheStatusTheme); structural so tests need no pi UI. */
export interface QuotaStatusTheme {
  fg(color: string, text: string): string;
}

/** Older pi builds (and non-TUI contexts) have no `ctx.ui.theme` — then the status stays plain text. */
export function readQuotaStatusTheme(ctx: unknown): QuotaStatusTheme | undefined {
  const theme = (ctx as { ui?: { theme?: unknown } } | undefined)?.ui?.theme;
  return typeof (theme as QuotaStatusTheme | undefined)?.fg === "function" ? (theme as QuotaStatusTheme) : undefined;
}

/**
 * 同池去重（评审 Minor 9）：`zai-coding-cn` 与 `zai` 常配同一把 key（同一账号同一
 * 配额池），两行数据实质相同——仅展示层折叠为首行；gate 仍按各自 provider id
 * 独立跟踪（verdicts 本身不动）。容差：usedPct 取整、resetAt 按分钟分桶，
 * 两次独立拉取间的微小漂移不会分成两行。
 */
function poolSignature(v: ProviderVerdict): string {
  return `${v.plan ?? ""}/${v.windows
    .map((w) => `${w.scope}:${Math.round(w.usedPct)}@${w.resetAt === undefined ? "?" : Math.floor(w.resetAt / 60_000)}`)
    .join("|")}`;
}

export function dedupeVerdicts(verdicts: readonly ProviderVerdict[]): readonly ProviderVerdict[] {
  const seen = new Set<string>();
  const out: ProviderVerdict[] = [];
  for (const v of verdicts) {
    const sig = poolSignature(v);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(v);
  }
  return out;
}

/** HUD 调色板（对齐 cache-ttl 的 TONE_COLOR 惯例：L0/L1 常态、L2 警告、L3 错误）。 */
function levelColor(level: number): string {
  return level >= 3 ? "error" : level === 2 ? "warning" : "text";
}

/** HUD 约定：dim 标签 + 彩色值（`input 32` 同款，见 keepalive-state.ts 的注释）。 */
function hudSegmentThemed(v: ProviderVerdict, theme: QuotaStatusTheme): string {
  if (v.windows.length === 0) return theme.fg("dim", shortName(v.provider)); // 防御分支
  const name = theme.fg("dim", shortName(v.provider));
  const value = v.windows.map((w) => `${pctOf(w.usedPct)}%${resetSuffix(w)}`).join("/");
  return `${name} ${theme.fg(levelColor(v.level), value)}`;
}

/**
 * HUD 一行（含陈旧标记）：`quota zai 62%/21% · kimi 8%/100%`。
 * 全部 provider 无快照（verdicts 为空）⇒ undefined（不占位）；
 * 任一快照年龄超过 refreshMs ⇒ 行尾追加 ` ·stale 12m`（取最老者）。
 */
export function renderQuotaStatus(
  verdicts: readonly ProviderVerdict[],
  now: Millis,
  refreshMs: Millis,
  theme?: QuotaStatusTheme | undefined,
): string | undefined {
  const rows = dedupeVerdicts(verdicts);
  if (rows.length === 0) return undefined;
  let maxAge = 0;
  for (const v of rows) maxAge = Math.max(maxAge, now - v.fetchedAt);
  const joiner = theme === undefined ? " · " : theme.fg("dim", " · ");
  const segments = rows.map((v) => (theme === undefined ? hudSegment(v) : hudSegmentThemed(v, theme)));
  let line = `${theme === undefined ? "quota" : theme.fg("dim", "quota")} ${segments.join(joiner)}`;
  if (maxAge > refreshMs) {
    const stale = ` ·stale ${Math.floor(maxAge / MINUTE_MS)}m`;
    line += theme === undefined ? stale : theme.fg("dim", stale);
  }
  return line;
}
