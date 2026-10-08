/**
 * `transcript` i18n namespace, Chinese (vue-plan.md v2.1 §3.2/§3.8/§5.2 — P4). `satisfies
 * Messages<typeof en>` makes a missing/extra key a `vue-tsc` compile error at authoring time
 * (`i18n-parity.test.ts` also checks it — and the `{param}` sets — at runtime).
 */
import en from "../en/transcript.js";

type Messages<T> = { [K in keyof T]: string };

const transcript = {
  ariaLabel: "对话",
  who: "pi",
  whoNotice: "通知",
  whoSubagent: "子代理",
  streaming: "生成中…",
  thinking: "思考 · {n} 行",
  imagePlaceholder: "[图片]",
  truncated: "已截断",
  truncatedTitle: "内容已截断",
  compacted: "上下文已压缩",
  branchSummary: "分支摘要",
  modelChange: "模型 → {model}",
  modelChangeUnknown: "未知模型",
  loadOlderMessages: "加载更早的消息",
  loadingOlder: "正在加载更早的消息…",
  loadingHistory: "正在加载历史…",
  historyError: "历史记录不可用：{error}",
  hiddenBefore: "已隐藏 {n} 条更早的消息 · 显示",
  hiddenAfter: "{n} 条新消息 · 跳到最新",
  plainText: "文本",
  copyCode: "复制代码",
  copyCopied: "已复制！",
  copySelected: "已选中 — 按复制",
  showAll: "展开全部",
  collapse: "收起",
  "tool.input": "输入",
  "tool.liveOutput": "实时输出",
  "tool.output": "输出",
  "tool.result": "结果",
  "tool.error": "错误",
  "tool.lines": "{n} 行",
  "tool.showFull": "显示完整输出",
  "tool.diffEdit": "编辑 {i}/{m}",
  "tool.diffFold": "… 已省略 {n} 行",
  "tool.diffExpand": "展开",
} satisfies Messages<typeof en>;

export default transcript;
