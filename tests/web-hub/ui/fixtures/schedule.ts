/**
 * Mock `SchedulesPayloadWire` fixtures for the W1 UI tests (scheduled-reports plan r3 §5.6).
 * Typed against the S0-frozen `src/web-hub/protocol/schedule.ts` projection types — the real
 * hub producer is H1; until then these are the ONLY source of truth the UI is tested against.
 * Mock data lives in tests/, never in the production bundle.
 */
import type {
  ScheduleRunProjectionWire,
  ScheduleSessionProjectionWire,
  ScheduleTaskDef,
  ScheduleTaskProjectionWire,
  SchedulesPayloadWire,
} from "../../../src/web-hub/protocol/schedule.js";

export const SCHED_SID = "01a0d892-5c1e-7a40-9e2b-4f6d0c8a1b37";
export const SCHED_SID_OFFLINE = "01b1e903-6d2f-8b51-af3c-5a7e1d9b2c48";

const HASH_A = "fd9fcbba309bbae09b0d3c6d69258712ce12370868bc09012b3649c28daa08e9";
const HASH_B = "1b4611e2ff4f7bc06a36a751b84306214878c05506d49e70aec1d8394ec06655";
const HASH_C = "903e09819b62a8a998043f26eb9ddc52b736e783a207b767c6a1da07c9051c32";

const T0 = 1_761_350_400_000; // fixed base instant for deterministic snapshots

export function makeTaskDef(over: Partial<ScheduleTaskDef> = {}): ScheduleTaskDef {
  return {
    id: "s_abcd2345",
    name: "每日晨报",
    form: "background",
    when: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
    prompt: "汇总今天的 git 提交与 CI 状态，生成晨报。<script>alert(1)</script> 应原样显示。",
    feishu: true,
    bg: {
      type: "general-purpose",
      model: { provider: "cr-anthropic", id: "claude-sonnet-4-5" },
      thinking: "low",
      timeoutS: 1800,
      consultMain: false,
      handoff: false,
    },
    enabled: true,
    createdBy: "user",
    createdVia: "tui",
    createdAt: T0 - 7 * 86_400_000,
    ownerCwd: "/home/bluecake/ai/pi-toolkit",
    ...over,
  };
}

export function makeTask(
  over: Partial<ScheduleTaskProjectionWire> & { task?: Partial<ScheduleTaskDef> } = {},
): ScheduleTaskProjectionWire {
  const { task: taskOver, ...rest } = over;
  const task = makeTaskDef(taskOver);
  return {
    task,
    defHash: HASH_A,
    executable: true,
    pendingApproval: false,
    nextAt: T0 + 12 * 3_600_000,
    totals: { fired: 12, missed: 0, skipped: 1, manual: 2 },
    ...rest,
  };
}

/** The AI-created pending-approval task (message form). */
export function makePendingTask(): ScheduleTaskProjectionWire {
  return makeTask({
    task: {
      id: "s_efgh6789",
      name: "周五归档提醒",
      form: "message",
      when: { kind: "cron", expr: "30 17 * * 5", tz: "Asia/Shanghai" },
      prompt: "提醒我检查本周的归档目录，把超过 30 天未动的文件列出来。",
      feishu: false,
      bg: undefined,
      createdBy: "agent",
      createdVia: "tool",
    },
    defHash: HASH_B,
    executable: false,
    pendingApproval: true,
    nextAt: T0 + 3 * 86_400_000,
    totals: { fired: 0, missed: 0, skipped: 0, manual: 0 },
  });
}

export function makeRun(over: Partial<ScheduleRunProjectionWire> = {}): ScheduleRunProjectionWire {
  return {
    runKey: `s_abcd2345@${T0}`,
    taskId: "s_abcd2345",
    kind: "auto",
    form: "background",
    scheduledAt: T0,
    state: "completed",
    startedAt: T0 + 2_000,
    endedAt: T0 + 136_000,
    reportFile: `reports/${HASH_C}.md`,
    feishu: "sent",
    ...over,
  };
}

export function makeSession(over: Partial<ScheduleSessionProjectionWire> = {}): ScheduleSessionProjectionWire {
  return {
    sessionId: SCHED_SID,
    rev: 7,
    tasks: [makeTask(), makePendingTask()],
    runs: [
      makeRun({
        runKey: `s_abcd2345@${T0 + 86_400_000}`,
        state: "running",
        endedAt: undefined,
        reportFile: undefined,
        feishu: "none",
      }),
      makeRun(),
      makeRun({
        runKey: `s_efgh6789@m-20f1cd92`,
        taskId: "s_efgh6789",
        kind: "manual",
        form: "message",
        state: "timed_out",
        reason: "run-max",
        feishu: "n/a",
        reportFile: undefined,
      }),
    ],
    ...over,
  };
}

export function makePayload(sessions: ScheduleSessionProjectionWire[] = [makeSession()]): SchedulesPayloadWire {
  return { sessions };
}
