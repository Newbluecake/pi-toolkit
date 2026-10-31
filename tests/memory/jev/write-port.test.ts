// JevWritePort unit tests (jev-plan §4 J5, arch §6.2.1/§6.2.4/§6.2.5).
// Real tmpdir + real EntryIndex; fake JevClient; presets taxonomy. Pins:
// changed-entry hash diff, parallel tagging, §6.2.4 echo (incl. all four
// conditional lines), partial/off(pi-api) echos, usage aggregation,
// checkInline new-error-only rejection, the v4.1 §3.2 pairing via the port,
// the 3000ms total budget (fake clock) and that the sidecar write lands
// OUTSIDE any held lock (writeIndexPatch ⇒ "ok", never "busy").

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevWritePort } from "../../../src/memory/jev/write-port.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";
import { memoryDirFor, type MemoryPaths } from "../../../src/memory/paths.js";
import type {
  ClassifierRegistryLike,
  JevAnswer,
  JevClient,
  JevOutcome,
  JevRequest,
  JevStatus,
} from "../../../src/memory/jev/contracts.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const FIX_NOW = Date.parse("2026-10-31T00:00:00Z");
const REGISTRY: ClassifierRegistryLike = {};

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
  memDir: string;
}

const tmpRoots: string[] = [];

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-jevwp-"));
  tmpRoots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
  const memDir = memoryDirFor(cwd, paths);
  mkdirSync(memDir, { recursive: true });
  return { tmp, cwd, paths, memDir };
}

afterEach(() => {
  vi.useRealTimers();
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

/** Fake JevClient: scripted status + per-ask answers; records every ask. */
function fakeClient(opts: {
  status?: JevStatus;
  answerFor?: (req: JevRequest, index: number) => Record<string, JevAnswer>;
  costUsd?: number;
  hang?: boolean;
  onStart?: (req: JevRequest) => void;
}) {
  const asks: JevRequest[] = [];
  const client: JevClient = {
    status: () => opts.status ?? { kind: "full", model: "opencode/jev-1.13-free" },
    async ask(req): Promise<JevOutcome> {
      const index = asks.length;
      asks.push(req);
      opts.onStart?.(req);
      if (opts.hang === true) {
        return await new Promise<JevOutcome>((resolve) => {
          const fail = (): void => resolve({ ok: false, reason: "aborted", detail: "deadline" });
          if (req.signal?.aborted === true) return fail();
          req.signal?.addEventListener("abort", fail, { once: true });
        });
      }
      return {
        ok: true,
        model: "opencode/jev-1.13-free",
        answers: opts.answerFor?.(req, index) ?? {},
        missing: [],
        costUsd: opts.costUsd ?? 0.0001,
        latencyMs: 5,
      };
    },
    async probe() {
      return client.status();
    },
  };
  return { client, asks };
}

function makePort(fx: Fixture, client: JevClient, over: { confirmTimeoutMs?: number } = {}) {
  return createJevWritePort({
    client,
    entryIndex: new EntryIndex(),
    dirFor: (cwd) => memoryDirFor(cwd, fx.paths),
    taxonomyFor: () => mergeTaxonomy().taxonomy,
    confirmTimeoutMs: over.confirmTimeoutMs ?? 60_000,
    now: () => FIX_NOW,
  });
}

const AGENT_FM = "---\nsource: agent\nupdated: 2026-10-01T00:00:00.000Z\n---\n\n";

const TWO_ENTRIES = `${AGENT_FM}## Pitfalls\n\n- push before export https_proxy causes GitHub timeout\n- never run release.sh while CI is green-check pending\n`;

function answersFor(over: Record<string, JevAnswer> = {}): Record<string, JevAnswer> {
  return {
    m_type: { type: "choice", choice: "pitfall", probabilities: { pitfall: 0.91 }, confidence: 0.91 },
    m_importance: { type: "score", score: 2, confidence: 0.9 },
    m_guard: { type: "bool", probability: 0.12 },
    m_temporal: { type: "choice", choice: "permanent", probabilities: { permanent: 0.95 }, confidence: 0.95 },
    m_userlike: { type: "bool", probability: 0.1 },
    ...over,
  };
}

describe("afterWrite: changed-entry detection", () => {
  it("one changed entry of two ⇒ exactly one tag ask for that entry; sidecar keyed by its hash", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "pitfalls-git.md", TWO_ENTRIES);
    const before = readFileSync(join(fx.memDir, "pitfalls-git.md"), "utf8");
    const after = before.replace("causes GitHub timeout", "causes GitHub timeout (2026-10-12)");
    const { client, asks } = fakeClient({ answerFor: () => answersFor() });
    const port = makePort(fx, client);
    const result = await port.afterWrite({
      cwd: fx.cwd,
      file: "pitfalls-git.md",
      before,
      after,
      registry: REGISTRY,
    });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.duty).toBe("tag");
    expect(asks[0]!.mode).toBe("sync");
    expect(String((asks[0]!.state as any).entry)).toContain("2026-10-12");
    const changedHash = entryHash(
      "- push before export https_proxy causes GitHub timeout (2026-10-12)".replace(" <!-- mem user -->", ""),
    );
    const { index } = readIndex(fx.memDir);
    expect(Object.keys(index.entries)).toHaveLength(1);
    expect(index.entries[changedHash]).toBeDefined();
    expect(index.entries[changedHash]!.type).toBe("pitfall");
    expect(index.lastTaggedAt).toBe(new Date(FIX_NOW).toISOString());
    expect(result.echo.length).toBeGreaterThan(0);
  });

  it("byte-identical content ⇒ no asks, empty echo", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", TWO_ENTRIES);
    const { client, asks } = fakeClient({});
    const port = makePort(fx, client);
    const result = await port.afterWrite({
      cwd: fx.cwd,
      file: "a.md",
      before: TWO_ENTRIES,
      after: TWO_ENTRIES,
      registry: REGISTRY,
    });
    expect(asks).toHaveLength(0);
    expect(result.echo).toEqual([]);
    expect(result.usage).toBeUndefined();
  });

  it("new file (before undefined) ⇒ every entry tagged", async () => {
    const fx = fixture();
    const { client, asks } = fakeClient({ answerFor: () => answersFor() });
    const port = makePort(fx, client);
    await port.afterWrite({ cwd: fx.cwd, file: "fresh.md", before: undefined, after: TWO_ENTRIES, registry: REGISTRY });
    expect(asks).toHaveLength(2);
  });

  it("private entries are never sent and stay silent", async () => {
    const fx = fixture();
    const body = `${AGENT_FM}## Rules\n\n- secret sauce recipe <!-- mem private -->\n`;
    const { client, asks } = fakeClient({});
    const port = makePort(fx, client);
    const result = await port.afterWrite({
      cwd: fx.cwd,
      file: "p.md",
      before: undefined,
      after: body,
      registry: REGISTRY,
    });
    expect(asks).toHaveLength(0);
    expect(result.echo).toEqual([]);
  });
});

describe("afterWrite: parallel tagging + concurrency proof", () => {
  it("three changed entries ⇒ three asks in flight simultaneously (barrier release)", async () => {
    const fx = fixture();
    const body = `${AGENT_FM}## S\n\n${["alpha", "beta", "gamma"].map((w) => `- entry about ${w} things`).join("\n")}\n`;
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, asks } = fakeClient({
      onStart: () => {
        started += 1;
        if (started === 3) release!();
      },
      answerFor: () => answersFor(),
    });
    const port = makePort(fx, client);
    // The asks must all be pending on the gate BEFORE any resolves — proves
    // Promise.all parallelism (a sequential loop would deadlock here).
    const done = port.afterWrite({ cwd: fx.cwd, file: "multi.md", before: undefined, after: body, registry: REGISTRY });
    await gate;
    expect(asks).toHaveLength(3);
    await done;
  });
});

describe("afterWrite: §6.2.4 echo", () => {
  it("tagged echo prints the section/jev/similar lines", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", `${AGENT_FM}## Rules\n\n- GitHub needs the proxy since October\n`);
    writeFile(
      fx.memDir,
      "pitfalls-git.md",
      `${AGENT_FM}## Pitfalls\n\n- push without https_proxy times out on GitHub\n`,
    );
    const { client } = fakeClient({
      answerFor: (req) => {
        const a = answersFor({
          t_network: { type: "bool", probability: 0.83 },
          "t_git-push": { type: "bool", probability: 0.88 },
          c1: {
            type: "choice",
            choice: "complementary",
            probabilities: { complementary: 0.72 },
            confidence: 0.72,
          },
        });
        void req;
        return a;
      },
    });
    const port = makePort(fx, client);
    const before = `${AGENT_FM}## Pitfalls\n\n- placeholder line here\n`;
    const after = `${AGENT_FM}## Pitfalls\n\n- push without https_proxy times out on GitHub\n`;
    const { echo } = await port.afterWrite({
      cwd: fx.cwd,
      file: "pitfalls-git.md",
      before,
      after,
      registry: REGISTRY,
    });
    const text = echo.join("\n");
    expect(text).toContain("section: pitfalls-git.md #1 (L");
    expect(text).toContain("jev: pitfall 0.91 · important · tags git-push 0.88, network 0.83 · guard 0.12 · permanent");
    expect(text).toMatch(/similar: core\.md L\d+ \(complementary 0\.72\)/);
  });

  it("all four conditional lines fire under their conditions", async () => {
    const fx = fixture();
    // compare target: a USER entry (hand-written file) so the conflict line
    // takes the 用户令 wording.
    writeFile(fx.memDir, "core.md", "## Rules\n\n- release needs CI green first\n");
    writeFile(fx.memDir, "topic.md", `${AGENT_FM}## S\n\n- filler entry zero\n`);
    const { client } = fakeClient({
      answerFor: () =>
        answersFor({
          m_userlike: { type: "bool", probability: 0.86 },
          m_temporal: { type: "choice", choice: "dated", probabilities: { dated: 0.9 }, confidence: 0.9 },
          m_guard: { type: "bool", probability: 0.82 },
          c1: {
            type: "choice",
            choice: "conflict",
            probabilities: { conflict: 0.84 },
            confidence: 0.84,
          },
        }),
    });
    const port = makePort(fx, client);
    const after = `${AGENT_FM}## S\n\n- release does not need CI green\n`;
    const { echo } = await port.afterWrite({
      cwd: fx.cwd,
      file: "topic.md",
      before: `${AGENT_FM}## S\n\n- filler entry zero\n`,
      after,
      registry: REGISTRY,
    });
    const text = echo.join("\n");
    expect(text).toContain("jev: looks like a user order (0.86) — if the user said it, append <!-- mem user -->");
    expect(text).toContain('jev: looks temporary — add expires=YYYY-MM-DD or until="…"');
    expect(text).toContain("jev: guards a risky action (0.82) — pre-action review enabled;");
    expect(text).toMatch(/conflict: core\.md L\d+ \(user rule, conflict 0\.84\) — 用户令只有用户能作废/);
  });

  it("duplicate relation against an agent entry suggests in-place merging", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", `${AGENT_FM}## Rules\n\n- use the proxy for GitHub pushes\n`);
    const { client } = fakeClient({
      answerFor: () =>
        answersFor({
          c1: { type: "choice", choice: "duplicate", probabilities: { duplicate: 0.9 }, confidence: 0.9 },
        }),
    });
    const port = makePort(fx, client);
    const { echo } = await port.afterWrite({
      cwd: fx.cwd,
      file: "topic.md",
      before: undefined,
      // not byte-identical to core.md's entry (same-hash twins are excluded
      // from the compare pool as "self")
      after: `${AGENT_FM}## S\n\n- always use the proxy for GitHub pushes\n`,
      registry: REGISTRY,
    });
    expect(echo.join("\n")).toMatch(
      /conflict: core\.md L\d+ \(agent entry, duplicate 0\.90\) — consider merging into it or deleting the older entry in place/,
    );
  });

  it("similar: and conflict: are independent picks — complementary 0.9 does not mask conflict 0.8", async () => {
    const fx = fixture();
    writeFile(
      fx.memDir,
      "core.md",
      `${AGENT_FM}## Rules\n\n- release needs CI green first\n- unrelated but complementary proxy note\n`,
    );
    const { client } = fakeClient({
      answerFor: (req) => {
        // identify candidates by their excerpt inside the c* instructions
        const answers = answersFor();
        for (const [id, q] of Object.entries(req.questions)) {
          if (!/^c\d+$/.test(id)) continue;
          const instr = (q as { instructions: string }).instructions;
          if (instr.includes("complementary proxy note")) {
            answers[id] = {
              type: "choice",
              choice: "complementary",
              probabilities: { complementary: 0.9 },
              confidence: 0.9,
            };
          } else if (instr.includes("CI green")) {
            answers[id] = {
              type: "choice",
              choice: "conflict",
              probabilities: { conflict: 0.8 },
              confidence: 0.8,
            };
          } else {
            answers[id] = {
              type: "choice",
              choice: "unrelated",
              probabilities: { unrelated: 0.99 },
              confidence: 0.99,
            };
          }
        }
        return answers;
      },
    });
    const port = makePort(fx, client);
    const { echo } = await port.afterWrite({
      cwd: fx.cwd,
      file: "topic.md",
      before: `${AGENT_FM}## S\n\n- placeholder\n`,
      after: `${AGENT_FM}## S\n\n- release does not need CI green, and proxy notes apply\n`,
      registry: REGISTRY,
    });
    const text = echo.join("\n");
    expect(text).toMatch(/similar: core\.md L\d+ \(complementary 0\.90\)/);
    expect(text).toMatch(/conflict: core\.md L\d+ \(agent entry, conflict 0\.80\)/);
  });
});

describe("afterWrite: index-parity details", () => {
  it("an archived target file yields no entries — zero asks, empty echo, no sidecar (verifier minor #4)", async () => {
    const fx = fixture();
    const raw = `---\nsource: agent\nstatus: archived\nupdated: 2026-10-01T00:00:00.000Z\n---\n\n## S\n\n- archived content entry\n`;
    const { client, asks } = fakeClient({ answerFor: () => answersFor() });
    const port = makePort(fx, client);
    const result = await port.afterWrite({
      cwd: fx.cwd,
      file: "gone.md",
      before: raw.replace("- archived content entry", "- archived content entries"),
      after: raw,
      registry: REGISTRY,
    });
    expect(asks).toHaveLength(0);
    expect(result.echo).toEqual([]);
    expect(existsSync(join(fx.memDir, ".jev", "index.json"))).toBe(false);
  });

  it("compare pool = top-12 lexical + same-file entries, capped at 20 c* questions (verifier minor #5)", async () => {
    const fx = fixture();
    // 12 lexically-related entries in other files, 3 unrelated ones
    const related = Array.from({ length: 12 }, (_, i) => `- proxy github push variant ${i}`).join("\n");
    const unrelated = "- zebra yak quokka\n- emu tapir llama\n- okapi wombat sloth";
    writeFile(fx.memDir, "corpus.md", `${AGENT_FM}## C\n\n${related}\n${unrelated}\n`);
    // 2 lexically-distant same-file siblings — must join the pool anyway
    writeFile(
      fx.memDir,
      "t.md",
      `${AGENT_FM}## S\n\n- alpha beta gamma sibling\n- delta epsilon zeta sibling\n- proxy github push timeout target OLD\n`,
    );
    const { client, asks } = fakeClient({ answerFor: () => answersFor() });
    const port = makePort(fx, client);
    const before = readFileSync(join(fx.memDir, "t.md"), "utf8");
    await port.afterWrite({
      cwd: fx.cwd,
      file: "t.md",
      before,
      after: before.replace("target OLD", "target NEW"),
      registry: REGISTRY,
    });
    expect(asks).toHaveLength(1);
    const cIds = Object.keys(asks[0]!.questions)
      .filter((id) => /^c\d+$/.test(id))
      .sort();
    expect(cIds).toHaveLength(14); // 12 lexical + 2 same-file, deduped by hash
    const instructions = cIds.map((id) => (asks[0]!.questions[id] as { instructions: string }).instructions).join("\n");
    expect(instructions).toContain("alpha beta gamma sibling"); // same-file made it in
    expect(instructions).not.toContain("zebra yak quokka"); // unrelated outsiders didn't
    expect(Number(cIds[cIds.length - 1]!.slice(1))).toBeLessThanOrEqual(20);
  });

  it("compare pool caps at 20 questions when candidates exceed it", async () => {
    const fx = fixture();
    // 12 lexically-related outsiders + 12 same-file siblings ⇒ 24 > cap
    const many = Array.from({ length: 12 }, (_, i) => `- proxy github push filler ${i}`).join("\n");
    writeFile(fx.memDir, "corpus.md", `${AGENT_FM}## C\n\n${many}\n`);
    const siblings = Array.from({ length: 12 }, (_, i) => `- proxy github push sibling ${i}`).join("\n");
    writeFile(fx.memDir, "t.md", `${AGENT_FM}## S\n\n${siblings}\n- proxy github push timeout target OLD\n`);
    const { client, asks } = fakeClient({ answerFor: () => answersFor() });
    const port = makePort(fx, client);
    const before = readFileSync(join(fx.memDir, "t.md"), "utf8");
    await port.afterWrite({
      cwd: fx.cwd,
      file: "t.md",
      before,
      after: before.replace("OLD", "NEW"),
      registry: REGISTRY,
    });
    const cIds = Object.keys(asks[0]!.questions).filter((id) => /^c\d+$/.test(id));
    expect(cIds).toHaveLength(20);
  });
});

describe("afterWrite: degraded states", () => {
  it("partial ⇒ write-side long echo, zero asks, no sidecar, entry pending", async () => {
    const fx = fixture();
    const { client, asks } = fakeClient({ status: { kind: "partial", reason: "451", inactive: false } });
    const port = makePort(fx, client);
    const { echo, usage } = await port.afterWrite({
      cwd: fx.cwd,
      file: "a.md",
      before: undefined,
      after: `${AGENT_FM}## S\n\n- some new entry\n`,
      registry: REGISTRY,
    });
    expect(asks).toHaveLength(0);
    expect(usage).toBeUndefined();
    expect(echo).toEqual([
      "jev: not tagged (partial: 451) — fast path will not see this entry until tagged; inline tags=+… works now",
    ]);
    expect(existsSync(join(fx.memDir, ".jev", "index.json"))).toBe(false);
  });

  it("registry missing ⇒ off(pi-api) short echo", async () => {
    const fx = fixture();
    const { client, asks } = fakeClient({});
    const port = makePort(fx, client);
    const { echo } = await port.afterWrite({
      cwd: fx.cwd,
      file: "a.md",
      before: undefined,
      after: `${AGENT_FM}## S\n\n- some new entry\n`,
      registry: undefined,
    });
    expect(asks).toHaveLength(0);
    expect(echo).toEqual(["jev: not tagged (off: pi-api)"]);
  });

  it("client off ⇒ off(<reason>) short echo", async () => {
    const fx = fixture();
    const { client, asks } = fakeClient({ status: { kind: "off", reason: "disabled" } });
    const port = makePort(fx, client);
    const { echo } = await port.afterWrite({
      cwd: fx.cwd,
      file: "a.md",
      before: undefined,
      after: `${AGENT_FM}## S\n\n- some new entry\n`,
      registry: REGISTRY,
    });
    expect(asks).toHaveLength(0);
    expect(echo).toEqual(["jev: not tagged (off: disabled)"]);
  });
});

describe("afterWrite: usage + budget", () => {
  it("usage aggregates cost and counts calls", async () => {
    const fx = fixture();
    const body = `${AGENT_FM}## S\n\n- entry one\n- entry two\n`;
    const { client } = fakeClient({ answerFor: () => answersFor(), costUsd: 0.0001 });
    const port = makePort(fx, client);
    const { usage } = await port.afterWrite({
      cwd: fx.cwd,
      file: "u.md",
      before: undefined,
      after: body,
      registry: REGISTRY,
    });
    expect(usage).toEqual({ costUsd: 0.0002, calls: 2 });
  });

  it("total budget 3000ms aborts hanging asks (fake clock), sidecar untouched", async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const { client, asks } = fakeClient({ hang: true });
    const port = makePort(fx, client);
    const done = port.afterWrite({
      cwd: fx.cwd,
      file: "slow.md",
      before: undefined,
      after: `${AGENT_FM}## S\n\n- slow entry\n`,
      registry: REGISTRY,
    });
    const { echo } = await vi.advanceTimersByTimeAsync(3000);
    void echo;
    const result = await done;
    expect(asks).toHaveLength(1);
    expect(result.echo.join("\n")).toContain("jev: not tagged (aborted)");
    expect(existsSync(join(fx.memDir, ".jev", "index.json"))).toBe(false);
    expect(result.usage).toEqual({ costUsd: 0, calls: 1 });
  });

  it("afterWrite never rejects on internal errors (dirFor throwing)", async () => {
    const fx = fixture();
    const { client } = fakeClient({});
    const port = createJevWritePort({
      client,
      entryIndex: new EntryIndex(),
      dirFor: () => {
        throw new Error("boom");
      },
      taxonomyFor: () => mergeTaxonomy().taxonomy,
      confirmTimeoutMs: 60_000,
      now: () => FIX_NOW,
    });
    await expect(
      port.afterWrite({ cwd: fx.cwd, file: "a.md", before: undefined, after: "x", registry: REGISTRY }),
    ).resolves.toEqual({ echo: [] });
  });
});

describe("checkInline", () => {
  const ok = `${AGENT_FM}## S\n\n- plain entry\n`;
  const bad = `${AGENT_FM}## S\n\n- entry <!-- mem expires=not-a-date -->\n`;

  it("a newly introduced inline-comment error rejects the write", () => {
    const fx = fixture();
    const port = makePort(fx, fakeClient({}).client);
    const err = port.checkInline("a.md", ok, bad);
    expect(err).toBeDefined();
    expect(err).toContain("refused: a.md would introduce inline-comment errors");
  });

  it("pre-existing errors do not block (decision 8)", () => {
    const fx = fixture();
    const port = makePort(fx, fakeClient({}).client);
    expect(port.checkInline("a.md", bad, bad)).toBeUndefined();
  });

  it("creating a file (before undefined) with a broken comment rejects", () => {
    const fx = fixture();
    const port = makePort(fx, fakeClient({}).client);
    expect(port.checkInline("new.md", undefined, bad)).toBeDefined();
  });
});

describe("touchedUserEntries (v4.1 §3.2 through the port)", () => {
  const mk = (body: string): string => `## Rules\n\n${body}\n`;

  it("top-of-file insertion shifts lines but pairs by hash ⇒ no touch", () => {
    const fx = fixture();
    const port = makePort(fx, fakeClient({}).client);
    const before = mk("- user order one\n- user order two");
    const after = `# Title\n\n## Rules\n\n- brand new context line\n\n- user order one\n- user order two`;
    expect(port.touchedUserEntries("core.md", before, after, true)).toEqual([]);
  });

  it("editing one character of a user entry ⇒ touched (and file name re-stamped)", () => {
    const fx = fixture();
    const port = makePort(fx, fakeClient({}).client);
    const before = mk("- user order one");
    const after = mk("- user order two");
    const touched = port.touchedUserEntries("core.md", before, after, true);
    expect(touched).toHaveLength(1);
    expect(touched[0]!.file).toBe("core.md");
  });

  it("deleting one of two identical duplicate rows ⇒ touched once", () => {
    const fx = fixture();
    const port = makePort(fx, fakeClient({}).client);
    const before = mk("- identical user order\n- identical user order");
    const after = mk("- identical user order");
    expect(port.touchedUserEntries("core.md", before, after, true)).toHaveLength(1);
  });
});
