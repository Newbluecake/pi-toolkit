/**
 * web-hub archive plan — the TUI fleet widget hides archived runs and archived bash rows
 * (display only; no other surface reads the view). Absent `archived` getter ⇒ identical
 * rendering to the pre-feature widget.
 */
import { describe, expect, it } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { FakeClock } from "../../src/core/clock.js";
import type { JobRecord } from "../../src/bash/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import { FleetWidgetController } from "../../src/ui/fleet-widget.js";
import type { RunSnapshot } from "../../src/core/types.js";

function query(runs: RunSnapshot[]): QueryService {
  return {
    get: () => undefined,
    list: () => runs,
    wait: async () => ({ ok: false as const, reason: "unknown_run" as const }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => ({ ok: false as const, reason: "not_running" as const }),
    stop: async () => ({ ok: false as const, reason: "stop_failed" as const, escalatedTo: "L4" as const }),
  } as unknown as QueryService;
}

function snap(runId: string, status: string, label: string): RunSnapshot {
  return {
    runId,
    generation: 1,
    status,
    phase: status === "running" ? "model_turn" : "settled",
    deadlines: {},
    diag: {
      createdAt: 0,
      phase: status === "running" ? "model_turn" : "settled",
      phaseEnteredAt: 0,
      escalation: [],
      label,
    },
    updatedAt: 5000,
  } as unknown as RunSnapshot;
}

const job = (jobId: string, status: JobRecord["status"]): JobRecord =>
  ({
    v: 1,
    jobId,
    command: `echo ${jobId}`,
    cwd: "/tmp",
    sessionId: "s",
    hostPid: 1,
    status,
    createdAt: 0,
    spawnedAt: 0,
    backgroundedAt: 1,
    exitCode: status === "exited" ? 0 : null,
    logPath: "/tmp/x.log",
    logBytes: 4,
    outputTruncated: false,
    readCursor: 0,
  }) as JobRecord;

function ui() {
  type WidgetFactory = (tui: { requestRender: () => void }, theme: unknown) => Component;
  let mounted: Component | undefined;
  const tui = { requestRender: () => {} };
  return {
    setWidget: (_key: string, content: string[] | WidgetFactory | undefined) => {
      if (content === undefined) mounted = undefined;
      else if (typeof content === "function") mounted = content(tui, {});
    },
    renderedLines: (): string[] | undefined => mounted?.render(200),
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("fleet widget archive filter", () => {
  it("hides archived runs and bash rows while keeping live ones", async () => {
    const clock = new FakeClock(10_000);
    const host = ui();
    const runs = [snap("run-live-1111", "running", "live-run"), snap("run-done-2222", "completed", "done-run")];
    const jobs = [job("b_LIVE0001", "running"), job("b_DONE0002", "exited")];
    const widget = new FleetWidgetController({
      ui: host,
      query: query(runs),
      clock,
      bashJobs: () => jobs,
      readBashTail: () => Promise.resolve(undefined),
      archived: () => ({ runs: new Set(["run-done-2222"]), bash: new Set(["b_DONE0002"]) }),
    });
    await flush();
    const text = (host.renderedLines() ?? []).join("\n");
    expect(text).toContain("live-run");
    expect(text).toContain("b_LIVE0001");
    expect(text).not.toContain("done-run");
    expect(text).not.toContain("b_DONE0002");
    widget.dispose();
  });

  it("renders archived rows again once the view clears (undo)", async () => {
    const clock = new FakeClock(10_000);
    const host = ui();
    // updatedAt === now: the completed row is inside its 5s linger window, so the ONLY thing
    // that can hide it is the archive filter — and clearing the filter brings it straight back.
    const runs = [snap("run-done-2222", "completed", "done-run")];
    (runs[0] as unknown as { updatedAt: number }).updatedAt = 10_000;
    let archived: { runs: ReadonlySet<string>; bash: ReadonlySet<string> } | undefined = {
      runs: new Set(["run-done-2222"]),
      bash: new Set(),
    };
    const widget = new FleetWidgetController({
      ui: host,
      query: query(runs),
      clock,
      archived: () => archived,
    });
    await flush();
    expect((host.renderedLines() ?? []).join("\n")).not.toContain("done-run");
    archived = { runs: new Set(), bash: new Set() };
    clock.advance(1000); // still inside the linger window (age 1s < 5s)
    await flush();
    expect((host.renderedLines() ?? []).join("\n")).toContain("done-run");
    widget.dispose();
  });

  it("no archived getter ⇒ identical rendering (pre-feature bytes)", async () => {
    const clock = new FakeClock(10_000);
    const hostA = ui();
    const hostB = ui();
    const runs = [snap("run-done-2222", "completed", "done-run")];
    const a = new FleetWidgetController({ ui: hostA, query: query(runs), clock });
    const b = new FleetWidgetController({
      ui: hostB,
      query: query(runs),
      clock,
      archived: () => ({ runs: new Set(), bash: new Set() }),
    });
    await flush();
    expect(hostA.renderedLines()).toEqual(hostB.renderedLines());
    a.dispose();
    b.dispose();
  });
});
