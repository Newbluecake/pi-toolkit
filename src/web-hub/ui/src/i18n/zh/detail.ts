/**
 * `detail` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P3).
 */
import en from "../en/detail.js";

type Messages<T> = { [K in keyof T]: string };

const detail = {
  selectAgentTitle: "选择一个会话",
  selectAgentBody: "在左侧选择一个会话，查看它的对话、工具调用与子代理。",
  notConnectedTitle: "该会话未连接",
  notConnectedBody: "它可能已退出，或链接已过期。",
  sessionDetailsAria: "会话详情",
  // 2026-10 「红框部分支持收起，点击标题展开」：标题行的展开/收起开关（aria-label，展开+收起
  // 合一描述，同 todoToggleAria 语法；状态由 aria-expanded 承载）。
  headToggleAria: "展开/收起会话信息",
  kvCwd: "cwd",
  kvSession: "会话",
  kvModel: "模型",
  kvProcess: "进程",
  copyCwd: "复制 cwd",
  copySession: "复制会话 ID",
  contextLabel: "上下文",
  contextAria: "已用上下文",
  costLabel: "花费",
  subCost: "子代理 {v}",
  waitingOnDialog: "正在等待终端中的对话框：",
  waitingMore: "（+{n} 更多）",
  staleBanner: "过期 — 无最近心跳，数据可能已过期。",
  offlineBanner: "离线 — pi 进程已退出，正在显示最后已知的记录。",
  loadingHistory: "正在加载历史记录…",
  dockLong: "· 请在终端中回复",
  latest: "最新",
  newCount: "{n} 条新消息",
  // worktree-web plan §5 (W4)：git worktree 面板。紧凑行内标记（摘要计数、行内 token、旗标
  // chip）按 AGENTS.md UI 文案规则在中英文下保持一致（英文 token），仅散文提示/aria 翻译。
  worktreesBranchDetached: "detached",
  worktreesCount: "worktrees {total}",
  worktreesDirty: "{n} dirty",
  worktreesAgent: "{n} agent",
  worktreesStale: "stale {n}m",
  worktreesClean: "clean",
  worktreesCurrent: "current",
  worktreesLastSample: "上次采样 {time}（agent 侧时钟）",
  worktreesToggleAria: "展开或收起 worktree 列表",
  worktreesCopyPath: "复制 worktree 路径",
  worktreesUnprobedCap: "未探测：超出探测上限",
  worktreesUnprobedTimeout: "未探测：探测超时",
  worktreesUnprobedError: "探测失败",
  worktreesDirtyCapped: "变更数为下限（status 输出被截断）",
  worktreesUntrackedSkipped: "未统计未跟踪文件",
  worktreesAbHint: "相对本地 remote-tracking 引用的 ahead/behind（网页不执行 fetch）",
  worktreesMore: "(+{n} more)",
  worktreesFlagMain: "main",
  worktreesFlagAgent: "agent",
  worktreesFlagLocked: "locked",
  worktreesFlagPrunable: "prunable",
  worktreesFlagBare: "bare",
  // bash-jobs-panel plan §3 包 B (D4)：后台 bash 任务面板。紧凑行内标记（摘要分段、状态/
  // exit/grace/字节/新鲜度 token）两种语言都只用英文 token（AGENTS.md UI 文本规则）——zh 保
  // 持逐字节一致；只有 aria 标签真正翻译。
  // 2026-10-25 用户要求「对齐语言」：抽屉 Bash 分组标题的计数段（运行中/已完成/失败/已归档）
  // 改为中文，与相邻的「已归档 {n}」折叠行一致；exit/grace 等状态 token 仍保持英文。
  bashJobsTitle: "Bash",
  bashJobsSummary: "后台 bash 任务：{running} 个进行中、{done} 个已完成、{failed} 个失败",
  bashJobsRunning: "运行中 {n}",
  bashJobsDone: "已完成 {n}",
  bashJobsFailed: "失败 {n}",
  bashJobsExit: "exit {n}",
  bashJobsGrace: "grace",
  bashJobsNoOutput: "no output yet",
  bashJobsSampling: "sampling…",
  bashJobsTailAge: "tail {n}s old",
  bashJobsUnavailable: "unavailable",
  bashJobsMore: "(+{n} more)",
  todoTitle: "任务 {total} · {done} 已完成 · {active} 进行中",
  todoToggleAria: "展开或收起任务列表",
  todoStatusPending: "待办",
  todoStatusInProgress: "进行中",
  todoStatusCompleted: "已完成",
  todoBlockedBy: "被 {ids} 阻塞",
  todoMore: "（+{n} 更多）",
  removedTitle: "会话已从列表删除",
  removedBody: "会话文件仍保留，可在终端用 pi 恢复。",
  loadingTitle: "正在连接…",
  loadingBody: "正在等待 hub 的首个快照。",
  // todo-archive plan v2.1 §2（包 B，D4/D5）：TodoPanel 折叠尾行。zh 按散文翻译（D4 拍板：web 走
  // i18n，不同于 TUI 折叠行的英文 token）。追加在文件末尾——其它包插在 `todoCompletedHidden`
  // 之前，永不动这里。
  todoCompletedHidden: "已完成 {n} 项",
  todoArchived: "已归档 {n} 项",
  // Web /clear 快捷按钮（2026-10 用户需求）：详情头部的「清空」——同一 pi 进程内新建会话，
  // 直接携带确认发送内置 /new（全程无任何确认弹窗）。追加在文件末尾——其它包插在
  // `todoCompletedHidden` 之前，永不动这里。
  clearAria: "清空",
  clearLabel: "清空",
  clearBusyLabel: "清空中…",
  clearTitle: "新会话（/clear）",
  clearFailed: "新会话启动失败（{code}）",
  bashJobsArchived: "已归档 {n}",
  // scheduled-reports W1（方案 r3 §5.6）：详情头部「定时」按钮，打开懒加载的 SchedulePanel
  //（hub cap sched.v1 + 卡片有 sessionId 才出现；否则零痕迹）。
  scheduleOpenTitle: "定时任务",
  scheduleOpenLabel: "定时",
  // issue #41（顶栏窄屏溢出）：接收折入按钮的「⋯」菜单——触发器与菜单的 aria-label。
  moreActions: "更多操作",
  // 2026-10-28: the cards' corner × moved here — ⋯ menu entry + in-bar ✓/✕ confirm pill.
  deleteSessionLabel: "删除会话",
  deleteSessionGroupAria: "确认删除会话",
  deleteSessionConfirmAria: "立即删除会话",
  // omitted-orphan 修复（2026-10-27）：fleet bash 分组——wire 行全部归档且 omitted>0 时，
  // 「(+N more)」改为此说明文案，放在归档折叠旁。
  bashJobsOlderOmitted: "另有 {n} 条更早的已结束任务未传到网页（无法查看或归档）",
  // 2026-10-28 用户需求：「(+N more)」变成可操作的归档按钮——把 wire 装不下的已完成任务一次性
  // 归档（id 集合由 agent 侧重算，一次批量提交）。
  bashJobsArchiveOmitted: "归档 {n} 条更早的已完成任务",
  // 2026-10-28: running rows pushed out of the wire by the 20-row cap / byte budget (not archivable).
  bashJobsRunningOverflow: "另有 {n} 条运行中的任务未显示",
} satisfies Messages<typeof en>;

export default detail;
