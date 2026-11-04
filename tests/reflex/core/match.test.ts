/**
 * R1 · match (plan R1 step 7; arch §4.4): the example corpus end-to-end through S0+S1 —
 * every hit example is gate-passing + `high` for ITS script; every miss example never reaches
 * `high` anywhere. Plus capability filtering, exclude precedence, weak-only ambiguity and the
 * strong+weak cross-script rule (custom mini-catalog).
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { evaluateGate } from "../../../src/reflex/core/gate.js";
import { compileCatalog } from "../../../src/reflex/core/match.js";
import { normalizeInput } from "../../../src/reflex/core/normalize.js";
import type { Capability, GateFacts, RScriptV1 } from "../../../src/reflex/core/types.js";

const ALL_CAPS = new Set<Capability>(["bashJobs", "fleet", "quota", "git"]);
const MATCHER = compileCatalog(BUILTIN_SCRIPTS);

function facts(text: string): GateFacts {
  return {
    source: "interactive",
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    imageCount: 0,
    text,
    topicSwitchActive: false,
    goalBusy: false,
    inFlight: false,
  };
}

/** S0+S1 composite: veto code, or the match result on the normalized text. */
function composite(text: string, caps: ReadonlySet<Capability> = ALL_CAPS) {
  const gate = evaluateGate(facts(text));
  if (!gate.pass) return { gate: gate.veto, match: undefined };
  return { gate: "pass", match: MATCHER.match(gate.norm.norm, caps) };
}

describe("example corpus end-to-end (S0+S1)", () => {
  it("every hit example: gate passes AND match is high for exactly that script", () => {
    for (const script of BUILTIN_SCRIPTS) {
      for (const hit of script.intent.examples.hit) {
        const { gate, match } = composite(hit);
        expect(gate, `${script.id} hit "${hit}"`).toBe("pass");
        expect(match, `${script.id} hit "${hit}"`).toEqual({
          kind: "hit",
          band: "high",
          scriptId: script.id,
          candidates: [script.id],
        });
      }
    }
  });

  it("every miss example: never high (veto / miss / ambiguous all acceptable)", () => {
    for (const script of BUILTIN_SCRIPTS) {
      for (const miss of script.intent.examples.miss) {
        const { gate, match } = composite(miss);
        const band = match?.kind === "hit" ? match.band : undefined;
        expect(band ?? `veto:${gate}`, `${script.id} miss "${miss}"`).not.toBe("high");
      }
    }
  });

  it("miss outcomes are classified (sanity: each misses for a reason)", () => {
    expect(composite("把后台 job 都停了").gate).toBe("cancel"); // 停 hits CANCEL_SRC (row 14) before row 15
    expect(composite("那个 job 完成了吗").gate).toBe("anaphora");
    expect(composite("把改动提交了").gate).toBe("imperative");
    expect(composite("回滚工作区").match?.kind).toBe("miss"); // gate passes, exclude kills the script
    expect(composite("agent 跑完了吗他说了啥").match?.band).toBe("ambiguous"); // weak-only
    expect(composite("这周花了多少钱").match?.kind).toBe("miss"); // exclude 花
  });
});

describe("capability filtering (arch §4.4)", () => {
  it("a script whose requires are unsatisfied is invisible", () => {
    const noBash = new Set<Capability>(["fleet", "quota", "git"]);
    const { gate, match } = composite("后台还有几个 job", noBash);
    expect(gate).toBe("pass");
    expect(match?.kind).toBe("miss");
  });

  it("caps are computed per script: quota example survives without bashJobs", () => {
    const { match } = composite("额度还剩多少", new Set<Capability>(["quota"]));
    expect(match).toEqual({ kind: "hit", band: "high", scriptId: "quota.summary", candidates: ["quota.summary"] });
  });

  it("git requires nothing dynamic (always visible) — not a repo is the port's problem", () => {
    const { match } = composite("git status", new Set<Capability>(["git"]));
    expect(match?.band).toBe("high");
  });
});

describe("band rules (arch §4.4)", () => {
  it("exclude beats strong AND weak: an exclude word kills the script entirely", () => {
    // builtin: jobs.list excludes 日志 — the weak anchor 后台任务 is killed along with strong.
    const { gate, match } = composite("后台任务状态 的日志");
    expect(gate).toBe("pass");
    expect(match?.kind).toBe("miss");
    // custom: a strong pattern that EXACTLY matches still loses to its own exclude.
    const base = BUILTIN_SCRIPTS[0]!;
    const selfExcluded: RScriptV1 = {
      ...structuredClone(base),
      id: "self.excluded",
      intent: { ...structuredClone(base.intent), strong: ["停掉所有 job"], weak: [], exclude: ["停"] },
    };
    const matcher = compileCatalog([selfExcluded]);
    expect(matcher.match("停掉所有 job", new Set<Capability>(["bashJobs"]))).toEqual({ kind: "miss" });
  });

  it("weak-only hit ⇒ ambiguous with candidates in catalog order", () => {
    const { gate, match } = composite("job 进度怎么样");
    expect(gate).toBe("pass");
    expect(match).toEqual({ kind: "hit", band: "ambiguous", scriptId: "jobs.list", candidates: ["jobs.list"] });
  });

  it("two scripts weak-hit ⇒ ambiguous, scriptId = first candidate (bookkeeping only)", () => {
    const { gate, match } = composite("job 和 agent 的状态");
    expect(gate).toBe("pass");
    expect(match).toEqual({
      kind: "hit",
      band: "ambiguous",
      scriptId: "jobs.list",
      candidates: ["jobs.list", "fleet.status"],
    });
  });

  it("strong + other-script weak ⇒ ambiguous (custom mini-catalog, arch rule)", () => {
    const base = BUILTIN_SCRIPTS[0]!;
    const twin: RScriptV1 = {
      ...structuredClone(base),
      id: "twin.status",
      intent: {
        ...structuredClone(base.intent),
        strong: ["twin 询问"],
        weak: ["job"], // jobs.list's strong text contains "job"
        exclude: [],
      },
    };
    const matcher = compileCatalog([base, twin]);
    const result = matcher.match("bash jobs", new Set<Capability>(["bashJobs", "fleet", "quota", "git"]));
    // base strong-hits "bash jobs" but twin weak-hits "job" ⇒ ambiguous, never high.
    expect(result).toEqual({
      kind: "hit",
      band: "ambiguous",
      scriptId: "jobs.list",
      candidates: ["jobs.list", "twin.status"],
    });
  });

  it("normalize feeds the matcher: full-width, case, trailing punctuation all hit", () => {
    expect(composite("ＢＡＳＨ ＪＯＢＳ？").match?.band).toBe("high");
    expect(composite("  Git Status  ").match?.band).toBe("high");
    expect(composite("额度还剩多少??").match?.band).toBe("high");
  });
});
