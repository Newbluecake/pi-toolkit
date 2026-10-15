/**
 * [date] 注入 — pi-free 核心（date 模块）。
 *
 * pi 的系统提示不含日期，模型在跨天长对话里不知道「今天」是哪天。本模块以
 * **消息**（而非系统提示）形式注入当前日期+时刻：首轮一次 + 跨日各一次 + 同日闲置
 * ≥3h 的 before_agent_start 重注入一次，内容形如
 * `[date] 2026-10-15 Thu 22:30 (Asia/Shanghai)`（紧凑英文标记；跨日那条追加一句
 * 极短中文说明 + 时刻语义）。不改系统提示 —— sysprompt-stable 的冻结快照保 prompt 缓存，
 * 注入走 before_agent_start 的 message / sendMessage 通道。
 *
 * 本文件只做纯逻辑：格式化、时区解析/回退、跨日判定、闲置重注入判定，时钟与时区
 * 均可注入（`createDateTimeSource({ now, timeZone })`），不 import pi。
 *
 * 时区标签：优先 `Intl.DateTimeFormat().resolvedOptions().timeZone` 的 IANA id；
 * 取不到（极端宿主）回退到宿主 UTC 偏移标签（`UTC+08:00`），此时日期/星期按
 * 宿主本地时区计算（与偏移语义一致）。
 */

export const DATE_CUSTOM_TYPE = "subagent:date";

/** 跨日那条附加的极短中文说明（仅跨日注入使用；首轮为裸标记）。 */
export const CROSS_DAY_NOTE = "当前日期已变更";

/** 时刻语义说明：HH:MM 是注入时刻的快照，非恒定「现在」。仅拼进跨日附注。 */
export const TIME_AS_OF_NOTE = "时间为注入时刻";

/**
 * 闲置重注入阈值（用户拍板）：before_agent_start 时距上次注入 ≥3h（墙钟）
 * 则同日也再注入一次当前日期+时刻。运行中（turn_end）不做闲置注入。
 * 常量放 core（无新设置项）。
 */
export const DATE_REINJECT_IDLE_MS = 3 * 60 * 60 * 1000;

export type TimeZoneLabel =
  { readonly kind: "iana"; readonly id: string } | { readonly kind: "offset"; readonly label: string };

export interface DateTimeSource {
  /** 解析后的时区标签（IANAN id 或 UTC 偏移回退）。 */
  readonly timeZone: TimeZoneLabel;
  /** 当地日历日键 `YYYY-MM-DD`（en-CA 数字格式）。 */
  dateKey(at: number): string;
  /** 英文短星期（`Thu`）。 */
  weekday(at: number): string;
  /** 完整注入标记：`[date] 2026-10-15 Thu 22:30 (Asia/Shanghai)`。 */
  marker(at: number): string;
}

export interface DateTimeSourceOpts {
  /** 可注入时钟（测试用）；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined;
  /** 可注入 IANA 时区（测试用）；非法值回落宿主解析，永不抛。 */
  readonly timeZone?: string | undefined;
}

/** 分钟偏移 → `UTC±HH:MM` 标签（纯函数：480 ⇒ `UTC+08:00`，-330 ⇒ `UTC-05:30`）。 */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/** 宿主时区解析：优先 IANA id；`Intl` 异常/缺失时回退宿主偏移标签。永不抛。 */
export function resolveTimeZone(): TimeZoneLabel {
  try {
    const id = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof id === "string" && id !== "") return { kind: "iana", id };
  } catch {
    /* fall through to offset fallback */
  }
  return { kind: "offset", label: formatUtcOffset(-new Date().getTimezoneOffset()) };
}

/** 跨日判定：`previous === undefined`（无基线）不算跨日 —— 那是「首轮」路径的事。 */
export function dateChanged(previous: string | undefined, current: string): boolean {
  return previous !== undefined && previous !== current;
}

/**
 * 闲置重注入判定：上次注入时刻未知（旧条目缺 `details.at` / 从未注入）⇒ 不触发
 * （恢复后首轮本来就会注入）；差值为负（时钟回拨）同样不触发。纯函数。
 */
export function idleReinjectDue(previousAt: number | undefined, at: number): boolean {
  return previousAt !== undefined && at - previousAt >= DATE_REINJECT_IDLE_MS;
}

/** 首轮注入内容：裸标记（无附注）。 */
export function firstTurnContent(marker: string): string {
  return marker;
}

/** 跨日注入内容：标记 + 极短中文说明 + 时刻语义（时间只是注入时快照）。 */
export function crossDayContent(marker: string): string {
  return `${marker} — ${CROSS_DAY_NOTE}，${TIME_AS_OF_NOTE}`;
}

export function createDateTimeSource(opts: DateTimeSourceOpts = {}): DateTimeSource {
  const zone: TimeZoneLabel = (() => {
    if (typeof opts.timeZone === "string" && opts.timeZone !== "") {
      try {
        // 构造即校验：非法 IANA id 让 DateTimeFormat 直接抛 RangeError。
        new Intl.DateTimeFormat("en-US", { timeZone: opts.timeZone, weekday: "short" }).format(0);
        return { kind: "iana", id: opts.timeZone };
      } catch {
        /* fall through to host resolution */
      }
    }
    return resolveTimeZone();
  })();
  // 偏移回退时不传 timeZone ⇒ 按宿主本地时区算日期/星期（与偏移语义一致）。
  const tzOption: { timeZone?: string } = zone.kind === "iana" ? { timeZone: zone.id } : {};
  const label = zone.kind === "iana" ? zone.id : zone.label;
  // en-CA 数字年月日天然输出 YYYY-MM-DD；en-GB + h23 输出 24h `HH:MM`（午夜 00:05，绝不 24:00）。
  const dateFmt = new Intl.DateTimeFormat("en-CA", { ...tzOption, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("en-US", { ...tzOption, weekday: "short" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    ...tzOption,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return {
    timeZone: zone,
    dateKey: (at: number) => dateFmt.format(at),
    weekday: (at: number) => dayFmt.format(at),
    marker: (at: number) => `[date] ${dateFmt.format(at)} ${dayFmt.format(at)} ${timeFmt.format(at)} (${label})`,
  };
}
