/**
 * R1 · catalog (plan R1 step 5; arch §4.5): four frozen builtin scripts, the arch table
 * sentences present verbatim, ≥5 examples per side, deep freeze, module-load self-check.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { regexSourceProblems, validateCatalog } from "../../../src/reflex/core/schema.js";
import { IMPERATIVE_VETO } from "../../../src/reflex/core/gate.js";
import type { RScriptV1 } from "../../../src/reflex/core/types.js";

const ARCH_TABLE_HITS: Record<string, readonly string[]> = {
  "jobs.list": ["后台还有几个 job", "有后台任务在跑吗", "bash jobs", "后台任务状态"],
  "fleet.status": ["有几个 subagent 在跑", "子 agent 状态", "现在有哪些 agent 在跑"],
  "quota.summary": ["额度还剩多少", "quota 还有多少", "5h 额度用了多少"],
  "git.status": ["工作区干净吗", "git status", "有未提交的改动吗", "当前分支是什么"],
};

const ARCH_TABLE_MISS: Record<string, readonly string[]> = {
  "jobs.list": ["把后台 job 都停了", "那个 job 完成了吗", "跑一下测试放后台"],
  "fleet.status": ["派个 agent 去查", "停掉所有 agent", "agent 跑完了吗他说了啥"],
  "quota.summary": ["额度不够了换个模型", "这周花了多少钱"],
  "git.status": ["把改动提交了", "回滚工作区", "这些改动对吗", "git log 看一下"],
};

function script(id: string): RScriptV1 {
  const found = BUILTIN_SCRIPTS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`missing script ${id}`);
  return found;
}

describe("BUILTIN_SCRIPTS", () => {
  it("has exactly the four MVP scripts, builtin, v1, readonly", () => {
    expect(BUILTIN_SCRIPTS.map((s) => s.id)).toEqual(["jobs.list", "fleet.status", "quota.summary", "git.status"]);
    for (const s of BUILTIN_SCRIPTS) {
      expect(s.schema).toBe("rscript/1");
      expect(s.version).toBe(1);
      expect(s.origin).toBe("builtin");
      expect(s.risk).toBe("readonly");
    }
  });

  it.each(Object.keys(ARCH_TABLE_HITS))("%s contains the arch §4.5 table sentences verbatim", (id) => {
    for (const hit of ARCH_TABLE_HITS[id]!) expect(script(id).intent.examples.hit, hit).toContain(hit);
    for (const miss of ARCH_TABLE_MISS[id]!) expect(script(id).intent.examples.miss, miss).toContain(miss);
  });

  it("every script has ≥5 hit and ≥5 miss examples", () => {
    for (const s of BUILTIN_SCRIPTS) {
      expect(s.intent.examples.hit.length, s.id).toBeGreaterThanOrEqual(5);
      expect(s.intent.examples.miss.length, s.id).toBeGreaterThanOrEqual(5);
    }
  });

  it("requires map to the arch table (jobs→bashJobs, fleet→fleet, quota→quota, git→git)", () => {
    expect(script("jobs.list").requires).toEqual(["bashJobs"]);
    expect(script("fleet.status").requires).toEqual(["fleet"]);
    expect(script("quota.summary").requires).toEqual(["quota"]);
    expect(script("git.status").requires).toEqual(["git"]);
  });

  it("agreement shapes match the arch table (quota has none — no-tool statistic)", () => {
    expect(script("jobs.list").agreement.tools).toEqual(["bash_job:list", "bash_job:status"]);
    expect(script("fleet.status").agreement.tools).toEqual(["get_run_result", "list_subagents"]);
    expect(script("quota.summary").agreement.tools).toEqual([]);
    expect(script("git.status").agreement.bashShapes).toEqual(["git status", "git diff"]);
  });

  it("is deep-frozen (strict-mode mutation throws, nested arrays included)", () => {
    expect(() => {
      (BUILTIN_SCRIPTS as unknown as { id: string }[])[0]!.id = "hacked";
    }).toThrow();
    expect(() => {
      (script("jobs.list").intent as unknown as { strong: string[] }).strong.push("x");
    }).toThrow();
    expect(() => {
      (script("jobs.list").intent.examples as unknown as { hit: string[] }).hit[0] = "x";
    }).toThrow();
  });

  it("passes validateCatalog (also proven by successful module load)", () => {
    expect(() => validateCatalog(BUILTIN_SCRIPTS)).not.toThrow();
  });
});

describe("regex hygiene scan (plan R1 tests: no /g semantics, no nested quantifiers)", () => {
  it("all catalog intent sources are clean", () => {
    for (const s of BUILTIN_SCRIPTS) {
      const sources = [...s.intent.strong, ...s.intent.weak, ...s.intent.exclude];
      for (const src of sources) expect(regexSourceProblems(src), `${s.id}: ${src}`).toEqual([]);
    }
  });

  it("IMPERATIVE_VETO entries are plain substrings (no regex metacharacters at all)", () => {
    for (const word of IMPERATIVE_VETO) {
      expect(regexSourceProblems(word), word).toEqual([]);
      expect(/[\\^$.*+?()[\]{}|]/.test(word), word).toBe(false);
    }
  });

  it("catalog-compiled matchers are stateless across repeated tests (no /g lastIndex)", async () => {
    const { compileCatalog } = await import("../../../src/reflex/core/match.js");
    const matcher = compileCatalog(BUILTIN_SCRIPTS);
    const caps = new Set(["bashJobs", "fleet", "quota", "git"] as const);
    const norm = "后台还有几个 job";
    const first = matcher.match(norm, caps);
    const second = matcher.match(norm, caps);
    const third = matcher.match(norm, caps);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });
});
