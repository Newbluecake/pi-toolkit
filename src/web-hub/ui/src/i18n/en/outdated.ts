/**
 * `outdated` i18n namespace（#65 outdated-reload，预览 outdated-reload-preview.html §1–§7）。
 * 散文文案在此；mono 版本号由组件拼接（`bannerPre` + pv + `bannerMid` + hv + `bannerSuffix`
 * 的语序在中英两种语言下都成立）。失败原因的人读文案优先用 wire message，本地合成失败
 * （离线/无控制面/超时）用 `errOffline`/`errUnsupported`/`errTimeout`/`errQueueTimeout`。
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
  parkedText: "Reload delivered — waiting for {n} sub-agent(s)/workflow(s) to settle before it fires.",
  cancelQueue: "Cancel queued reload",
  awaitingText: "Command delivered; waiting for the reload to take effect…",
  failedPre: "Reload failed: ",
  retry: "Retry",
  close: "Close",
  donePre: "Reloaded to ",
  errOffline: "the session process is gone — /reload cannot be delivered",
  errUnsupported: "this session has no web control plane",
  errTimeout: "command delivered, but the reload did not take effect in time",
  errQueueTimeout: "timed out waiting for the session to go idle",
  chipNeedsUpdate: "Update",
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
