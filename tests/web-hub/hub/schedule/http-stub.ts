/**
 * Test stub standing in for the hub schedule coordinator on `createHttpFrontend`'s duck-typed
 * `deps.schedules` attach (schedule-http.test.ts). Mirrors exactly the structural surface
 * `hub/http.ts` consumes: `snapshot(sessionId?)` + optional `setSseSink` — plus `bump()` so the
 * test can push a changed payload through the registered sink.
 */
import type { SchedulesPayloadWire } from "../../../src/web-hub/protocol/schedule.js";

export interface SchedStub {
  snapshot(sessionId?: string): SchedulesPayloadWire;
  setSseSink(sink: { publish(p: SchedulesPayloadWire): void }): void;
  bump(): void;
}

const payload = (): SchedulesPayloadWire => ({
  sessions: [
    {
      sessionId: "sid-a",
      rev: 1,
      tasks: [
        {
          task: {
            id: "s_abcd2345",
            name: "daily",
            form: "background",
            when: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
            prompt: "hi",
            feishu: true,
            enabled: true,
            createdBy: "user",
            createdVia: "tui",
            createdAt: 1,
            ownerCwd: "/tmp",
          },
          defHash: "a".repeat(64),
          executable: true,
          pendingApproval: false,
          totals: { fired: 0, missed: 0, skipped: 0, manual: 0 },
        },
      ],
      runs: [],
    },
    {
      sessionId: "sid-b",
      rev: 1,
      tasks: [],
      runs: [],
    },
  ],
});

export const SCHEDULES_PAYLOAD_STUB_FOR_TESTS: SchedStub = (() => {
  let current = payload();
  let sink: { publish(p: SchedulesPayloadWire): void } | undefined;
  return {
    snapshot(sessionId?: string): SchedulesPayloadWire {
      if (sessionId === undefined) return current;
      return { sessions: current.sessions.filter((s) => s.sessionId === sessionId) };
    },
    setSseSink(s): void {
      sink = s;
    },
    bump(): void {
      const first = current.sessions[0]!;
      current = { sessions: [{ ...first, rev: first.rev + 1 }, ...current.sessions.slice(1)] };
      sink?.publish(current);
    },
  };
})();
