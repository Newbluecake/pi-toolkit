/**
 * `agents` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P3).
 */
import en from "../en/agents.js";

type Messages<T> = { [K in keyof T]: string };

const agents = {
  title: "会话",
  filterPlaceholder: "按路径或会话筛选…",
  filterAria: "筛选会话",
  staleOffline: "过期与离线",
  stopped: "已停止",
  costTitle: "本会话 {own} + 子 agent {sub}",
  emptyTitle: "没有已连接的 pi 会话",
  emptyBodyLead: "在此机器上启用",
  emptyBodyTail: "并启动 pi；会话会在一秒内出现在这里。",
  runningCount: "{n} 个运行中",
  noSessionName: "（无会话名称）",
  collapseSidebar: "收起侧边栏",
  expandSidebar: "展开侧边栏",
  densityCompact: "紧凑列表：仅显示目录、标题和别名（点击切换为详细）",
  densityDetailed: "详细列表：含费用、模型和上下文（点击切换为紧凑）",
  openDrawer: "显示会话列表",
  newSession: "新建会话",
  newSessionAria: "在选中会话的目录新建独立会话；无选中时选择目录新建",
  newSessionOk: "已开启新会话",
  remove: "删除",
  removeConfirm: "再次点击确认删除",
  removeAria: "从列表中删除这个会话（会话文件保留）",
  removeManagedAria: "停止并删除这个由网页启动的会话（会话文件保留）",
  removing: "removing\u2026",
  removeFailed: "删除失败：{reason}",
  "removeErr.online": "会话仍在线",
  "removeErr.unconfirmed": "无法确认进程已退出，已保留",
  "removeErr.managedLan": "网页托管的会话，局域网侧无权停止",
  "removeErr.rate": "操作太频繁，稍后再试",
  "removeErr.unsupported": "hub 版本不支持，请刷新页面",
  "removeErr.network": "网络错误",
  loadingTitle: "正在连接…",
  renameAria: "重命名此会话",
  renameInputAria: "新的会话名称",
  renameSaveAria: "保存名称",
  renameCancelAria: "取消重命名",
  renameFailed: "重命名失败：{reason}",
  // title-auto plan: 清空输入并保存 = 把标题交回自动生成（同 /title auto）
  renameAutoHint: "留空 = 自动生成标题",
  titleAutoFailed: "恢复自动标题失败：{reason}",
  "xs.wake": "跨会话：已加入，其他会话的消息可唤醒本会话",
  "xs.deliver": "跨会话：已加入，其他会话的消息只送达、不唤醒本会话",
  "xs.replies": "跨会话：已加入，只接收本会话所发请求的回复，拒收其他消息",
  xsUnread: "{n} 条跨会话来信未读（模型处理后自动清零）",
  xsChannels: "频道：{list}",
  channelFilterAria: "频道筛选",
  channelAll: "全部",
  channelsOpenTitle: "管理跨会话频道",
  channelsOpenLabel: "频道",
  // alias-plan r4 §7.2 (ALU)：详情头部 `@别名` 按钮的提示
  xsAliasManage: "别名 @{alias}——管理频道与别名",
  "xs.off": "跨会话：已加入，但当前拒收所有消息",
} satisfies Messages<typeof en>;

export default agents;
