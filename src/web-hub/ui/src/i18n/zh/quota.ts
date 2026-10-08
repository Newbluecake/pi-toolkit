/**
 * `quota` i18n namespace, Chinese (quota-web plan §3/D9). See `en/quota.ts`'s header for the
 * token-vs-prose split rationale (scope/provider tokens stay unlocalized, assembled by the
 * component; everything here is real prose/labels).
 */
import en from "../en/quota.js";

type Messages<T> = { [K in keyof T]: string };

const quota = {
  title: "订阅额度",
  pillAria: "订阅额度",
  toggleAria: "订阅额度详情",
  scope5h: "5h",
  scopeWeek: "周",
  resetSuffix: "{clock} 重置",
  pillAriaBase: "订阅额度：{provider} {scope} {pct}%",
  pillAriaReset: "订阅额度：{provider} {scope} {pct}%，{clock} 重置",
  "provider.zai-coding-cn": "GLM",
  "provider.zai": "GLM 国际",
  "provider.kimi-coding": "Kimi",
  planBadgeAria: "档位：{plan}",
  demotedBadge: "⤓ 已降位",
  demotedBadgeUntil: "⤓ 已降位 · {clock} 恢复",
  staleBadge: "数据陈旧",
  staleBadgeAge: "数据 {n} 分钟前",
  etaMinutes: "{n} 分钟",
  etaHours: "{h} 小时",
  etaHoursMinutes: "{h} 小时 {m} 分钟",
  etaWarn: "按当前速率约 {duration} 耗尽",
  footerSampledBy: "主会话采样",
  footerUpdatedAt: "更新于 {clock}",
  emptyNote: "暂无订阅额度数据",
} satisfies Messages<typeof en>;

export default quota;
