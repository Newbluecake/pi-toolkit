import { clampSpanMs } from "../../core/deadline.js";
import { WTDIFF_GIT_PATH } from "../../git/diff.js";
import { parsePorcelainV2Z } from "../core/git-status-parse.js";
import type { ReflexPort, ReflexPortDeps } from "./index.js";

// Mirrored rather than importing hub's VERSION_GIT_PREFIX (I8). Unlike that prefix,
// omit --no-lazy-fetch: it requires git >=2.45 and status does not lazily fetch.
export const REFLEX_GIT_ARGV = Object.freeze([
  "--no-replace-objects",
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "status",
  "--porcelain=v2",
  "--branch",
  "-z",
  "--untracked-files=normal",
]);

export function createGitPort(deps: ReflexPortDeps): ReflexPort {
  return {
    id: "git.status",
    version: 1,
    async run(env) {
      if (env.signal.aborted) return { kind: "error", reason: "aborted" };
      const timeoutMs = clampSpanMs(Math.min(env.budgetMs, 1200));
      if (timeoutMs === undefined) return { kind: "error", reason: "timeout" };
      const result = await deps.git(REFLEX_GIT_ARGV, {
        cwd: env.cwd,
        timeoutMs,
        maxStdoutBytes: 65536,
        envPolicy: "minimal",
        pathOverride: WTDIFF_GIT_PATH,
        signal: env.signal,
      });
      if (result.stdoutCapped || result.killed === "overflow") return { kind: "error", reason: "overflow" };
      if (result.killed === "timeout") return { kind: "error", reason: "timeout" };
      if (result.killed === "abort") return { kind: "error", reason: "aborted" };
      if (result.code === 128 || result.spawnError !== undefined)
        return { kind: "unavailable", reason: "git unavailable" };
      if (result.code !== 0) return { kind: "error", reason: "exit" };
      try {
        const status = parsePorcelainV2Z(result.stdout);
        const { branch, ahead, behind, staged, modified, untracked, unmerged } = status;
        const clean = staged + modified + untracked + unmerged === 0;
        return {
          kind: "ok",
          // Root-approved R2a deviation from arch §4.6: never hide branch/ahead/behind
          // behind emptyText, since the same port also answers "current branch" questions.
          lines: [
            `${branch === "(detached)" ? "HEAD (detached)" : branch} · upstream ${status.upstream ?? "none"} · ahead ${ahead}/behind ${behind}`,
            ...(clean
              ? ["working tree clean"]
              : [
                  `staged ${staged}/modified ${modified}/untracked ${untracked}/unmerged ${unmerged}`,
                  ...status.paths.slice(0, 15),
                ]),
          ],
          facts: { branch, ahead, behind, staged, modified, untracked, unmerged, clean },
          truncated: status.paths.length > 15,
        };
      } catch {
        return { kind: "error", reason: "parse" };
      }
    },
  };
}
