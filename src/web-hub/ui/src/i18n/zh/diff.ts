/**
 * `diff` i18n namespace, Chinese (worktree-diff plan v3.1 §4.2/§4.3/§4.7, package D5).
 * `satisfies Messages<typeof en>` makes a missing/extra key a `vue-tsc` compile error at
 * authoring time (`i18n-parity.test.ts` also checks it — and the `{param}` sets — at runtime).
 * 紧凑内联标记（bin/conflict chip、old·/new· 侧栏头）按 AGENTS.md UI 文案规则在两个语言
 * 里都保持英文 token；其余提示、横幅、aria 文案为中文。
 */
import en from "../en/diff.js";

type Messages<T> = { [K in keyof T]: string };

const diff = {
  // ---- 行展开开关（§4.1）----
  toggleTitle: "查看变更文件",
  // ---- 文件列表（§4.2）----
  listLoading: "正在加载变更文件…",
  listEmpty: "没有可显示的变更。",
  listErrorTitle: "无法加载变更文件",
  footnote: "受保护条目不显示；子模块变化不在此列出。",
  refresh: "刷新",
  retry: "重试",
  truncatedNote: "清单已截断——实际变更多于已显示条目。",
  untrackedSkippedNote: "本清单跳过了未跟踪文件。",
  numstatPartialNote: "部分文件无法统计行数。",
  attrPartialNote: "部分文件的过滤器状态未知——这些条目不可查看。",
  chipBinary: "bin",
  chipConflict: "conflict",
  entryFiltered: "由 Git 过滤器管理（如 LFS）——不可查看",
  entryNewline: "文件名含回车/换行字符——无法请求 diff",
  entryLossy: "文件名含无法解码的字节——无法请求 diff",
  entryInvalid: "文件名含特殊字符——无法请求 diff",
  // ---- 对话框壳层（§4.3）----
  dialogLabel: "文件 diff",
  close: "关闭",
  copyPath: "复制 worktree 路径",
  viewLabel: "视图",
  viewSplit: "分屏",
  viewUnified: "单屏",
  oldSide: "旧 · {base}",
  newSide: "新 · 工作区",
  plaintextWarning: "当前为明文连接——你查看的 diff 可能被网络中的他人看到。",
  // ---- 对话框主体六态（§4.3）----
  bodyLoading: "正在加载 diff…",
  bodyBinary: "二进制文件——不渲染 diff。",
  bodyEmpty: "相对 HEAD 无内容差异。",
  bodyUnviewable: "此文件已无变更，或不可在此查看。",
  errorTitle: "无法加载 diff",
  // ---- 横幅（§4.3）----
  bannerUntracked: "未跟踪文件——内容按工作区原样读取。",
  bannerTruncated: "diff 已截断——未显示结尾部分。",
  bannerIncomplete: "patch 在 hunk 中途结束——结尾缺失。",
  bannerLineCap: "diff 达到渲染行数上限——未显示结尾部分。",
  bannerHunkCap: "diff 达到 hunk 数上限——未显示结尾部分。",
  bannerMalformed: "patch 从此处开始无法解析。",
  bannerStale: "加载该 diff 后工作区已发生变化。",
  bannerRenameOnly: "仅重命名（相似度 {pct}%）——无内容变化。",
  bannerModeOnly: "仅权限变化——无内容变化。",
  // ---- 行渲染（§3.4/§3.5/§3.7）----
  srDel: "删除",
  srAdd: "新增",
  noEol: "行尾无换行符",
  showMore: "显示更多（剩余 {n} 行）",
  metaNewFile: "新增文件",
  metaDeleted: "已删除",
  metaBinary: "二进制",
  metaMode: "{a} → {b}",
  // ---- 错误映射（§1.5，列表与对话框共用）----
  errNotRepo: "会话 cwd 不在 git 仓库内。",
  errNotWorktree: "不是本仓库已注册的 worktree。",
  errDenied: "无权访问该 worktree。",
  errUnborn: "仓库尚无提交（HEAD 未诞生）。",
  errSymlink: "未跟踪路径包含符号链接。",
  errGitUnavailable: "hub 所在主机上 git 不可用。",
  errGitTooOld: "git 版本过旧，不支持此功能。",
  errFilterConfig: "git 过滤器配置不安全——拒绝执行。",
  errStaleCtx: "加载期间工作区已变化——请重试。",
  errSession: "会话已变化——请重新加载面板。",
  errDeadline: "请求超时。",
  errRate: "请求过于频繁——稍后重试。",
  errBusy: "hub 忙——稍后重试。",
  errGeneric: "请求失败（{code}）",
} satisfies Messages<typeof en>;

export default diff;
