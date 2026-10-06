/**
 * bash-jobs-panel plan §3.9 (包 A): `selectJobs` / `projectBashJobs` /
 * `bashJobsLightFingerprint` / the D6 byte-budget ladder.
 */
import { describe, expect, it } from "vitest";
import {
  BASH_JOBS_MAX_ROWS,
  BASH_JOBS_MAX_TERMINAL_ROWS,
  BASH_JOBS_WIRE_BUDGET_BYTES,
  bashJobsLightFingerprint,
  bashJobsWireBytes,
  projectBashJobs,
  selectJobs,
  type BashJobsTails,
} from "../../../src/web-hub/agent/bash-jobs.js";
import type { JobRecord } from "../../../src/bash/types.js";

const NOW = 1_790_000_000_000;

function job(jobId: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    v: 1,
    jobId,
    command: "npm test",
    cwd: "/w",
    sessionId: "sess",
    hostPid: 1,
    status: "running",
    createdAt: NOW - 60_000,
    spawnedAt: NOW - 60_000,
    backgroundedAt: NOW - 60_000,
    exitCode: null,
    logPath: `/log/${jobId}.log`,
    logBytes: 10,
    outputTruncated: false,
    readCursor: 0,
    ...over,
  };
}

function terminal(id: string, over: Partial<JobRecord> = {}): JobRecord {
  return job(id, { status: "completed", endedAt: NOW - 1_000, exitCode: 0, ...over });
}

const noRetention = 0;

describe("selectJobs — D1", () => {
  it("foreground rows (no backgroundedAt) never surface, even terminal", () => {
    const rows = selectJobs(
      [job("b_fg", { backgroundedAt: undefined }), terminal("b_fgdone", { backgroundedAt: undefined }), job("b_bg")],
      NOW,
      noRetention,
    );
    expect(rows.rows.map((r) => r.jobId)).toEqual(["b_bg"]);
    expect(rows.total).toBe(1);
  });

  it("non-terminal first (createdAt desc), then terminal (endedAt desc)", () => {
    const out = selectJobs(
      [
        terminal("b_t1", { endedAt: NOW - 5_000 }),
        job("b_r1", { createdAt: NOW - 30_000 }),
        terminal("b_t2", { endedAt: NOW - 1_000 }),
        job("b_r2", { createdAt: NOW - 10_000 }),
      ],
      NOW,
      noRetention,
    );
    expect(out.rows.map((r) => r.jobId)).toEqual(["b_r2", "b_r1", "b_t2", "b_t1"]);
    expect(out.running).toBe(2);
  });

  it("20-row and 12-terminal caps; overflow counts into omitted (total stays full-population)", () => {
    const records: JobRecord[] = [];
    for (let i = 0; i < 8; i++) records.push(job(`b_r${String(i).padStart(2, "0")}`, { createdAt: NOW - i }));
    for (let i = 0; i < 15; i++) records.push(terminal(`b_t${String(i).padStart(2, "0")}`, { endedAt: NOW - i }));
    const out = selectJobs(records, NOW, noRetention);
    expect(out.rows).toHaveLength(20);
    expect(out.rows.filter((r) => r.status === "completed")).toHaveLength(12); // ≤12 terminal cap
    expect(out.rows.slice(0, 8).every((r) => r.status !== "completed")).toBe(true); // running first
    expect(out.rows.slice(8).every((r) => r.status === "completed")).toBe(true);
    expect(out.total).toBe(23);
    expect(out.running).toBe(8);
    expect(out.failed).toBe(0); // completed rows are not failed
    expect(out.omitted).toBe(3);
  });

  it("failed counts terminal rows that are not completed", () => {
    const out = selectJobs(
      [terminal("b_ok"), terminal("b_bad", { status: "failed", exitCode: 2 }), job("b_run")],
      NOW,
      noRetention,
    );
    expect(out.failed).toBe(1);
    expect(out.running).toBe(1);
  });

  it("retention: terminal row expires at exactly now - (endedAt) >= R (store's pruneExpired formula)", () => {
    const R = 60_000;
    const endedAt = NOW - 59_999;
    const rec = terminal("b_t", { endedAt });
    expect(selectJobs([rec], NOW, R).total).toBe(1); // now - endedAt = R-1 ⇒ kept
    expect(selectJobs([terminal("b_t2", { endedAt: NOW - R })], NOW, R).total).toBe(0); // == R ⇒ gone
    expect(selectJobs([terminal("b_t3", { endedAt: NOW - R })], NOW, noRetention).total).toBe(1); // R<=0 off
  });

  it("retention: terminal rows without endedAt fall back to createdAt", () => {
    const R = 1_000;
    // A terminal record missing endedAt (defensive): age measured from createdAt.
    expect(selectJobs([terminal("b_x", { endedAt: undefined, createdAt: NOW - R })], NOW, R).total).toBe(0);
    expect(selectJobs([terminal("b_y", { endedAt: undefined, createdAt: NOW - R + 1 })], NOW, R).total).toBe(1);
  });

  it("running rows are never retention-filtered", () => {
    expect(selectJobs([job("b_old", { createdAt: NOW - 10 * 60_000 })], NOW, 60_000).total).toBe(1);
  });
});

describe("projectBashJobs — row content (D2/D2a/D6 caps)", () => {
  it("no selected rows ⇒ undefined (field absent, byte-equal to pre-feature)", () => {
    expect(projectBashJobs([], undefined, NOW, noRetention)).toBeUndefined();
    expect(projectBashJobs([job("b_fg", { backgroundedAt: undefined })], undefined, NOW, noRetention)).toBeUndefined();
  });

  it("field caps: emoji cmd truncated flag, 4-byte safety; id/status byte caps; logTruncated; grace", () => {
    const rec = job("b_cap", {
      command: "😀".repeat(300),
      logBytes: 2_048,
      deadline: {
        timeoutMs: 1_000,
        policy: { graceMs: 1, maxExtensions: 1, maxTimeoutFactor: 1 },
        dueAt: NOW,
        hardAt: NOW,
        graceUntil: NOW + 1,
        graces: 1,
        graceNotified: 0,
        extensions: 0,
        grantedMs: 0,
        seq: 0,
      },
    });
    const wire = projectBashJobs([rec], undefined, NOW, noRetention)!;
    const row = wire.rows[0]!;
    expect([...row.cmd].length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(row.cmd, "utf8")).toBeLessThanOrEqual(600);
    expect(row.cmdTruncated).toBe(true);
    expect(row.logTruncated).toBe(true); // logBytes > 1 KiB read window
    expect(row.grace).toBe(true);
    expect("endedAt" in row).toBe(false);
    expect(row.elapsedMs).toBe(NOW - rec.createdAt);
    expect(wire.total).toBe(1);
    expect(wire.running).toBe(1);
  });

  it("tail sample rides the row: tail/tailAt/tailBytes (cache text is pre-sanitized by the sampler)", () => {
    const tails: BashJobsTails = new Map([["b_run", { text: "building TOKEN=***…", logBytes: 42, at: NOW - 500 }]]);
    const wire = projectBashJobs([job("b_run")], tails, NOW, noRetention)!;
    const row = wire.rows[0]!;
    expect(row.tail).toBe("building TOKEN=***…");
    expect(row.tailAt).toBe(NOW - 500);
    expect(row.tailBytes).toBe(42);
    expect(row.tailCurrent).toBe(true); // running + sample exists
  });

  it("tailCurrent table (D3-3, agent-judged freshness)", () => {
    const t = (id: string, over: Partial<JobRecord> = {}) => terminal(id, { endedAt: NOW - 1_000, ...over });
    const cases: Array<{
      id: string;
      row: JobRecord;
      tail?: { text?: string; logBytes: number; at?: number; settled?: true; unavailableAtLogBytes?: number };
    }> = [
      { id: "terminal no sample", row: t("b_a") },
      { id: "terminal current", row: t("b_b", { logBytes: 50 }), tail: { text: "done", logBytes: 50, at: NOW } },
      {
        id: "terminal footer pending (tailBytes != record)",
        row: t("b_c", { logBytes: 50 }),
        tail: { text: "done", logBytes: 60, at: NOW },
      },
      {
        id: "terminal sampled before end",
        row: t("b_d", { logBytes: 50, endedAt: NOW }),
        tail: { text: "old", logBytes: 50, at: NOW - 2_000 },
      },
      {
        id: "terminal settled mismatch",
        row: t("b_e", { logBytes: 50 }),
        tail: { text: "done", logBytes: 99, at: NOW, settled: true },
      },
      { id: "terminal unavailable", row: t("b_f", { logBytes: 50 }), tail: { logBytes: 0, unavailableAtLogBytes: 50 } },
      { id: "running no sample", row: job("b_g") },
      { id: "running with sample", row: job("b_h"), tail: { text: "…", logBytes: 1, at: NOW - 9_000 } },
    ];
    const wire = projectBashJobs(
      cases.map((c) => c.row),
      new Map(cases.flatMap((c) => (c.tail !== undefined ? [[c.row.jobId, c.tail] as const] : []))),
      NOW,
      noRetention,
    )!;
    const byId = new Map(wire.rows.map((r) => [r.id, r]));
    expect(byId.get("b_a")!.tailCurrent).toBeUndefined();
    expect(byId.get("b_b")!.tailCurrent).toBe(true);
    expect(byId.get("b_c")!.tailCurrent).toBeUndefined(); // footer race: not current
    expect(byId.get("b_d")!.tailCurrent).toBeUndefined(); // tailAt < endedAt
    expect(byId.get("b_e")!.tailCurrent).toBe(true); // settled ⇒ treated as current
    expect(byId.get("b_f")!.tailCurrent).toBeUndefined();
    expect(byId.get("b_f")!.tailUnavailable).toBe(true);
    expect("tailAt" in byId.get("b_f")!).toBe(false); // unavailable-only entry carries no observation
    expect(byId.get("b_g")!.tailCurrent).toBeUndefined();
    expect(byId.get("b_h")!.tailCurrent).toBe(true);
  });

  it("retention expiry drops row and tail in the SAME projection + flips the fingerprint", () => {
    const R = 60_000;
    const rec = terminal("b_t", { endedAt: NOW, logBytes: 30 });
    const tails: BashJobsTails = new Map([["b_t", { text: "done", logBytes: 30, at: NOW }]]);
    const before = projectBashJobs([rec], tails, NOW + R - 1, R)!;
    expect(before.rows[0]!.tail).toBe("done");
    const fpBefore = bashJobsLightFingerprint(selectJobs([rec], NOW + R - 1, R), NOW + R - 1);
    // One tick later the row expired: row AND tail leave together, field absent, fp changed.
    expect(projectBashJobs([rec], tails, NOW + R, R)).toBeUndefined();
    const fpAfter = bashJobsLightFingerprint(selectJobs([rec], NOW + R, R), NOW + R);
    expect(fpAfter).not.toBe(fpBefore);
  });
});

describe("projectBashJobs — D6 budget ladder", () => {
  /** Max-wire-cost row: cmd at the 200-char cap of `"` (JSON-escapes to 400 B), maxed fixed fields. */
  const fatTail = '"'.repeat(1024);
  const fatCmd = '"'.repeat(200);

  it("worst combination (20 rows, all caps, tails all quotes) fits the 24 KiB budget", () => {
    const records: JobRecord[] = [];
    for (let i = 0; i < 20; i++) {
      records.push(
        i < 12
          ? terminal(`b_t${String(i).padStart(2, "0")}`, {
              command: fatCmd,
              logBytes: 40_000,
              endedAt: NOW - i,
              createdAt: NOW - 100 - i,
            })
          : job(`b_r${String(i).padStart(2, "0")}`, { command: fatCmd, logBytes: 40_000, createdAt: NOW - 200 - i }),
      );
    }
    const tails: BashJobsTails = new Map(records.map((r) => [r.jobId, { text: fatTail, logBytes: 40_960, at: NOW }]));
    const wire = projectBashJobs(records, tails, NOW, noRetention)!;
    expect(wire.rows).toHaveLength(BASH_JOBS_MAX_ROWS);
    expect(bashJobsWireBytes(wire)).toBeLessThanOrEqual(BASH_JOBS_WIRE_BUDGET_BYTES);
    // Ladder order: terminal tails shrank (①) and were fully DELETED (②); only then did ③
    // touch running tails — shrinking them OLDEST-first (a prefix of the running block keeps
    // the full 1 KiB tail, the oldest rows carry ≤256 B, none is ever deleted here).
    const term = wire.rows.filter((r) => r.endedAt !== undefined);
    const run = wire.rows.filter((r) => r.endedAt === undefined);
    expect(run).toHaveLength(8);
    for (const r of term) expect(r.tail).toBeUndefined();
    for (const r of run) expect(r.tail).toBeDefined(); // ③ shrinks, never deletes
    const fatRun = run.map((r) => Buffer.byteLength(r.tail!, "utf8") > 256);
    expect(fatRun[0]).toBe(true); // newest running row untouched
    expect(fatRun.at(-1)).toBe(false); // oldest running rows shrank
    const firstShrunk = fatRun.indexOf(false);
    expect(fatRun.slice(firstShrunk).every((v) => !v)).toBe(true); // contiguous prefix
    expect(wire.omitted).toBeUndefined(); // row dropping (⑤) never became necessary
  });

  it("pass ③: when terminal deletion is not enough, OLDEST running tails shrink first", () => {
    const records: JobRecord[] = [];
    records.push(terminal("b_t0", { command: fatCmd, logBytes: 40_000, endedAt: NOW, createdAt: NOW - 100 }));
    records.push(terminal("b_t1", { command: fatCmd, logBytes: 40_000, endedAt: NOW - 1, createdAt: NOW - 101 }));
    for (let i = 0; i < 18; i++) {
      records.push(job(`b_r${String(i).padStart(2, "0")}`, { command: fatCmd, logBytes: 40_000, createdAt: NOW - i }));
    }
    const tails: BashJobsTails = new Map(records.map((r) => [r.jobId, { text: fatTail, logBytes: 40_960, at: NOW }]));
    const wire = projectBashJobs(records, tails, NOW, noRetention)!;
    expect(bashJobsWireBytes(wire)).toBeLessThanOrEqual(BASH_JOBS_WIRE_BUDGET_BYTES);
    // Both terminal tails are gone (①+② exhausted), then ③ shrank running tails OLDEST-first
    // until the budget closed — a contiguous prefix of the running block keeps the full tail.
    for (const r of wire.rows.filter((x) => x.endedAt !== undefined)) expect(r.tail).toBeUndefined();
    const run = wire.rows.filter((r) => r.endedAt === undefined);
    expect(run.every((r) => r.tail !== undefined)).toBe(true); // ③ shrinks, never deletes here
    const fatRun = run.map((r) => Buffer.byteLength(r.tail!, "utf8") > 256);
    expect(fatRun[0]).toBe(true);
    expect(fatRun.at(-1)).toBe(false);
    const firstShrunk = fatRun.indexOf(false);
    expect(fatRun.slice(firstShrunk).every((v) => !v)).toBe(true); // contiguous prefix
    // Every shrunk tail is still quote-only content (shrunk from the head, keeping the tail).
    for (const r of run.filter((x) => Buffer.byteLength(x.tail!, "utf8") <= 256)) {
      expect(r.tail).toBe('"'.repeat(r.tail!.length));
    }
  });

  it("passes ④/⑤ (delete running tails / drop rows) are unreachable under the per-field caps — documented defense-in-depth", () => {
    // With rows ≤20 and every field already at its own cap (cmd ≤200 chars/≤600 B ⇒ ≤400 wire
    // bytes escaped, tail ≤1 KiB ⇒ ≤2 KiB wire), a fully ③-shrunk wire (every tail ≤256 B)
    // tops out around ~24 KB — the ladder closes at ③. ④/⑤ exist for future field growth.
    const records: JobRecord[] = [];
    for (let i = 0; i < 20; i++) {
      records.push(
        job(`b_r${String(i).padStart(2, "0")}`, {
          command: fatCmd,
          logBytes: 40_000,
          createdAt: NOW - i,
        }),
      );
    }
    // 256 B tails: ③'s shrink would be a no-op, so IF the budget were exceedable this would
    // need ④. It is not exceedable — the wire passes through untouched.
    const tails: BashJobsTails = new Map(
      records.map((r) => [r.jobId, { text: '"'.repeat(256), logBytes: 40_960, at: NOW }]),
    );
    const wire = projectBashJobs(records, tails, NOW, noRetention)!;
    expect(bashJobsWireBytes(wire)).toBeLessThanOrEqual(BASH_JOBS_WIRE_BUDGET_BYTES);
    for (const r of wire.rows) expect(r.tail).toBe('"'.repeat(256));
  });

  it("mild input never trims (byte-identical pass-through of the caps)", () => {
    const rec = terminal("b_mild", { logBytes: 20 });
    const tails: BashJobsTails = new Map([["b_mild", { text: "ok", logBytes: 20, at: NOW }]]);
    const wire = projectBashJobs([rec], tails, NOW, noRetention)!;
    expect(wire.rows[0]!.tail).toBe("ok");
    expect(wire.omitted).toBeUndefined();
  });
});

describe("bashJobsLightFingerprint — D3-1", () => {
  it("running rows: logBytes and second-level elapsed do NOT flip it; minute bucket does", () => {
    const rec = job("b_r", { createdAt: NOW - 30_000, logBytes: 100 });
    const base = (at: number, bytes: number) =>
      bashJobsLightFingerprint(selectJobs([{ ...rec, logBytes: bytes }], at, noRetention), at);
    expect(base(NOW, 100)).toBe(base(NOW + 500, 5_000)); // same minute, logBytes grew
    expect(base(NOW, 100)).not.toBe(base(NOW + 60_000, 100)); // minute bucket advanced
  });

  it("terminal rows: logBytes (footer patch, R3-2), status, exitCode, grace all flip it", () => {
    const base = terminal("b_t", { logBytes: 100, endedAt: NOW - 1_000 });
    const fp = (r: JobRecord) => bashJobsLightFingerprint(selectJobs([r], NOW, noRetention), NOW);
    expect(fp(base)).not.toBe(fp({ ...base, logBytes: 140 }));
    expect(fp(base)).not.toBe(fp({ ...base, status: "failed", exitCode: 2 }));
    expect(fp(base)).not.toBe(
      fp({
        ...base,
        deadline: {
          timeoutMs: 1,
          policy: { graceMs: 1, maxExtensions: 1, maxTimeoutFactor: 1 },
          dueAt: 1,
          hardAt: 2,
          graceUntil: 3,
          graces: 1,
          graceNotified: 0,
          extensions: 0,
          grantedMs: 0,
          seq: 0,
        },
      }),
    );
  });

  it("row population and omitted ride the fingerprint (retention expiry flips it)", () => {
    const records = [job("b_a"), job("b_b")];
    const fp = (rs: readonly JobRecord[], at: number) => bashJobsLightFingerprint(selectJobs(rs, at, noRetention), at);
    expect(fp(records, NOW)).not.toBe(fp([records[0]!], NOW));
  });
});
