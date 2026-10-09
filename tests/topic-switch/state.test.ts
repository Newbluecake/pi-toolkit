import { describe, expect, it } from "vitest";
import {
  COOLDOWN_OUTCOMES,
  cooldownActive,
  initialHoldState,
  isCooldownOutcome,
  stepHold,
  type HoldEffect,
  type HoldEvent,
  type HoldPhase,
  type HoldState,
} from "../../src/topic-switch/state.js";
import { ENTRY_TYPE } from "../../src/topic-switch/records.js";
import type { EntryLike, JudgeVerdictLike } from "../../src/topic-switch/types.js";

const MIN_CONF = 0.7;

const judgedOkUnrelated: JudgeVerdictLike = { kind: "ok", related: false, confidence: 0.9 };
const judgedOkUnrelatedLowConf: JudgeVerdictLike = { kind: "ok", related: false, confidence: 0.5 };
const judgedRelated: JudgeVerdictLike = { kind: "ok", related: true, confidence: 0.95 };
const judgedTimeout: JudgeVerdictLike = { kind: "timeout" };

function state(phase: HoldPhase): HoldState {
  return { phase };
}

function run(phase: HoldPhase, ev: HoldEvent): { phase: HoldPhase; fx: readonly HoldEffect[] } {
  const result = stepHold(state(phase), ev, MIN_CONF);
  return { phase: result.s.phase, fx: result.fx };
}

const fx = (...effects: HoldEffect[]): readonly HoldEffect[] => effects;
// typed constructor (keep the table below plain)
const rec = (outcome: Parameters<typeof isCooldownOutcome>[0]): HoldEffect => ({ e: "record", outcome });

describe("stepHold · transition matrix (表驱动)", () => {
  const cases: Array<{ phase: HoldPhase; ev: HoldEvent; out: HoldPhase; fx: readonly HoldEffect[] }> = [
    // ── judging ──
    { phase: "judging", ev: { t: "judged", v: judgedOkUnrelated }, out: "confirming", fx: fx({ e: "confirm" }) },
    {
      phase: "judging",
      ev: { t: "judged", v: judgedRelated },
      out: "releasing",
      fx: fx({ e: "release" }, rec("related")),
    },
    {
      phase: "judging",
      ev: { t: "judged", v: judgedOkUnrelatedLowConf },
      out: "releasing",
      fx: fx({ e: "release" }, rec("related")),
    },
    {
      phase: "judging",
      ev: { t: "judged", v: judgedTimeout },
      out: "releasing",
      fx: fx({ e: "release" }, rec("judge-timeout")),
    },
    {
      phase: "judging",
      ev: { t: "judged", v: { kind: "error" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("judge-error")),
    },
    {
      phase: "judging",
      ev: { t: "judged", v: { kind: "parse-error" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("judge-parse")),
    },
    {
      phase: "judging",
      ev: { t: "judged", v: { kind: "no-model" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("no-model")),
    },
    {
      phase: "judging",
      ev: { t: "judged", v: { kind: "aborted" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("judge-error")),
    },
    { phase: "judging", ev: { t: "confirmed", o: { kind: "switch" } }, out: "judging", fx: fx() },
    {
      phase: "judging",
      ev: { t: "newcomer" },
      out: "releasing",
      fx: fx({ e: "cancel-async" }, { e: "release" }, rec("newcomer")),
    },
    { phase: "judging", ev: { t: "hop-timeout" }, out: "judging", fx: fx() },
    { phase: "judging", ev: { t: "ponr" }, out: "judging", fx: fx() },
    { phase: "judging", ev: { t: "preflight-failed" }, out: "judging", fx: fx() },
    { phase: "judging", ev: { t: "switch-entered" }, out: "judging", fx: fx() },
    { phase: "judging", ev: { t: "switch-cancelled" }, out: "judging", fx: fx() },
    {
      phase: "judging",
      ev: { t: "abort", why: "watchdog" },
      out: "releasing",
      fx: fx({ e: "cancel-async" }, { e: "release" }, rec("watchdog")),
    },
    {
      phase: "judging",
      ev: { t: "abort", why: "shutdown", reason: "reload" },
      out: "done",
      fx: fx({ e: "cancel-async" }, { e: "persist-pending", reason: "reload" }),
    },
    { phase: "judging", ev: { t: "released" }, out: "judging", fx: fx() },
    // ── confirming ──
    { phase: "confirming", ev: { t: "judged", v: judgedOkUnrelated }, out: "confirming", fx: fx() },
    { phase: "confirming", ev: { t: "confirmed", o: { kind: "switch" } }, out: "hopping", fx: fx({ e: "hop" }) },
    {
      phase: "confirming",
      ev: { t: "confirmed", o: { kind: "stay" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("declined"), { e: "cooldown" }),
    },
    {
      phase: "confirming",
      ev: { t: "confirmed", o: { kind: "timeout" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("confirm-timeout"), { e: "cooldown" }),
    },
    {
      phase: "confirming",
      ev: { t: "confirmed", o: { kind: "cancel" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("confirm-cancel"), { e: "cooldown" }),
    },
    {
      phase: "confirming",
      ev: { t: "confirmed", o: { kind: "unavailable" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("ui-unavailable")),
    },
    {
      phase: "confirming",
      ev: { t: "confirmed", o: { kind: "error" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("ui-unavailable")),
    },
    {
      phase: "confirming",
      ev: { t: "confirmed", o: { kind: "aborted" } },
      out: "releasing",
      fx: fx({ e: "release" }, rec("ui-unavailable")),
    },
    {
      phase: "confirming",
      ev: { t: "newcomer" },
      out: "releasing",
      fx: fx({ e: "cancel-async" }, { e: "release" }, rec("newcomer")),
    },
    { phase: "confirming", ev: { t: "hop-timeout" }, out: "confirming", fx: fx() },
    { phase: "confirming", ev: { t: "ponr" }, out: "confirming", fx: fx() },
    { phase: "confirming", ev: { t: "preflight-failed" }, out: "confirming", fx: fx() },
    {
      phase: "confirming",
      ev: { t: "abort", why: "watchdog" },
      out: "releasing",
      fx: fx({ e: "cancel-async" }, { e: "release" }, rec("watchdog")),
    },
    {
      phase: "confirming",
      ev: { t: "abort", why: "shutdown", reason: "quit" },
      out: "done",
      fx: fx({ e: "cancel-async" }, { e: "persist-pending", reason: "quit" }),
    },
    { phase: "confirming", ev: { t: "released" }, out: "confirming", fx: fx() },
    // ── hopping ──
    { phase: "hopping", ev: { t: "judged", v: judgedOkUnrelated }, out: "hopping", fx: fx() },
    { phase: "hopping", ev: { t: "confirmed", o: { kind: "switch" } }, out: "hopping", fx: fx() },
    {
      phase: "hopping",
      ev: { t: "newcomer" },
      out: "releasing",
      fx: fx({ e: "cancel-async" }, { e: "release" }, rec("newcomer")),
    },
    { phase: "hopping", ev: { t: "hop-timeout" }, out: "releasing", fx: fx({ e: "release" }, rec("hop-timeout")) },
    { phase: "hopping", ev: { t: "preflight-failed" }, out: "releasing", fx: fx({ e: "release" }, rec("preflight")) },
    { phase: "hopping", ev: { t: "ponr" }, out: "switching", fx: fx() },
    { phase: "hopping", ev: { t: "switch-entered" }, out: "hopping", fx: fx() },
    { phase: "hopping", ev: { t: "switch-cancelled" }, out: "hopping", fx: fx() },
    {
      phase: "hopping",
      ev: { t: "abort", why: "watchdog" },
      out: "releasing",
      fx: fx({ e: "cancel-async" }, { e: "release" }, rec("watchdog")),
    },
    {
      phase: "hopping",
      ev: { t: "abort", why: "shutdown", reason: "new" },
      out: "done",
      fx: fx({ e: "cancel-async" }, { e: "persist-pending", reason: "new" }),
    },
    { phase: "hopping", ev: { t: "released" }, out: "hopping", fx: fx() },
    // ── switching（PONR 后）──
    { phase: "switching", ev: { t: "judged", v: judgedOkUnrelated }, out: "switching", fx: fx() },
    { phase: "switching", ev: { t: "confirmed", o: { kind: "switch" } }, out: "switching", fx: fx() },
    { phase: "switching", ev: { t: "newcomer" }, out: "switching", fx: fx() }, // I4：不进归约器
    { phase: "switching", ev: { t: "hop-timeout" }, out: "switching", fx: fx() },
    { phase: "switching", ev: { t: "ponr" }, out: "switching", fx: fx() },
    { phase: "switching", ev: { t: "preflight-failed" }, out: "switching", fx: fx() },
    { phase: "switching", ev: { t: "switch-entered" }, out: "done", fx: fx(rec("switched")) },
    {
      phase: "switching",
      ev: { t: "switch-cancelled" },
      out: "releasing",
      fx: fx({ e: "release" }, rec("switch-cancelled")),
    },
    { phase: "switching", ev: { t: "abort", why: "watchdog" }, out: "switching", fx: fx() }, // I4：只通知
    { phase: "switching", ev: { t: "abort", why: "shutdown", reason: "new" }, out: "switching", fx: fx() },
    { phase: "switching", ev: { t: "released" }, out: "switching", fx: fx() },
    // ── releasing ──
    { phase: "releasing", ev: { t: "judged", v: judgedOkUnrelated }, out: "releasing", fx: fx() },
    { phase: "releasing", ev: { t: "confirmed", o: { kind: "stay" } }, out: "releasing", fx: fx() },
    { phase: "releasing", ev: { t: "newcomer" }, out: "releasing", fx: fx() }, // 由 release 队列追加，不产生新 release
    { phase: "releasing", ev: { t: "hop-timeout" }, out: "releasing", fx: fx() },
    { phase: "releasing", ev: { t: "ponr" }, out: "releasing", fx: fx() },
    { phase: "releasing", ev: { t: "switch-entered" }, out: "releasing", fx: fx() },
    { phase: "releasing", ev: { t: "switch-cancelled" }, out: "releasing", fx: fx() },
    { phase: "releasing", ev: { t: "abort", why: "watchdog" }, out: "releasing", fx: fx() },
    {
      phase: "releasing",
      ev: { t: "abort", why: "shutdown", reason: "reload" },
      out: "done",
      fx: fx({ e: "persist-pending", reason: "reload" }), // 只持久化尚未发出的队列项（P3b.5）
    },
    { phase: "releasing", ev: { t: "released" }, out: "done", fx: fx() },
  ];

  it.each(cases)("$phase × $ev.t ⇒ $out", ({ phase, ev, out, fx: expectedFx }) => {
    const result = run(phase, ev);
    expect(result.phase).toBe(out);
    expect(result.fx).toEqual(expectedFx);
  });

  it("every phase × every event combination runs without throwing and returns a legal shape", () => {
    const phases: HoldPhase[] = ["judging", "confirming", "hopping", "switching", "releasing", "done"];
    const events: HoldEvent[] = [
      { t: "judged", v: { kind: "error" } },
      { t: "judged", v: { kind: "parse-error" } },
      { t: "judged", v: { kind: "no-model" } },
      { t: "judged", v: { kind: "aborted" } },
      { t: "confirmed", o: { kind: "unavailable" } },
      { t: "confirmed", o: { kind: "error" } },
      { t: "confirmed", o: { kind: "aborted" } },
      { t: "abort", why: "shutdown" }, // 缺 reason 的防御分支
    ];
    for (const phase of phases) {
      for (const ev of events) {
        const result = stepHold(state(phase), ev, MIN_CONF);
        expect(Object.prototype.hasOwnProperty.call(result, "s")).toBe(true);
        expect(Array.isArray(result.fx)).toBe(true);
      }
    }
  });

  it("done × every event ⇒ identity state, fx=[] (迟到事件无副作用)", () => {
    const events: HoldEvent[] = [
      { t: "judged", v: judgedOkUnrelated },
      { t: "confirmed", o: { kind: "switch" } },
      { t: "newcomer" },
      { t: "hop-timeout" },
      { t: "ponr" },
      { t: "preflight-failed" },
      { t: "switch-entered" },
      { t: "switch-cancelled" },
      { t: "abort", why: "watchdog" },
      { t: "abort", why: "shutdown", reason: "reload" },
      { t: "released" },
    ];
    for (const ev of events) {
      const s = state("done");
      const result = stepHold(s, ev, MIN_CONF);
      expect(result.s).toBe(s);
      expect(result.fx).toEqual([]);
    }
  });

  it("judged with confidence exactly at minConfidence counts as unrelated (≥)", () => {
    expect(run("judging", { t: "judged", v: { kind: "ok", related: false, confidence: MIN_CONF } }).phase).toBe(
      "confirming",
    );
  });

  it("lifecycle: judging → confirming → hopping → switching → done", () => {
    let s = initialHoldState();
    s = stepHold(s, { t: "judged", v: judgedOkUnrelated }, MIN_CONF).s;
    expect(s.phase).toBe("confirming");
    s = stepHold(s, { t: "confirmed", o: { kind: "switch" } }, MIN_CONF).s;
    expect(s.phase).toBe("hopping");
    s = stepHold(s, { t: "ponr" }, MIN_CONF).s;
    expect(s.phase).toBe("switching");
    const done = stepHold(s, { t: "switch-entered" }, MIN_CONF);
    expect(done.s.phase).toBe("done");
    expect(done.fx).toEqual([{ e: "record", outcome: "switched" }]);
  });
});

describe("cooldown outcomes (D4)", () => {
  it("COOLDOWN_OUTCOMES is the frozen D4 set", () => {
    expect(COOLDOWN_OUTCOMES).toEqual(["declined", "confirm-timeout", "confirm-cancel"]);
    expect(Object.isFrozen(COOLDOWN_OUTCOMES)).toBe(true);
  });
  it("isCooldownOutcome", () => {
    expect(isCooldownOutcome("declined")).toBe(true);
    expect(isCooldownOutcome("confirm-timeout")).toBe(true);
    expect(isCooldownOutcome("confirm-cancel")).toBe(true);
    expect(isCooldownOutcome("stayed")).toBe(false);
    expect(isCooldownOutcome("related")).toBe(false);
    expect(isCooldownOutcome("newcomer")).toBe(false);
  });
});

describe("cooldownActive", () => {
  const cooldown = (tokens: number): EntryLike => ({
    type: "custom",
    customType: ENTRY_TYPE,
    data: { v: 1, kind: "cooldown", at: 1_000, tokens },
  });
  const compaction: EntryLike = { type: "compaction" };
  const outcomeEntry: EntryLike = {
    type: "custom",
    customType: ENTRY_TYPE,
    data: { v: 1, kind: "outcome", at: 2_000, holdId: "h1", outcome: "related", estUsd: 1, prefixK: 100 },
  };

  it("no cooldown record ⇒ inactive", () => {
    expect(cooldownActive([], 100_000, 100_000)).toBe(false);
    expect(cooldownActive([outcomeEntry], 100_000, 100_000)).toBe(false);
  });

  it("cooldown with nothing after ⇒ active; null/undefined tokensNow keeps it active", () => {
    expect(cooldownActive([cooldown(50_000)], 60_000, 100_000)).toBe(true);
    expect(cooldownActive([cooldown(50_000)], null, 100_000)).toBe(true);
    expect(cooldownActive([cooldown(50_000)], undefined, 100_000)).toBe(true);
    expect(cooldownActive([cooldown(50_000)], Number.NaN, 100_000)).toBe(true);
  });

  it("regrow: tokensNow − cooldown.tokens ≥ regrowTokens lifts it (boundary inclusive)", () => {
    expect(cooldownActive([cooldown(50_000)], 149_999, 100_000)).toBe(true);
    expect(cooldownActive([cooldown(50_000)], 150_000, 100_000)).toBe(false);
  });

  it("regrowTokens = 0 ⇒ only a compaction lifts the cooldown", () => {
    expect(cooldownActive([cooldown(50_000)], 1_000_000, 0)).toBe(true);
    expect(cooldownActive([cooldown(50_000), compaction], 1_000_000, 0)).toBe(false);
  });

  it("compaction AFTER the most recent cooldown lifts it; compaction BEFORE does not", () => {
    expect(cooldownActive([compaction, cooldown(50_000)], 60_000, 100_000)).toBe(true);
    expect(cooldownActive([cooldown(50_000), compaction], 60_000, 100_000)).toBe(false);
  });

  it("only the MOST RECENT cooldown counts (backward scan)", () => {
    expect(cooldownActive([cooldown(10_000), outcomeEntry, cooldown(90_000)], 95_000, 100_000)).toBe(true); // 95k−90k < 100k
    expect(cooldownActive([cooldown(10_000), outcomeEntry, cooldown(90_000)], 190_000, 100_000)).toBe(false); // 190k−90k ≥ 100k
  });

  it("corrupt cooldown record is ignored (treated as absent)", () => {
    const corrupt: EntryLike = { type: "custom", customType: ENTRY_TYPE, data: { v: 1, kind: "cooldown", at: "x" } };
    expect(cooldownActive([corrupt], 100_000, 100_000)).toBe(false);
    expect(cooldownActive([cooldown(50_000), corrupt], 60_000, 100_000)).toBe(true);
  });

  it("non-finite cooldown.tokens fails strict parse ⇒ record treated absent (fail-open)", () => {
    const bad: EntryLike = {
      type: "custom",
      customType: ENTRY_TYPE,
      data: { v: 1, kind: "cooldown", at: 1, tokens: Number.NaN },
    };
    expect(cooldownActive([bad], 1e9, 100_000)).toBe(false);
    expect(cooldownActive([bad, compaction], 1e9, 100_000)).toBe(false);
  });
});
