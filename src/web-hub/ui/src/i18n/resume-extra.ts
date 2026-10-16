/**
 * `resume` namespace's LAZY half (web-resume plan v2 §2.6, package P3) — every string only
 * the `ResumeDialog` chunk renders. Deliberately NOT under `en/`/`zh/`: `i18n/index.ts`'s
 * `import.meta.glob("./{en,zh}/*.ts", { eager: true })` would fold it into the first-screen
 * bundle, and the 255 KiB first-screen gate has no headroom for it (plan §4 P3's own target
 * keeps the DIALOG in a lazy chunk; the dictionary is dialog-only payload). The lazy chunk
 * calls `registerResumeExtra()` once on mount, which merges these keys into the SAME
 * `MESSAGES.<lang>.resume` namespace the 3 eager keys (`i18n/{en,zh}/resume.ts`) already
 * occupy — `useI18n`'s `t()` reads `MESSAGES` live at call time, so nothing else changes.
 *
 * Parity discipline is unchanged: zh `satisfies Record<keyof typeof en, string>` (compile
 * error on drift) + `tests/web-hub/ui/resume-logic.test.ts` pins the key/placeholder sets
 * of BOTH halves.
 */
import { MESSAGES } from "./index.js";

const en = {
  // --- shell ---
  dialogTitle: "Resume session",
  rowsAria: "Session list",
  searchLabel: "Search session titles",
  searchPlaceholder: "Search titles…",
  scopeAria: "Scope",
  scopeRecent: "48h",
  scopeAll: "All",
  close: "Close",
  // --- list body ---
  loading: "Scanning…",
  loadingMore: "Loading…",
  empty: "No sessions in this folder",
  noResults: "No matching sessions",
  loadMore: "Load more",
  partialNote: "List may be incomplete (scan budget hit)",
  truncatedNote: "Showing the first {n} sessions",
  ambiguousNote: "{n} sessions with duplicate IDs omitted",
  listFailed: "Failed to load ({code})",
  retry: "Retry",
  // --- D4 busy ---
  busyBanner: "Agent is replying — switch after it finishes",
  // --- rows ---
  currentBadge: "Current",
  forkBadge: "⑂",
  liveBadge: "Open in another window",
  liveHint: "This session looks in use elsewhere — click again to switch anyway",
  noTitle: "Untitled",
  // --- D5 (§7 D5-a) ---
  confirmTitle: "Switch to this session?",
  confirmBody: "Its file changed or was written recently — it may be open elsewhere. Switch anyway?",
  confirmOk: "Switch",
  confirmCancel: "Cancel",
  d5Footer:
    "pi does not lock session files; a session left open idle in a terminal not connected to the web cannot be detected here.",
  // --- pick outcomes ---
  picking: "Switching…",
  switchedElsewhere: "Switched to a different session",
  unconfirmedTimeout: "Switch unconfirmed — check the terminal",
  pickFailed: "Switch failed ({code})",
  staleList: "Session list was stale — reloaded",
} satisfies Record<string, string>;

const zh: Record<keyof typeof en, string> = {
  // --- 外壳 ---
  dialogTitle: "恢复会话",
  rowsAria: "会话列表",
  searchLabel: "搜索会话标题",
  searchPlaceholder: "搜索标题…",
  scopeAria: "范围",
  scopeRecent: "48h",
  scopeAll: "全部",
  close: "关闭",
  // --- 列表主体 ---
  loading: "正在扫描…",
  loadingMore: "加载中…",
  empty: "当前目录暂无会话",
  noResults: "没有匹配的会话",
  loadMore: "加载更多",
  partialNote: "列表可能不完整（扫描有上限）",
  truncatedNote: "仅显示前 {n} 个会话",
  ambiguousNote: "{n} 个 ID 重复的会话已省略",
  listFailed: "加载失败（{code}）",
  retry: "重试",
  // --- D4 忙 ---
  busyBanner: "Agent 正在回复，结束后再切换",
  // --- 行 ---
  currentBadge: "当前",
  forkBadge: "⑂",
  liveBadge: "已在其他窗口打开",
  liveHint: "该会话似乎正在其他窗口使用，再点一次确认切换",
  noTitle: "无标题",
  // --- D5（§7 D5-a）---
  confirmTitle: "切换到该会话？",
  confirmBody: "该会话文件最近被写入或有变化，可能正被其他窗口使用。仍要切换吗？",
  confirmOk: "切换",
  confirmCancel: "取消",
  d5Footer: "pi 不锁会话文件；若该会话正在一个未接入 web 的终端里空闲打开，这里无法发现。",
  // --- 选择结果 ---
  picking: "正在切换…",
  switchedElsewhere: "已切换到其他会话",
  unconfirmedTimeout: "未确认切换，请查看终端",
  pickFailed: "切换失败（{code}）",
  staleList: "会话列表已过期，已重新加载",
};

/** Both halves, for the parity test. */
export const RESUME_EXTRA: Readonly<Record<"en" | "zh", Readonly<Record<string, string>>>> = { en, zh };

let registered = false;

/**
 * Merge the lazy keys into `MESSAGES.<lang>.resume` (idempotent, one-shot per process — the
 * eager 3 keys always win conflicts, so a re-registration can never change shipped copy).
 * Called from `createResume()`; nothing here can throw (Object.assign on a plain record).
 */
export function registerResumeExtra(): void {
  if (registered) return;
  registered = true;
  for (const lang of ["en", "zh"] as const) {
    const extra = RESUME_EXTRA[lang];
    const dict = MESSAGES[lang]["resume"];
    if (dict === undefined) MESSAGES[lang]["resume"] = { ...extra };
    else for (const [k, v] of Object.entries(extra)) if (!(k in dict)) dict[k] = v;
  }
}
