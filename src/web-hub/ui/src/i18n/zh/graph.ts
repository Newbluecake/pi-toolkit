/**
 * `graph` i18n namespace, Chinese (worktree-graph plan v2 §4.3, package P5).
 * `satisfies Messages<typeof en>` makes a missing/extra key a compile error at authoring time
 * (`i18n-parity.test.ts` re-checks key + `{param}` sets at runtime). 紧凑内联标记
 * （`graph · 200`、`+3`、`HEAD`、hash）按 AGENTS.md UI 文案规则在两个语言里都保持英文
 * token；其余状态、降级脚注、sr 拓扑描述、aria 文案为中文。
 */
import en from "../en/graph.js";

type Messages<T> = { [K in keyof T]: string };

const graph = {
  // ---- 分区头（§4.3）----
  toggleAria: "展开/收起提交图",
  headLabel: "git graph · 最近 {n} 条提交",
  footNote: "{n} commits · date-order · local refs, no fetch",
  footMore: "仅显示最近 {n} 条提交",
  // ---- 状态（§4.3 五态）----
  loading: "正在加载提交图…",
  empty: "暂无提交。",
  degradedTitle: "提交图已按降级数据加载",
  errorTitle: "无法加载提交图",
  retry: "重试",
  // ---- 按原因的错误文案（§4.3 错误态，`reason` 词表来自 P0）----
  errLogTimeout:
    "git log --date-order 超时——缺少 commit-graph 文件的大仓库会很慢。可在仓库中运行 `git commit-graph write` 后重试。",
  errMissingObject: "部分提交缺失（部分克隆？），无法为其绘制图形。",
  errGitTooOld: "仓库的 git 版本过旧，不支持此功能。",
  errGitFailed: "git 读取仓库时失败。",
  errNotWorktree: "不是此仓库已注册的 worktree。",
  errSessionChanged: "会话已变化——重新展开提交图即可重新加载。",
  errBusy: "hub 忙碌，请稍后重试。",
  errGeneric: "错误：{code}",
  // ---- 降级脚注（§2.5 词表，逐项一行）----
  degLogCapped: "日志输出超过字节上限——末尾可能缺失。",
  degBadRecords: "跳过了 {n} 条格式非法的记录。",
  degParentsTruncated: "{n} 条提交的父提交超过 8 个（父列表已截断）。",
  degRefsTruncated: "引用快照不完整（超过 {n} 个引用）。",
  degRefsSkipped: "跳过了 {n} 个引用（目标不是提交）。",
  degRefsOmitted: "为满足响应字节预算，丢弃了 {n} 个引用。",
  degTrimmed: "为满足响应字节预算，丢弃了 {n} 条提交。",
  degWtHeadsCapped: "worktree HEAD 超过 32 个——部分未显示。",
  degShallow: "浅克隆——历史止于克隆边界。",
  // ---- sr-only 拓扑描述（§4.3 读屏，每行一条）----
  srMerge: "合并提交，父提交 {parents}",
  srCurrent: "当前检出",
  srRing: "worktree HEAD：{label}",
  srFold: "位于折叠泳道",
  srOutOfSet: "父提交在列表之外",
  // ---- hash 复制（§4.3）----
  copyHash: "复制提交哈希 {hash}",
  copiedHash: "提交哈希已复制。",
  selectedHash: "已选中——请按复制键。",
  // ---- 表格标题（§4.3）----
  caption: "当前 worktree 的提交图，最新在前",
  // ---- 已合入分支（merged-plan r3 §7.3；徽章跟随界面语言是用户拍板②的显式豁免）----
  mergedShow: "显示已合入的 {n} 个分支",
  mergedHide: "隐藏已合入的 {n} 个分支",
  mergedBadge: "已合入",
  mergedBadgePart: "部分已合入 {k}/{t}",
  mergedTitle: "按补丁等价判定（git patch-id，忽略空白差异）：本分支独有的 {t} 个提交在 {head} 中都有补丁等价的提交",
  mergedTitlePart:
    "按补丁等价判定（git patch-id，忽略空白差异）：本分支独有的 {t} 个提交中有 {k} 个在 {head} 中有补丁等价的提交；解冲突或修改后的 cherry-pick 可能计为未合入",
  mergedTitlePartial: "（窗内逐提交标记不完整）",
  srLanded: "已合入 HEAD（补丁等价）",
  // 脚注等紧凑标记不豁免，两个语言都保持英文 token
  footMergedHidden: "{n} merged hidden",
  footMergedUnknown: "merged ? {m}",
  footFoldOff: "fold off",
} satisfies Messages<typeof en>;

export default graph;
