/**
 * `load` i18n namespace (sysload plan docs/dev/sysload/plan.md §7.4): the top-bar host-load
 * pill/card (`LoadPill.vue`/`LoadCard.vue`) and the `FleetDrawer` crit/warn dispatch-paused
 * banner. Per AGENTS.md's UI-text split, compact inline markers (`CPU 72%`, `WARN`, duration
 * tokens like `2m`) are assembled client-side in the components rather than looked up here —
 * this namespace carries only what actually reads as prose (titles, section labels, aria text,
 * the banner headline, footer disclosure).
 */
const load = {
  title: "Host load",
  pillAria: "Host load: {segs}",
  sectionCpu: "CPU & PSI",
  sectionMem: "Memory",
  sectionLoadavg: "Loadavg",
  sectionDisk: "Disk",
  sectionTop: "Top processes",
  cpuBusy: "CPU busy",
  psiCpu: "PSI cpu",
  psiIo: "PSI io",
  memUsed: "MEM used",
  memAvail: "available {pct}%",
  loadavgLabel: "1 / 5 / 15",
  cores: "{n} cores",
  diskHome: "$HOME",
  diskFree: "{gib} free",
  diskRemote: "remote filesystem — not sampled",
  diskUnresolved: "symlink not resolved yet",
  topByCpu: "by CPU",
  topByRss: "by RSS",
  topLoading: "Loading top processes…",
  topUnavailable: "Top-process snapshot unavailable",
  topRetry: "Retry",
  retryAfter: "retry in {n}s",
  updatedAgo: "updated {ago} ago",
  sinceDuration: "since {duration}",
  footerThresholds: "Thresholds from the hub's startup config",
  // FleetDrawer crit/warn banner (visual mockup "新子 agent 派发已暂停（负载过高）" — tweak ③
  // keeps the duration annex on the SAME line, assembled by the component as "{LEVEL} ({ago})").
  bannerPaused: "New sub-agent dispatch paused (host load)",
};

export default load;
