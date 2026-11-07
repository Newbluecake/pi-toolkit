/**
 * `outdated` i18n namespace（#65 outdated-reload，预览 outdated-reload-preview.html §1–§7）。
 * 散文文案在此；mono 版本号由组件拼接（`bannerPre` + pv + `bannerMid` + hv + `bannerSuffix`
 * 的语序在中英两种语言下都成立）。失败原因的人读文案优先用 wire message，本地合成失败
 * （离线/无控制面/超时/结果未知）统一经 `orFailReason`（#23 D9）映射到
 * `errOffline`/`errUnsupported`/`errTimeout`/`errQueueTimeout`/`errSendUnknown`。
 */
export default {
  bannerPre: "This session's plugin version",
  bannerMid: "is older than hub",
  bannerSuffix: ". Reload to apply (the session content is kept).",
  reload: "Reload",
  later: "Later",
  reloading: "Reloading…",
  queuedText: "A turn is running; the reload will fire automatically once the session goes idle.",
  queuedFleetText: "{n} sub-agent(s)/workflow(s) still running; the reload will fire automatically once they settle.",
  parkedIdle: "Reload delivered — waiting for the current turn to end and the session to go idle before it fires.",
  parkedText: "Reload delivered — waiting for {n} sub-agent(s)/workflow(s) to settle before it fires.",
  cancelQueue: "Cancel queued reload",
  awaitingText: "Command delivered; waiting for the reload to take effect…",
  failedPre: "Reload failed: ",
  retry: "Retry",
  close: "Close",
  donePre: "Reloaded to ",
  errOffline:
    "the session is offline (its process exited or is restarting); the reload did not finish — if it restarted, check or retry on the new card",
  errUnsupported: "this session has no web control plane",
  errTimeout: "command delivered, but the reload did not take effect in time",
  errQueueTimeout: "the 30-minute overall limit on the web side ran out; the queued reload was cancelled",
  errReloadLost:
    "the reload started, but the session never came back online (loading may have failed or the process exited); check the terminal hosting the session",
  errReloadNoUpgrade:
    "the session reloaded, but its plugin version still differs from the hub (the installed copy on disk may not be updated yet)",
  errReloadCancelled: "the reload was cancelled (on the session side, or superseded by another reload)",
  errReloadUnavailable: "the host running this session cannot reload",
  errReloadSettle: "the session did not go idle in time, so the reload could not start",
  errReloadIdleWait:
    "the session timed out waiting to go idle; the reload is still pending and will be cancelled at the overall limit",
  errReloadRefused: "the host refused the reload (the session is streaming or compacting)",
  errReloadFailed: "the reload failed",
  errSendUnknown:
    "command outcome unknown (the network response never completed); if the reload did take effect, it turns successful once the version lands",
  chipNeedsUpdate: "Update",
  chipTitle: "Plugin older than hub — click to reload (/agent reload)",
  chipQueued: "Queued",
  chipQueuedTitle: "Reload queued — fires once the session goes idle; click to cancel",
  chipFailed: "Update failed",
  chipFailedTitle: "{reason} — click to retry",
  resultPre: "Reload result: ",
  summaryPre: "",
  summaryMid: " sessions run a plugin version older than hub ",
  summarySuffix: ".",
  reloadAll: "Reload all",
  view: "View",
  rowQueued: "queued — reloads when idle…",
  rowParked: "delivered — waiting for {n} sub-agent(s)…",
  rowSending: "reloading…",
  rowAwaiting: "delivered, taking effect…",
  rowDone: "reloaded",
  rowFailedPre: "failed: ",
  summaryDonePre: "All ",
  summaryDoneMid: " sessions reloaded to ",
  summaryDoneSuffix: "",
} as const;
