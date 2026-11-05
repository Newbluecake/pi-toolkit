/**
 * jev-reflex · #25 B0 shared test constructors (backtest-plan B0 新建): `makeTurn` / `makeHeader` /
 * `makeRecord` / `makeDraft`. B1/B2/B4/B5 import these READ-ONLY — changing a default here shifts
 * every downstream fixture, so treat defaults as frozen contract sugar (override per test instead).
 */
import { portDefaultsOf } from "../../../src/reflex/core/port-defaults.js";
import type { PortId, ReflexRecordV1, RScriptV1, SessionHeaderFact, Turn } from "../../../src/reflex/core/types.js";

export const T0 = 1_700_000_000_000;

export function makeTurn(over: Partial<Turn> & Pick<Turn, "session" | "entryId">): Turn {
  return {
    familyRoot: "root-1",
    split: "train",
    at: T0,
    settledAt: T0 + 5_000,
    cwd: "/home/unit/proj",
    text: "后台还有几个 job",
    digest: "d000000000000001",
    imageCount: 0,
    origin: "tui",
    shapes: ["bash_job:list"],
    toolCount: 1,
    hasWrite: false,
    unknownFacts: [],
    ...over,
  };
}

export function makeHeader(
  over: Partial<SessionHeaderFact> & Pick<SessionHeaderFact, "file" | "id">,
): SessionHeaderFact {
  // `exactOptionalPropertyTypes`: an absent parentSession must be an ABSENT key, not `undefined`.
  const merged = {
    file: over.file,
    id: over.id,
    timestamp: over.timestamp ?? T0,
    cwd: over.cwd ?? "/home/unit/proj",
    ...(over.parentSession !== undefined ? { parentSession: over.parentSession } : {}),
  };
  return merged as SessionHeaderFact;
}

export function makeRecord(over: Partial<ReflexRecordV1> & Pick<ReflexRecordV1, "scriptId">): ReflexRecordV1 {
  return {
    v: 1,
    kind: "shadow",
    at: T0,
    scriptVer: 1,
    state: "shadow",
    band: "high",
    requestDigest: "d000000000000001",
    chars: 9,
    model: { agree: "no-tool", tools: [] },
    ...over,
  };
}

/** The default draft intent (a valid DRX jobs.list template set — see makeDraft). */
export function draftIntent(): RScriptV1["intent"] {
  return {
    strong: ["后台 job 有哪些", "后台\\?job 有哪些", "后台第\\d{1,4}个 job", "后台第\\d{1,4}个 job (?:吗|呢)?"],
    weak: ["后台 job"],
    exclude: ["停了", "清空", "新开"],
    examples: {
      hit: ["后台 job 有哪些", "后台?job 有哪些", "后台第3个 job", "后台第10个 job 吗", "后台第2个 job 呢"],
      miss: ["把后台 job 都停了", "后台 job 的日志", "新开一个后台 job", "帮我看看后台 job", "后台 job 状态怎么样"],
    },
  };
}

/**
 * A VALID draft (passes every validateDraft rule ①–⑦) bound to a port's defaults — the base for
 * draft-schema / identity / B4 / B5 fixtures. Override `intent` fields per test. Default port:
 * jobs.list (a signed port). NOTE: when overriding `port`, the defaults follow the NEW port.
 */
export function makeDraft(over: Partial<RScriptV1> & Pick<RScriptV1, "id">): RScriptV1 {
  // Port defaults are DEEP-CLONED (the catalog is deep-frozen; tests mutate drafts freely).
  // A port without defaults (e.g. sessions.recent) falls back to jobs.list's fields so the
  // draft stays structurally complete — validateDraft then reports `port-mismatch`.
  const d = portDefaultsOf((over.port?.id ?? "jobs.list") as PortId) ?? portDefaultsOf("jobs.list")!;
  const merged: RScriptV1 = {
    ...{
      schema: "rscript/1",
      version: 1,
      origin: "extracted",
      risk: "readonly",
      intent: draftIntent(),
      port: { id: "jobs.list" },
      requires: [...d.requires],
      render: { ...d.render },
      agreement: { tools: [...d.agreement.tools], bashShapes: [...d.agreement.bashShapes] },
    },
    ...over,
  };
  const d2 = portDefaultsOf(merged.port.id) ?? d;
  return {
    ...merged,
    requires: over.requires ?? [...d2.requires],
    render: over.render ?? { ...d2.render },
    agreement: over.agreement ?? { tools: [...d2.agreement.tools], bashShapes: [...d2.agreement.bashShapes] },
    intent: { ...draftIntent(), ...(over.intent ?? {}) },
  };
}
