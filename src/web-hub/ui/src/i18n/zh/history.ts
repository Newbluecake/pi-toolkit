/**
 * `history` 命名空间的中文副本（session-history plan §4.7 — P-ui）。键集与占位符由
 * `tests/web-hub/ui/i18n-parity.test.ts` 自动对齐 en/history.ts；`bestEffortNote` 的
 * 文案被 dialog 测试逐短语钉住（W5「pid 被新进程复用」/ W7「替换又换回」）。
 */
import type en from "../en/history.js";

const history = {
  // --- NewSessionMenu / AgentList EmptyState 入口 ---
  menuItem: "历史会话…",
  emptyStateItem: "历史会话",

  // --- SessionHistoryDialog 外壳 ---
  dialogAria: "历史会话",
  dialogTitle: "历史会话",
  searchLabel: "搜索会话",
  searchPlaceholder: "搜索标题、路径或 id",
  kindAll: "包含子代理",
  close: "关闭",
  loading: "正在加载会话…",
  loadMore: "加载更多",
  scanningMore: "继续扫描中…",
  indexedPartial: "已索引 {x} / {y} 个会话文件…",
  indexedIo: "部分文件读取失败，正在重试",
  emptyFiles: "hub 的会话目录下还没有会话文件。",
  noResults: "没有匹配此搜索的会话。",
  rowNoTitle: "（无标题）",
  blockedGone: "目录已不存在",
  blockedNoAccess: "目录不可访问",
  blockedNotDir: "路径已不是目录",
  blockedMoved: "目录已变为符号链接",
  blockedInvalid: "会话文件损坏",
  resume: "继续",
  forkAction: "复制为新会话",
  goto: "转到",
  overflowAria: "此会话的更多操作",
  retry: "重试",
  sessionErrorTitle: "无法打开此会话",

  // --- incompleteNotice 横幅（logic/sessionHistory.ts 的 key，固定顺序） ---
  noticeEnumRunning: "正在枚举会话目录（{done}/{total}），排序在枚举完成前为近似",
  noticeSkipped: "{n} 个会话文件读取失败，未包含在结果中；刷新列表后重试",
  noticeDirsSkipped: "{n} 个目录无法读取",
  noticeChanged: "{n} 个会话所在目录已被更改",
  noticeTruncated: "列表已达上限",
  noticeIncomplete: "列表可能不完整",
  livenessNote: "未完成进程扫描，占用检测可能不完整",

  // --- 列表错误（historyErrorKey） ---
  errBusy: "hub 忙碌，稍后重试",
  errRate: "请求过于频繁，稍后重试",
  errDeadline: "hub 未及时响应，请重试",
  errAuth: "登录已过期，请重新登录",
  errCursor: "hub 上的列表已变化，正在重新加载",
  errNetwork: "网络错误，请重试",

  // --- failed{kind:"session"} 原因（sessionErrKey） ---
  errSessionRef: "会话引用无效，请刷新列表",
  errModelWithSession: "恢复会话时不能指定模型",
  errSessionMissing: "会话文件已不存在，请刷新列表",
  errSessionMismatch: "会话文件与其 id 不再匹配，请刷新列表",
  errSessionInvalid: "会话文件无法读取或不匹配，请刷新列表",
  errSessionTooLarge: "会话文件过大，无法复制；请尝试原地打开",
  errMoved: "会话所在目录已更改，请刷新列表",
  errSessionChanged: "启动期间会话文件发生变化，请重试",
  errSessionUnsupported: "此 hub 不再提供历史会话，请刷新页面",

  // --- HistoryForkConfirm（六种文案，forkConfirmKey） ---
  forkTitle: "复制为新会话",
  forkRun: "复制并启动",
  forkOpenCard:
    "该会话正被一个网页会话打开。为避免两个进程同时写入同一会话文件，将复制一份新会话继续：原会话不受影响，此后两边的对话互不同步。",
  forkOpenManaged:
    "该会话正被此 hub 上一个受管 pi 进程打开。为避免两个进程同时写入同一会话文件，将复制一份新会话继续：原会话不受影响，此后两边的对话互不同步。",
  forkMaybeProc:
    "检测到一个未连接到 hub 的 pi 进程（pid {pid}），可能仍打开着此会话。为安全起见，将复制一份新会话继续；原会话不受影响。",
  forkSubagent: "这是子代理会话，总是以副本方式打开，原会话保持其子代理运行记录不变。",
  forkManual: "将复制一份此会话作为新会话继续；原会话不受影响，此后两边的对话互不同步。",
  forkUnverified:
    "无法确认此会话当前没有被其他 pi 进程打开（{gap}）。为避免两个进程同时写入，将复制一份新会话继续，原会话不受影响。",

  // --- ProofGap → forkUnverified 的 {gap} 文案（historyGapKey） ---
  gapKind: "无法判定这是主会话",
  gapUnconnectedPi: "有未连接到 hub 的 pi 进程 (pid {pid})",
  gapCardUnproven: "有尚未上报会话的 pi 进程 (pid {pid})",
  gapProcPartial: "进程扫描未完成",
  gapNewProcess: "检测期间有新的 pi/node 进程启动",

  // --- §14.1 残余窗口 W1–W7（常驻于弹窗最底部；文案被测试钉住） ---
  bestEffortNote:
    "占用检测为尽力而为：无法检测 root / 容器内 / 非 pi 启动器的进程（W3/W4），检测完成后才打开该会话的进程（W1/W2），刚退出的 pi 其 pid 被新进程复用的瞬间（W5）；hub 重启后的自动恢复不重新检测（W6）；启动期间会话文件被替换又换回无法察觉（W7）。双开只会使会话树分叉，不会丢失或损坏数据。",

  // --- SpawnRow 的 from 标记（PD15：隐藏重试） ---
  fromRetryHidden: "此会话来自历史记录，原样重试不可用；请从历史会话列表重新打开。",
} satisfies Record<keyof typeof en, string>;

export default history;
