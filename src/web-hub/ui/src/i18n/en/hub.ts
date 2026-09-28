/**
 * `hub` i18n namespace (control-plan.md v2.1 §6.6/§6.7, §7.7 — C5): the hub-state banner —
 * stopping / restarting (forced vs draining) / supersedePending countdown.
 */
const hub = {
  bannerAria: "Hub status",
  stopped: "Hub stopped from the terminal — run /webhub start to bring it back.",
  restarting: "Hub is upgrading to v{v}…",
  forcedUpgrade: "Waited over 30 minutes — forced upgrade.",
  draining: "Draining in-flight requests.",
  supersedePending: "Hub will upgrade to v{v} when idle (by {time} at the latest).",
  supersedeBlocked: "Upgrade to v{v} paused: a hub stop marker is present.",
  supersedeBlockedHint: "Runs immediately once /webhub start clears the marker.",
  supersedeDetail:
    "A newer pi-toolkit version is connected; the hub replaces itself with it once every agent is idle — nothing you are doing is interrupted.",
  expand: "Details",
  collapse: "Hide details",
} satisfies Record<string, string>;

export default hub;
