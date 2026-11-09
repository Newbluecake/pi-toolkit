// #36 P4 (arch r5 §4.4/§5.3/§5.4) — the v3 tool against the REAL
// `createJevWritePort` with a scripted full-status client: the g1 scope
// question rides the tagging askAll, `EntryTags.globalP` lands in the blocks
// sidecar, relation VERDICTS execute through P5a's locked single-edge
// protocol, and the jev-off shape stays silent.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { createMemoryToolV3 } from "../../src/memory/tool-v3.js";
import { createJevWritePort } from "../../src/memory/jev/write-port.js";
import { EntryIndex } from "../../src/memory/jev/entries.js";
import { mergeTaxonomy } from "../../src/memory/jev/taxonomy.js";
import { readIndex } from "../../src/memory/jev/index-store.js";
import { MEMORY_TOOL_V3_TEXT, MEMORY_TOOL_V3_TEXT_JEV } from "../../src/memory/tool-surface.js";
import type {
  ClassifierRegistryLike,
  JevClient,
  JevOutcome,
  JevQuestion,
  JevWritePort,
  RelationVerdict,
} from "../../src/memory/jev/contracts.js";

/** `(registry: ClassifierRegistryLike | undefined) => void` — the ctx stub's
 *  modelRegistry shape the port's registryOf accepts. */
type JevWritePortRegistry = (registry: ClassifierRegistryLike | undefined) => void;
import { writeBlocksDir, blockRaw, type BlockSpec } from "./blocks/helpers.js";
import { clearHealthTable } from "../../src/memory/jev/health.js";
import { createFakeRegistry } from "./jev/helpers/fake-registry.js";
import { wireMemory } from "../../src/memory/index.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { parseBlockFile } from "../../src/memory/blocks/format.js";

const FULL = { kind: "full", model: "opencode/jev-1.13" } as const;
const CLASSIFIERS = DEFAULT_SETTINGS.memory.jev.classifiers;

interface AskRecord {
  questions: Record<string, JevQuestion>;
  answers: Record<string, unknown>;
}

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
  memDir: string;
  realDir: string;
  asks: AskRecord[];
  port: JevWritePort;
  verdicts: readonly RelationVerdict[] | undefined;
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build the REAL write port over a scripted full client. `script` maps an
 *  ask's question ids to answers; unmapped m_* default to a plausible
 *  minimal tagging answer. */
function fixture(
  specs: readonly BlockSpec[],
  script: (ask: AskRecord) => Record<string, unknown> = () => ({}),
): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-toolv3jev-"));
  tmpRoots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
  const memDir = memoryDirFor(cwd, paths);
  const realDir = specs.length > 0 ? writeBlocksDir(memDir, specs) : join(memDir, "blocks");
  const asks: AskRecord[] = [];
  const client: JevClient = {
    status: () => FULL,
    async ask(req) {
      asks.push({ questions: req.questions, answers: {} });
      const defaults: Record<string, unknown> = {
        m_type: { type: "choice", choice: "fact", probabilities: { fact: 0.9 }, confidence: 0.9 },
        m_importance: { type: "score", score: 2, confidence: 0.9 },
        m_guard: { type: "bool", probability: 0.05 },
        m_temporal: { type: "choice", choice: "permanent", probabilities: { permanent: 0.9 }, confidence: 0.9 },
        m_userlike: { type: "bool", probability: 0.1 },
      };
      const answers = { ...defaults, ...script(asks[asks.length - 1]!) };
      return {
        ok: true,
        model: FULL.model,
        answers: answers as Parameters<typeof script>[0] extends never ? never : Record<string, never>,
        missing: [],
        costUsd: 0.001,
        latencyMs: 10,
      } as unknown as JevOutcome;
    },
    async probe() {
      return FULL;
    },
  };
  const port = createJevWritePort({
    client,
    entryIndex: new EntryIndex(),
    dirFor: (c) => memoryDirFor(c, paths),
    taxonomyFor: () => mergeTaxonomy().taxonomy,
    now: () => Date.parse("2026-11-06T00:00:00Z"),
  });
  return { tmp, cwd, paths, memDir, realDir, asks, port, verdicts: undefined };
}

function ctx(
  cwd: string,
  opts: { notify?: (m: string, l?: string) => void; registry?: unknown } = {},
): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    ui: { notify: opts.notify ?? (() => {}) },
    ...(opts.registry === undefined ? {} : { modelRegistry: opts.registry }),
  } as unknown as ExtensionContext;
}

/** The registry stub the port accepts (classify + getAvailableOfType). */
const registry: ClassifierRegistryLike = {
  classify: async () => ({ stopReason: "stop" as const, answers: {} }),
  getAvailableOfType: () => [],
};

function makeTool(fx: Fixture, capture?: (relations: readonly RelationVerdict[] | undefined) => void) {
  const port = fx.port;
  const wrapped: JevWritePort = {
    async afterWrite(input) {
      const result = await port.afterWrite(input);
      capture?.(result.relations);
      return result;
    },
    checkInline: (f, b, a) => port.checkInline(f, b, a),
    touchedUserEntries: (f, b, a, h) => port.touchedUserEntries(f, b, a, h),
  };
  return createMemoryToolV3({
    settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
    isChildSession: false,
    onAfterWrite: () => {},
    paths: fx.paths,
    jev: wrapped,
  });
}

async function exec(tool: ReturnType<typeof createMemoryToolV3>, params: Record<string, unknown>, c: ExtensionContext) {
  const result = (await tool.execute("call-1", params, undefined, undefined, c)) as {
    content: { type: string; text: string }[];
  };
  return result.content.map((x) => x.text).join("\n");
}

function block(fx: Fixture, id: string) {
  const parsed = parseBlockFile(`${id}.md`, readFileSync(join(fx.realDir, `${id}.md`), "utf8"));
  if ("stray" in parsed) throw new Error("stray");
  return parsed;
}

// ───────────────────── V11: g1 + globalP ─────────────────────

describe("v3 jev: the g1 scope question (§5.3)", () => {
  test("a scope-less user rule asks g1 in the SAME askAll as the tagging questions", async () => {
    const fx = fixture([], (ask) => ({
      ...(Object.keys(ask.questions).some((k) => k === "g1") ? { g1: { type: "bool", probability: 0.82 } } : {}),
    }));
    const tool = makeTool(fx);
    const out = await exec(
      tool,
      { command: "create", topic: "gen", text: "- always ask before release <!-- mem user -->" },
      ctx(fx.cwd, { registry }),
    );
    expect(out).toContain("created gen.001");
    expect(fx.asks.length).toBe(1);
    const questions = fx.asks[0]!.questions;
    expect(questions).toHaveProperty("g1");
    expect(questions).toHaveProperty("m_type");
    expect(questions).toHaveProperty("m_importance");
    // the answer lands as EntryTags.globalP in the blocks sidecar
    const index = readIndex(fx.memDir).index;
    const entryTags = Object.values(index.entries)[0]!;
    expect(entryTags.globalP).toBeCloseTo(0.82);
    // ≥0.7 ⇒ the scope advice echo
    expect(out).toContain("scope: topic (decision record — injected when relevant)");
    expect(out).toContain("add scope=global to inject it every turn");
  });

  test("globalP < 0.7: no scope echo (still stored)", async () => {
    const fx = fixture([], () => ({ g1: { type: "bool", probability: 0.3 } }));
    const tool = makeTool(fx);
    const out = await exec(
      tool,
      { command: "create", topic: "gen", text: "- a decision <!-- mem user -->" },
      ctx(fx.cwd, { registry }),
    );
    expect(out).not.toContain("scope: topic");
    expect(Object.values(readIndex(fx.memDir).index.entries)[0]!.globalP).toBeCloseTo(0.3);
  });

  test("g1 is NOT asked for explicit-scope user rules, agent rules, or agent-demoted blocks", async () => {
    const fx = fixture([
      { id: "gen.001", authority: "user", scope: "global", body: "- explicit global" },
      { id: "gen.002", authority: "agent", body: "- agent fact" },
    ]);
    const tool = makeTool(fx);
    await exec(
      tool,
      {
        command: "update",
        path: "gen.001",
        rev: block(fx, "gen.001").rev,
        text: "- explicit global v2 <!-- mem user scope=global -->",
      },
      ctx(fx.cwd, { registry }),
    );
    expect(fx.asks.length).toBe(1);
    expect(fx.asks[0]!.questions).not.toHaveProperty("g1");
    await exec(tool, { command: "create", topic: "gen", text: "- plain agent fact" }, ctx(fx.cwd, { registry }));
    expect(fx.asks[1]!.questions).not.toHaveProperty("g1");
  });

  test("jev off (no port): no questions, no scope echo — tool-v3.test covers this; here the port's off path", async () => {
    // off via a client that reports off: the write still succeeds, echo is
    // the deterministic not-tagged line, no g1 anywhere.
    const tmp = mkdtempSync(join(tmpdir(), "pi-mem-toolv3jevoff-"));
    tmpRoots.push(tmp);
    const cwd = join(tmp, "proj");
    mkdirSync(cwd, { recursive: true });
    const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
    const memDir = memoryDirFor(cwd, paths);
    const realDir = writeBlocksDir(memDir, [{ id: "gen.001", authority: "user", body: "- u" }]);
    const offClient: JevClient = {
      status: () => ({ kind: "off", reason: "disabled" }),
      async ask() {
        return { ok: false, reason: "off", detail: "" };
      },
      async probe() {
        return { kind: "off", reason: "disabled" };
      },
    };
    const port = createJevWritePort({
      client: offClient,
      entryIndex: new EntryIndex(),
      dirFor: (c) => memoryDirFor(c, paths),
      taxonomyFor: () => mergeTaxonomy().taxonomy,
      now: () => 0,
    });
    const tool = createMemoryToolV3({
      settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
      isChildSession: false,
      onAfterWrite: () => {},
      paths,
      jev: port,
    });
    const out = await exec(
      tool,
      { command: "update", path: "gen.001", rev: block({ realDir } as Fixture, "gen.001").rev, text: "- u v2" },
      ctx(cwd, { registry }),
    );
    expect(out).toContain("updated gen.001");
    expect(out).toContain("jev: not tagged (off: disabled)");
    expect(out).not.toContain("scope: topic");
  });

  test("description: the jev variant is selected when a port is wired", async () => {
    const fx = fixture([]);
    const tool = makeTool(fx);
    expect(tool.description).toBe(MEMORY_TOOL_V3_TEXT_JEV.description);
    const bare = createMemoryToolV3({
      settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
      isChildSession: false,
      onAfterWrite: () => {},
      paths: fx.paths,
    });
    expect(bare.description).toBe(MEMORY_TOOL_V3_TEXT.description);
  });
});

// ───────────────────── §5.4 relation verdicts + P5a execution ─────────────────────

describe("v3 jev: relation verdicts (§5.4 — P5a executes)", () => {
  const supersedes09 = (ask: AskRecord): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const id of Object.keys(ask.questions)) {
      if (/^c\d+$/.test(id)) {
        out[id] = { type: "choice", choice: "supersedes", probabilities: { supersedes: 0.9 }, confidence: 0.9 };
      }
    }
    return out;
  };

  test("user→agent at p≥0.85 is an AUTO verdict and supersedes the old block with CAS", async () => {
    const fx = fixture(
      [{ id: "old.001", authority: "agent", body: "- ship releases via the scripted pipeline" }],
      supersedes09,
    );
    const oldBefore = block(fx, "old.001");
    let verdicts: readonly RelationVerdict[] | undefined;
    const tool = makeTool(fx, (v) => {
      verdicts = v;
    });
    const out = await exec(
      tool,
      { command: "create", topic: "other", text: "- ship releases with npm run release now <!-- mem user -->" },
      ctx(fx.cwd, { registry }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    // scripted: every c* answers supersedes at 0.9
    expect(verdicts).toBeDefined();
    const auto = verdicts!.filter((v) => v.auto);
    expect(auto.length).toBeGreaterThan(0);
    expect(auto[0]!.kind).toBe("supersedes");
    expect(auto[0]!.oldId).toBe("old.001");
    expect(auto[0]!.p).toBeGreaterThanOrEqual(0.85);
    expect(auto[0]!.newRev).toBe(block(fx, "other.001").rev);
    // oldRev = the rev the JUDGMENT actually saw (P5a's in-lock CAS recheck
    // compares against exactly this value)
    expect(auto[0]!.oldRev).toBe(oldBefore.rev);
    const oldAfter = block(fx, "old.001");
    expect(oldAfter.rev).not.toBe(oldBefore.rev);
    expect(oldAfter.meta.version).toBe(oldBefore.meta.version + 1);
    expect(oldAfter.body).toBe(oldBefore.body);
    expect(oldAfter.meta.status).toBe("superseded");
    expect(oldAfter.meta.supersededBy).toBe("other.001");
    expect(out).toContain("superseded: old.001 by other.001");
  });

  test("below the auto threshold (0.75–0.85): conflict suggestion echo, auto=false", async () => {
    const supersedes078 = (ask: AskRecord): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const id of Object.keys(ask.questions)) {
        if (/^c\d+$/.test(id)) {
          out[id] = { type: "choice", choice: "supersedes", probabilities: { supersedes: 0.78 }, confidence: 0.78 };
        }
      }
      return out;
    };
    const fx = fixture([{ id: "old.001", authority: "agent", body: "- completely different fact" }], supersedes078);
    let verdicts: readonly RelationVerdict[] | undefined;
    const tool = makeTool(fx, (v) => {
      verdicts = v;
    });
    const out = await exec(tool, { command: "create", topic: "x", text: "- another fact" }, ctx(fx.cwd, { registry }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(verdicts!.length).toBeGreaterThan(0);
    expect(verdicts!.every((v) => !v.auto)).toBe(true);
    expect(out).toContain("conflict: old.001 (p=0.78) — below auto threshold; review suggested");
    expect(block(fx, "old.001").meta.status).toBe("active");
    expect(block(fx, "old.001").meta.supersededBy).toBeUndefined();
  });

  test("agent→user NEVER auto: the not-superseded suggestion echoes instead", async () => {
    const conflict095 = (ask: AskRecord): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const id of Object.keys(ask.questions)) {
        if (/^c\d+$/.test(id)) {
          out[id] = { type: "choice", choice: "conflict", probabilities: { conflict: 0.95 }, confidence: 0.95 };
        }
      }
      return out;
    };
    const fx = fixture(
      [{ id: "rule.001", authority: "user", scope: "global", body: "- never push to master" }],
      conflict095,
    );
    let verdicts: readonly RelationVerdict[] | undefined;
    const tool = makeTool(fx, (v) => {
      verdicts = v;
    });
    const out = await exec(
      tool,
      { command: "create", topic: "x", text: "- pushing to master is fine" },
      ctx(fx.cwd, { registry }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    // the user block is never in the relation pool (matrix), so no verdicts
    // against it can be auto — the userEcho suggestion is the only output.
    for (const v of verdicts ?? []) {
      expect(v.oldId).not.toBe("rule.001");
    }
    expect(out).toContain("not superseded: rule.001 is a user rule — agent blocks never supersede user rules");
    expect(block(fx, "rule.001").meta.status).toBe("active");
    expect(block(fx, "rule.001").meta.supersededBy).toBeUndefined();
  });

  test("compare pool: user-new pools cross-topic user + agents; agent-new pools agents + userEcho", async () => {
    const specs: BlockSpec[] = [
      { id: "alpha.001", authority: "user", scope: "global", body: "- alpha user rule" },
      { id: "beta.001", authority: "agent", body: "- beta agent fact" },
      { id: "x.001", authority: "agent", body: "- x agent fact" },
    ];
    const fx = fixture(specs);
    const tool = makeTool(fx);
    await exec(
      tool,
      { command: "create", topic: "gamma", text: "- gamma user rule <!-- mem user -->" },
      ctx(fx.cwd, { registry }),
    );
    // user-new: pool has c1..cN with the existing user + agent blocks
    const userNewIds = Object.keys(fx.asks[0]!.questions).filter((k) => /^c\d+$/.test(k));
    expect(userNewIds.length).toBeGreaterThan(0);
    expect(userNewIds.length).toBeLessThanOrEqual(12);
    const fx2 = fixture(specs);
    const tool2 = makeTool(fx2);
    await exec(tool2, { command: "create", topic: "x", text: "- x agent fact two" }, ctx(fx2.cwd, { registry }));
    const agentNewIds = Object.keys(fx2.asks[0]!.questions).filter((k) => /^c\d+$/.test(k));
    expect(agentNewIds.length).toBeGreaterThan(0);
    expect(agentNewIds.length).toBeLessThanOrEqual(12);
  });

  test("metadata-only edit (same body hash) re-tags nothing", async () => {
    const fx = fixture([{ id: "gen.001", authority: "agent", expires: "2030-01-01", body: "- stable fact" }]);
    const tool = makeTool(fx);
    await exec(
      tool,
      {
        command: "update",
        path: "gen.001",
        rev: block(fx, "gen.001").rev,
        text: "- stable fact <!-- mem expires=2031-01-01 -->",
      },
      ctx(fx.cwd, { registry }),
    );
    expect(fx.asks.length).toBe(0); // body hash unchanged ⇒ no askAll at all
    expect(block(fx, "gen.001").meta.expires).toBe("2031-01-01");
  });
});

// ── 修复轮：checkInline 在端口开启时对服务端键保持 v3 忽略语义 ──

describe("v3 jev fix-round", () => {
  test("section repair passes the real Jev inline guard without triggering classification or relations", async () => {
    const fx = fixture([{ id: "gen.001", section: "中".repeat(34), body: "- fact", allowOversize: true }]);
    const tool = makeTool(fx);
    const before = block(fx, "gen.001");
    const reply = await exec(
      tool,
      {
        command: "update",
        path: "gen.001",
        rev: before.rev,
        text: '- fact <!-- mem section="short group" -->',
      },
      ctx(fx.cwd, { registry }),
    );
    expect(reply).toContain("updated gen.001");
    expect(block(fx, "gen.001").meta.section).toBe("short group");
    expect(block(fx, "gen.001").meta.authority).toBe(before.meta.authority);
    expect(block(fx, "gen.001").meta.supersededBy).toBeUndefined();
    expect(fx.asks).toHaveLength(0);
  });
  test("server-owned keys pass checkInline under a wired port (tokens stripped, real errors kept)", async () => {
    const fx = fixture([{ id: "gen.001", authority: "agent", body: "- fact" }]);
    const tool = makeTool(fx);
    // rev=/version= are server-owned ⇒ ignored (no rejection), still echoed
    const ok = await exec(
      tool,
      {
        command: "update",
        path: "gen.001",
        rev: block(fx, "gen.001").rev,
        text: "- fact v2 <!-- mem rev=9 version=3 -->",
      },
      ctx(fx.cwd, { registry }),
    );
    expect(ok).toContain("updated gen.001");
    expect(ok).toContain("ignored: rev, version (server-owned)");
    // a genuinely broken key still rejects BEFORE the port (parseWriteMeta)
    const bad = await exec(
      tool,
      { command: "update", path: "gen.001", rev: block(fx, "gen.001").rev, text: "- x <!-- mem bogus=1 -->" },
      ctx(fx.cwd, { registry }),
    ).catch((e: Error) => e.message);
    expect(bad).toContain("refused: the inline comment has errors");
  });
});

// ── 修复轮：真实 wireMemory layout:blocks + jev on 的生产互斥证明 ──

describe("production wireMemory with layout:blocks wires jev (fix round)", () => {
  test("v3 registers with the JEV description; tagging + g1 + sidecar all reachable through the real assembly", async () => {
    clearHealthTable();
    const tmp = mkdtempSync(join(tmpdir(), "mem-blocks-prod-jev-"));
    tmpRoots.push(tmp);
    vi.stubEnv("HOME", join(tmp, "nohome"));
    vi.stubEnv("ARMORY_MEMORY_ROOT", join(tmp, "mem"));
    const cwd = join(tmp, "proj");
    mkdirSync(cwd, { recursive: true });
    const memDir = memoryDirFor(cwd);
    const realDir = writeBlocksDir(memDir, [
      { id: "old.001", authority: "agent", body: "- ship releases via the scripted pipeline" },
    ]);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools = new Map<
      string,
      {
        name: string;
        description: string;
        execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown>;
      }
    >();
    const branch: unknown[] = [];
    const pi = {
      on: (event: string, h: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), h]);
      },
      registerTool: (t: { name: string; description: string }) => tools.set(t.name, t as never),
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      getActiveTools: () => ["read", "bash", "memory"],
      sendMessage: (message: unknown) => {
        branch.push(message);
      },
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
    const hub = createPromptSectionHub(pi, {
      mode: () => "stable",
      wakeReplay: false,
      adoptForeignForcedPrompt: false,
    });
    const classifyAsks: Record<string, unknown>[] = [];
    const fake = createFakeRegistry({
      available: CLASSIFIERS,
      responses: Object.fromEntries(
        CLASSIFIERS.map((id) => [
          id,
          [
            async (call: { state: Record<string, unknown>; questions: Record<string, unknown> }) => {
              classifyAsks.push({ state: call.state, questions: call.questions });
              const answers: Record<string, unknown> = {
                m_type: { type: "choice", choice: "rule", probabilities: { rule: 0.9 }, confidence: 0.9 },
                m_importance: { type: "score", score: 3, confidence: 0.9 },
                m_guard: { type: "bool", probability: 0.05 },
                m_temporal: { type: "choice", choice: "permanent", probabilities: { permanent: 0.9 }, confidence: 0.9 },
                m_userlike: { type: "bool", probability: 0.2 },
                g1: { type: "bool", probability: 0.82 },
                c1: { type: "choice", choice: "supersedes", probabilities: { supersedes: 0.91 }, confidence: 0.91 },
              };
              return { stopReason: "stop" as const, answers };
            },
          ],
        ]),
      ),
    });
    wireMemory(pi, {
      settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
      isChildSession: false,
      sections: hub,
      secureDomainKind: "plain",
    });
    // 1. the PRODUCTION layout:blocks activation wires jev (config fix) and
    //    registers the v3 tool with the JEV description variant
    const tool = tools.get("memory")!;
    expect(tool.description).toBe(MEMORY_TOOL_V3_TEXT_JEV.description);
    // 2. a user-rule create through the real tool: tagging + g1 in ONE
    //    askAll, and the verdict against the old agent block
    const result = (await tool.execute(
      "call-1",
      { command: "create", topic: "other", text: "- ship releases with npm run release now <!-- mem user -->" },
      undefined,
      undefined,
      {
        mode: "tui",
        hasUI: true,
        cwd,
        ui: { notify: () => {} },
        modelRegistry: fake.registry,
        sessionManager: { getBranch: () => branch, getSessionId: () => "prod-jev-1" },
      },
    )) as { content: { type: string; text: string }[] };
    const out = result.content.map((c) => c.text).join("\n");
    expect(out).toContain("created other.001");
    expect(out).toContain("jev: rule ");
    expect(out).toContain("scope: topic (decision record — injected when relevant)");
    expect(classifyAsks.length).toBe(1);
    expect(classifyAsks[0]!.questions).toHaveProperty("g1");
    expect(classifyAsks[0]!.questions).toHaveProperty("c1");
    // 3. the sidecar is the REAL blocks sidecar with globalP + the tags
    const index = readIndex(memDir).index;
    const tags = Object.values(index.entries)[0]!;
    expect(tags.globalP).toBeCloseTo(0.82);
    expect(tags.file).toBe("other.001.md");
    // 4. P5a consumes the verdict through the real production assembly.
    const superseded = parseBlockFile("old.001.md", readFileSync(join(realDir, "old.001.md"), "utf8"));
    if ("stray" in superseded) throw new Error("superseded block is malformed");
    expect(superseded.meta.status).toBe("superseded");
    expect(superseded.meta.supersededBy).toBe("other.001");
    expect(out).toContain("superseded: old.001 by other.001");
    vi.unstubAllEnvs();
  });
});

describe("whole-replacement-only policy", () => {
  test.each([0.9, 1])("conflict p=%s stays active with a suggestion", async (p) => {
    const fx = fixture([{ id: "old.001", authority: "agent", body: "- pipeline and backup rules" }], (ask) =>
      Object.fromEntries(
        Object.keys(ask.questions)
          .filter((id) => /^c\d+$/.test(id))
          .map((id) => [id, { type: "choice", choice: "conflict", probabilities: { conflict: p }, confidence: p }]),
      ),
    );
    let verdicts: readonly RelationVerdict[] | undefined;
    const out = await exec(
      makeTool(fx, (v) => {
        verdicts = v;
      }),
      { command: "create", topic: "old", text: "- change pipeline only" },
      ctx(fx.cwd, { registry }),
    );
    expect(verdicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "conflict", p, auto: false })]));
    expect(block(fx, "old.001").meta.status).toBe("active");
    expect(block(fx, "old.001").meta.supersededBy).toBeUndefined();
    expect(out).toContain("review suggested");
    const q = fx.asks[0]!.questions.c1!;
    if (q.type !== "choice") throw new Error("expected choice");
    expect(q.criteria.duplicate).toContain("new subset is NOT duplicate");
  });
  test.each([false, true])(
    "tool-v3 governance=%s only opts automatic afterWrite into wholeRelation",
    async (enabled) => {
      const fx = fixture([]);
      const inputs: Parameters<JevWritePort["afterWrite"]>[0][] = [];
      const tool = createMemoryToolV3({
        settings: {
          ...DEFAULT_SETTINGS.memory,
          layout: "blocks",
          governance: { ...DEFAULT_SETTINGS.memory.governance, enabled },
        },
        isChildSession: false,
        onAfterWrite() {},
        paths: fx.paths,
        jev: {
          ...fx.port,
          async afterWrite(input) {
            inputs.push(input);
            return fx.port.afterWrite(input);
          },
        },
      });
      await exec(tool, { command: "create", topic: "gen", text: "- agent fact" }, ctx(fx.cwd, { registry }));
      expect(inputs).toHaveLength(1);
      expect(Object.hasOwn(inputs[0]!, "wholeRelation")).toBe(enabled);
      expect(inputs[0]!.wholeRelation).toBe(enabled ? true : undefined);
      expect(inputs[0]!.askScope).toBeUndefined();
    },
  );
});
