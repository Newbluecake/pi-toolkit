/* eslint-disable @typescript-eslint/no-explicit-any */
/** jev-reflex R2b: `/reflex status | explain | reset` (command.ts) — explain agrees with `match`, status text pinned inline. */
import { describe, expect, it } from "vitest";
import { createReflexCommand, explainText, statusText, type ReflexCommandDeps } from "../../src/reflex/command.js";
import { BUILTIN_SCRIPTS } from "../../src/reflex/core/catalog.js";
import { evaluateGate } from "../../src/reflex/core/gate.js";
import { compileCatalog } from "../../src/reflex/core/match.js";
import type { Capability, ReflexStatusSnapshot } from "../../src/reflex/core/types.js";

const ALL: ReadonlySet<Capability> = new Set<Capability>(["bashJobs", "fleet", "quota", "git"]);
const matcher = compileCatalog(BUILTIN_SCRIPTS);

function snap(over: Partial<ReflexStatusSnapshot> = {}): ReflexStatusSnapshot {
  return {
    enabled: true,
    generation: 2,
    disposed: false,
    inFlight: false,
    scripts: BUILTIN_SCRIPTS.map((s) => ({ id: s.id, state: "shadow" as const, strikes: 0 })),
    counters: { candidates: 3, answered: 0, ambiguous: 1, repeat: 0, reasked: 1, corrected: 0 },
    unknownAutoResolve: [],
    ...over,
  };
}

function deps(over: Partial<ReflexCommandDeps> = {}): ReflexCommandDeps {
  return {
    enabled: () => true,
    autoResolve: () => [],
    snapshot: () => snap(),
    catalog: BUILTIN_SCRIPTS,
    matcher,
    capabilities: () => ALL,
    reset: () => true,
    ...over,
  };
}

const rec = (over: Record<string, unknown>) => ({
  type: "custom",
  customType: "subagent:reflex-record",
  data: {
    v: 1,
    kind: "shadow",
    at: 1,
    scriptId: "jobs.list",
    scriptVer: 1,
    state: "shadow",
    band: "high",
    requestDigest: "d",
    chars: 5,
    port: { outcome: "ok", ms: 10, portVer: 1 },
    model: { agree: "agree", tools: [] },
    ...over,
  },
});

describe("/reflex explain", () => {
  it("agrees with gate+match on every example sentence of the catalog (hit and miss)", () => {
    for (const s of BUILTIN_SCRIPTS) {
      for (const text of [...s.intent.examples.hit, ...s.intent.examples.miss]) {
        const out = explainText(deps(), text);
        const g = evaluateGate({
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
        });
        if (!g.pass) {
          expect(out).toBe(`reflex explain: veto=${g.veto}`);
          continue;
        }
        const m = matcher.match(g.norm.norm, ALL);
        if (m.kind === "miss") expect(out).toBe("reflex explain: miss（S1 无命中）");
        else {
          expect(out).toContain(`band=${m.band} script=${m.scriptId}`);
          expect(out).toMatch(/\((strong|weak)#\d+\)|（(strong|weak)#\d+）/);
        }
      }
      for (const text of s.intent.examples.hit) {
        const out = explainText(deps(), text);
        expect(out, text).toContain(`script=${s.id}`);
        expect(out, text).toContain("band=high");
      }
    }
  });

  it("pinned outputs", () => {
    expect(explainText(deps(), "后台还有几个 job")).toBe(
      "reflex explain: band=high script=jobs.list candidates=jobs.list（strong#0）",
    );
    expect(explainText(deps(), "job")).toBe(
      "reflex explain: band=ambiguous script=jobs.list candidates=jobs.list（weak#0）",
    );
    expect(explainText(deps(), "把后台 job 都停了")).toBe("reflex explain: veto=cancel");
    expect(explainText(deps(), "把改动提交了")).toBe("reflex explain: veto=imperative");
    expect(explainText(deps(), "/reflex")).toBe("reflex explain: veto=prefix");
    expect(explainText(deps(), "今天天气怎么样")).toBe("reflex explain: miss（S1 无命中）");
    expect(explainText(deps(), "  ")).toContain("用法");
  });

  it("uses live capabilities: without bashJobs the jobs script is invisible", () => {
    expect(explainText(deps({ capabilities: () => new Set<Capability>(["git"]) }), "后台还有几个 job")).toBe(
      "reflex explain: miss（S1 无命中）",
    );
  });

  it("never executes a port (deps expose none)", () => {
    expect(Object.keys(deps()).sort()).toEqual(
      ["autoResolve", "capabilities", "catalog", "enabled", "matcher", "reset", "snapshot"].sort(),
    );
  });
});

describe("/reflex status", () => {
  it("text snapshot: empty branch", () => {
    expect(statusText(deps(), [])).toBe(
      [
        "reflex: enabled · autoResolve=- · gen 2",
        "脚本状态（shadow 只记账不作答；auto 命中时直接作答，失败两次/重复/被纠正自动降回 shadow）：",
        "  jobs.list shadow strikes=0",
        "  fleet.status shadow strikes=0",
        "  quota.summary shadow strikes=0",
        "  git.status shadow strikes=0",
        "本激活计数：candidates=3 answered=0 ambiguous=1 repeat=0 reasked=1 corrected=0 fallback=0",
        "本会话记录（getBranch）：",
        "  （无）",
        "晋升判定：本会话样本不足以判定，跨会话请跑 `node scripts/dev/reflex-shadow.mjs`（R3b）。",
      ].join("\n"),
    );
  });

  it("text snapshot: per-session rollup from getBranch, demote, unknown autoResolve id", () => {
    const branch = [
      rec({}),
      rec({ port: { outcome: "ok", ms: 30, portVer: 1 }, model: { agree: "diverge", tools: [] } }),
      rec({
        port: { outcome: "error", ms: 50, reason: "exception", portVer: 1 },
        model: { agree: "unknown", tools: [] },
      }),
      { type: "custom", customType: "other", data: {} },
      {
        type: "custom",
        customType: "subagent:reflex-correction",
        data: {
          v: 1,
          at: 2,
          targetKind: "shadow",
          targetScriptId: "jobs.list",
          targetScriptVer: 1,
          targetDigest: "d",
          deltaMs: 1,
          correctionDigest: "c",
        },
      },
    ];
    const d = deps({
      autoResolve: () => ["jobs.list", "nope.x"],
      snapshot: () =>
        snap({
          scripts: [
            { id: "jobs.list", state: "demoted", strikes: 2, demoteReason: "strikes" },
            { id: "git.status", state: "shadow", strikes: 0 },
          ],
          counters: {
            candidates: 3,
            answered: 0,
            ambiguous: 0,
            repeat: 0,
            reasked: 0,
            corrected: 1,
            "fallback.timeout": 2,
          },
          unknownAutoResolve: ["nope.x"],
        }),
    });
    expect(statusText(d, branch)).toBe(
      [
        "reflex: enabled · autoResolve=jobs.list,nope.x · gen 2",
        "脚本状态（shadow 只记账不作答；auto 命中时直接作答，失败两次/重复/被纠正自动降回 shadow）：",
        "  jobs.list demoted strikes=2 demote=strikes",
        "  git.status shadow strikes=0",
        "本激活计数：candidates=3 answered=0 ambiguous=0 repeat=0 reasked=0 corrected=1 fallback=fallback.timeout=2",
        "本会话记录（getBranch）：",
        "  jobs.list@1 cand=3 port_ok=2/3 agree=50%(1/2) diverge=1 unknown=1 reasked=0 corrected=1 answered=0 p50=30ms p95=50ms",
        "    promotion: not eligible（7 项未过）",
        "晋升判定：本会话样本不足以判定，跨会话请跑 `node scripts/dev/reflex-shadow.mjs`（R3b）。",
        "autoResolve 含未知 id（已忽略）：nope.x",
      ].join("\n"),
    );
  });
});

describe("command handler", () => {
  async function run(d: ReflexCommandDeps, args: string, ctx?: any): Promise<string[]> {
    const out: string[] = [];
    const c = ctx ?? { ui: { notify: (m: string) => out.push(m) }, sessionManager: { getBranch: () => [] } };
    if (ctx === undefined) await createReflexCommand(d).handler(args, c);
    else await createReflexCommand(d).handler(args, ctx);
    return out;
  }

  it("default and `status` print the status; unknown subcommand prints usage", async () => {
    const a = await run(deps(), "");
    const b = await run(deps(), "status");
    expect(a).toEqual(b);
    expect(a[0]).toContain("reflex: enabled");
    expect((await run(deps(), "bogus"))[0]).toContain("用法");
  });

  it("explain forwards the rest of the line; reset reports unknown ids", async () => {
    expect((await run(deps(), "explain git status"))[0]).toContain("script=git.status");
    const resets: Array<string | undefined> = [];
    const d = deps({
      reset: (id) => {
        resets.push(id);
        return id !== "nope";
      },
    });
    expect((await run(d, "reset"))[0]).toContain("reset all");
    expect((await run(d, "reset jobs.list"))[0]).toContain("reset jobs.list");
    expect((await run(d, "reset nope"))[0]).toContain("未知脚本 id「nope」");
    expect(resets).toEqual([undefined, "jobs.list", "nope"]);
  });

  it("status survives a missing session manager and a missing UI", async () => {
    const out: string[] = [];
    await createReflexCommand(deps()).handler("", { ui: { notify: (m: string) => out.push(m) } } as any);
    expect(out).toHaveLength(1);
    await expect(createReflexCommand(deps()).handler("", {} as any)).resolves.toBeUndefined();
  });
});
