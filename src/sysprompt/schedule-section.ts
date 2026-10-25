import { statSync } from "node:fs";
import { join } from "node:path";
import { SKIP } from "../prompt-sections/stable-section.js";
import { sessionDirName } from "../schedule/core/paths.js";
import { isApproved, SCHED_STATE_FILE, type ScheduleStateFile } from "../schedule/core/spec.js";
import { whenText } from "../schedule/agent/view.js";
import type { ScheduleAgent } from "../schedule/agent/wire.js";
import type { SectionRegistration } from "./hub.js";

/**
 * `pi_schedules` — the AI's passive awareness of this session's scheduled tasks (plan r3 §5.3).
 *
 * Definitions ONLY (id, name, time + tz, form, feishu, pending): next-run times and run state change
 * every minute and would churn the prompt cache, so they stay behind the `schedule` tool. Registered
 * session-scoped and last in the fold order; no tasks ⇒ "" (the fold skips empty sections, so a
 * session without tasks keeps byte-identical system prompt bytes).
 */
export const SCHEDULES_TITLE = "## Scheduled tasks (pi-subagent)";

export function renderSchedulesSection(state: ScheduleStateFile): string {
  if (state.tasks.length === 0) return "";
  const lines = state.tasks.map((t) =>
    [
      `- ${t.id} "${t.name}"`,
      whenText(t.when),
      t.form,
      ...(t.feishu ? ["feishu"] : []),
      ...(isApproved(t) ? [] : ["pending"]),
    ].join(" · "),
  );
  return [
    SCHEDULES_TITLE,
    "This session owns the scheduled tasks below (definitions only — use the `schedule` tool for status, runs and changes). " +
      "They run only while this session is open. Tasks you create or change stay `pending` until the user approves them.",
    ...lines,
  ].join("\n");
}

interface CacheEntry {
  key: string;
  text: string;
}

export function scheduleSection(deps: { agent: () => ScheduleAgent | undefined }): SectionRegistration {
  // Per-registration (per-activate) memo: keyed by sid + the ledger file's stat, so an unchanged
  // ledger costs one stat per turn and a changed one is re-read exactly once.
  let cache: CacheEntry | undefined;
  return {
    sessionScoped: true,
    title: SCHEDULES_TITLE,
    pointerHint: "Call the schedule tool with action=list for the current tasks.",
    provider: () => {
      const agent = deps.agent();
      if (agent === undefined) return SKIP;
      const kind = agent.mode.kind;
      if (kind === "secure" || kind === "child" || kind === "ephemeral" || agent.sessionId === undefined) return "";
      let key = `${agent.sessionId}|`;
      try {
        const st = statSync(join(agent.dir, sessionDirName(agent.sessionId), SCHED_STATE_FILE));
        key += `${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        key += "absent";
      }
      if (cache?.key === key) return cache.text;
      const read = agent.readState();
      if (read.kind === "degraded") return SKIP;
      const text = read.kind === "ok" ? renderSchedulesSection(read.state) : "";
      cache = { key, text };
      return text;
    },
  };
}
