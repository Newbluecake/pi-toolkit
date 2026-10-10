/**
 * `load` i18n 命名空间中文版(镜像 `en/load.ts`;紧凑行内标记如 `CPU 72%`/`WARN`/`2m` 按
 * AGENTS.md 规定保持英文,由组件自行拼装,不进本命名空间)。
 */
const load = {
  title: "负载",
  pillAria: "主机负载：{segs}",
  sectionCpu: "CPU & PSI",
  sectionMem: "内存",
  sectionLoadavg: "Loadavg",
  sectionDisk: "磁盘",
  sectionTop: "Top 进程",
  cpuBusy: "CPU busy",
  psiCpu: "PSI cpu",
  psiIo: "PSI io",
  memUsed: "MEM used",
  memAvail: "可用 {pct}%",
  loadavgLabel: "1 / 5 / 15",
  cores: "{n} 核",
  diskHome: "$HOME",
  diskFree: "剩余 {gib}",
  diskRemote: "远程文件系统 — 未采样",
  diskUnresolved: "符号链接尚未解析",
  topByCpu: "按 CPU",
  topByRss: "按 RSS",
  topLoading: "正在加载 top 进程…",
  topUnavailable: "top 快照不可用",
  topRetry: "重试",
  retryAfter: "{n} 秒后重试",
  updatedAgo: "{ago} 前更新",
  sinceDuration: "已持续 {duration}",
  footerThresholds: "阈值取自 hub 启动配置",
  bannerPaused: "负载过高，已暂停派发新子 agent",
};

export default load;
