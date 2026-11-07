/**
 * B1 · corpus builder (BA §4.2): turn attribution, origin table (one fixture per row),
 * subagent-child exclusion, cross-file dedup (BD5 earliest-wins + steal/revocation), time/cwd
 * filters, the full CorrectionFact timeline, idle derivability, fence states and the r3
 * sourceMode evidence criteria ①–⑤.
 */
import { describe, expect, it } from "vitest";
import { HUD_TUI_GATE_SINCE } from "../../../../src/reflex/core/backtest/markers.js";
import { requestDigest } from "../../../../src/reflex/core/digest.js";
import { normalizeInput } from "../../../../src/reflex/core/normalize.js";
import {
  builderFor,
  feedFile,
  userLine,
  assistantLine,
  toolResultLine,
  customLine,
  hudLine,
  reflexRecordLine,
  eid,
  TG,
} from "./fixtures-b1.js";
import type { CorpusBuilder } from "../../../../src/reflex/core/backtest/corpus.js";
import type { HeaderSpec } from "./fixtures-b1.js";

const ROOT: HeaderSpec = { id: "croot-1", at: TG };

function oneFile(
  lines: readonly string[],
  header: HeaderSpec = { ...ROOT },
  filter: Parameters<typeof builderFor>[1] = { since: 0 },
) {
  return feedFile(builderFor([header], filter), header, lines);
}

describe("turn attribution & fields", () => {
  it("harvests a tui turn with digest/shapes/toolCount/hasWrite/settledAt", () => {
    const uid = eid("u");
    const r = oneFile([
      userLine({ id: uid, at: TG + 10, text: "看一下仓库状态和分支" }),
      assistantLine({
        id: eid(),
        at: TG + 11,
        stopReason: "toolUse",
        toolCalls: [
          { name: "bash", command: "git status" },
          { name: "bash_job", action: "list" },
        ],
      }),
      toolResultLine({ id: eid(), at: TG + 12 }),
      assistantLine({ id: eid(), at: TG + 13, stopReason: "stop", toolCalls: [{ name: "edit" }] }),
    ]);
    expect(r.turns).toHaveLength(1);
    const t = r.turns[0]!;
    expect(t.origin).toBe("tui");
    expect(t.entryId).toBe(uid);
    expect(t.digest).toBe(requestDigest(normalizeInput("看一下仓库状态和分支").norm));
    expect(t.shapes).toContain("git status"); // bash → allShapes
    expect(t.shapes).toContain("bash_job:list"); // bash_job → bash_job:<action>
    expect(t.shapes).toContain("edit");
    expect(t.toolCount).toBe(3);
    expect(t.hasWrite).toBe(true);
    expect(t.settledAt).toBe(TG + 13);
    // no HUD/reflex evidence in the interval ⇒ lenient (sourceMode unknown); see the
    // sourceMode block below for the confirmed path.
    expect(t.unknownFacts).toEqual(["sourceMode"]);
  });

  it("settles at the turn's own time when nothing follows, and counts image parts", () => {
    const r = oneFile([
      userLine({ id: eid(), at: TG + 10, text: "hello", images: 2 }),
      userLine({ id: eid(), at: TG + 20, text: "world" }),
    ]);
    expect(r.turns[0]!.settledAt).toBe(TG + 10);
    expect(r.turns[0]!.imageCount).toBe(2);
    expect(r.turns[1]!.imageCount).toBe(0);
  });

  it("joins multi-part text content like toBranchLike", () => {
    const line = JSON.stringify({
      type: "message",
      id: eid(),
      timestamp: new Date(TG).toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        timestamp: TG,
      },
    });
    const r = oneFile([line]);
    expect(r.turns[0]!.text).toBe("ab");
  });
});

describe("origin table (one fixture per row)", () => {
  const mk = (customType: string | undefined, text: string, opts: { stopReason?: string } = {}) => {
    const pid = eid("p");
    const uid = eid("u");
    const parent =
      customType !== undefined
        ? customLine({ id: pid, at: TG + 1, customType, data: { v: 1 } })
        : opts.stopReason !== undefined
          ? assistantLine({ id: pid, at: TG + 1, stopReason: opts.stopReason, toolCalls: [] })
          : toolResultLine({ id: pid, at: TG + 1 });
    return [parent, userLine({ id: uid, parentId: pid, at: TG + 2, text })];
  };

  it("web parent marker ⇒ excluded from turns, correction fact kept", () => {
    const r = oneFile(mk("subagent:web-origin", "从网页问后台还有几个 job"));
    expect(r.turns).toHaveLength(0);
    expect(r.corrections).toHaveLength(1);
    expect(r.corrections[0]!.origin).toBe("web");
  });

  it("wake parent marker ⇒ injected (excluded)", () => {
    const r = oneFile(mk("subagent:wake-level", "后台还有几个 job"));
    expect(r.turns).toHaveLength(0);
    expect(r.corrections[0]!.origin).toBe("injected");
  });

  it("injected text prefixes ⇒ injected (excluded)", () => {
    for (const text of [
      "[主会话 steer · 需回复] xx",
      "[switch_context] 上下文已切换",
      "[fabric inbox n=1] xx",
      "[飞书 · a · b · #tok] hi",
    ]) {
      const r = oneFile([userLine({ id: eid(), at: TG + 5, text })]);
      expect(r.turns, text).toHaveLength(0);
      expect(r.corrections[0]!.origin, text).toBe("injected");
    }
  });

  it("topic-switch parent ⇒ replay (KEPT as a turn)", () => {
    const r = oneFile(mk("subagent:topic-switch", "后台还有几个 job"));
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.origin).toBe("replay");
  });

  it("toolUse-assistant parent ⇒ steer (kept)", () => {
    const r = oneFile(mk(undefined, "继续", { stopReason: "toolUse" }));
    expect(r.turns[0]!.origin).toBe("steer");
  });

  it("toolResult parent ⇒ steer (kept)", () => {
    const r = oneFile(mk(undefined, "继续"));
    expect(r.turns[0]!.origin).toBe("steer");
  });

  it("no parent / assistant-stop parent ⇒ tui", () => {
    const uid = eid();
    const aid = eid();
    const r = oneFile([
      userLine({ id: uid, at: TG + 1, text: "第一问" }),
      assistantLine({ id: aid, at: TG + 2, stopReason: "stop", toolCalls: [] }),
      userLine({ id: eid(), parentId: aid, at: TG + 3, text: "第二问" }),
    ]);
    expect(r.turns.map((t) => t.origin)).toEqual(["tui", "tui"]);
  });
});

describe("subagent child exclusion", () => {
  it("skips a self-marked child file entirely (turns AND corrections)", () => {
    const b = builderFor([{ ...ROOT }]);
    const r = feedFile(b, ROOT, [
      customLine({ id: eid(), at: TG, customType: "subagent:child", data: { v: 1 } }),
      userLine({ id: eid(), at: TG + 1, text: "hi" }),
    ]);
    expect(r.turns).toHaveLength(0);
    expect(r.corrections).toHaveLength(0);
  });

  it("beginFile skips files referenced by a main session's subagent:run (relative + absolute)", () => {
    const childAbs = `/sess/${TG + 5}_child-9.jsonl`;
    const b = builderFor([{ ...ROOT }, { id: "child-9", at: TG + 5 }]);
    // main session spawns the child with a RELATIVE diag.sessionFile (provenance口径 resolves it)
    feedFile(b, ROOT, [
      userLine({ id: eid(), at: TG + 1, text: "派个 agent" }),
      customLine({
        id: eid(),
        at: TG + 2,
        customType: "subagent:run",
        data: { v: 1, diag: { sessionFile: `${TG + 5}_child-9.jsonl` } },
      }),
    ]);
    const r2 = feedFile(b, { id: "child-9", at: TG + 5 }, [userLine({ id: eid(), at: TG + 6, text: "inner" })]);
    expect(r2.turns).toHaveLength(0); // skip-child
    // absolute references work the same
    const b2 = builderFor([{ ...ROOT }]);
    feedFile(b2, ROOT, [
      customLine({ id: eid(), at: TG + 2, customType: "subagent:run", data: { diag: { sessionFile: childAbs } } }),
    ]);
    expect(b2.childFiles().has(childAbs)).toBe(true);
  });
});

describe("cross-file dedup (BD5)", () => {
  const ancestor: HeaderSpec = { id: "anc-1", at: TG };
  const fork: HeaderSpec = { id: "frk-1", at: TG + 10_000, parentSession: `/sess/${TG}_anc-1.jsonl` };

  it("counts a fork-copied entry once, attributed to the earliest header (fed in order)", () => {
    const shared = userLine({ id: "shared-1", at: TG + 100, text: "后台还有几个 job" });
    const b = builderFor([ancestor, fork]);
    const a = feedFile(b, ancestor, [shared]);
    const f = feedFile(b, fork, [shared]); // fork copies the ancestor's entries verbatim
    expect(a.turns).toHaveLength(1);
    expect(f.turns).toHaveLength(0);
  });

  it("steals + revokes when the older-header file is fed LATER (order independence)", () => {
    const shared = userLine({ id: "shared-2", at: TG + 100, text: "后台还有几个 job" });
    const b = builderFor([ancestor, fork]);
    const f = feedFile(b, fork, [shared]); // fork first (younger header claims)
    expect(f.turns).toHaveLength(1);
    const a = feedFile(b, ancestor, [shared]); // ancestor steals
    expect(a.turns).toHaveLength(1);
    const revoked = b.takeRevoked();
    expect(revoked.turns).toHaveLength(1);
    expect(revoked.turns[0]!.session).toBe("frk-1");
    expect(b.takeRevoked().turns).toHaveLength(0); // take drains
  });
});

describe("time / cwd filters", () => {
  it("bounds turns by [since, until) but keeps the correction timeline from `since` on", () => {
    const r = oneFile(
      [
        userLine({ id: eid(), at: TG, text: "早" }),
        userLine({ id: eid(), at: TG + 100, text: "中" }),
        userLine({ id: eid(), at: TG + 200, text: "晚" }),
      ],
      { ...ROOT },
      { since: TG + 50, until: TG + 150 },
    );
    expect(r.turns.map((t) => t.text)).toEqual(["中"]);
    expect(r.corrections.map((c) => c.at)).toEqual([TG + 100, TG + 200]); // since bounds only
  });

  it("suppresses turns+corrections from non-matching cwd files", () => {
    const b = builderFor(
      [
        { ...ROOT, cwd: "/x" },
        { id: "other", at: TG, cwd: "/y" },
      ],
      { since: 0, cwd: "/x" },
    );
    const rx = feedFile(b, { ...ROOT, cwd: "/x" }, [userLine({ id: eid(), at: TG + 1, text: "x" })]);
    const ry = feedFile(b, { id: "other", at: TG, cwd: "/y" }, [userLine({ id: eid(), at: TG + 1, text: "y" })]);
    expect(rx.turns).toHaveLength(1);
    expect(ry.turns).toHaveLength(0);
    expect(ry.corrections).toHaveLength(0);
  });
});

describe("correction timeline (Major 9)", () => {
  it("produces facts for EVERY user entry — long, multi-line, web — with corrHit from CORRECTION_RE", () => {
    const r = oneFile([
      userLine({ id: eid(), at: TG + 1, text: "不对，重新查" }),
      userLine({ id: eid(), at: TG + 2, text: "这是一个特别长的句子".repeat(30) }),
      userLine({ id: eid(), at: TG + 3, text: "第一行\n第二行" }),
      userLine({ id: eid("w"), at: TG + 4, text: "wrong" }),
    ]);
    expect(r.corrections).toHaveLength(4);
    expect(r.corrections.map((c) => c.corrHit)).toEqual([true, false, false, true]);
  });
});

describe("idle / fence derivability", () => {
  it("proves idle at session start and after an assistant stop; unknown after user/toolUse/toolResult", () => {
    const r = oneFile([
      userLine({ id: eid(), at: TG + 1, text: "第一问" }), // session-first ⇒ provable
      userLine({ id: eid(), at: TG + 2, text: "抢跑" }), // previous message is USER ⇒ unknown
      assistantLine({ id: eid(), at: TG + 3, stopReason: "stop", toolCalls: [] }),
      userLine({ id: eid(), at: TG + 4, text: "正常问" }), // after assistant stop ⇒ provable
      assistantLine({ id: eid(), at: TG + 5, stopReason: "toolUse", toolCalls: [] }),
      userLine({ id: eid(), at: TG + 6, text: "中途插话" }), // after toolUse ⇒ unknown
    ]);
    const facts = r.turns.map((t) => t.unknownFacts.includes("idle"));
    expect(facts).toEqual([false, true, false, true]);
    expect(r.turns[1]!.unknownFacts).toContain("pendingMessages"); // rides along with idle
  });

  it("topic-switch hold marks its window's turns lenient; after the outcome the fence is provably off", () => {
    const r = oneFile([
      customLine({
        id: eid(),
        at: TG,
        customType: "subagent:topic-switch",
        data: { v: 1, kind: "pending", holdId: "h1" },
      }),
      userLine({ id: eid(), at: TG + 1, text: "hold 期间的问题" }),
      customLine({
        id: eid(),
        at: TG + 2,
        customType: "subagent:topic-switch",
        data: { v: 1, kind: "outcome", holdId: "h1", outcome: "related" },
      }),
      userLine({ id: eid(), at: TG + 3, text: "hold 之后的问题" }),
    ]);
    expect(r.turns[0]!.unknownFacts).toContain("topicSwitchActive");
    expect(r.turns[1]!.unknownFacts).not.toContain("topicSwitchActive");
  });

  it("malformed fence entries make later turns lenient; goal active does too", () => {
    const r = oneFile([
      customLine({ id: eid(), at: TG, customType: "subagent:goal", data: { v: 1 } }), // no state ⇒ underivable
      userLine({ id: eid(), at: TG + 1, text: "问一" }),
      customLine({ id: eid(), at: TG + 2, customType: "subagent:goal", data: { v: 1, state: "active" } }),
      userLine({ id: eid(), at: TG + 3, text: "问二" }),
      customLine({ id: eid(), at: TG + 4, customType: "subagent:goal", data: { v: 1, state: "paused" } }),
      userLine({ id: eid(), at: TG + 5, text: "问三" }),
    ]);
    expect(r.turns[0]!.unknownFacts).toContain("goalBusy");
    expect(r.turns[1]!.unknownFacts).toContain("goalBusy");
    expect(r.turns[2]!.unknownFacts).not.toContain("goalBusy");
  });
});

describe("sourceMode evidence (r3 criteria ①–⑤)", () => {
  const Q1 = "后台还有几个 job";
  const digestOf = (s: string) => requestDigest(normalizeInput(s).norm);

  /** ① fork copies carry the ancestor's HUD/reflex entries; the fork's own later turns run print/json. */
  it("① fork-copied evidence confirms only the ANCESTOR's turns; the fork's own turns stay unknown", () => {
    const ancestor: HeaderSpec = { id: "anc-2", at: TG };
    const fork: HeaderSpec = { id: "frk-2", at: TG + 5000, parentSession: `/sess/${TG}_anc-2.jsonl` };
    const shared = [userLine({ id: "sh-u", at: TG + 100, text: Q1 }), hudLine({ id: "sh-h", at: TG + 110 })];
    const b = builderFor([ancestor, fork]);
    const a = feedFile(b, ancestor, shared);
    const f = feedFile(b, fork, [...shared, userLine({ id: "fr-u", at: TG + 9000, text: Q1 })]);
    expect(a.turns[0]!.unknownFacts).not.toContain("sourceMode"); // native evidence owned by the ancestor
    expect(f.turns.map((t) => t.entryId)).toEqual(["fr-u"]); // copied turn deduped away
    expect(f.turns[0]!.unknownFacts).toContain("sourceMode"); // fork's own round has no native evidence
  });

  it("② a session that runs TUI first and print later confirms only the first half", () => {
    const r = oneFile([
      userLine({ id: "h1u", at: TG + 10, text: Q1 }),
      hudLine({ id: "h1h", at: TG + 11 }),
      userLine({ id: "h2u", at: TG + 20, text: Q1 }), // second half: no HUD entries follow
      assistantLine({ id: eid(), at: TG + 21, stopReason: "stop", toolCalls: [] }),
    ]);
    expect(r.turns[0]!.unknownFacts).not.toContain("sourceMode");
    expect(r.turns[1]!.unknownFacts).toContain("sourceMode");
  });

  it("③ reflex records belonging to OTHER rounds never confirm this round", () => {
    const r = oneFile([
      userLine({ id: "m1", at: TG + 10, text: Q1 }),
      reflexRecordLine({ id: "m2", at: TG + 11, requestDigest: digestOf("完全不同的问题") }),
      assistantLine({ id: eid(), at: TG + 12, stopReason: "stop", toolCalls: [] }),
    ]);
    expect(r.turns[0]!.unknownFacts).toContain("sourceMode");
  });

  it("④ HUD entries inside turns that START before HUD_TUI_GATE_SINCE are not admitted", () => {
    const before = HUD_TUI_GATE_SINCE - 1000;
    const header: HeaderSpec = { id: "old-1", at: before };
    const r = feedFile(builderFor([header]), header, [
      userLine({ id: "o1", at: before, text: Q1 }),
      hudLine({ id: "o2", at: before + 10 }),
    ]);
    expect(r.turns[0]!.unknownFacts).toContain("sourceMode");
  });

  it("⑤ a same-digest native reflex record confirms the round (and hud evidence ≥ gate confirms)", () => {
    const withRec = oneFile([
      userLine({ id: "r1", at: TG + 10, text: Q1 }),
      reflexRecordLine({ id: "r2", at: TG + 11, requestDigest: digestOf(Q1) }),
    ]);
    expect(withRec.turns[0]!.unknownFacts).not.toContain("sourceMode");
    // same digest but a FORK COPY (ancestor claimed it) does NOT confirm the fork's copy — but the
    // copied turn itself is deduped away, so assert on a distinct fork-owned round instead (① covers).
  });
});

describe("misc robustness", () => {
  it("ignores unparsable lines and entries without ids, and tolerates numeric timestamps", () => {
    const numeric = JSON.stringify({
      type: "custom",
      customType: "pi-hud-llm-time",
      data: {},
      id: "n1",
      timestamp: TG + 3,
    });
    const r = oneFile([
      "{broken json",
      numeric,
      userLine({ id: "n2", at: TG + 5, text: "q" }),
      hudLine({ id: "n3", at: TG + 6 }),
    ]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.unknownFacts).not.toContain("sourceMode"); // numeric-ts HUD entry admitted
  });

  it("returns empty for a file never begun (line after endFile is dropped)", () => {
    const b: CorpusBuilder = builderFor([{ ...ROOT }]);
    b.line(userLine({ id: eid(), at: TG, text: "孤儿行" }));
    expect(b.endFile()).toEqual({ turns: [], corrections: [] });
  });
});
