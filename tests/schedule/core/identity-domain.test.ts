/**
 * Start-domain judging for scheduled runs (darwin-plan §3.P1 测试, arch §4.2/§4.3).
 *
 * Darwin holders persist `start` as epoch-ms while Linux persists /proc clock ticks; a value from
 * the OTHER domain must never be interpreted as "pid reuse" (that would kill a live foreign
 * holder) — it judges `unprovable`. Same-domain values keep the exact deterministic matrix:
 * equal ⇒ alive, different ⇒ dead(crash), unreadable ⇒ unprovable. All pure — tier 1, no probe
 * touches the filesystem.
 *
 * Also pins the judge call-chain inventory (J1–J7): every `judgeHolder` / `recoverDeadRuns` /
 * `recoverRuns` / `unknownRunKeys` call site in src is enumerated here, and the agent-side sites
 * must forward the probe — a future call site that forgets it turns this suite red until it is
 * registered and wired (darwin-plan review #6).
 */
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyStateFile,
  isTerminalRunState,
  type Holder,
  type RunRecord,
  type ScheduleRunState,
} from "../../../src/schedule/core/spec.js";
import {
  judgeHolder,
  procLivenessProbe,
  recoverDeadRuns,
  SCHED_EPOCH_MS_FLOOR,
  startDomainOf,
  unknownRunKeys,
  type LivenessProbe,
  type ProcessIdentity,
} from "../../../src/schedule/core/recovery.js";
import { JUDGE_MANIFEST } from "./fdpath-manifest.js";

const ROOT = join(import.meta.dirname, "../../..");

// ----------------------------------------------------------------- start-domain classification

describe("startDomainOf", () => {
  it("splits at 1e11: below ⇒ ticks, at/above ⇒ epoch-ms", () => {
    expect(startDomainOf(0)).toBe("ticks");
    expect(startDomainOf(99_999_999_999)).toBe("ticks");
    expect(startDomainOf(100_000_000_000)).toBe("epoch-ms");
    expect(startDomainOf(1.795e12)).toBe("epoch-ms");
    expect(SCHED_EPOCH_MS_FLOOR).toBe(100_000_000_000);
  });
});

// ----------------------------------------------------------------- judgeHolder domain matrix

const SELF_START = Date.UTC(2026, 10, 17, 5, 40, 6); // epoch-ms domain (~1.795e12)
const self: ProcessIdentity = { pid: 100, start: SELF_START, host: "h", boot: "b" };

interface ProbeScript {
  start?: (pid: number) => number | undefined | "error";
  mayExist?: boolean;
  calls?: { startOf: number };
}

/** A Darwin-shaped probe: `startDomain: "epoch-ms"`, fully scripted, call-counted. */
function darwinProbe(script: ProbeScript = {}): LivenessProbe {
  return {
    startDomain: "epoch-ms",
    startOf: (pid) => {
      if (script.calls) script.calls.startOf++;
      return script.start ? script.start(pid) : SELF_START;
    },
    pidMayExist: () => script.mayExist ?? true,
  };
}

describe("judgeHolder with a start-domain probe", () => {
  it("cross-domain holder ⇒ unprovable, even when the probe could see a different value", () => {
    // A Linux-ticks holder (small number) must never be treated as "pid reused" on Darwin.
    const script: ProbeScript = { start: () => SELF_START, calls: { startOf: 0 } };
    const probe = darwinProbe(script);
    expect(judgeHolder({ pid: 200, start: 99_999_999_999, host: "h", boot: "b" }, self, { probe })).toEqual({
      liveness: "unprovable",
    });
    expect(script.calls!.startOf).toBe(0); // the domain check fires before any probing
  });

  it("same-domain same-value ⇒ alive; same-domain different value ⇒ dead(crash)", () => {
    expect(
      judgeHolder({ pid: 200, start: 100_000_000_000, host: "h", boot: "b" }, self, {
        probe: darwinProbe({ start: () => 100_000_000_000 }),
      }),
    ).toEqual({ liveness: "alive" });
    expect(
      judgeHolder({ pid: 200, start: SELF_START + 1_000, host: "h", boot: "b" }, self, {
        probe: darwinProbe({ start: () => SELF_START }),
      }),
    ).toEqual({ liveness: "dead", cause: "crash" });
  });

  it('probe "error" ⇒ unprovable; gone pid with no existence residue ⇒ dead(crash)', () => {
    expect(
      judgeHolder({ pid: 200, start: SELF_START, host: "h", boot: "b" }, self, {
        probe: darwinProbe({ start: () => "error" }),
      }),
    ).toEqual({ liveness: "unprovable" });
    expect(
      judgeHolder({ pid: 200, start: SELF_START, host: "h", boot: "b" }, self, {
        probe: darwinProbe({ start: () => undefined, mayExist: true }),
      }),
    ).toEqual({ liveness: "unprovable" });
    expect(
      judgeHolder({ pid: 200, start: SELF_START, host: "h", boot: "b" }, self, {
        probe: darwinProbe({ start: () => undefined, mayExist: false }),
      }),
    ).toEqual({ liveness: "dead", cause: "crash" });
  });

  it("same-second pid reuse judges alive — accepted residual evidence (arch §4.2: delays recovery, never kills)", () => {
    // A reused pid inside the same second of the same boot is indistinguishable from the original.
    const probe = darwinProbe({ start: () => SELF_START });
    expect(judgeHolder({ pid: 200, start: SELF_START, host: "h", boot: "b" }, self, { probe })).toEqual({
      liveness: "alive",
    });
  });

  it("same-process holders short-circuit before any probe call (0 subprocesses)", () => {
    const script: ProbeScript = { calls: { startOf: 0 } };
    const probe = darwinProbe(script);
    expect(judgeHolder({ pid: 100, start: SELF_START, host: "h", boot: "b" }, self, { probe })).toEqual({
      liveness: "alive",
    });
    expect(
      judgeHolder({ pid: 100, start: SELF_START, host: "h", boot: "b", epoch: "old" }, self, {
        probe,
        currentEpoch: "now",
        epochDisposed: () => true,
      }),
    ).toEqual({ liveness: "dead", cause: "reload" });
    expect(script.calls!.startOf).toBe(0);
  });

  it("host/boot differences still fire before any domain judgment", () => {
    const script: ProbeScript = { calls: { startOf: 0 } };
    const probe = darwinProbe(script);
    expect(judgeHolder({ pid: 200, start: SELF_START, host: "other", boot: "b" }, self, { probe })).toEqual({
      liveness: "unprovable",
    });
    expect(judgeHolder({ pid: 200, start: SELF_START, host: "h", boot: "b2" }, self, { probe })).toEqual({
      liveness: "dead",
      cause: "crash",
    });
    expect(script.calls!.startOf).toBe(0);
  });
});

describe("judgeHolder with a domain-less probe (Linux matrix unchanged)", () => {
  const ticksProbe: LivenessProbe = { startOf: () => 123, pidMayExist: () => true };

  it("compares raw values even when they look like the other domain", () => {
    expect(judgeHolder({ pid: 200, start: 123, host: "h", boot: "b" }, self, { probe: ticksProbe })).toEqual({
      liveness: "alive",
    });
    expect(judgeHolder({ pid: 200, start: 456, host: "h", boot: "b" }, self, { probe: ticksProbe })).toEqual({
      liveness: "dead",
      cause: "crash",
    });
    expect(procLivenessProbe.startDomain).toBeUndefined();
  });
});

// ----------------------------------------------------------------- recovery with a probe

function holderOf(pid: number, start: number, boot = "b"): Holder {
  return { pid, start, host: "h", boot, epoch: `e${pid}` };
}

function run(holder: Holder, state: ScheduleRunState, runKey: string): RunRecord {
  return {
    runKey,
    taskId: "t1",
    kind: "auto",
    form: "background",
    scheduledAt: 0,
    defHash: "d",
    state,
    holder,
    startedAt: 0,
    note: "none",
  };
}

function stateWith(...runs: RunRecord[]) {
  const state = emptyStateFile("s1");
  state.runs.push(...runs);
  return state;
}

describe("recoverDeadRuns / unknownRunKeys with a start-domain probe", () => {
  it("recoverDeadRuns: dead external holder ⇒ unknown(crash) / dropped(owner-closed)", () => {
    const state = stateWith(
      run(holderOf(200, SELF_START), "running", "r1"),
      run(holderOf(201, SELF_START), "queued", "r2"),
    );
    const out = recoverDeadRuns(state, self, 5_000, {
      probe: darwinProbe({ start: () => SELF_START + 60_000 }),
    });
    expect(out).toEqual([
      { runKey: "r1", from: "running", to: "unknown", reason: "crash" },
      { runKey: "r2", from: "queued", to: "dropped", reason: "owner-closed" },
    ]);
    expect(state.runs[0]!.state).toBe("unknown");
    expect(state.runs[1]!.state).toBe("dropped");
  });

  it("recoverDeadRuns: same-domain alive and cross-domain holders are left alone", () => {
    const state = stateWith(
      run(holderOf(200, SELF_START), "running", "alive"),
      run(holderOf(201, 99_999_999_999), "running", "ticks"),
    );
    const out = recoverDeadRuns(state, self, 5_000, { probe: darwinProbe({ start: () => SELF_START }) });
    expect(out).toEqual([]);
    expect(state.runs.map((r) => r.state)).toEqual(["running", "running"]);
  });

  it("unknownRunKeys: unknown runs listed; dead ⇒ listed; alive / cross-domain / terminal ⇒ not", () => {
    const state = stateWith(
      run(holderOf(200, SELF_START), "unknown", "u1"),
      run(holderOf(201, SELF_START), "running", "dead"),
      run(holderOf(202, SELF_START), "running", "live"),
      run(holderOf(203, 99_999_999_999), "running", "ticks"),
      run(holderOf(204, SELF_START), "completed", "done"),
    );
    const probe = darwinProbe({
      start: (pid) => (pid === 201 ? SELF_START + 60_000 : SELF_START),
    });
    expect(unknownRunKeys(state, self, { probe })).toEqual(["u1", "dead"]);
    // terminal-state vocabulary sanity: "completed" and "unknown" are terminal
    expect(isTerminalRunState("completed")).toBe(true);
    expect(isTerminalRunState("unknown")).toBe(true);
  });
});

// ----------------------------------------------------------------- judge call-chain inventory (J1–J7)

interface Site {
  file: string;
  fn: string;
  callee: string;
  /** Substring the call's argument list must contain (probe wiring / opts forwarding). */
  arg: string;
}

/**
 * The complete expected inventory (darwin-plan §3.P1-b): a new unregistered call site goes red.
 * `arg` pins HOW each site stays probe-reachable:
 *  - internal recovery/claim/clock sites forward the caller's judge opts (probe rides in them);
 *  - note/digest sites pass `probe` explicitly;
 *  - the two hub sites are the read-only projection (J6/J7): probe injection lands in P4-A —
 *    they are registered in JUDGE_MANIFEST and pinned here so new hub wiring cannot regress silently.
 */
const EXPECTED_SITES: Site[] = [
  { file: "src/schedule/core/recovery.ts", fn: "recoverDeadRuns", callee: "judgeHolder", arg: "opts" },
  { file: "src/schedule/core/recovery.ts", fn: "unknownRunKeys", callee: "judgeHolder", arg: "opts" },
  { file: "src/schedule/core/claim.ts", fn: "recoverRuns", callee: "recoverDeadRuns", arg: "opts" },
  { file: "src/schedule/agent/clock.ts", fn: "doRecover", callee: "recoverRuns", arg: "deps.judge" },
  { file: "src/schedule/agent/note.ts", fn: "claimAndSend", callee: "judgeHolder", arg: "probe" },
  { file: "src/schedule/agent/note.ts", fn: "verify", callee: "judgeHolder", arg: "probe" },
  { file: "src/schedule/agent/digest.ts", fn: "resolveInflight", callee: "judgeHolder", arg: "probe" },
  { file: "src/web-hub/hub/schedule/service.ts", fn: "predictUnknowns", callee: "judgeHolder", arg: "self" },
  { file: "src/web-hub/hub/schedule/service.ts", fn: "predictUnknowns", callee: "judgeHolder", arg: "self" },
];

const JUDGE_CALLEES = ["judgeHolder", "recoverDeadRuns", "recoverRuns", "unknownRunKeys"] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Extract the balanced argument text starting at `source[open]` (an opening paren). */
function callArgs(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

interface Derived extends Site {
  args: string;
}

/** Scan every schedule/hub-schedule source file for judge call sites (comments stripped). */
function deriveSites(): Derived[] {
  const files = [
    ...globSync("src/schedule/**/*.ts", { cwd: ROOT }),
    ...globSync("src/web-hub/hub/schedule/*.ts", { cwd: ROOT }),
  ];
  const derived: Derived[] = [];
  for (const rel of files) {
    const source = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    const lines = source.split("\n");
    const offsets: number[] = [];
    let at = 0;
    for (const line of lines) {
      offsets.push(at);
      at += line.length + 1;
    }
    let fn = "";
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      // enclosing function: `function NAME(…)` declarations and declaration-arrows
      // (`const NAME = (…) =>` / `const NAME = async (…) =>`). Plain `const x = call(…)` lines and
      // `.map(x => …)` callback arrows do NOT re-label — those calls belong to the enclosing fn.
      const fnDecl = line.match(/(?:async\s+)?function\s+(\w+)/);
      const arrowDecl = fnDecl ? null : line.match(/const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]*)?=>/);
      if (fnDecl) fn = fnDecl[1]!;
      else if (arrowDecl) fn = arrowDecl[1]!;
      for (const callee of JUDGE_CALLEES) {
        for (const m of line.matchAll(new RegExp(`\\b${callee}\\(`, "g"))) {
          const before = line.slice(Math.max(0, m.index - 20), m.index);
          if (/\bfunction\s*$/.test(before)) continue; // declaration, not a call
          const open = offsets[li]! + m.index + m[0].length - 1;
          derived.push({ file: rel, fn, callee, arg: "", args: callArgs(source, open) });
        }
      }
    }
  }
  return derived;
}

const siteKey = (s: { file: string; fn: string; callee: string }): string => `${s.file}|${s.fn}|${s.callee}`;

describe("judge call-chain inventory (J1–J7, darwin-plan §3.P1-b)", () => {
  it("every judgeHolder/recoverDeadRuns/recoverRuns/unknownRunKeys call site is inventoried and probe-wired", () => {
    const derived = deriveSites();
    const count = (xs: string[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const x of xs) out[x] = (out[x] ?? 0) + 1;
      return out;
    };
    expect(count(derived.map(siteKey))).toEqual(count(EXPECTED_SITES.map(siteKey)));
    for (const d of derived) {
      const wanted = EXPECTED_SITES.find((s) => siteKey(s) === siteKey(d))!;
      expect(d.args.includes(wanted.arg), `${d.file}:${d.fn} ${d.callee} must pass "${wanted.arg}"`).toBe(true);
    }
  });

  it("JUDGE_MANIFEST registers the derived judge sites per file (note×2, digest×1, wire clock-judge×1, service×2)", () => {
    const manifestFiles: Record<string, number> = {};
    for (const entry of JUDGE_MANIFEST) {
      const file = entry.slice(0, entry.indexOf(":"));
      manifestFiles[file] = (manifestFiles[file] ?? 0) + 1;
    }
    expect(manifestFiles).toEqual({ "note.ts": 2, "digest.ts": 1, "wire.ts": 1, "service.ts": 2 });
    const derived = deriveSites();
    for (const [file, wanted] of [
      ["note.ts", 2],
      ["digest.ts", 1],
      ["service.ts", 2],
    ] as const) {
      expect(derived.filter((s) => s.file.endsWith(file)).length, file).toBe(wanted);
    }
  });

  it("the wire clock judge config carries the probe (J4: clock → recoverRuns → recoverDeadRuns)", () => {
    const wire = stripComments(readFileSync(join(ROOT, "src/schedule/agent/wire.ts"), "utf8"));
    expect(/judge:\s*\{[^}]*probe/.test(wire)).toBe(true);
  });
});
