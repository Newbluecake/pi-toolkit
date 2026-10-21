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
  dateAriaLabel: "日期标记",
  dateWeekMon: "周一",
  dateWeekTue: "周二",
  dateWeekWed: "周三",
  dateWeekThu: "周四",
  dateWeekFri: "周五",
  dateWeekSat: "周六",
  dateWeekSun: "周日",
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
  "tool.viewRendered": "渲染",
  "tool.viewSource": "源码",
  "tool.viewToggleLabel": "Markdown 显示方式",
  // web-hub-mermaid 方案 §6.2（P2）：MermaidBlock 外观文案。错误行按 reason 在组件里选文案
  // （parse/render/timeout/output-invalid 共用 mermaidError + runtime 的 ≤160 字符 message；
  // unsupported 且 message 含 KaTeX 时选 mermaidMath）。
  mermaidShowSource: "源码",
  mermaidShowDiagram: "图",
  mermaidRendering: "渲染中…",
  mermaidError: "渲染失败：{message}",
  mermaidTooLarge: "图表过大，已显示源码",
  mermaidUnsupported: "暂不支持此图内容（图类型或配置），已显示源码",
  mermaidMath: "图中含数学公式（未支持），已显示源码",
  mermaidLoadFailed: "渲染引擎不可用，已显示源码",
  mermaidBusy: "渲染队列已满，已显示源码",
  mermaidAlt: "Mermaid {type} 图",
  mermaidFitWidth: "适应宽度",
  mermaidActualSize: "原尺寸",
  mermaidCopySelectFailed: "复制失败，请手动选择",
} satisfies Messages<typeof en>;

export default transcript;
