/** TEST ONLY: passive observer on the existing real spawn seam. It forwards all
 * arguments/return value unchanged, does not consume events/stdio or alter timers,
 * and annotates ONLY the target generic query-exit error with closed metadata. */
import { spawn } from "node:child_process";
import { DbClientError } from "../../../src/web-hub/hub/db-client.js";
export function observeDbExit(spawnFn: typeof spawn = spawn) {
  let exit: { childCode: number | null; childSignal: "SIGKILL" | "SIGTERM" | "SIGABRT" | "other" | null } | undefined;
  const observedSpawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawnFn(...args);
    child.on("exit", (code, signal) => {
      exit = {
        childCode: code !== null && Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
        childSignal:
          signal === null || signal === "SIGKILL" || signal === "SIGTERM" || signal === "SIGABRT" ? signal : "other",
      };
    });
    return child;
  }) as typeof spawn;
  return {
    spawnFn: observedSpawn,
    annotate(error: unknown, op: string): unknown {
      if (
        !(error instanceof DbClientError) ||
        error.code !== "E_DB" ||
        error.message !== "web-hub db: query subprocess exited"
      )
        return error;
      const operation = op === "markInitialLogin" ? op : "other";
      const diagnostic = {
        childCode: exit?.childCode ?? null,
        childSignal: exit?.childSignal ?? null,
        operation,
        lifecycle: exit ? "exited" : "not-observed",
      };
      const annotated = new DbClientError(
        error.code,
        `web-hub db: query subprocess exited (code=${diagnostic.childCode ?? "unknown"} signal=${diagnostic.childSignal ?? "none"} op=${operation} lifecycle=${diagnostic.lifecycle})`,
      );
      return Object.assign(annotated, { childExit: Object.freeze(diagnostic) });
    },
  };
}
