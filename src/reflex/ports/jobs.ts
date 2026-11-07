import { describeJobStatus, isTerminalJobStatus, previewCommand } from "../../bash/types.js";
import { formatDuration } from "../../core/format.js";
import { redactForJev } from "../../memory/jev/redact.js";
import type { ReflexPort, ReflexPortDeps } from "./index.js";

/** Only list(): no log reads, cursor advancement or notification acknowledgement. */
export function createJobsPort(deps: ReflexPortDeps): ReflexPort {
  return {
    id: "jobs.list",
    version: 1,
    run(env) {
      const manager = deps.bashJobs();
      if (!manager) return { kind: "unavailable", reason: "bash jobs unavailable" };
      const jobs = manager.list();
      const running = jobs.filter((j) => !isTerminalJobStatus(j.status));
      const unread = jobs.filter((j) => isTerminalJobStatus(j.status) && j.notifiedAt === undefined);
      const rows = [...running.slice(0, 8), ...unread.slice(0, 8)];
      return {
        kind: "ok",
        lines:
          jobs.length === 0
            ? []
            : [
                `bash jobs (${running.length} running, ${unread.length} finished unread):`,
                ...rows.map(
                  (j) =>
                    `  ${j.jobId} ${describeJobStatus(j)} ${formatDuration((j.endedAt ?? env.now) - (j.spawnedAt ?? j.createdAt))}  ${previewCommand(redactForJev(j.command, "command"), 80)}`,
                ),
              ],
        facts: { running: running.length, unread: unread.length, total: jobs.length },
        truncated: running.length > 8 || unread.length > 8,
      };
    },
  };
}
