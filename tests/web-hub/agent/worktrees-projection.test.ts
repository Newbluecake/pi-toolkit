/**
 * worktree-web plan §4.2/§7 (W2): the `projectWorktrees` budget ladder + fingerprint.
 * Mirrors `tests/web-hub/agent/todo-projection.test.ts`'s posture for `projectTodo`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  WT_LABEL_MAX_BYTES,
  WT_MAX_ROWS,
  WT_WIRE_BUDGET_BYTES,
  projectWorktrees,
  worktreesFingerprint,
} from "../../../src/web-hub/agent/worktrees.js";
import { WorktreesWireSchema } from "../../../src/web-hub/protocol/messages.js";
import type { ScanResult, ScannedWorktree } from "../../../src/git/worktrees.js";

type OkScan = Extract<ScanResult, { kind: "ok" }>;

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function row(over: Partial<ScannedWorktree> = {}): ScannedWorktree {
  return {
    path: "/home/u/ai/pi-toolkit",
    head: "0123456789abcdef0123456789abcdef01234567",
    branch: "master",
    main: false,
    current: false,
    ...over,
  };
}

function scan(worktrees: ScannedWorktree[], over: Partial<OkScan> = {}): OkScan {
  return { kind: "ok", toplevel: "/home/u/ai/pi-toolkit", listCapped: false, worktrees, ...over };
}

describe("projectWorktrees", () => {
  it("abbreviates the home prefix in label but keeps the full path", () => {
    const wire = projectWorktrees(
      scan([row({ path: "/home/u/ai/pi-toolkit", current: true, main: true })]),
      "/home/u",
      1,
    );
    expect(wire.rows[0]).toMatchObject({ label: "~/ai/pi-toolkit", path: "/home/u/ai/pi-toolkit" });
  });

  it("truncates head to 7 chars", () => {
    const wire = projectWorktrees(scan([row({ head: "fedcba9876543210fedcba9876543210fedcba9" })]), undefined, 1);
    expect(wire.rows[0]?.head).toBe("fedcba9");
  });

  it("maps a pi-agent-* branch to agentRunId and counts it", () => {
    const wire = projectWorktrees(scan([row({ branch: "pi-agent-run-1", agentRunId: "run-1" })]), undefined, 1);
    expect(wire.rows[0]?.agentRunId).toBe("run-1");
    expect(wire.agentCount).toBe(1);
  });

  it("flags are present only as `true`, never `false`", () => {
    const wire = projectWorktrees(scan([row({ current: true, main: true, bare: true, locked: true })]), undefined, 1);
    const r = wire.rows[0]!;
    expect(r.current).toBe(true);
    expect(r.main).toBe(true);
    expect(r.bare).toBe(true);
    expect(r.locked).toBe(true);
    expect("prunable" in r).toBe(false);
  });

  it("counts (total/probed/dirtyCount/agentCount) are full-population, independent of the 24-row cap", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({
        path: `/home/u/wt-${i}`,
        current: i === 0,
        main: i === 0,
        agentRunId: i % 2 === 0 ? `run-${i}` : undefined,
        probe:
          i % 3 === 0
            ? { dirty: i, dirtyCapped: false, untrackedSkipped: false, upstream: false, ahead: 0, behind: 0 }
            : undefined,
      }),
    );
    const wire = projectWorktrees(scan(rows), undefined, 1);
    expect(wire.rows.length).toBe(WT_MAX_ROWS);
    expect(wire.total).toBe(40);
    expect(wire.omitted).toBe(40 - WT_MAX_ROWS);
    expect(wire.agentCount).toBe(20); // every even index
    expect(wire.probed).toBe(Math.ceil(40 / 3)); // i % 3 === 0: 0,3,...,39 -> 14
    expect(wire.dirtyCount).toBe(wire.probed - 1); // all but i=0 (dirty=0) have dirty>0
  });

  it("CJK branch names are truncated on a UTF-8 code-point boundary, never split mid-character", () => {
    const branch = "特性".repeat(200); // far beyond the 200-byte cap, all 3-byte code points
    const wire = projectWorktrees(scan([row({ branch })]), undefined, 1);
    const b = wire.rows[0]?.branch;
    expect(b).toBeDefined();
    expect(Buffer.byteLength(b!, "utf8")).toBeLessThanOrEqual(200);
    expect(Buffer.from(b!, "utf8").toString("utf8")).toBe(b); // round-trips cleanly: no split code point
  });

  it("budget pass 2: drops `path` tail-first when the wire exceeds 16 KiB, keeping `label`", () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      row({ path: `/home/u/${"x".repeat(1200)}-${i}`, current: i === 0, main: i === 0 }),
    );
    const wire = projectWorktrees(scan(rows), "/home/u", 1);
    expect(byteSize(wire)).toBeLessThanOrEqual(WT_WIRE_BUDGET_BYTES);
    expect(wire.rows.length).toBe(24); // pass 2 alone was enough, no row dropped
    // some tail rows lost `path`, every row kept its `label`
    const withPath = wire.rows.filter((r) => r.path !== undefined).length;
    expect(withPath).toBeLessThan(wire.rows.length);
    for (const r of wire.rows) expect(r.label.length).toBeGreaterThan(0);
    // index 0 is never touched by pass 2 or 3
    expect(wire.rows[0]?.current).toBe(true);
    expect(wire.rows[0]?.path).toBeDefined();
  });

  it("budget pass 3: drops whole rows from the tail once path-stripping alone cannot fit, index 0 survives", () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      row({
        path: `/home/u/${"x".repeat(1200)}-${i}`,
        branch: '"'.repeat(500), // quote-heavy: JSON-escaping roughly doubles its serialized size
        agentRunId: '"'.repeat(150),
        current: i === 0,
        main: i === 0,
      }),
    );
    const wire = projectWorktrees(scan(rows), "/home/u", 1);
    expect(byteSize(wire)).toBeLessThanOrEqual(WT_WIRE_BUDGET_BYTES);
    expect(wire.rows.length).toBeLessThan(24);
    expect(wire.rows[0]?.current).toBe(true);
    expect(wire.omitted).toBeGreaterThan(0);
  });

  it("property: label never exceeds its byte cap regardless of path content (fast-check)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", minLength: 0, maxLength: 2000 }), (path) => {
        const wire = projectWorktrees(
          scan([row({ path: path.length > 0 ? path : "/x", current: true, main: true })]),
          "/home",
          1,
        );
        expect(Buffer.byteLength(wire.rows[0]!.label, "utf8")).toBeLessThanOrEqual(WT_LABEL_MAX_BYTES);
      }),
      { numRuns: 100 },
    );
  });

  describe("fingerprint", () => {
    it("is stable within the same minute bucket and changes when a row's dirty count changes", () => {
      const a = projectWorktrees(scan([row({ current: true, main: true, probe: dirtyProbe(0) })]), undefined, 1000);
      const b = projectWorktrees(scan([row({ current: true, main: true, probe: dirtyProbe(0) })]), undefined, 30000);
      const c = projectWorktrees(scan([row({ current: true, main: true, probe: dirtyProbe(1) })]), undefined, 1000);
      expect(worktreesFingerprint(a)).toBe(worktreesFingerprint(b)); // same floor(sampledAt/60s) bucket
      expect(worktreesFingerprint(a)).not.toBe(worktreesFingerprint(c));
    });

    it("changes once sampledAt crosses a minute bucket", () => {
      const a = projectWorktrees(scan([row({ current: true, main: true })]), undefined, 1000);
      const b = projectWorktrees(scan([row({ current: true, main: true })]), undefined, 61000);
      expect(worktreesFingerprint(a)).not.toBe(worktreesFingerprint(b));
    });

    it("changes when staleMin changes and is empty for undefined", () => {
      const base = projectWorktrees(scan([row({ current: true, main: true })]), undefined, 1);
      expect(worktreesFingerprint(undefined)).toBe("");
      expect(worktreesFingerprint(base)).not.toBe(worktreesFingerprint({ ...base, staleMin: 2 }));
      expect(worktreesFingerprint({ ...base, staleMin: 2 })).toBe(worktreesFingerprint({ ...base, staleMin: 2 }));
    });
  });
});

function dirtyProbe(dirty: number): NonNullable<ScannedWorktree["probe"]> {
  return { dirty, dirtyCapped: false, untrackedSkipped: false, upstream: false, ahead: 0, behind: 0 };
}

// --- property test: any scan result's projection always passes WorktreesWireSchema and fits budget ---

const binaryStr = (maxLength: number) => fc.string({ unit: "binary", minLength: 0, maxLength });

const scannedWorktreeArb: fc.Arbitrary<ScannedWorktree> = fc.record(
  {
    path: binaryStr(300).map((s) => (s.length > 0 ? `/home/u/${s}` : "/home/u/x")),
    head: fc.option(binaryStr(64), { nil: undefined }),
    branch: fc.option(binaryStr(300), { nil: undefined }),
    detached: fc.option(fc.constant(true as const), { nil: undefined }),
    bare: fc.option(fc.constant(true as const), { nil: undefined }),
    locked: fc.option(fc.constant(true as const), { nil: undefined }),
    prunable: fc.option(fc.constant(true as const), { nil: undefined }),
    main: fc.boolean(),
    current: fc.boolean(),
    agentRunId: fc.option(binaryStr(150), { nil: undefined }),
    probe: fc.option(
      fc.record({
        dirty: fc.integer({ min: 0, max: 100000 }),
        dirtyCapped: fc.boolean(),
        untrackedSkipped: fc.boolean(),
        upstream: fc.boolean(),
        ahead: fc.integer({ min: 0, max: 100000 }),
        behind: fc.integer({ min: 0, max: 100000 }),
      }),
      { nil: undefined },
    ),
    unprobed: fc.option(fc.constantFrom("cap" as const, "timeout" as const, "error" as const), { nil: undefined }),
  },
  { requiredKeys: ["path", "main", "current"] },
);

const okScanArb: fc.Arbitrary<OkScan> = fc.record({
  kind: fc.constant("ok" as const),
  toplevel: fc.constant("/home/u/ai/pi-toolkit"),
  listCapped: fc.boolean(),
  worktrees: fc.array(scannedWorktreeArb, { minLength: 1, maxLength: 60 }),
});

describe("projectWorktrees (property)", () => {
  it("self-check: the generator actually produces control characters and high-Unicode code points", () => {
    const samples = fc.sample(binaryStr(50), 200).join("");
    const hasControl = /[\u0000-\u001f]/.test(samples);
    const hasHighUnicode = Array.from(samples).some((ch) => (ch.codePointAt(0) ?? 0) > 0xffff);
    expect(hasControl || hasHighUnicode).toBe(true);
  });

  it("any ok scan's projection always passes WorktreesWireSchema and fits the 16 KiB budget", () => {
    fc.assert(
      fc.property(okScanArb, fc.constantFrom("/home/u", undefined), (scanResult, home) => {
        const wire = projectWorktrees(scanResult, home, Date.now());
        expect(Value.Check(WorktreesWireSchema, wire)).toBe(true);
        expect(byteSize(wire)).toBeLessThanOrEqual(WT_WIRE_BUDGET_BYTES);
        expect(wire.rows.length).toBeLessThanOrEqual(WT_MAX_ROWS);
      }),
      { numRuns: 200 },
    );
  });
});
