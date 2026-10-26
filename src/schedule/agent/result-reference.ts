/** Model-facing result references only; ledger reportFile values always stay relative. */
import { join } from "node:path";
import { SCHED_REPORT_FILE_RE } from "../core/spec.js";
import type { SessionStore } from "../core/writer.js";

/** Centralized for the forthcoming result-tool rename. */
export const SCHEDULE_RESULT_TOOL = "get_subagent_result";
export type ReportLocation = Pick<SessionStore, "root" | "dirName">;

export function absoluteReportPath(
  location: ReportLocation | undefined,
  reportFile: string | undefined,
): string | undefined {
  if (location === undefined || reportFile === undefined || !SCHED_REPORT_FILE_RE.test(reportFile)) return undefined;
  return join(location.root.real, location.dirName, reportFile);
}
