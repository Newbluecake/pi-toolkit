/** Passive parent observation only; no timers, child writes or product decisions. */
import { performance } from "node:perf_hooks";
import { canonicalExternal, EXTERNAL_MARKER, unseenExternal } from "../../ci/external-probe-schema.mjs";
export function observeExternalChild(child, clock = () => performance.now()) {
  const start = clock();
  const elapsed = () => Math.min(30000, Math.max(0, Math.floor(clock() - start)));
  let exit = unseenExternal(),
    close = unseenExternal(),
    frozen;
  const seen = (code, signal) => ({
    state: "seen",
    ms: elapsed(),
    code: code === 0 ? "zero" : code === 75 ? "probe75" : code === null ? "unknown" : "other",
    signal:
      signal === null
        ? "none"
        : signal === "SIGKILL"
          ? "kill"
          : signal === "SIGTERM"
            ? "term"
            : signal === "SIGABRT"
              ? "abort"
              : "other",
  });
  const onExit = (code, signal) => {
    if (!frozen) exit = seen(code, signal);
  };
  child.once("exit", onExit);
  return {
    // Called INSIDE the original close callback, including its already-settled path.
    close(code, signal) {
      if (!frozen) close = seen(code, signal);
    },
    freeze(product, lastStage, reason, truncated) {
      if (!frozen) {
        child.removeListener("exit", onExit);
        frozen = Object.freeze({
          selection: "existing-zero-first",
          product,
          asOfMs: elapsed(),
          exit: Object.freeze(exit),
          close: Object.freeze(close),
          lastStage,
          reason,
          truncated,
        });
      }
      return frozen;
    },
  };
}
export function emitExternal(snapshot) {
  try {
    console.error(EXTERNAL_MARKER + canonicalExternal(snapshot));
  } catch {
    /* diagnostic missing, never change product outcome */
  }
}
