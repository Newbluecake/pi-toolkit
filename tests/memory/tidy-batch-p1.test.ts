import { describe, expect, it } from "vitest";
import type { Ident, JournalEvent, Loc, Obs } from "../../src/memory/contracts.js";
import { archiveSignals } from "../../src/memory/tidy/archive-signals.js";
import { headroomBytes, overheadFloorBytes, planBatches } from "../../src/memory/tidy/batch-plan.js";
import { editIndex } from "../../src/memory/tidy/index-edit.js";
import { decide, foldEvents, transitionRunState, validateRunEvents } from "../../src/memory/tidy/journal.js";
import { createLedger, reserve, settle, watcherCap } from "../../src/memory/tidy/run-ledger.js";
import { reduceSelection, selectionAction, selectionItems } from "../../src/memory/tidy/selection.js";

const live = (name: string): Loc => ({ area: "live", name });
const ident = (sha = "a".repeat(64), ino = 1): Ident => ({ dev: 1, ino, sha, size: 3 });
const file = (value: Ident): Obs => ({ kind: "file", ...value });
const intent = (op: Extract<JournalEvent, { ev: "intent" }>["op"]): Extract<JournalEvent, { ev: "intent" }> => ({
  ev: "intent",
  opId: "o1",
  seq: 1,
  step: 1,
  phase: "archive",
  op,
});

describe("tidy P1 pure logic", () => {
  it("covers MOVE rollback, roll-forward, and ownership conflicts", () => {
    const object = ident();
    const op = {
      prim: "MOVE" as const,
      src: live("a.md"),
      dst: { area: "archive" as const, name: "a.md" },
      obj: object,
    };
    expect(
      decide(intent(op), [
        { loc: op.src, obs: file(object) },
        { loc: op.dst, obs: { kind: "absent" } },
      ]).outcome,
    ).toBe("roll-back");
    expect(
      decide(intent(op), [
        { loc: op.src, obs: { kind: "absent" } },
        { loc: op.dst, obs: file(object) },
      ]).outcome,
    ).toBe("roll-forward");
    expect(
      decide(intent(op), [
        { loc: op.src, obs: file(object) },
        { loc: op.dst, obs: file(ident("b".repeat(64), 2)) },
      ]).outcome,
    ).toBe("conflict");
  });

  it.each([
    ["M1", "roll-back", "before", "absent"],
    ["M2", "roll-forward", "before", "after-same"],
    ["M3", "roll-forward", "absent", "after"],
    ["M4", "conflict", "before", "foreign"],
    ["M5", "conflict", "foreign", "absent"],
    ["M6", "conflict", "foreign", "after"],
    ["M7", "conflict", "absent", "foreign"],
    ["M8", "conflict", "absent", "absent"],
  ])("MOVE truth row %s", (_row, expected, sourceState, destinationState) => {
    const object = ident();
    const other = ident("b".repeat(64), 2);
    const op = {
      prim: "MOVE" as const,
      src: live("m.md"),
      dst: { area: "archive" as const, name: "m.md" },
      obj: object,
    };
    const sourceObs: Obs =
      sourceState === "before" ? file(object) : sourceState === "foreign" ? file(other) : { kind: "absent" };
    const destinationObs: Obs =
      destinationState === "after" || destinationState === "after-same"
        ? file(object)
        : destinationState === "foreign"
          ? file(other)
          : { kind: "absent" };
    const verdict = decide(intent(op), [
      { loc: op.src, obs: sourceObs },
      { loc: op.dst, obs: destinationObs },
    ]);
    expect(verdict.outcome).toBe(expected);
    const actionCounts: Record<string, number> = { M1: 0, M2: 1, M3: 0, M4: 0, M5: 0, M6: 0, M7: 0, M8: 0 };
    const leftoverCounts: Record<string, number> = { M1: 0, M2: 0, M3: 0, M4: 1, M5: 1, M6: 1, M7: 1, M8: 0 };
    expect(verdict.actions).toHaveLength(actionCounts[_row]);
    expect(verdict.leftovers).toHaveLength(leftoverCounts[_row]);
  });

  it("does not delete an unaccounted CREATE tmp", () => {
    const target = live("new.md");
    const tmp: Loc = { area: "tmp", within: "live", name: ".pt-aaaaaaaa-1-c.tmp" };
    const op = { prim: "CREATE" as const, target, afterSha: "a".repeat(64), tmpContent: tmp };
    const foreign = ident("b".repeat(64), 2);
    const verdict = decide(intent(op), [
      { loc: target, obs: { kind: "absent" } },
      { loc: tmp, obs: file(foreign) },
    ]);
    expect(verdict.outcome).toBe("conflict");
    expect(verdict.actions).toHaveLength(0);
  });

  it.each([
    ["C1", "roll-back", "absent", "absent", 0, 0],
    ["C2", "roll-back", "absent", "staged", 1, 0],
    ["C3", "conflict", "absent", "foreign", 0, 1],
    ["C4", "roll-forward", "after", "staged", 1, 0],
    ["C5", "roll-forward", "after", "absent", 0, 0],
    ["C6", "conflict", "after", "foreign", 0, 1],
    ["C7", "conflict", "foreign", "staged", 1, 1],
  ])("CREATE truth row %s", (_row, expected, targetState, tmpState, actionCount, leftoverCount) => {
    const target = live("c.md");
    const tmp: Loc = { area: "tmp", within: "live", name: ".pt-aaaaaaaa-1-c.tmp" };
    const content = ident("c".repeat(64), 3);
    const foreign = ident("f".repeat(64), 4);
    const op = { prim: "CREATE" as const, target, afterSha: content.sha, tmpContent: tmp };
    const staged: JournalEvent[] = [{ ev: "staged", opId: "o1", which: "content", tmp, ident: content }];
    const targetObs: Obs =
      targetState === "absent" ? { kind: "absent" } : targetState === "after" ? file(content) : file(foreign);
    const tmpObs: Obs =
      tmpState === "absent" ? { kind: "absent" } : tmpState === "staged" ? file(content) : file(foreign);
    const verdict = decide(
      [intent(op), ...staged],
      [
        { loc: target, obs: targetObs },
        { loc: tmp, obs: tmpObs },
      ],
    );
    expect(verdict.outcome).toBe(expected);
    expect(verdict.actions).toHaveLength(actionCount);
    expect(verdict.leftovers).toHaveLength(leftoverCount);
  });

  it.each([
    ["R1", "roll-back", "before", "absent", "staged", "staged"],
    ["R1x", "conflict", "before", "foreign", "staged", "foreign"],
    ["R2", "roll-forward", "after", "backup", "absent", "absent"],
    ["R2x", "conflict", "after", "backup", "foreign", "absent"],
    ["R3", "conflict", "after", "absent", "absent", "absent"],
    ["R4", "conflict", "foreign", "backup", "staged", "staged"],
    ["R5", "conflict", "absent", "backup", "absent", "absent"],
    ["R6", "conflict", "other", "absent", "absent", "absent"],
  ])("REPLACE truth row %s", (_row, expected, targetState, backupState, tmpBackupState, tmpContentState) => {
    const before = ident("a".repeat(64), 1);
    const backupIdent = ident("b".repeat(64), 2);
    const content = ident("c".repeat(64), 3);
    const foreign = ident("f".repeat(64), 4);
    const target = live("r.md");
    const backup: Loc = { area: "backup", name: "s1-1-live--r.md" };
    const tmpBackup: Loc = { area: "tmp", within: "backup", name: ".pt-aaaaaaaa-1-b.tmp" };
    const tmpContent: Loc = { area: "tmp", within: "live", name: ".pt-aaaaaaaa-1-c.tmp" };
    const op = { prim: "REPLACE" as const, target, before, afterSha: content.sha, backup, tmpBackup, tmpContent };
    const observation = (state: string, after: Ident): Obs =>
      state === "absent"
        ? { kind: "absent" }
        : state === "other"
          ? { kind: "other", reason: "symlink" }
          : file(
              state === "before"
                ? before
                : state === "after"
                  ? content
                  : state === "backup"
                    ? backupIdent
                    : state === "staged"
                      ? after
                      : foreign,
            );
    const staged: JournalEvent[] = [
      { ev: "staged", opId: "o1", which: "backup", tmp: tmpBackup, ident: backupIdent },
      { ev: "staged", opId: "o1", which: "content", tmp: tmpContent, ident: content },
    ];
    const verdict = decide(
      [intent(op), ...staged],
      [
        { loc: target, obs: observation(targetState, content) },
        { loc: backup, obs: observation(backupState, backupIdent) },
        { loc: tmpBackup, obs: observation(tmpBackupState, backupIdent) },
        { loc: tmpContent, obs: observation(tmpContentState, content) },
      ],
    );
    expect(verdict.outcome).toBe(expected);
    const actionCounts: Record<string, number> = { R1: 2, R1x: 1, R2: 0, R2x: 0, R3: 0, R4: 2, R5: 0, R6: 0 };
    const leftoverCounts: Record<string, number> = { R1: 0, R1x: 2, R2: 0, R2x: 1, R3: 0, R4: 1, R5: 0, R6: 1 };
    expect(verdict.actions).toHaveLength(actionCounts[_row]);
    expect(verdict.leftovers).toHaveLength(leftoverCounts[_row]);
  });

  it("folds attempts/results and permits a new run after terminal", () => {
    const events: JournalEvent[] = [
      { ev: "run", state: "applying", epoch: 2 },
      {
        ev: "intent",
        opId: "o1",
        seq: 1,
        step: 1,
        phase: "archive",
        op: { prim: "MOVE", src: live("a.md"), dst: { area: "archive", name: "a.md" }, obj: ident() },
      },
      { ev: "attempt", opId: "o1", by: "recovery", n: 1 },
      { ev: "result", opId: "o1", state: "rolled-back", final: [] },
      { ev: "run", state: "recovered", epoch: 2 },
    ];
    const folded = foldEvents({ v: 2, id: "tidy-1", kind: "batch", createdAt: "now", events });
    expect(folded.attempts.size).toBe(1);
    expect(folded.terminal).toBe(true);
    expect(transitionRunState("recovered", "applying").ok).toBe(true);
  });

  it("enforces the full terminal state transition matrix", () => {
    expect(transitionRunState(undefined, "applying").ok).toBe(true);
    expect(transitionRunState("applying", "complete", { allResults: true, hasConflict: false }).ok).toBe(true);
    expect(transitionRunState("applying", "aborted", { allResults: true, hasConflict: false }).ok).toBe(true);
    expect(transitionRunState("applying", "conflict-reported", { allResults: true, hasConflict: true }).ok).toBe(true);
    expect(transitionRunState("applying", "complete", { allResults: true, hasConflict: true }).ok).toBe(false);
    expect(transitionRunState("applying", "conflict-reported", { allResults: true, hasConflict: false }).ok).toBe(
      false,
    );
    expect(transitionRunState("applying", "interrupted", { ownerAlive: false }).ok).toBe(true);
    expect(transitionRunState("interrupted", "interrupted", { ownerRevoked: true }).ok).toBe(true);
    expect(transitionRunState("interrupted", "recovered", { allResults: true, hasConflict: false }).ok).toBe(true);
    expect(transitionRunState("interrupted", "conflict-reported", { allResults: true, hasConflict: true }).ok).toBe(
      true,
    );
    expect(transitionRunState("interrupted", "recovered", { allResults: true, hasConflict: true }).ok).toBe(false);
    expect(transitionRunState("interrupted", "conflict-reported", { allResults: true, hasConflict: false }).ok).toBe(
      false,
    );
    expect(transitionRunState("recovered", "applying").ok).toBe(true);

    const good: JournalEvent[] = [
      { ev: "run", state: "applying", epoch: 0 },
      {
        ev: "intent",
        opId: "o1",
        seq: 1,
        step: 1,
        phase: "archive",
        op: { prim: "MOVE", src: live("a.md"), dst: { area: "archive", name: "a.md" }, obj: ident() },
      },
      { ev: "result", opId: "o1", state: "done", final: [] },
      { ev: "run", state: "complete", epoch: 0 },
    ];
    expect(validateRunEvents(good).ok).toBe(true);
    expect(validateRunEvents([...good.slice(0, 3), { ev: "run", state: "conflict-reported", epoch: 0 }]).ok).toBe(
      false,
    );
  });

  it("packs every fitting candidate under both hard limits", () => {
    const result = planBatches(
      Array.from({ length: 45 }, (_, i) => ({ name: `topic-${String(i)}.md`, body: "x".repeat(10), k1: "topic" })),
      { targetBytes: 100, maxInputBytes: 100 },
    );
    expect(result.reported).toHaveLength(0);
    expect(result.batches.every((batch) => batch.files.length <= 20 && batch.bytes <= 100)).toBe(true);
    expect(result.batches.flatMap((batch) => batch.files)).toHaveLength(45);
  });

  it("isolates files at the topic byte threshold", () => {
    const result = planBatches(
      [
        { name: "a.md", body: "x".repeat(20), k1: "topic" },
        { name: "b.md", body: "x".repeat(10), k1: "topic" },
        { name: "c.md", body: "x".repeat(10), k1: "topic" },
      ],
      { targetBytes: 100, maxInputBytes: 100, topicMaxBytes: 20 },
    );
    expect(result.reported).toHaveLength(0);
    expect(result.batches.map((batch) => batch.files.map((file) => file.name))).toEqual([["a.md"], ["b.md", "c.md"]]);
  });

  it("computes measured headroom and keeps the schema overhead floor positive", () => {
    expect(headroomBytes({ contextWindow: 1000, maxTokens: 100, overheadBytes: 200 })).toBe(1600);
    expect(headroomBytes({ contextWindow: 10, maxTokens: 20, overheadBytes: 0 })).toBe(0);
    expect(overheadFloorBytes).toBeGreaterThan(0);
  });

  it("edits only standalone archive links and reports unsupported references", () => {
    const source = "- [old](archive/old.md)\n- [keep](../keep.md)\n[ref]: archive/old.md\n- [next](archive/next.md)";
    const result = editIndex(source, new Set(["old.md", "next.md"]));
    expect(result.text).toContain("keep");
    expect(result.text).not.toContain("- [old](archive/old.md)");
    expect(result.text).toContain("archive/old.md");
    expect(result.text).not.toContain("- [next](archive/next.md)");
    expect(result.manual.some((item) => item.reason.includes("reference"))).toBe(true);
  });

  it("applies bounded ledger reservations and invalid-cost fallback", () => {
    let ledger = createLedger(5);
    const first = reserve(ledger, "r1", 3);
    expect(first.ok).toBe(true);
    ledger = first.state;
    expect(watcherCap(ledger, "r1")).toBe(5);
    const settled = settle(ledger, { runId: "r1", costUsd: Number.NaN, estimatedUsd: 2 });
    expect(settled.charged).toBe(3);
    expect(settled.state.spentUsd).toBe(3);
  });

  it("keeps orphan archive signals visible but not suggested", () => {
    const fileLike = { name: "old.md", body: "completed", meta: { status: "active", pin: false } } as never;
    const signal = archiveSignals(fileLike, { orphan: true, now: Date.UTC(2025, 0, 1) });
    expect(signal.signals).toContain("S5");
    expect(signal.suggested).toBe(false);
  });

  it("fails closed for unknown selection labels and conflicts", () => {
    const state = {
      candidates: [{ name: "a.md", bytes: 1, conflict: true, suggested: true }],
      selected: new Set<string>(),
    };
    expect(selectionAction(selectionItems(state), "not a real label").kind).toBe("cancel");
    const next = reduceSelection(state, { kind: "toggle", name: "a.md" });
    expect(next.selected.size).toBe(0);
  });
});
