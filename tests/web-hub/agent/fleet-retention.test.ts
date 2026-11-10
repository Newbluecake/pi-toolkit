import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveControl, type RunArchiveDisplayView } from "../../../src/archive/control.js";
import { ARCHIVE_ENTRY_TYPE } from "../../../src/archive/state.js";
import { isTerminalStatus } from "../../../src/core/status.js";
import type { RunSnapshot } from "../../../src/core/types.js";
import {
  WEB_FLEET_FRAME_BYTES,
  WEB_FLEET_ROW_BYTES,
  fleetFingerprint,
  projectFleet,
} from "../../../src/web-hub/agent/status.js";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import { formatSseFrame } from "../../../src/web-hub/hub/sse.js";
import { decodeAgentFrame } from "../../../src/web-hub/protocol/messages.js";
import { encodeFrame, NdjsonDecoder } from "../../../src/web-hub/protocol/ndjson.js";
import { archiveSetOf, partitionArchived } from "../../../src/web-hub/ui/src/components/fleet/archiveView.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

interface SnapOptions {
  terminal?: boolean;
  updatedAt?: number;
  settledAt?: number;
  createdAt?: number;
  title?: string;
  label?: string;
  model?: { provider: string; id: string };
  thinkingText?: string;
  toolName?: string;
  sessionFile?: string;
  parentRunId?: string;
  costUsd?: number;
}

function snap(runId: string, opts: SnapOptions = {}): RunSnapshot {
  const terminal = opts.terminal ?? true;
  const updatedAt = opts.updatedAt ?? 1;
  const diag: RunSnapshot["diag"] = {
    createdAt: opts.createdAt ?? 0,
    phase: terminal ? "settled" : "model_turn",
    phaseEnteredAt: updatedAt,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    label: opts.label ?? `label-${runId}`,
    title: opts.title ?? `title-${runId}`,
    model: opts.model ?? { provider: "p", id: "m" },
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: opts.costUsd ?? 0.25 },
    ...(opts.settledAt !== undefined || terminal ? { settledAt: opts.settledAt ?? updatedAt } : {}),
    ...(opts.thinkingText !== undefined ? { thinkingText: opts.thinkingText } : {}),
    ...(opts.toolName !== undefined
      ? {
          toolHistory: [{ name: opts.toolName, toolCallId: `call-${runId}`, startedAt: 0, argsPreview: "npm test" }],
        }
      : {}),
    ...(opts.sessionFile !== undefined ? { sessionFile: opts.sessionFile } : {}),
  } as RunSnapshot["diag"];
  return {
    runId,
    generation: 1,
    status: terminal ? "completed" : "running",
    phase: terminal ? "settled" : "model_turn",
    deadlines: {},
    diag,
    updatedAt,
    ...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
  } as RunSnapshot;
}

function archiveView(
  archived: readonly string[],
  held: readonly string[] = [],
  horizon?: number,
): RunArchiveDisplayView {
  return {
    archived: new Set(archived),
    held: new Set(held),
    ...(horizon !== undefined ? { horizon } : {}),
  };
}

function restoredArchive(
  snaps: readonly RunSnapshot[],
  archived: readonly string[],
  held: readonly string[] = [],
  horizon?: number,
) {
  const appended: unknown[] = [];
  const control = new ArchiveControl(
    { runs: () => snaps, bashJobs: () => [] },
    { appendEntry: (_type, data) => appended.push(data), now: () => 10_000 },
  );
  control.restore([
    {
      type: "custom",
      customType: ARCHIVE_ENTRY_TYPE,
      data: {
        entries: archived.map((id, i) => ({ kind: "run", id, at: i + 1, auto: true as const })),
        held: held.map((id, i) => ({ kind: "run", id, at: i + 1 })),
        ...(horizon !== undefined ? { horizon: { run: horizon } } : {}),
      },
    },
  ]);
  return { control, appended };
}

type Projection = ReturnType<typeof projectFleet>;

function frameOf(rows: Projection): { t: "fleet"; runs: Projection; omitted?: Projection["omitted"] } {
  return { t: "fleet", runs: rows, ...(rows.omitted !== undefined ? { omitted: rows.omitted } : {}) };
}

function frameBytes(rows: Projection): number {
  return Buffer.byteLength(`${JSON.stringify(frameOf(rows))}\n`);
}

function ssePayloadOf(rows: Projection, agentKey: string): object {
  return { agentKey, runs: rows, ...(rows.omitted !== undefined ? { omitted: rows.omitted } : {}) };
}

function omitted(rows: Projection): { active: number; terminal: number } {
  return rows.omitted ?? { active: 0, terminal: 0 };
}

function expectConservation(snaps: readonly RunSnapshot[], rows: Projection): void {
  const originalActive = snaps.filter((s) => !isTerminalStatus(s.status)).length;
  const originalTerminal = snaps.length - originalActive;
  const emittedActive = rows.filter((r) => !r.terminal).length;
  const emittedTerminal = rows.length - emittedActive;
  expect(omitted(rows)).toEqual({
    active: originalActive - emittedActive,
    terminal: originalTerminal - emittedTerminal,
  });
  expect(frameBytes(rows)).toBeLessThanOrEqual(WEB_FLEET_FRAME_BYTES);
  for (const row of rows) expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(WEB_FLEET_ROW_BYTES);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function expectRealNdjson(rows: Projection): void {
  const decoded: unknown[] = [];
  const errors: unknown[] = [];
  const decoder = new NdjsonDecoder({ onFrame: (raw) => decoded.push(raw), onError: (err) => errors.push(err) });
  const encoded = encodeFrame(frameOf(rows));
  // Exercise both split multibyte/chunk reassembly and the production schema decoder.
  const bytes = Buffer.from(encoded);
  decoder.push(bytes.subarray(0, Math.floor(bytes.length / 3)));
  decoder.push(bytes.subarray(Math.floor(bytes.length / 3)));
  expect(errors).toEqual([]);
  expect(decoded).toHaveLength(1);
  expect(decodeAgentFrame(decoded[0])).toBeDefined();
}

describe("projectFleet archive retention", () => {
  it("64 completed / 58 explicit archives ⇒ 6 ordinary + 58 archived, with no terminal omission", () => {
    const snaps = Array.from({ length: 64 }, (_, i) =>
      snap(`r-${i}`, { updatedAt: 1_000 + i, settledAt: 2_000 + i, costUsd: i + 0.25 }),
    );
    const archivedIds = snaps.slice(0, 58).map((s) => s.runId);
    const { control, appended } = restoredArchive(snaps, archivedIds);
    const rows = projectFleet(snaps, 20_000, undefined, control.runDisplayView());
    const partition = partitionArchived(rows, archiveSetOf(control.wire(), "run"));

    expect(rows).toHaveLength(64);
    expect(partition.live).toHaveLength(6);
    expect(partition.archivedRows).toHaveLength(58);
    expect(new Set(rows.map((r) => r.runId)).size).toBe(64);
    expect(rows.omitted).toBeUndefined();
    expectConservation(snaps, rows);
    for (const row of rows) {
      const source = snaps.find((s) => s.runId === row.runId)!;
      expect(row.title).toBe(source.diag.title);
      expect(row.costUsd).toBe(source.diag.usage?.costUsd);
      expect(row.startedAt).toBe(source.diag.createdAt);
      expect(row.endedAt).toBe(source.diag.settledAt);
    }
    expect(appended).toHaveLength(0); // projection + both read views are persistence-inert

    // Counterfactual: the legacy producer emitted only eight terminal rows, two of them archived.
    const legacy = projectFleet(snaps, 20_000);
    const oldPartition = partitionArchived(legacy, archiveSetOf(control.wire(), "run"));
    expect(legacy).toHaveLength(8);
    expect(oldPartition.live).toHaveLength(6);
    expect(oldPartition.archivedRows).toHaveLength(2);
    expect(omitted(legacy).terminal).toBe(56);
    control.dispose();
  });

  it("ordinary U8 is independent of E256 even when every archive is newer", () => {
    const ordinary = Array.from({ length: 20 }, (_, i) => snap(`u-${i}`, { updatedAt: 100 + i }));
    const archived = Array.from({ length: 58 }, (_, i) => snap(`e-${i}`, { updatedAt: 1_000 + i }));
    const snaps = [...ordinary, ...archived];
    const rows = projectFleet(snaps, 5_000, undefined, archiveView(archived.map((s) => s.runId)));

    expect(rows).toHaveLength(66);
    expect(omitted(rows)).toEqual({ active: 0, terminal: 12 });
    for (let i = 12; i < 20; i++) expect(rows.some((r) => r.runId === `u-${i}`)).toBe(true);
    for (let i = 0; i < 12; i++) expect(rows.some((r) => r.runId === `u-${i}`)).toBe(false);
    for (let i = 0; i < 58; i++) expect(rows.some((r) => r.runId === `e-${i}`)).toBe(true);
    expectConservation(snaps, rows);
  });

  it("70 active keeps the original severity/elapsed top 64; archived metadata never hides active rows", () => {
    const active = Array.from({ length: 70 }, (_, i) =>
      snap(`a-${i}`, { terminal: false, createdAt: i, updatedAt: 100 + i }),
    );
    const ordinary = Array.from({ length: 20 }, (_, i) => snap(`u-${i}`, { updatedAt: 100 + i }));
    const archived = Array.from({ length: 58 }, (_, i) => snap(`e-${i}`, { updatedAt: 1_000 + i }));
    const snaps = [...active, ...ordinary, ...archived];
    const rows = projectFleet(snaps, 10_000, undefined, archiveView([...archived.map((s) => s.runId), "a-0"]));

    expect(rows.filter((r) => !r.terminal)).toHaveLength(64);
    expect(rows.some((r) => r.runId === "a-0")).toBe(true); // longest elapsed, still nonterminal
    expect(rows.some((r) => r.runId === "a-69")).toBe(false); // shortest elapsed, original cap
    expect(omitted(rows)).toEqual({ active: 6, terminal: 12 });
    expectConservation(snaps, rows);
  });

  it("explicit E beats horizon, held beats horizon, implicit H is omitted, and an absent horizon revives U", () => {
    const snaps = [
      snap("running", { terminal: false, updatedAt: 0 }),
      snap("explicit", { updatedAt: 50, settledAt: 50 }),
      snap("held", { updatedAt: 60, settledAt: 60 }),
      snap("implicit", { updatedAt: 100, settledAt: 100 }),
      snap("ordinary", { updatedAt: 101, settledAt: 101 }),
    ];
    const rows = projectFleet(snaps, 1_000, undefined, archiveView(["explicit", "running"], ["held"], 100));
    expect(rows.map((r) => r.runId)).toEqual(["running", "ordinary", "held", "explicit"]);
    expect(omitted(rows)).toEqual({ active: 0, terminal: 1 });
    expectConservation(snaps, rows);

    const noHorizon = projectFleet(snaps, 1_000, undefined, archiveView(["explicit", "running"], ["held"]));
    expect(noHorizon.map((r) => r.runId)).toContain("implicit");
    expect(noHorizon.omitted).toBeUndefined();
  });

  it("restore enforces the real 256 cap: 64 active + U8 + E256 = 328, with 44 implicit H omitted", () => {
    const active = Array.from({ length: 64 }, (_, i) => snap(`a-${i}`, { terminal: false, createdAt: i }));
    const old = Array.from({ length: 300 }, (_, i) => snap(`e-${i}`, { updatedAt: 1_000 + i, settledAt: 1_000 + i }));
    const ordinary = Array.from({ length: 8 }, (_, i) => snap(`u-${i}`, { updatedAt: 2_000 + i }));
    const snaps = [...active, ...old, ...ordinary];
    const { control, appended } = restoredArchive(
      snaps,
      old.map((s) => s.runId),
      [],
      1_043,
    );
    expect(control.runDisplayView().archived.size).toBe(256);
    const rows = projectFleet(snaps, 10_000, undefined, control.runDisplayView());

    expect(rows).toHaveLength(328);
    expect(rows.filter((r) => !r.terminal)).toHaveLength(64);
    expect(rows.filter((r) => r.runId.startsWith("u-"))).toHaveLength(8);
    expect(rows.filter((r) => r.runId.startsWith("e-"))).toHaveLength(256);
    expect(omitted(rows)).toEqual({ active: 0, terminal: 44 });
    expectConservation(snaps, rows);
    expect(appended).toHaveLength(0);
    control.dispose();
  });

  it("resume identity stays runId-keyed even when two runs share one sessionFile and a missing parent", () => {
    const snaps = [
      snap("run-original", { sessionFile: "/tmp/same-child.jsonl", parentRunId: "missing-parent", updatedAt: 1 }),
      snap("run-resumed", { sessionFile: "/tmp/same-child.jsonl", parentRunId: "missing-parent", updatedAt: 2 }),
    ];
    const rows = projectFleet(snaps, 100, undefined, archiveView([]));
    expect(rows.map((r) => r.runId)).toEqual(["run-resumed", "run-original"]);
    expect(rows.map((r) => r.parentRunId)).toEqual(["missing-parent", "missing-parent"]);
    expect(rows.omitted).toBeUndefined();
  });

  it("no archive tail keeps legacy bytes; an empty view is equivalent; omitted-only flips fingerprint", () => {
    const eight = Array.from({ length: 8 }, (_, i) => snap(`r-${i}`, { updatedAt: i }));
    const legacy = projectFleet(eight, 100);
    const withEmptyView = projectFleet(eight, 100, undefined, archiveView([]));
    expect(JSON.stringify(frameOf(withEmptyView))).toBe(JSON.stringify(frameOf(legacy)));
    expect("omitted" in legacy).toBe(false);
    expect(JSON.stringify(frameOf(projectFleet([], 100)))).toBe('{"t":"fleet","runs":[]}');

    const nine = [...eight, snap("older", { updatedAt: -1 })];
    const truncated = projectFleet(nine, 100);
    expect(truncated.map((r) => r.runId)).toEqual(legacy.map((r) => r.runId));
    expect(omitted(truncated)).toEqual({ active: 0, terminal: 1 });
    expect(fleetFingerprint(truncated)).not.toBe(fleetFingerprint(legacy));
  });
});

describe("projectFleet UTF-8 row/frame budgets", () => {
  it("degrades long multibyte display fields without splitting Unicode or mutating snapshots", () => {
    const source = snap("身份-😀", {
      terminal: false,
      title: "汉😀\\\n\t".repeat(2_000),
      label: "标签😀".repeat(1_000),
      model: { provider: "提供方😀".repeat(300), id: '模型\\"\n'.repeat(300) },
      thinkingText: "思考🙂\n最后多字节😀".repeat(1_000),
      toolName: "工具😀".repeat(1_000),
    });
    const before = JSON.stringify(source);
    deepFreeze(source);
    const rows = projectFleet([source], 10_000);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.runId).toBe("身份-😀");
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(WEB_FLEET_ROW_BYTES);
    for (const field of [row.title, row.label, row.model, row.toolTrail, row.streamLine, row.type]) {
      if (field !== undefined) expect(Buffer.byteLength(field)).toBeLessThanOrEqual(512);
    }
    expect(row.title).toMatch(/…$/);
    expect(JSON.stringify(row)).not.toContain("�");
    expect(JSON.stringify(source)).toBe(before);
    expectConservation([source], rows);
    expectRealNdjson(rows);
    const sse = formatSseFrame("fleet", ssePayloadOf(rows, "a1-test"));
    expect(Buffer.byteLength(sse)).toBeLessThanOrEqual(WEB_FLEET_FRAME_BYTES + 1_024);
  });

  it("row budget is exact at 4095 / 4096 / 4097 bytes", () => {
    const atRawSize = (target: number) => {
      const baseSnap = snap("row-boundary", { title: "x" });
      const baseRow = projectFleet([baseSnap], 100)[0]!;
      const titleLength = 1 + target - Buffer.byteLength(JSON.stringify(baseRow));
      const source = snap("row-boundary", { title: "x".repeat(titleLength) });
      return projectFleet([source], 100)[0]!;
    };
    const below = atRawSize(WEB_FLEET_ROW_BYTES - 1);
    const exact = atRawSize(WEB_FLEET_ROW_BYTES);
    const above = atRawSize(WEB_FLEET_ROW_BYTES + 1);
    expect(Buffer.byteLength(JSON.stringify(below))).toBe(WEB_FLEET_ROW_BYTES - 1);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(WEB_FLEET_ROW_BYTES);
    expect(exact.title?.endsWith("…")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(above))).toBeLessThanOrEqual(WEB_FLEET_ROW_BYTES);
    expect(above.title?.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(above.title!)).toBeLessThanOrEqual(512);
  });

  it("frame pressure admits active → U → newest E and preserves omission conservation", () => {
    const active = Array.from({ length: 64 }, (_, i) =>
      snap(`a-${i}`, { terminal: false, createdAt: i, title: "a".repeat(3_600) }),
    );
    const ordinary = Array.from({ length: 8 }, (_, i) =>
      snap(`u-${i}`, { updatedAt: 100 + i, title: "u".repeat(3_600) }),
    );
    const archived = Array.from({ length: 200 }, (_, i) =>
      snap(`e-${i}`, { updatedAt: 1_000 + i, title: "e".repeat(3_600) }),
    );
    const snaps = deepFreeze([...active, ...ordinary, ...archived]);
    const rows = projectFleet(snaps, 10_000, undefined, archiveView(archived.map((s) => s.runId)));

    expect(rows.filter((r) => !r.terminal)).toHaveLength(64);
    for (let i = 0; i < 8; i++) expect(rows.some((r) => r.runId === `u-${i}`)).toBe(true);
    const emittedArchives = rows.filter((r) => r.runId.startsWith("e-"));
    expect(emittedArchives.length).toBeGreaterThan(0);
    expect(emittedArchives.length).toBeLessThan(200);
    expect(omitted(rows).active).toBe(0);
    expect(omitted(rows).terminal).toBe(208 - 8 - emittedArchives.length);
    expectConservation(snaps, rows);
    expectRealNdjson(rows);
  });

  it("oversized identities are skipped whole, never truncated; empty rows + omitted remains valid", () => {
    const huge = snap("😀".repeat(3_000), { terminal: false });
    const rows = projectFleet([huge], 100);
    expect(rows).toHaveLength(0);
    expect(omitted(rows)).toEqual({ active: 1, terminal: 0 });
    expect(frameBytes(rows)).toBeLessThanOrEqual(WEB_FLEET_FRAME_BYTES);
    expectRealNdjson(rows);

    const hugeParent = snap("small-id", { parentRunId: "父😀".repeat(3_000) });
    const terminalRows = projectFleet([hugeParent], 100, undefined, archiveView(["small-id"]));
    expect(terminalRows).toHaveLength(0);
    expect(omitted(terminalRows)).toEqual({ active: 0, terminal: 1 });
  });

  it("final admission is exact at the last reserved byte −1 / exact / +1, with real NDJSON + SSE", () => {
    // 160 × ~3.2 KiB rows reach the 512-KiB producer budget without tripping
    // the independent 4-KiB row degradation. The implementation reserves 256 bytes
    // for final omitted digits, so a no-omission frame of 512-KiB−256 is the exact
    // admission edge. Title length is ASCII-linear, making this a byte test, not a char proxy.
    const count = 160;
    const makeSnaps = (base: number, extra: (i: number) => number = () => 0) =>
      Array.from({ length: count }, (_, i) =>
        snap(`e-${i}`, { updatedAt: i, title: `title-${i}-` + "x".repeat(base + extra(i)) }),
      );
    const makeAt = (target: number) => {
      const base = 3_000;
      const baseSnaps = makeSnaps(base);
      const view = archiveView(baseSnaps.map((s) => s.runId));
      const baseRows = projectFleet(baseSnaps, 10_000, undefined, view);
      const delta = target - frameBytes(baseRows);
      const each = Math.floor(delta / count);
      const remainder = delta % count;
      const snaps = makeSnaps(base + each, (i) => (i < remainder ? 1 : 0));
      return { snaps, rows: projectFleet(snaps, 10_000, undefined, archiveView(snaps.map((s) => s.runId))) };
    };

    const edge = WEB_FLEET_FRAME_BYTES - 256;
    const below = makeAt(edge - 1);
    const exact = makeAt(edge);
    const above = makeAt(edge + 1);
    expect(frameBytes(below.rows)).toBe(edge - 1);
    expect(below.rows).toHaveLength(count);
    expect(frameBytes(exact.rows)).toBe(edge);
    expect(exact.rows).toHaveLength(count);
    expect(exact.rows.omitted).toBeUndefined();
    expectConservation(exact.snaps, exact.rows);
    expectRealNdjson(exact.rows);
    const sse = formatSseFrame("fleet", ssePayloadOf(exact.rows, "a1-boundary"), 42);
    expect(Buffer.byteLength(sse)).toBeLessThanOrEqual(WEB_FLEET_FRAME_BYTES + 1_024);

    // One input byte over the edge rejects only the lowest-priority archive; omitted
    // grows in the FINAL serialization and the other 127 rows survive.
    expect(above.rows).toHaveLength(count - 1);
    expect(omitted(above.rows)).toEqual({ active: 0, terminal: 1 });
    expectConservation(above.snaps, above.rows);
    expect(frameBytes(above.rows)).toBeLessThanOrEqual(WEB_FLEET_FRAME_BYTES);
  });
});

describe("wireWebHub #9 tick-only archive wiring", () => {
  let tmp: ReturnType<typeof tmpDir>;
  beforeEach(() => {
    tmp = tmpDir("wh-fleet-retention-");
    resetGlobals();
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetGlobals();
    vi.useRealTimers();
    tmp.cleanup();
  });

  it("real tick consumes the original ArchiveControl view; snapshot stays legacy; safe-read failures degrade", async () => {
    const snaps = Array.from({ length: 64 }, (_, i) => snap(`r-${i}`, { updatedAt: i }));
    const { control } = restoredArchive(
      snaps,
      snaps.slice(0, 58).map((s) => s.runId),
    );
    const n = fakeNet();
    const { pi, fire } = fakePi();
    const deps: WebHubDeps = {
      settings: SETTINGS,
      fleet: () => snaps,
      archive: () => control,
      netConnect: n.netConnect,
      env: { HOME: tmp.dir },
      paths: pathsIn(tmp.dir),
      buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
      argv1: "/nonexistent/pi",
    };
    wireWebHub(pi, deps);
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await vi.advanceTimersByTimeAsync(0);
    const socket = n.sockets[0]!;
    socket.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    socket.hub(ackFrame("a1-retention", 4242));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    const fleets = () =>
      socket.frames().filter((f) => f.t === "fleet") as unknown as Array<{
        runs: Array<{ runId: string }>;
        omitted?: { active: number; terminal: number };
      }>;
    expect(fleets().at(-1)?.runs).toHaveLength(64);
    expect(fleets().at(-1)?.omitted).toBeUndefined();

    socket.hub({ t: "snapshot_req", rid: "snapshot-legacy" });
    await vi.advanceTimersByTimeAsync(0);
    const reply = socket.frames().find((f) => f.t === "snapshot_reply" && f.rid === "snapshot-legacy") as
      { fleet: unknown[] } | undefined;
    expect(reply?.fleet).toHaveLength(8);

    vi.spyOn(control, "runDisplayView").mockImplementation(() => {
      throw new Error("disposed/broken archive read");
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fleets().at(-1)?.runs).toHaveLength(8);
    expect(fleets().at(-1)?.omitted).toEqual({ active: 0, terminal: 56 });
    control.dispose();
  });
});
