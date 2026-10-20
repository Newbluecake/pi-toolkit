/**
 * `cacheKeepalive` i18n namespace, Chinese (cache-keepalive-web plan §4.1/D10, P-B). See
 * `en/cacheKeepalive.ts`'s header for the token-vs-prose split rationale (the collapsed line,
 * `http 403` / `trips N` / `eligible now` / `proven-hit` / `keepalive off` markers stay English
 * in both languages, assembled client-side; everything here is real prose).
 */
import en from "../en/cacheKeepalive.js";

type Messages<T> = { [K in keyof T]: string };

const cacheKeepalive = {
  title: "缓存保活",
  toggleAria: "缓存保活详情",
  summaryAria: "缓存保活：{marker}",
  rowMode: "模式",
  modeAutoNote: "跟随 pi/供应商默认；`on` 固定写 1h，`off` 去除覆盖",
  rowEnabled: "保活",
  enabledOn: "已启用",
  enabledOff: "已关闭",
  rowLastPing: "最近一次 ping",
  lastPingNone: "尚无记录",
  lastPingAgo: "{age} 前",
  transientTag: "瞬态",
  permanentTag: "永久",
  lineTag: "线路级",
  rowWindow: "窗口",
  rowSession: "本会话累计",
  rowCacheRead: "缓存读取",
  rowCost: "缓存读费用",
  rowAvoided: "避免重写",
  rowLoadBearing: "承重窗口",
  rowUnnecessary: "非必要窗口",
  rowDiscarded: "已丢弃窗口",
  rowDisabled: "保活已停用",
  disabledSince: "自 {ago} 起",
  linesTitle: "线路熔断",
  linesNone: "暂无线路熔断记录",
  lineCurrent: "当前",
  lineLegacy: "旧版",
  lineHistory: "历史",
  lineRetryIn: "{dur} 后可重试",
  lineEligibleNow: "现已可重试",
  linesMore: "(+{n} 条未显示)",
} satisfies Messages<typeof en>;

export default cacheKeepalive;
