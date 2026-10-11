/**
 * `load` i18n 命名空间中文版(镜像 `en/load.ts`；紧凑行内标记如 `WARN`/`2m` 按 AGENTS.md 规定保持
 * 英文，由组件自行拼装，不进本命名空间)。
 *
 * 例外（2026-10 用户裁定，仅对本 pill 生效）：`segCpu`/`segMem`/`segDisk` 这三个 pill 分段标签
 * 本身就是要本地化的内容——中文显示「内存」「磁盘」，CPU 两种语言都不变；`@logic/load.js`的
 * `pillView` 仍在客户端拼出 `"{label} {pct}%"`，这里只提供 LABEL 那一半。
 */
const load = {
  title: "负载",
  pillAria: "主机负载：{segs}",
  segCpu: "CPU",
  segMem: "内存",
  segDisk: "磁盘",
  sectionCpu: "CPU & PSI",
  sectionMem: "内存",
  sectionLoadavg: "平均负载",
  sectionDisk: "磁盘",
  sectionTop: "Top 进程",
  cpuBusy: "CPU 占用",
  psiCpu: "PSI cpu",
  psiIo: "PSI io",
  memUsed: "内存占用",
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
  footerThresholds: "颜色分级阈值来自 hub 启动时的 load.* 设置，修改后需 /webhub restart",
  bannerPaused: "负载过高，已暂停派发新子 agent",
};

export default load;
