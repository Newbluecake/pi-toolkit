// jev-plan §4 J6 wire-recall: U/A/E/B layers, static core, previous message,
// child dispatch, dedup + reload seeding, renderer — driven through a fake pi
// that mirrors pi's registration semantics (every `on()` handler fires) and a
// scripted classifier registry.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import type { EntryTags, JevConfig, JevRenderInfo, JevQuestion, MemEntry } from "../../../src/memory/jev/contracts.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { readIndex, writeIndexPatch } from "../../../src/memory/jev/index-store.js";
import {
  entryAnchor,
  failureExitCode,
  isStaticCore,
  passesPromptGate,
  previousUserMessage,
  stripSkillBlocks,
  wireJev,
} from "../../../src/memory/jev/wire.js";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "../../../src/memory/settings.js";
import { createFakeRegistry, type ClassifyCallRecord } from "./helpers/fake-registry.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const CLASSIFIERS = ["opencode/jev-1.13-free", "opencode/jev-1.13"];

let tmp: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  tmp = mkdtempSync(join(tmpdir(), "jev-wire-recall-"));
  memDir = join(tmp, "mem");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, "core.md"),
    [
      "# Core",
      "",
      "## Rules",
      "",
      "- always run long commands with timeout so nothing hangs",
      "- commit only exact paths and never use git add -A",
      "",
      "## Release",
      "",
      "- release only from dev after the CI pipeline is green",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(memDir, "pitfalls-git.md"),
    [
      "# Pitfalls git",
      "",
      "## Push",
      "",
      "- git push needs the proxy configured, otherwise it hangs forever",
      "- a private note never leaves the machine <!-- mem private -->",
      "- npm install fails on node 18 because fs.globSync is missing; use node 22",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearHealthTable();
});

function entries(): readonly MemEntry[] {
  return new EntryIndex().get(memDir);
}
function entryWith(text: string): MemEntry {
  const e = entries().find((x) => x.body.includes(text));
  if (e === undefined) throw new Error(`no entry containing ${text}`);
  return e;
}

/** Bool answers: p = first matching rule's value (substring of the question
 *  instructions), else 0.1. */
type Rules = readonly (readonly [string, number])[];
function answersFor(questions: Record<string, JevQuestion>, rules: Rules): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "bool") {
      const hit = rules.find(([needle]) => q.instructions.includes(needle));
      out[id] = { type: "bool", probability: hit?.[1] ?? 0.1 };
    } else if (q.type === "score") out[id] = { type: "score", score: 2, confidence: 0.9 };
    else {
      const k = Object.keys(q.criteria)[0]!;
      out[id] = { type: "choice", choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 };
    }
  }
  return out as Record<string, never>;
}

interface HarnessOpts {
  rules?: Rules;
  delayMs?: number;
  fail?: string;
  config?: Partial<JevConfig>;
  settings?: Partial<MemorySettings>;
  isChild?: boolean;
  renderInfo?: JevRenderInfo;
  noRegistry?: boolean;
}

function harness(opts: HarnessOpts = {}) {
  const handlers = new Map<string, Handler[]>();
  const sent: { message: { customType: string; content: unknown; details: any }; options: unknown }[] = [];
  const appended: { customType: string; data: any }[] = [];
  const branch: any[] = [];
  const renderers = new Map<string, Function>();
  const logs: string[] = [];
  let nextId = 1;
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (message: any, options: unknown) => {
      sent.push({ message, options });
      branch.push({ type: "custom_message", id: `m${nextId++}`, ...message });
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      branch.push({ type: "custom", id: `c${nextId++}`, customType, data });
    },
    registerMessageRenderer: (customType: string, r: Function) => renderers.set(customType, r),
  } as unknown as ExtensionAPI;
  const fake = createFakeRegistry({
    available: CLASSIFIERS,
    responses: Object.fromEntries(
      CLASSIFIERS.map((id) => [
        id,
        [
          async (call: ClassifyCallRecord) => {
            if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
            if (opts.fail !== undefined) return { stopReason: "error" as const, errorMessage: opts.fail };
            return { stopReason: "stop" as const, answers: answersFor(call.questions, opts.rules ?? []) };
          },
        ],
      ]),
    ),
  });
  // memory-predict plan.md §10/§11.1: this suite exercises the U/A/E/B layers
  // in isolation and pins exact `appended`/`sent` arrays; predict defaults to
  // ON (D3) and would append its own `subagent:memory-predict` final records
  // alongside U's recall records, breaking those pins. Default it off here so
  // this file's assertions stay scoped to the layers it actually tests —
  // P1b's own behaviour is covered by tests/memory/jev/wire-predict.test.ts.
  const settings: MemorySettings = {
    ...DEFAULT_MEMORY_SETTINGS,
    ...opts.settings,
    jev: {
      ...DEFAULT_MEMORY_SETTINGS.jev,
      ...opts.settings?.jev,
      predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, enabled: false, ...opts.settings?.jev?.predict },
    },
  };
  const config: JevConfig = { ...jevConfigOf(settings), classifiers: CLASSIFIERS, ...opts.config };
  let renderInfo = opts.renderInfo;
  const writeHooks: ((cwd: string) => void)[] = [];
  const wire = wireJev(pi, {
    config,
    settings,
    isChildSession: opts.isChild === true,
    dirFor: () => memDir,
    getRenderInfo: () => renderInfo,
    onAfterWriteHook: (fn) => writeHooks.push(fn),
    log: (l) => logs.push(l),
  });
  const ctx = (extra: Record<string, unknown> = {}) => ({
    cwd: tmp,
    hasUI: true,
    ui: { notify: () => {} },
    ...(opts.noRegistry === true ? {} : { modelRegistry: fake.registry }),
    sessionManager: { getBranch: () => branch, getSessionId: () => "s1" },
    ...extra,
  });
  const emit = async (event: string, payload: unknown, c: unknown = ctx()): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, c));
    return out;
  };
  const prompt = async (text: string) => {
    branch.push({ type: "message", id: `u${nextId++}`, message: { role: "user", content: text } });
    const [r] = await emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: text });
    return r as { message?: any; systemPrompt?: string } | undefined;
  };
  const recallCalls = () => fake.calls.filter((c) => typeof c.state["user_message"] === "string");
  return {
    pi,
    handlers,
    sent,
    appended,
    branch,
    renderers,
    logs,
    fake,
    wire,
    ctx,
    emit,
    prompt,
    recallCalls,
    writeHooks,
    setRenderInfo: (i: JevRenderInfo | undefined) => {
      renderInfo = i;
    },
  };
}

const settleBackground = () => new Promise((r) => setTimeout(r, 30));

// ───────────────────────────── pure helpers ─────────────────────────────

describe("pure helpers", () => {
  test("stripSkillBlocks removes C-J9 skill expansions; passesPromptGate needs ≥8 code points and no ack", () => {
    const expanded = '<skill name="x" location="/a/SKILL.md">\nBody of skill\n</skill>\n\ndo the thing please now';
    expect(stripSkillBlocks(expanded)).toBe("do the thing please now");
    expect(passesPromptGate("好的")).toBe(false);
    expect(passesPromptGate("continue")).toBe(false);
    expect(passesPromptGate("Continue.")).toBe(false);
    expect(passesPromptGate("那发版呢？发版")).toBe(false); // 7 code points after whitespace removal
    expect(passesPromptGate("那发版呢？现在发吗")).toBe(true);
    expect(passesPromptGate("push the branch now")).toBe(true);
  });

  test("failureExitCode: structuredContent → tail line → notice details", () => {
    expect(failureExitCode({ structuredContent: { exit_code: 7 }, text: "Command exited with code 2" })).toBe(7);
    expect(failureExitCode({ text: "x\nCommand exited with code 2\n\n" })).toBe(2);
    expect(failureExitCode({ detailsExitCode: 3 })).toBe(3);
    expect(failureExitCode({ text: "fine" })).toBeUndefined();
  });

  test("previousUserMessage skips the current prompt and returns the newest earlier user message", () => {
    const branch = [
      { type: "message", message: { role: "user", content: "first ask" } },
      { type: "message", message: { role: "assistant", content: "x" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "second ask" }] } },
      { type: "message", message: { role: "user", content: "now" } },
    ];
    expect(previousUserMessage(branch as never, "now")).toBe("second ask");
    expect(previousUserMessage([] as never, "now")).toBeUndefined();
  });
});

// ───────────────────────────── static core (review #10) ─────────────────────────────

describe("static core mapping", () => {
  test("omittedSections uses the same `## ` title text as MemEntry.section (incl. CJK and ### nesting)", () => {
    writeFileSync(
      join(memDir, "core.md"),
      "# Core\n\nIntro paragraph that is long enough to be its own entry here.\n\n## 规则 一\n\n- 中文规则条目\n\n### Sub\n\n- nested entry under sub\n\n## Release\n\n- rel\n",
    );
    const core = entries().filter((e) => e.file === "core.md");
    const sections = [...new Set(core.map((e) => e.section))];
    expect(sections).toEqual(["", "规则 一", "Release"]);
    const info: JevRenderInfo = { primary: "core.md", omittedSections: ["Release"], coreInlined: true };
    const statik = core.filter((e) => isStaticCore(e, info)).map((e) => e.section);
    expect(statik).toEqual(["", "规则 一", "规则 一"]);
    expect(core.filter((e) => e.section === "Release").every((e) => !isStaticCore(e, info))).toBe(true);
    expect(core.every((e) => !isStaticCore(e, undefined))).toBe(true);
    expect(core.every((e) => !isStaticCore(e, { primary: "core.md", omittedSections: [], coreInlined: false }))).toBe(
      true,
    );
  });

  test("entryAnchor format", () => {
    const e = entryWith("git push needs the proxy");
    expect(entryAnchor(e)).toBe("pitfalls-git › Push #1");
  });
});

// ───────────────────────────── U layer ─────────────────────────────

describe("U layer (before_agent_start)", () => {
  test("in-time answer ⇒ returned as this run's message (never systemPrompt); private/secret never sent", async () => {
    const h = harness({ rules: [["proxy configured", 0.92]] });
    const r = await h.prompt("帮我把 dev 推到 GitHub 上去");
    expect(r?.systemPrompt).toBeUndefined();
    expect(r?.message?.customType).toBe("subagent:memory-inject");
    expect(r?.message?.display).toBe(true);
    expect(r?.message?.content).toContain("[memory · U jev]");
    expect(r?.message?.content).toContain("git push needs the proxy configured");
    expect(r?.message?.details).toMatchObject({ v: 1, layer: "U", trigger: "user" });
    expect(r?.message?.details.items[0]).toMatchObject({ file: "pitfalls-git.md", authority: "user", p: 0.92 });
    expect(h.appended).toEqual([
      { customType: "subagent:memory-recall", data: { v: 1, layer: "U", keys: [entryWith("proxy configured").hash] } },
    ]);
    const call = h.recallCalls()[0]!;
    expect(call.state).toMatchObject({ user_message: "帮我把 dev 推到 GitHub 上去", session: "main" });
    expect(call.state["today"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const asked = JSON.stringify(call.questions);
    expect(asked).not.toContain("private note");
    expect(Object.keys(call.questions)).toHaveLength(entries().filter((e) => e.inline.isPrivate !== true).length);
  });

  test("gate: ack-only / too-short prompts make zero calls; skill blocks are stripped from user and previous messages", async () => {
    const h = harness({ rules: [["proxy", 0.9]] });
    expect(await h.prompt("好的")).toBeUndefined();
    expect(
      await h.prompt('<skill name="s" location="/x">\nlots of skill body text here\n</skill>\n\nok'),
    ).toBeUndefined();
    expect(h.recallCalls()).toHaveLength(0);
    h.branch.push({
      type: "message",
      message: {
        role: "user",
        content: '<skill name="s" location="/x">\nSKILLBODY\n</skill>\n\nearlier question about push',
      },
    });
    await h.prompt('<skill name="s" location="/x">\nSKILLBODY\n</skill>\n\nnow publish the release please');
    const st = h.recallCalls()[0]!.state;
    expect(st["user_message"]).toBe("now publish the release please");
    expect(st["previous_user_message"]).toBe("earlier question about push");
    expect(JSON.stringify(st)).not.toContain("SKILLBODY");
  });

  test("late answer ⇒ nothing returned, then sendMessage(triggerTurn:false) while the generation is current", async () => {
    const h = harness({
      rules: [["proxy configured", 0.9]],
      delayMs: 120,
      config: { recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 20 } },
    });
    const r = await h.prompt("push the dev branch to github");
    expect(r).toBeUndefined();
    expect(h.sent).toHaveLength(0);
    await new Promise((res) => setTimeout(res, 250));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.options).toEqual({ triggerTurn: false });
    expect(h.sent[0]!.message.details.layer).toBe("U");
  });

  test("a new prompt aborts the in-flight recall: the stale result is never sent", async () => {
    const h = harness({
      rules: [["proxy configured", 0.9]],
      delayMs: 100,
      config: { recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 10 } },
    });
    await h.prompt("push the dev branch to github");
    const firstSignal = h.recallCalls()[0]!.signal;
    await h.prompt("unrelated question about the weather");
    expect(firstSignal?.aborted).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    const layers = h.sent.map((s) => s.message.details.layer);
    expect(layers.filter((l) => l === "U").length).toBeLessThanOrEqual(1);
    // the only U that may land belongs to the second prompt's generation
    for (const s of h.sent) expect(JSON.stringify(s.message.details)).not.toContain("weather");
  });

  test("failure ⇒ no injection, one log line", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    expect(await h.prompt("push the dev branch to github")).toBeUndefined();
    expect(h.sent).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("recall failed"))).toBe(true);
  });

  test("static core: not rendered yet ⇒ included; primary sections not omitted ⇒ excluded; core not inlined ⇒ included", async () => {
    const count = async (info: JevRenderInfo | undefined) => {
      const h = harness({ renderInfo: info });
      await h.prompt("tell me about committing and releasing");
      const qs = JSON.stringify(h.recallCalls()[0]!.questions);
      return { rules: qs.includes("timeout so nothing hangs"), release: qs.includes("CI pipeline is green") };
    };
    expect(await count(undefined)).toEqual({ rules: true, release: true });
    expect(await count({ primary: "core.md", omittedSections: ["Release"], coreInlined: true })).toEqual({
      rules: false,
      release: true,
    });
    expect(await count({ primary: "core.md", omittedSections: [], coreInlined: false })).toEqual({
      rules: true,
      release: true,
    });
  });

  test("dedup: an injected entry is excluded from later candidates; reload re-seeds from the branch", async () => {
    const h = harness({ rules: [["proxy configured", 0.9]] });
    await h.prompt("push the dev branch to github");
    await h.prompt("push again to github please");
    const second = JSON.stringify(h.recallCalls()[1]!.questions);
    expect(second).not.toContain("proxy configured");
    // new activation (reload) over the same branch ⇒ seeding keeps the dedup
    const h2 = harness({ rules: [["proxy configured", 0.9]] });
    h2.branch.push(...h.branch);
    await h2.prompt("push one more time to github");
    expect(JSON.stringify(h2.recallCalls()[0]!.questions)).not.toContain("proxy configured");
  });

  test(">360 candidates ⇒ local prefilter to 360 and `/mem jev` shows `recall truncated N→360`", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- generic entry number ${i} about topic ${i % 7}`);
    writeFileSync(join(memDir, "bulk.md"), `# Bulk\n\n## Many\n\n${lines.join("\n")}\n`);
    const h = harness();
    await h.prompt("question about topic three and others");
    const asked = h.recallCalls().reduce((n, c) => n + Object.keys(c.questions).length, 0);
    expect(asked).toBe(360);
    const report = await h.wire.commandPort.report(tmp, undefined);
    expect(report).toMatch(/recall truncated \d+→360/);
  });

  test("child session: dispatch prompt ⇒ session child, 2000 code points, no previous message", async () => {
    const h = harness({ isChild: true });
    h.branch.push({ type: "message", message: { role: "user", content: "earlier" } });
    await h.prompt(`dispatch ${"做一件事 ".repeat(800)}`);
    const st = h.recallCalls()[0]!.state;
    expect(st["session"]).toBe("child");
    expect(Array.from(String(st["user_message"])).length).toBe(2000);
    expect(st["previous_user_message"]).toBeUndefined();
  });

  test("child with memory.jev.childSessions=false ⇒ every handler inert", async () => {
    const h = harness({ isChild: true, config: { childSessions: false } });
    expect(await h.prompt("push the dev branch to github")).toBeUndefined();
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(h.fake.calls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.handlers.get("session_start")).toBeUndefined(); // children never probe
  });
});

// ───────────────────────────── A layer ─────────────────────────────

async function tagEntry(e: MemEntry, tags: Record<string, number>, extra: Partial<EntryTags> = {}): Promise<void> {
  const rec: EntryTags = {
    file: e.file,
    type: "pitfall",
    typeP: 0.9,
    importance: 2,
    tags: Object.fromEntries(Object.entries(tags).map(([k, p]) => [k, { p, rev: 1 }])),
    guard: 0.1,
    temporal: "permanent",
    userLike: 0.1,
    model: "opencode/jev-1.13",
    at: "2026-10-30T00:00:00.000Z",
    taxonomyRev: "x",
    ...extra,
  };
  expect(await writeIndexPatch(memDir, { upsert: { [e.hash]: rec } })).toBe("ok");
}

describe("A layer (tool_call fast path, zero calls)", () => {
  test("matching tag + importance ≥2 + type filter ⇒ sendMessage(triggerTurn:false); zero classifier calls; returns undefined", async () => {
    await tagEntry(entryWith("proxy configured"), { "git-push": 0.88 });
    await tagEntry(entryWith("node 18"), { "git-push": 0.9 }, { importance: 1 }); // below importance 2
    const h = harness();
    const [r] = await h.emit("tool_call", {
      toolName: "bash",
      toolCallId: "t1",
      input: { command: "cd x && git push origin dev" },
    });
    expect(r).toBeUndefined();
    expect(h.fake.calls).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.options).toEqual({ triggerTurn: false });
    expect(h.sent[0]!.message.details).toMatchObject({ layer: "A", trigger: "bash" });
    expect(h.sent[0]!.message.content).toContain("proxy configured");
    expect(h.sent[0]!.message.content).not.toContain("node 18");
    // dedup: same call again ⇒ nothing new
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t2", input: { command: "git push" } });
    expect(h.sent).toHaveLength(1);
  });

  test("pending entry with an inline manual tag passes the importance/type filter", async () => {
    writeFileSync(
      join(memDir, "manual.md"),
      "# M\n\n## Tags\n\n- push via the corp proxy only <!-- mem tags=+git-push -->\n",
    );
    const h = harness();
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.content).toContain("corp proxy");
  });

  test("partial ⇒ continues with the ·partial marker; inactive ⇒ zero sendMessage", async () => {
    await tagEntry(entryWith("proxy configured"), { "git-push": 0.88 });
    const h = harness({ fail: "System One API error (451): blocked" });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settleBackground();
    expect(h.wire.client.status()).toMatchObject({ kind: "partial", inactive: false });
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.details.partial).toBe(true);
    const marker = h.renderers.get("subagent:memory-inject")!(
      h.sent[0]!.message,
      {},
      { fg: (_c: string, t: string) => t },
    );
    expect(marker.render(200).join("\n")).toContain("── mem A·partial: pitfalls-git › Push #1 ──");
  });

  test("inactive (no credentials, coverage 0, no inline metadata) ⇒ zero sendMessage", async () => {
    const h = harness();
    // registry knows no available classifiers ⇒ no-auth everywhere
    (h.fake.registry as any).getAvailableOfType = async () => [];
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settleBackground();
    expect(h.wire.client.status()).toMatchObject({ kind: "partial", inactive: true });
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(h.sent).toHaveLength(0);
  });

  test("generic tags (testing) alone no longer trigger A; high-risk tags still do (2026-11-03 noise fix)", async () => {
    await tagEntry(entryWith("proxy configured"), { testing: 0.99 });
    await tagEntry(entryWith("node 18"), { "git-push": 0.9 });
    const h = harness();
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "npm test" } });
    expect(h.sent).toHaveLength(0);
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t2", input: { command: "git push" } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.content).toContain("node 18");
    expect(h.sent[0]!.message.content).not.toContain("proxy configured");
  });

  test("mixed tags: the eligible high tag carries the entry; its generic tag alone does not", async () => {
    await tagEntry(entryWith("proxy configured"), { testing: 0.99, release: 0.7 });
    const h = harness();
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "npm test" } });
    expect(h.sent).toHaveLength(0);
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t2", input: { command: "git tag v1.2.3" } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.content).toContain("proxy configured");
  });

  test("memory.jev.fastPathAllowTags re-enables a generic tag; fastPathDenyTags blocks a high-risk one", async () => {
    await tagEntry(entryWith("proxy configured"), { testing: 0.9 });
    const allow = harness({ config: { fastPath: { allowTags: ["testing"], denyTags: [], cooldownMs: 0 } } });
    await allow.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "npm test" } });
    expect(allow.sent).toHaveLength(1);

    await tagEntry(entryWith("node 18"), { "git-push": 0.9 });
    const deny = harness({ config: { fastPath: { allowTags: [], denyTags: ["git-push"], cooldownMs: 0 } } });
    await deny.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(deny.sent).toHaveLength(0);
  });

  test("cross-session cooldown: a second session within 24h skips the entry (U still judges), expiry re-admits", async () => {
    const tagged = entryWith("proxy configured");
    await tagEntry(tagged, { "git-push": 0.9 });
    const first = harness();
    await first.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(first.sent).toHaveLength(1);
    await settleBackground(); // the cooldown stamp write is fire-and-forget
    expect(readIndex(memDir).index.aInjectedAt?.[tagged.hash]).toBeDefined();

    // New session (a fresh wireJev over the same dir): A skips the entry…
    const second = harness();
    await second.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(second.sent).toHaveLength(0);
    // …but the U layer (classifier-judged) still injects it — cooldown is A-only.
    const u = harness({ rules: [["proxy configured", 0.9]] });
    const r = await u.prompt("push the dev branch to github");
    expect(r?.message?.content).toContain("proxy configured");

    // Expired stamp ⇒ admitted again.
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    expect(await writeIndexPatch(memDir, { aInjectedAt: { [tagged.hash]: old } })).toBe("ok");
    const third = harness();
    await third.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(third.sent).toHaveLength(1);
  });

  test("cooldown 0 disables the cross-session skip", async () => {
    const tagged = entryWith("proxy configured");
    await tagEntry(tagged, { "git-push": 0.9 });
    const first = harness();
    await first.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(first.sent).toHaveLength(1);
    await settleBackground();
    const second = harness({ config: { fastPath: { allowTags: [], denyTags: [], cooldownMs: 0 } } });
    await second.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    expect(second.sent).toHaveLength(1);
  });
});

// ───────────────────────────── E layer ─────────────────────────────

describe("E layer (failure recall)", () => {
  test("exit code from structuredContent ⇒ asks with tool/command/exit_code, injects top hit via sendMessage", async () => {
    const h = harness({ rules: [["node 18", 0.85]] });
    const [r] = await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: "t1",
      input: { command: "npm install" },
      content: [{ type: "text", text: "TypeError: fs.globSync is not a function" }],
      structuredContent: { exit_code: 1 },
      isError: true,
    });
    expect(r).toBeUndefined(); // tool_result never changes the result
    await settleBackground();
    const call = h.fake.calls.find((c) => c.state["tool"] === "bash")!;
    expect(call.state).toMatchObject({ tool: "bash", command: "npm install", exit_code: 1 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.details).toMatchObject({ layer: "E" });
    expect(h.sent[0]!.message.content).toContain("node 22");
  });

  test("exit code from the output tail; success is ignored; same signature asked once per segment; ≤10 asks", async () => {
    const h = harness({ rules: [] });
    const fail = (n: number, text = "boom") =>
      h.emit("tool_result", {
        toolName: "bash",
        toolCallId: `t${n}`,
        input: { command: `cmd${n}` },
        content: [{ type: "text", text: `${text}\nCommand exited with code 2` }],
        isError: false,
      });
    await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: "ok",
      input: { command: "true" },
      content: [],
      isError: false,
    });
    await fail(1);
    await fail(1);
    await settleBackground();
    expect(h.fake.calls.filter((c) => c.state["tool"] === "bash")).toHaveLength(1);
    for (let i = 2; i <= 15; i++) await fail(i, `distinct failure ${i}`);
    await settleBackground();
    expect(h.fake.calls.filter((c) => c.state["tool"] === "bash")).toHaveLength(10);
  });

  test("wake turn: an idle bash-job failure notice starting a run ⇒ E returned as the before_agent_start message", async () => {
    const h = harness({ rules: [["node 18", 0.9]] });
    const [r] = (await h.emit("before_agent_start", {
      type: "before_agent_start",
      messageType: "custom",
      message: {
        customType: "bash-job:notification",
        content: "Bash job j1 ($ npm install) finished: exit 1\nfs.globSync is not a function",
        details: { kind: "bash-job", jobId: "j1", status: "failed", exitCode: 1 },
      },
    })) as { message?: any }[];
    expect(r?.message?.details.layer).toBe("E");
    expect(h.fake.calls[0]!.state).toMatchObject({ command: "npm install", exit_code: 1 });
  });

  test("quiet append path: message_start with a failed bash-job notice ⇒ E via sendMessage", async () => {
    const h = harness({ rules: [["node 18", 0.9]] });
    await h.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "bash-job:notification",
        content: "Bash job j2 ($ npm ci) finished: exit 1\nnode 18 unsupported",
        details: { exitCode: 1, status: "failed" },
      },
    });
    await settleBackground();
    expect(h.sent.map((s) => s.message.details.layer)).toEqual(["E"]);
  });
});

// ───────────────────────────── B layer ─────────────────────────────

describe("B layer (re-inject after compaction)", () => {
  test("re-injects the previous segment's recent entries once; edited ⇒ （已修改）; deleted ⇒ skipped", async () => {
    const h = harness({
      rules: [
        ["proxy configured", 0.9],
        ["node 18", 0.8],
        ["timeout so nothing hangs", 0.7],
      ],
    });
    await h.prompt("push the dev branch to github after npm install with timeout");
    const injected = h.appended[0]!.data.keys as string[];
    expect(injected.length).toBe(3);
    // edit one entry in place (same file/section/ordinal), delete another
    writeFileSync(
      join(memDir, "pitfalls-git.md"),
      "# Pitfalls git\n\n## Push\n\n- git push needs the proxy configured, otherwise it hangs (edited)\n- a private note never leaves the machine <!-- mem private -->\n",
    );
    for (const hook of h.writeHooks) hook(tmp);
    h.branch.push({ type: "compaction", id: "cmp1" });
    await h.emit("session_compact", { type: "session_compact", compactionEntry: { id: "cmp1" } });
    const b = h.sent.filter((s) => s.message.details.layer === "B");
    expect(b).toHaveLength(1);
    expect(b[0]!.options).toEqual({ triggerTurn: false });
    expect(b[0]!.message.content).toContain("（已修改）");
    expect(b[0]!.message.content).toContain("(edited)");
    expect(b[0]!.message.content).not.toContain("node 22"); // deleted entry skipped
    expect(h.appended.at(-1)!.data).toMatchObject({ layer: "B", bFor: "cmp1" });
    // turn_end checkpoint for the same compaction does not re-inject
    await h.emit("turn_end", { type: "turn_end" });
    expect(h.sent.filter((s) => s.message.details.layer === "B")).toHaveLength(1);
  });

  test("turn_end checkpoint catches a compaction never announced via session_compact (child switch)", async () => {
    const h = harness({ isChild: true, rules: [["proxy configured", 0.9]] });
    await h.prompt("push the dev branch to github now");
    h.branch.push({ type: "compaction", id: "sw1" });
    await h.emit("turn_end", { type: "turn_end" });
    expect(h.sent.filter((s) => s.message.details.layer === "B")).toHaveLength(1);
  });
});

describe("renderer", () => {
  test("subagent:memory-inject renders a one-line marker", async () => {
    const h = harness({ rules: [["proxy configured", 0.81]] });
    const r = await h.prompt("push the dev branch to github");
    const c = h.renderers.get("subagent:memory-inject")!(r!.message, {}, { fg: (_c: string, t: string) => t });
    expect(c.render(200).join("\n")).toContain("── mem U: pitfalls-git › Push #1 (0.81) ──");
  });
});
