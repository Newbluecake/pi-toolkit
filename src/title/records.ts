/**
 * 自有标题记录（`subagent:title` 会话条目）的落盘形状与读取——pi-free 纯函数
 * （仅 type-only import SessionEntry）。从 index.ts 抽出，供 pi 装配层与
 * `/title` 命令（command.ts）共用同一份所有权/额度口径。
 *
 * 形状（r1 #14）：`{v:1,name,at}`，name 非空字符串，at 数值。
 * - `at` 标为可选是向前兼容：窗口刷新（title.refreshWindowMinutes）落地前写入的
 *   记录没有时间戳，仍要能正常加载为「存在但无时间戳」的历史——窗口口径下这类
 *   记录不计入统计（见 readTitleRecords）。
 * - `reclaim`（可选，`/title auto` 回收所有权时写入）：该记录只证明「当前名字
 *   重新归自动生成所有」（参与 latestName 判定），**不是一次刷新**——不计入
 *   刷新额度（count / refreshTimestamps 都跳过）。缺失该字段的旧记录按
 *   `reclaim === false` 处理，老会话文件逐字节兼容。
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** 自有标题记录的 customType（会话级 appendEntry）。 */
export const TITLE_RECORD_CUSTOM_TYPE = "subagent:title";

export interface TitleRecordData {
  v: 1;
  name: string;
  at?: number;
  /** `/title auto` 的回收记录：只恢复所有权，不消耗刷新额度。 */
  reclaim?: boolean;
}

export function isValidTitleRecordData(data: unknown): data is TitleRecordData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || typeof d.name !== "string" || d.name.length === 0) return false;
  if (d.at !== undefined && typeof d.at !== "number") return false;
  if (d.reclaim !== undefined && typeof d.reclaim !== "boolean") return false;
  return true;
}

/**
 * 会话级（全部 fileEntries）扫描自有标题记录：最近一条有效记录的名字 + 有效
 * 「非回收」记录总数（legacy lifetime 口径，含首标）+ 「刷新」记录的时间戳数组
 * （升序，供 refreshWindowMinutes 的滚动窗口统计用）。
 *
 * 口径：
 * - 回收记录（`reclaim: true`）只参与 latestName（它把当前名字重新登记为自动
 *   生成所有），不进 count、不进 refreshTimestamps——回收不消耗刷新额度。
 * - 第一条有效「非回收」记录是首标，不计入 refreshTimestamps；没有 `at` 的旧
 *   格式记录同样不计入（窗口口径下视为无历史——不是 bug，是 r1 拍板的安全退
 *   化：宁可多刷新，不乱猜旧记录的时间）。
 * - 非法记录整体跳过。
 */
export function readTitleRecords(entries: readonly SessionEntry[]): {
  latestName?: string | undefined;
  count: number;
  refreshTimestamps: number[];
} {
  let latestName: string | undefined;
  let count = 0;
  const refreshTimestamps: number[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TITLE_RECORD_CUSTOM_TYPE) continue;
    if (!isValidTitleRecordData(entry.data)) continue;
    latestName = entry.data.name; // entries 是 chronological ascending，最后一次赋值即最新
    if (entry.data.reclaim === true) continue; // 回收记录：只恢复所有权，不占额度
    count++;
    if (count > 1 && typeof entry.data.at === "number") refreshTimestamps.push(entry.data.at);
  }
  return { latestName, count, refreshTimestamps };
}
