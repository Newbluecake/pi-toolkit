/**
 * `common` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P3). `satisfies
 * Messages<typeof en>` against the English namespace makes a missing/extra key a `vue-tsc`
 * compile error at authoring time (`i18n-parity.test.ts` also checks it at runtime, including
 * `{param}` sets).
 */
import en from "../en/common.js";

type Messages<T> = { [K in keyof T]: string };

const common = {
  back: "返回",
  backToAgents: "返回会话列表",
  copy: "复制",
  copied: "已复制",
  selectedPressCopy: "已选中 — 请按复制",
  readonly: "只读",
  needsAnswer: "待回答",
  "status.running": "运行中",
  "status.thinking": "思考中",
  "status.tool": "运行工具中",
  "status.idle": "空闲",
  "status.queued": "排队中",
  "status.done": "已完成",
  "status.failed": "失败",
  "status.timed_out": "超时",
  "status.waiting": "等待对话框",
  "status.stale": "过期 · 无最近心跳",
  "status.offline": "离线 · 进程已退出",
  "status.aborted": "已中止",
  "status.outdated": "插件旧于 hub，需 /reload",
} satisfies Messages<typeof en>;

export default common;
