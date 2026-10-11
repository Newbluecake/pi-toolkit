/**
 * `load` i18n namespace (sysload plan docs/dev/sysload/plan.md §7.4): the top-bar host-load
 * pill/card (`LoadPill.vue`/`LoadCard.vue`) and the `FleetDrawer` crit/warn dispatch-paused
 * banner. Per AGENTS.md's UI-text split, compact inline markers (`WARN`, duration tokens like
 * `2m`) are assembled client-side in the components rather than looked up here — this namespace
 * carries what reads as prose (titles, section labels, aria text, the banner headline, footer
 * disclosure) PLUS, as of 2026-10, the pill's own segment LABELS (`segCpu`/`segMem`/`segDisk`):
 * an explicit user ruling overrides AGENTS.md's "compact markers stay English" convention for
 * just this one pill — zh says "内存"/"磁盘" instead of "MEM"/"DISK" (CPU is unchanged in both
 * languages). `@logic/load.js`'s `pillView` still assembles the final `"{label} {pct}%"` string
 * client-side; only the LABEL half is looked up here.
 */
const load = {
  title: "Host load",
  pillAria: "Host load: {segs}",
  // Pill segment labels (2026-10 i18n ruling — overrides AGENTS.md's usual "compact markers
  // stay English" convention for THIS pill only): zh localizes mem/disk ("内存"/"磁盘"); CPU
  // stays "CPU" in both languages. `@logic/load.js`'s `pillView` assembles `"{label} {pct}%"`
  // from these at call time — never hardcoded in the component.
  segCpu: "CPU",
  segMem: "MEM",
  segDisk: "DISK",
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
  footerThresholds:
    "Colour thresholds come from the load.* settings read at hub start; change them, then /webhub restart",
  // FleetDrawer crit/warn banner (visual mockup "新子 agent 派发已暂停（负载过高）" — tweak ③
  // keeps the duration annex on the SAME line, assembled by the component as "{LEVEL} ({ago})").
  bannerPaused: "New sub-agent dispatch paused (host load)",
};

export default load;
