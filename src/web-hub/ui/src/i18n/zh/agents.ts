/**
 * `agents` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P3).
 */
import en from "../en/agents.js";

type Messages<T> = { [K in keyof T]: string };

const agents = {
  title: "代理",
  filterPlaceholder: "按路径或会话筛选…",
  filterAria: "筛选代理",
  staleOffline: "过期与离线",
  stopped: "已停止",
  emptyTitle: "没有已连接的 pi 会话",
  emptyBodyLead: "在此机器上启用",
  emptyBodyTail: "并启动 pi；会话会在一秒内出现在这里。",
  runningCount: "{n} 个运行中",
  noSessionName: "（无会话名称）",
  collapseSidebar: "收起侧边栏",
  expandSidebar: "展开侧边栏",
  openDrawer: "显示代理列表",
  newSession: "新建会话",
  newSessionAria: "为当前选中的 agent 开启新会话（执行 /new）",
  newSessionOk: "已开启新会话",
} satisfies Messages<typeof en>;

export default agents;
