/** Shared A3 test fixtures: a REAL schedule agent over a temp store (no mocks of the ledger). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../../src/core/clock.js";
import { createScheduleAgent, type ScheduleAgent, type ScheduleAgentDeps } from "../../../src/schedule/agent/wire.js";
import type { OpsPorts } from "../../../src/schedule/agent/ops.js";
import type { XsHostCapabilityState } from "../../../src/fabric/xs/host-cap.js";
import { self, SID, utc } from "../core/fixtures.js";

export const T0 = utc("2026-01-01T00:00:30Z");

export interface A3Env {
  dir: string;
  fake: FakeClock;
  agent: ScheduleAgent;
  ports: OpsPorts;
  cap: { state: XsHostCapabilityState };
  changed: { n: number };
  sidRef: { id: string };
  cleanup(): void;
}

export function a3Env(
  over: Partial<ScheduleAgentDeps> = {},
  kind: "interactive" | "print" | "ephemeral" = "interactive",
): A3Env {
  const base = mkdtempSync(join(tmpdir(), "sched-a3-"));
  const dir = join(base, "schedules");
  const fake = new FakeClock(T0);
  const sidRef = { id: SID };
  const ctx = {
    mode: "tui",
    sessionManager: {
      getSessionId: () => sidRef.id,
      getSessionFile: () => "/home/u/.pi/sessions/x.jsonl",
      getEntries: () => [],
    },
  };
  const agent = createScheduleAgent({
    ctx: ctx as never,
    mode: { kind, arm: kind === "interactive" },
    sessionId: SID,
    self: self(),
    dir,
    plain: true,
    inVault: () => false,
    clock: fake,
    monotonic: () => fake.now(),
    warn: () => undefined,
    router: undefined,
    storeOpts: { lockTimeoutMs: 300 },
    ...over,
  });
  const cap = { state: "verified" as XsHostCapabilityState };
  const changed = { n: 0 };
  const realChanged = agent.changed.bind(agent);
  agent.changed = () => {
    changed.n++;
    realChanged();
  };
  const ports: OpsPorts = {
    agent,
    now: () => fake.now(),
    limits: { defaultTimeoutS: 1800, maxTimeoutS: 14_400 },
    agentTypes: {
      has: (n) => n === "general-purpose" || n === "reviewer",
      names: () => ["general-purpose", "reviewer"],
    },
    capability: () => cap.state,
    ownerCwd: () => base, // a real directory: the execution gate realpath()s the owner cwd
    defaultTz: () => "Asia/Shanghai",
  };
  return {
    dir,
    fake,
    agent,
    ports,
    cap,
    changed,
    sidRef,
    cleanup: () => {
      agent.dispose();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export const CRON = { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" } as const;
export const basicRaw = (over: Record<string, unknown> = {}) => ({
  name: "daily",
  when: CRON,
  prompt: "do the thing",
  ...over,
});
