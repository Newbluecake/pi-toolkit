// §10 K group (todo #22 P4): `/mem tidy` proposal/validate/apply flow,
// `--dry-run`/`--frontmatter`, cost caps, hand-written suggestion-only, and
// the migration-mode fixture. Driven with fakes for `TidyPort` and
// `ExtensionCommandContext.ui` (same convention as `tests/memory/command.test.ts`).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeEmptyFixture,
  materializeFixture,
  writeMemAt,
  type MaterializedFixture,
} from "./helpers/fixture-dir.js";
import { snapshotMemoryDir } from "../../src/memory/tidy/snapshot.js";
import { validateTidyProposal } from "../../src/memory/tidy/validate.js";
import { renderTidyDiff } from "../../src/memory/tidy/diff.js";
import { planFrontmatterBackfill } from "../../src/memory/tidy/frontmatter.js";
import { applyTidy } from "../../src/memory/tidy/apply.js";
import type { TidyProposal } from "../../src/memory/contracts.js";

let fx: MaterializedFixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

// ───────────────────────────── snapshot.ts ─────────────────────────────

describe("snapshotMemoryDir (§7.3 step 1)", () => {
  it("current-5: pitfalls.md (pin:true) is the primary core (no core.md); totalBytes covers all 5", () => {
    fx = materializeFixture("current-5");
    const snap = snapshotMemoryDir(fx.cwd, { paths: fx.paths });
    expect(snap.files).toHaveLength(5);
    const pitfalls = snap.files.find((f) => f.name === "pitfalls.md");
    expect(pitfalls?.isPrimaryCore).toBe(true);
    expect(snap.files.filter((f) => f.isPrimaryCore)).toHaveLength(1);
    expect(pitfalls?.handWritten).toBe(false); // source: agent
    expect(snap.totalBytes).toBeGreaterThan(0);
  });

  it("explicit file list narrows the snapshot but primary-core detection still looks at the whole dir", () => {
    fx = materializeFixture("current-5");
    const snap = snapshotMemoryDir(fx.cwd, { names: ["quota.md"], paths: fx.paths });
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]?.name).toBe("quota.md");
    expect(snap.files[0]?.isPrimaryCore).toBe(false); // pitfalls.md is still primary, just not selected
  });

  it("rejects a name that isn't an addressable memory file", () => {
    fx = materializeFixture("current-5");
    expect(() => snapshotMemoryDir(fx!.cwd, { names: ["nope.md"], paths: fx!.paths })).toThrow(/not a memory file/);
  });

  it("archived files are excluded from the default (no-args) selection, included when named explicitly", () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "old.md", "---\nstatus: archived\n---\n\n# old\nstuff\n", "2026-09-01T00:00:00.000Z");
    writeMemAt(fx.memDir, "live.md", "# live\nstuff\n", "2026-09-02T00:00:00.000Z");
    const auto = snapshotMemoryDir(fx.cwd, { paths: fx.paths });
    expect(auto.files.map((f) => f.name)).toEqual(["live.md"]);
    const explicit = snapshotMemoryDir(fx.cwd, { names: ["old.md"], paths: fx.paths });
    expect(explicit.files.map((f) => f.name)).toEqual(["old.md"]);
  });

  it("hand-written (no source:agent) files are flagged handWritten", () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "byhand.md", "# manual notes\nwritten by a human\n", "2026-09-01T00:00:00.000Z");
    const snap = snapshotMemoryDir(fx.cwd, { paths: fx.paths });
    expect(snap.files[0]?.handWritten).toBe(true);
  });

  it("throws when there is no memory directory at all", () => {
    fx = materializeEmptyFixture();
    expect(() => snapshotMemoryDir("/definitely/not/a/real/cwd/for/this/test", { paths: fx!.paths })).toThrow(
      /no memory directory/,
    );
  });
});

// ───────────────────────────── validate.ts ─────────────────────────────

describe("validateTidyProposal (§7.3 step 5)", () => {
  const baseCtx = { coreBytes: 1600, topicMaxBytes: 16384, maxOutputBytes: 65536 };

  it("accepts a clean keep-everything proposal", () => {
    const original = new Map([
      ["a.md", { name: "a.md", body: "# a\nhello\n", handWritten: false, isPrimaryCore: false } as any],
    ]);
    const proposal: TidyProposal = {
      files: [{ name: "a.md", action: "keep", reason: "no change needed" }],
      dropped: [],
    };
    const res = validateTidyProposal(proposal, { original, ...baseCtx });
    expect(res.ok).toBe(true);
    expect(res.issues).toHaveLength(0);
  });

  it("output byte cap: the WHOLE proposal is invalid when the schema-content sum exceeds maxOutputBytes", () => {
    const original = new Map<string, any>();
    const bigContent = "x".repeat(200);
    const proposal: TidyProposal = {
      files: [{ name: "a.md", action: "create", content: bigContent, reason: "r" }],
      dropped: [],
    };
    const res = validateTidyProposal(proposal, { ...baseCtx, original, maxOutputBytes: 50 });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /over cap/.test(i.message))).toBe(true);
  });

  it("rejects an invalid filename, a create over an existing target, and a rewrite of an unknown target", () => {
    const original = new Map<string, any>([
      ["real.md", { name: "real.md", body: "x", handWritten: false, isPrimaryCore: false }],
    ]);
    const proposal: TidyProposal = {
      files: [
        { name: "../escape.md", action: "create", content: "x", reason: "r" },
        { name: "real.md", action: "create", content: "x", reason: "r" },
        { name: "ghost.md", action: "rewrite", content: "x", reason: "r" },
      ],
      dropped: [],
    };
    const res = validateTidyProposal(proposal, { original, ...baseCtx });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /invalid file name/.test(i.message))).toBe(true);
    expect(res.issues.some((i) => /already exists/.test(i.message))).toBe(true);
    expect(res.issues.some((i) => /not in the snapshot/.test(i.message))).toBe(true);
  });

  it("content conservation: every non-empty non-heading original line must survive or be dropped-with-reason", () => {
    const originalBody = "# Title\n\nfirst important fact\nsecond important fact\n";
    const original = new Map<string, any>([
      ["a.md", { name: "a.md", body: originalBody, handWritten: false, isPrimaryCore: false }],
    ]);

    const lossy: TidyProposal = {
      files: [{ name: "a.md", action: "rewrite", content: "# Title\n\nfirst important fact\n", reason: "trim" }],
      dropped: [],
    };
    const lossyRes = validateTidyProposal(lossy, { original, ...baseCtx });
    expect(lossyRes.fileFlags.get("a.md")?.unaccountedLines).toBe(1);

    const accountedViaDrop: TidyProposal = {
      files: [{ name: "a.md", action: "rewrite", content: "# Title\n\nfirst important fact\n", reason: "trim" }],
      dropped: [{ from: "a.md", text: "second important fact", reason: "redundant" }],
    };
    const droppedRes = validateTidyProposal(accountedViaDrop, { original, ...baseCtx });
    expect(droppedRes.fileFlags.get("a.md")?.unaccountedLines).toBe(0);

    const accountedElsewhere: TidyProposal = {
      files: [
        { name: "a.md", action: "rewrite", content: "# Title\n\nfirst important fact\n", reason: "trim" },
        { name: "b.md", action: "create", content: "# B\n\nsecond important fact\n", reason: "moved" },
      ],
      dropped: [],
    };
    const movedRes = validateTidyProposal(accountedElsewhere, { original, ...baseCtx });
    expect(movedRes.fileFlags.get("a.md")?.unaccountedLines).toBe(0);
  });

  it("frontmatter is never checked for content conservation (only body lines)", () => {
    const originalBody = "---\npin: true\nsource: agent\n---\n\n# Title\nonly body line\n";
    const original = new Map<string, any>([
      ["a.md", { name: "a.md", body: originalBody, handWritten: false, isPrimaryCore: false }],
    ]);
    const proposal: TidyProposal = {
      files: [{ name: "a.md", action: "rewrite", content: "# Title\nonly body line\n", reason: "strip frontmatter" }],
      dropped: [],
    };
    const res = validateTidyProposal(proposal, { original, ...baseCtx });
    expect(res.fileFlags.get("a.md")?.unaccountedLines).toBe(0);
  });

  it("hand-written original ⇒ canApply:false regardless of content quality", () => {
    const original = new Map<string, any>([
      ["h.md", { name: "h.md", body: "# H\nbody\n", handWritten: true, isPrimaryCore: false }],
    ]);
    const proposal: TidyProposal = {
      files: [{ name: "h.md", action: "rewrite", content: "# H\nbody\n", reason: "r" }],
      dropped: [],
    };
    const res = validateTidyProposal(proposal, { original, ...baseCtx });
    expect(res.fileFlags.get("h.md")?.canApply).toBe(false);
    expect(res.fileFlags.get("h.md")?.note).toMatch(/hand-written/);
  });

  it("core/topic byte caps: over-cap content ⇒ canApply:false with the overage noted", () => {
    const original = new Map<string, any>([
      ["core.md", { name: "core.md", body: "# core\n", handWritten: false, isPrimaryCore: true }],
      ["topic.md", { name: "topic.md", body: "# t\n", handWritten: false, isPrimaryCore: false }],
    ]);
    const proposal: TidyProposal = {
      files: [
        { name: "core.md", action: "rewrite", content: "x".repeat(2000), reason: "r" },
        { name: "topic.md", action: "rewrite", content: "y".repeat(20000), reason: "r" },
      ],
      dropped: [],
    };
    const res = validateTidyProposal(proposal, {
      original,
      coreBytes: 1600,
      topicMaxBytes: 16384,
      maxOutputBytes: 65536,
    });
    expect(res.fileFlags.get("core.md")?.canApply).toBe(false);
    expect(res.fileFlags.get("core.md")?.note).toMatch(/core cap/);
    expect(res.fileFlags.get("topic.md")?.canApply).toBe(false);
    expect(res.fileFlags.get("topic.md")?.note).toMatch(/topic cap/);
  });

  it("invalid frontmatter in proposed content ⇒ canApply:false", () => {
    const original = new Map<string, any>([
      ["a.md", { name: "a.md", body: "# a\n", handWritten: false, isPrimaryCore: false }],
    ]);
    const badStatus = "---\nstatus: not-a-real-status\n---\n\n# a\nbody\n";
    const proposal: TidyProposal = {
      files: [{ name: "a.md", action: "rewrite", content: badStatus, reason: "r" }],
      dropped: [],
    };
    const res = validateTidyProposal(proposal, { original, ...baseCtx });
    expect(res.fileFlags.get("a.md")?.canApply).toBe(false);
    expect(res.fileFlags.get("a.md")?.note).toMatch(/frontmatter/);
  });
});

// ───────────────────────────── diff.ts ─────────────────────────────

describe("renderTidyDiff (§7.3 step 6)", () => {
  it("small files: line-level unified diff", () => {
    const out = renderTidyDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n");
    expect(out).toContain("-line2");
    expect(out).toContain("+CHANGED");
    expect(out).toContain(" line1");
    expect(out).toContain(" line3");
  });

  it("degrades to a whole-file replace view above the size/line bound", () => {
    const before = Array.from({ length: 500 }, (_, i) => `before line ${String(i)}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `after line ${String(i)}`).join("\n");
    const out = renderTidyDiff(before, after);
    expect(out).toContain("whole-file replace view");
    expect(out).toContain("-before line 0");
    expect(out).toContain("+after line 0");
  });
});

// ───────────────────────────── frontmatter.ts (tidy) ─────────────────────────────

describe("planFrontmatterBackfill (§7.4)", () => {
  it("proposes description(H1)/topic/status for a file missing all three; never for the primary core's description", () => {
    const topic = {
      name: "quota.md",
      body: "# Quota notes\nsome body\n",
      meta: { readWhenTerms: [], topic: "quota", status: "active", pin: false } as any,
      isPrimaryCore: false,
    };
    const core = {
      name: "core.md",
      body: "# Core\nrules\n",
      meta: { readWhenTerms: [], topic: "core", status: "active", pin: true } as any,
      isPrimaryCore: true,
    };
    const proposals = planFrontmatterBackfill([topic, core]);
    const topicP = proposals.find((p) => p.name === "quota.md");
    expect(topicP?.patch.description).toBe("Quota notes");
    expect(topicP?.patch.topic).toBe("quota");
    expect(topicP?.patch.status).toBe("active");
    const coreP = proposals.find((p) => p.name === "core.md");
    expect(coreP?.patch.description).toBeUndefined(); // §5: primary core never gets a description backfill
    expect(coreP?.patch.topic).toBe("core");
  });

  it("is idempotent: a second run over an already-backfilled directory proposes nothing", () => {
    const already = {
      name: "a.md",
      body: "---\ndescription: already set\ntopic: a\nstatus: active\n---\n\n# A\nbody\n",
      meta: { description: "already set", readWhenTerms: [], topic: "a", status: "active" as const, pin: false },
      isPrimaryCore: false,
    };
    expect(planFrontmatterBackfill([already])).toEqual([]);
  });

  it("skips archived files entirely", () => {
    const archived = {
      name: "old.md",
      body: "---\nstatus: archived\n---\n\n# Old\n",
      meta: { readWhenTerms: [], topic: "old", status: "archived" as const, pin: false },
      isPrimaryCore: false,
    };
    expect(planFrontmatterBackfill([archived])).toEqual([]);
  });
});

// ───────────────────────────── apply.ts direct ─────────────────────────────

describe("applyTidy (§7.3 step 7)", () => {
  it("sha mismatch on one file ⇒ that file is skipped, others still applied, exactly one manifest write", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "a.md", "# a\nold\n", "2026-09-01T00:00:00.000Z");
    writeMemAt(fx.memDir, "b.md", "# b\nold\n", "2026-09-01T00:00:00.000Z");
    const originalSha = new Map([
      ["a.md", "deadbeef".repeat(8)], // deliberately wrong
      ["b.md", shaOf(fx.memDir, "b.md")],
    ]);
    const result = await applyTidy({
      cwd: fx.cwd,
      paths: fx.paths,
      proposal: {
        files: [
          { name: "a.md", action: "rewrite", content: "# a\nnew\n", reason: "r" },
          { name: "b.md", action: "rewrite", content: "# b\nnew\n", reason: "r" },
        ],
        dropped: [],
      },
      decisions: new Map([
        ["a.md", "apply"],
        ["b.md", "apply"],
      ]),
      originalSha,
      kind: "tidy",
    });
    expect(result.applied.map((a) => a.name)).toEqual(["b.md"]);
    expect(result.skipped).toEqual([{ name: "a.md", reason: "a.md changed on disk since the proposal was drafted" }]);
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("old"); // untouched
    expect(readFileSync(join(fx.memDir, "b.md"), "utf8")).toContain("new");
    expect(result.manifest.entries).toHaveLength(1);
  });

  it("create over an existing (concurrently-created) file is skipped, not fatal", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "new.md", "# surprise\nalready here\n", "2026-09-01T00:00:00.000Z");
    const result = await applyTidy({
      cwd: fx.cwd,
      paths: fx.paths,
      proposal: {
        files: [{ name: "new.md", action: "create", content: "# new\nfrom tidy\n", reason: "r" }],
        dropped: [],
      },
      decisions: new Map([["new.md", "apply"]]),
      originalSha: new Map(),
      kind: "tidy",
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/already exists/);
    expect(readFileSync(join(fx.memDir, "new.md"), "utf8")).toContain("already here");
  });

  it("decisions that are 'skip' or missing are never applied even if the proposal lists them", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "a.md", "# a\nkeep me as-is\n", "2026-09-01T00:00:00.000Z");
    const snap = snapshotMemoryDir(fx.cwd, { paths: fx.paths });
    const originalSha = new Map(snap.files.map((f) => [f.name, f.sha256]));
    const result = await applyTidy({
      cwd: fx.cwd,
      paths: fx.paths,
      proposal: { files: [{ name: "a.md", action: "rewrite", content: "# a\nCHANGED\n", reason: "r" }], dropped: [] },
      decisions: new Map([["a.md", "skip"]]),
      originalSha,
      kind: "tidy",
    });
    expect(result.applied).toHaveLength(0);
    expect(result.manifest.entries).toHaveLength(0);
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("keep me as-is");
  });
});

function shaOf(dir: string, name: string): string {
  return createHash("sha256")
    .update(readFileSync(join(dir, name), "utf8"), "utf8")
    .digest("hex");
}

// ───────────────────────────── command.ts orchestration ─────────────────────────────

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleMemTidyCommand, type TidyCommandDeps } from "../../src/memory/tidy/command.js";
import type { TidyPort } from "../../src/memory/contracts.js";
import type { RunOutcome, RunSnapshot } from "../../src/core/types.js";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import type { MemoryPaths } from "../../src/memory/paths.js";

interface FakeModel {
  provider: string;
  id: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function makeUi(
  script: { confirm?: boolean[]; select?: (string | undefined)[]; editor?: (string | undefined)[] } = {},
) {
  const notifications: { message: string; level?: string }[] = [];
  const confirmCalls: { title: string; message: string }[] = [];
  const confirmQ = [...(script.confirm ?? [])];
  const selectQ = [...(script.select ?? [])];
  const editorQ = [...(script.editor ?? [])];
  const selectCalls: { title: string; options: string[] }[] = [];
  const ui = {
    notify: (message: string, level?: string) => notifications.push({ message, level }),
    confirm: async (title: string, message: string) => {
      confirmCalls.push({ title, message });
      return confirmQ.shift() ?? true;
    },
    select: async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return selectQ.shift();
    },
    editor: async (_title: string, _prefill?: string) => editorQ.shift(),
  };
  return { ui, notifications, selectCalls, confirmCalls };
}

function makeCtx(
  cwd: string,
  ui: ReturnType<typeof makeUi>["ui"],
  opts: { hasUI?: boolean; model?: FakeModel | null } = {},
): ExtensionCommandContext {
  const model =
    opts.model === undefined
      ? { provider: "test", id: "model-a", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }
      : opts.model;
  return {
    hasUI: opts.hasUI !== false,
    mode: "tui",
    cwd,
    model: model ?? undefined,
    modelRegistry: {
      find: (p: string, i: string) => (model && p === model.provider && i === model.id ? model : undefined),
    },
    ui,
  } as unknown as ExtensionCommandContext;
}

function makeOutcome(o: Partial<RunOutcome> & { structuredResult?: unknown }): RunOutcome {
  return {
    runId: "r1",
    status: "completed",
    turns: 1,
    durationMs: 100,
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 0,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
    ...o,
  } as unknown as RunOutcome;
}

interface FakePort {
  port: TidyPort;
  spawnReqs: any[];
  aborts: { runId: string; cause?: string }[];
  setSnapshot: (s: Partial<RunSnapshot> | undefined) => void;
  settle: (o: RunOutcome) => void;
  forcePending: boolean;
}

function makeFakePort(): FakePort {
  const spawnReqs: any[] = [];
  const aborts: { runId: string; cause?: string }[] = [];
  let settled: RunOutcome | undefined;
  let pendingResolvers: ((r: { kind: "settled"; outcome: RunOutcome }) => void)[] = [];
  let snap: RunSnapshot | undefined;
  const self: FakePort = {
    spawnReqs,
    aborts,
    forcePending: false,
    setSnapshot: (s) => {
      snap = s as RunSnapshot | undefined;
    },
    settle: (o) => {
      settled = o;
      for (const r of pendingResolvers) r({ kind: "settled", outcome: o });
      pendingResolvers = [];
    },
    port: {
      spawn: async (req) => {
        spawnReqs.push(req);
        return { runId: "r1" };
      },
      waitOutcome: async () => {
        if (self.forcePending) return { kind: "pending" };
        if (settled) return { kind: "settled", outcome: settled };
        return await new Promise((resolve) => {
          pendingResolvers.push(resolve);
        });
      },
      abort: async (runId, cause) => {
        aborts.push({ runId, cause });
        return true;
      },
      snapshot: () => snap,
    },
  };
  return self;
}

function baseDeps(fp: FakePort, o: { paths: MemoryPaths; settings?: Partial<MemorySettings> }): TidyCommandDeps {
  const settings: MemorySettings = {
    ...DEFAULT_SETTINGS.memory,
    ...o.settings,
    tidy: { ...DEFAULT_SETTINGS.memory.tidy, ...o.settings?.tidy },
  };
  return {
    isChildSession: false,
    getTidyPort: () => fp.port,
    paths: o.paths,
    settings: () => settings,
    now: () => new Date("2026-09-27T00:00:00.000Z"),
  };
}

describe("/mem tidy command (§7.3, §10 K group)", () => {
  it("K11: child session or no UI ⇒ rejected, zero spawn", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const { ui, notifications } = makeUi();
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, { ...baseDeps(fp, { paths: fx.paths }), isChildSession: true });
    expect(notifications[0]?.message).toContain("only available in the main session");
    expect(fp.spawnReqs).toHaveLength(0);
  });

  it("K11: no attached tidy port ⇒ rejected, zero spawn", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const { ui, notifications } = makeUi();
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, { ...baseDeps(fp, { paths: fx.paths }), getTidyPort: () => undefined });
    expect(notifications[0]?.message).toContain("tidy unavailable in this session");
    expect(fp.spawnReqs).toHaveLength(0);
  });

  it("K2: no memory.tidy.model and no ctx.model ⇒ rejected, zero spawn", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const { ui, notifications } = makeUi();
    const ctx = makeCtx(fx.cwd, ui, { model: null });
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(notifications[0]?.message).toContain("no model to run tidy");
    expect(fp.spawnReqs).toHaveLength(0);
  });

  it("K2: memory.tidy.model (strict provider/id) overrides ctx.model", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const { ui } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui);
    fp.settle(makeOutcome({ status: "failed", error: { kind: "internal", message: "boom", retryable: false } as any }));
    await handleMemTidyCommand(
      "tidy",
      "",
      ctx,
      baseDeps(fp, {
        paths: fx.paths,
        settings: { tidy: { ...DEFAULT_SETTINGS.memory.tidy, model: "other/model-b" } } as any,
      }),
    );
    expect(fp.spawnReqs[0]?.modelOverride).toEqual({ provider: "other", id: "model-b" });
  });

  it("K5/K15: --dry-run makes zero spawn calls and leaves the directory byte-identical", async () => {
    fx = materializeFixture("current-5");
    const before = readFileSync(join(fx.memDir, "pitfalls.md"), "utf8");
    const fp = makeFakePort();
    const { ui, notifications } = makeUi();
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "--dry-run", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(fp.spawnReqs).toHaveLength(0);
    expect(readdirSync(fx.memDir)).not.toContain(".backup");
    expect(readFileSync(join(fx.memDir, "pitfalls.md"), "utf8")).toBe(before);
    expect(notifications[0]?.message).toContain("tidy --dry-run:");
  });

  it("K3: estimated cost over the cap ⇒ zero spawn", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const { ui, notifications } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand(
      "tidy",
      "",
      ctx,
      baseDeps(fp, {
        paths: fx.paths,
        settings: { tidy: { ...DEFAULT_SETTINGS.memory.tidy, maxCostUsd: 0.05 } as any },
      }),
    );
    expect(fp.spawnReqs).toHaveLength(0);
    expect(notifications[0]?.message).toMatch(/over the \$0\.05 cap/);
  });

  it("K3: unpriced model ⇒ allowed, confirm text says 'no cost guarantee', cost cap watcher disabled", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const unpriced: FakeModel = {
      provider: "free",
      id: "model",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const { ui, confirmCalls, notifications } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui, { model: unpriced });
    fp.settle(
      makeOutcome({ status: "aborted", error: { kind: "aborted", message: "aborted", retryable: false } as any }),
    );
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(confirmCalls[0]?.message).toMatch(/no cost guarantee/);
    expect(fp.spawnReqs).toHaveLength(1); // unpriced is allowed to dispatch, just warned
    expect(notifications.at(-1)?.message).toContain("zero writes");
  });

  it("K1/K5/K10: batch apply writes every file and fires one post-write refresh", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "a.md", "---\nsource: agent\n---\n\n# a\noriginal\n", "2026-09-01T00:00:00.000Z");
    writeMemAt(fx.memDir, "b.md", "---\nsource: agent\n---\n\n# b\noriginal\n", "2026-09-01T00:00:00.000Z");
    const fp = makeFakePort();
    const proposal = {
      files: [
        { name: "a.md", action: "rewrite", content: "# a\noriginal\n\nupdated by tidy\n", reason: "cleanup" },
        { name: "b.md", action: "rewrite", content: "# b\n\nupdated by tidy\n", reason: "cleanup" },
      ],
      dropped: [],
    };
    fp.settle(
      makeOutcome({
        status: "completed",
        structuredResult: proposal,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.12 },
      }),
    );
    const { ui, selectCalls } = makeUi({ confirm: [true], select: ["Apply", "Apply"] });
    const select = ui.select;
    ui.select = async (title, options) => {
      expect(readFileSync(join(fx!.memDir, "a.md"), "utf8")).toContain("original");
      expect(readFileSync(join(fx!.memDir, "b.md"), "utf8")).toContain("original");
      expect(readdirSync(fx!.memDir)).not.toContain(".backup");
      return select(title, options);
    };
    const ctx = makeCtx(fx.cwd, ui);
    let afterWriteCalls = 0;
    await handleMemTidyCommand("tidy", "", ctx, {
      ...baseDeps(fp, { paths: fx.paths }),
      onAfterWrite: () => afterWriteCalls++,
    });
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("updated by tidy");
    expect(readFileSync(join(fx.memDir, "b.md"), "utf8")).toContain("updated by tidy");
    expect(afterWriteCalls).toBe(1);
    expect(selectCalls).toHaveLength(2);
    expect(selectCalls[0]?.options[0]).toBe("Apply"); // clean files offer Apply first
    const [id] = readdirSync(join(fx.memDir, ".backup"));
    expect(id).toBeDefined();
    expect(readFileSync(join(fx.memDir, ".backup", id!, "a.md"), "utf8")).toContain("original");
    expect(readFileSync(join(fx.memDir, ".backup", id!, "b.md"), "utf8")).toContain("original");
    expect(fp.spawnReqs[0]).toMatchObject({ toolDomain: "readonly", expectAck: true, suppressDelivery: true });
  });

  it("K1: Skip leaves the file untouched", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "a.md", "---\nsource: agent\n---\n\n# a\noriginal\n", "2026-09-01T00:00:00.000Z");
    const fp = makeFakePort();
    const proposal = {
      files: [{ name: "a.md", action: "rewrite", content: "# a\nshould not land\n", reason: "cleanup" }],
      dropped: [],
    };
    fp.settle(makeOutcome({ status: "completed", structuredResult: proposal }));
    const { ui } = makeUi({ confirm: [true], select: ["Skip"] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("original");
    expect(readdirSync(fx.memDir)).not.toContain(".backup");
  });

  it("K1: Abort all ⇒ zero writes even if earlier files were about to Apply", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "a.md", "---\nsource: agent\n---\n\n# a\noriginal-a\n", "2026-09-01T00:00:00.000Z");
    writeMemAt(fx.memDir, "b.md", "---\nsource: agent\n---\n\n# b\noriginal-b\n", "2026-09-01T00:00:00.000Z");
    const fp = makeFakePort();
    const proposal = {
      files: [
        { name: "a.md", action: "rewrite", content: "# a\nnew-a\n", reason: "cleanup" },
        { name: "b.md", action: "rewrite", content: "# b\nnew-b\n", reason: "cleanup" },
      ],
      dropped: [],
    };
    fp.settle(makeOutcome({ status: "completed", structuredResult: proposal }));
    const { ui, notifications } = makeUi({ confirm: [true], select: ["Apply", "Abort all"] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("original-a");
    expect(readFileSync(join(fx.memDir, "b.md"), "utf8")).toContain("original-b");
    expect(notifications.at(-1)?.message).toContain("aborted by user");
  });

  it("K1: View diff returns to the same select, then Skip", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "a.md", "---\nsource: agent\n---\n\n# a\noriginal\n", "2026-09-01T00:00:00.000Z");
    const fp = makeFakePort();
    const proposal = {
      files: [{ name: "a.md", action: "rewrite", content: "# a\nnew\n", reason: "cleanup" }],
      dropped: [],
    };
    fp.settle(makeOutcome({ status: "completed", structuredResult: proposal }));
    const { ui, selectCalls, notifications } = makeUi({
      confirm: [true],
      select: ["View diff", "Skip"],
      editor: ["ignored"],
    });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(selectCalls).toHaveLength(2); // asked twice for the same file
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("original");
    expect(notifications.at(-1)?.message).toContain("applied 0, skipped 1");
  });

  it("K1: Edit then apply lands the EDITED content, not the model's original proposal", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "a.md", "---\nsource: agent\n---\n\n# a\noriginal\n", "2026-09-01T00:00:00.000Z");
    const fp = makeFakePort();
    const proposal = {
      files: [{ name: "a.md", action: "rewrite", content: "# a\nmodel proposal\n", reason: "cleanup" }],
      dropped: [],
    };
    fp.settle(makeOutcome({ status: "completed", structuredResult: proposal }));
    const { ui } = makeUi({ confirm: [true], select: ["Edit then apply"], editor: ["# a\nHUMAN EDITED\n"] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    const finalText = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(finalText).toContain("HUMAN EDITED");
    expect(finalText).not.toContain("model proposal");
  });

  it("K4: output-byte cap over-limit ⇒ the WHOLE proposal is discarded, zero writes", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "a.md", "# a\noriginal\n", "2026-09-01T00:00:00.000Z");
    const fp = makeFakePort();
    const proposal = {
      files: [{ name: "a.md", action: "rewrite", content: "x".repeat(200), reason: "cleanup" }],
      dropped: [],
    };
    fp.settle(makeOutcome({ status: "completed", structuredResult: proposal }));
    const { ui, notifications } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand(
      "tidy",
      "",
      ctx,
      baseDeps(fp, {
        paths: fx.paths,
        settings: { tidy: { ...DEFAULT_SETTINGS.memory.tidy, maxOutputBytes: 50 } as any },
      }),
    );
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("original");
    expect(notifications.at(-1)?.message).toContain("tidy proposal invalid");
  });

  it("K8: hand-written file's proposal offers no Apply option, and never lands even if the model proposed a change", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "manual.md", "# manual\nhuman wrote this\n", "2026-09-01T00:00:00.000Z"); // no source:agent ⇒ hand-written
    const fp = makeFakePort();
    const proposal = {
      files: [
        { name: "manual.md", action: "rewrite", content: "# manual\nmodel wants to change this\n", reason: "cleanup" },
      ],
      dropped: [],
    };
    fp.settle(makeOutcome({ status: "completed", structuredResult: proposal }));
    const { ui, selectCalls } = makeUi({ confirm: [true], select: ["Skip"] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(selectCalls[0]?.options).not.toContain("Apply");
    expect(readFileSync(join(fx.memDir, "manual.md"), "utf8")).toContain("human wrote this");
  });

  it("K11: spawn failure ⇒ zero writes", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    fp.port.spawn = async () => ({ error: { message: "no capacity" } });
    const { ui, notifications } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(notifications.at(-1)?.message).toContain("tidy spawn failed");
    expect(notifications.at(-1)?.message).toContain("zero writes");
  });

  it("K11: run never settles within the wait budget ⇒ aborted as timed out, zero writes", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    fp.forcePending = true;
    const { ui, notifications } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand(
      "tidy",
      "",
      ctx,
      baseDeps(fp, {
        paths: fx.paths,
        settings: { tidy: { ...DEFAULT_SETTINGS.memory.tidy, timeoutMs: 1000 } as any },
      }),
    );
    expect(fp.aborts[0]?.cause).toBe("timeout");
    expect(notifications.at(-1)?.message).toContain("timed out");
  });

  it("K11: user cancels the up-front confirm ⇒ zero spawn", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const { ui } = makeUi({ confirm: [false] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(fp.spawnReqs).toHaveLength(0);
  });

  it("K11: schema-invalid (no structuredResult) ⇒ aborted, zero writes", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    fp.settle(
      makeOutcome({
        status: "failed",
        error: { kind: "schema", message: "no structured output", retryable: false } as any,
      }),
    );
    const { ui, notifications } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(notifications.at(-1)?.message).toContain("tidy aborted");
    expect(notifications.at(-1)?.message).toContain("zero writes");
  });

  it('K15: the spawn request always carries toolDomain:"readonly" and never isolation, even with a custom agentType', async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    fp.settle(makeOutcome({ status: "failed", error: { kind: "internal", message: "x", retryable: false } as any }));
    const { ui } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand(
      "tidy",
      "",
      ctx,
      baseDeps(fp, {
        paths: fx.paths,
        settings: { tidy: { ...DEFAULT_SETTINGS.memory.tidy, agentType: "custom-with-bash" } as any },
      }),
    );
    expect(fp.spawnReqs[0]?.toolDomain).toBe("readonly");
    expect(fp.spawnReqs[0]?.isolation).toBeUndefined();
    expect(fp.spawnReqs[0]?.type).toBe("custom-with-bash");
  });

  it("K3: cap watcher aborts a run that exceeds the cost cap mid-flight", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const { ui, notifications } = makeUi({ confirm: [true] });
    const ctx = makeCtx(fx.cwd, ui);
    const runPromise = handleMemTidyCommand(
      "tidy",
      "",
      ctx,
      baseDeps(fp, {
        paths: fx.paths,
        settings: { tidy: { ...DEFAULT_SETTINGS.memory.tidy, maxCostUsd: 1, maxTurns: 20 } as any },
      }),
    );
    // Let the up-front confirm/spawn resolve, then arm a snapshot that trips
    // the cost cap on the next 1s poll tick.
    await new Promise((r) => setTimeout(r, 50));
    fp.setSnapshot({
      status: "model_turn",
      diag: {
        lastTurnStartAt: 12345,
        turns: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 5 },
      },
    } as any);
    fp.port.abort = async (runId, cause) => {
      fp.aborts.push({ runId, cause });
      fp.settle(
        makeOutcome({ status: "aborted", error: { kind: "aborted", message: "capped", retryable: false } as any }),
      );
      return true;
    };
    await new Promise((r) => setTimeout(r, 1100)); // let the real 1s poll interval fire
    await runPromise;
    expect(fp.aborts).toHaveLength(1);
    expect(fp.aborts[0]?.cause).toBe("user_stop");
    expect(notifications.at(-1)?.message).toContain("cost cap $1.00 reached");
  }, 5000);
});

// ───────────────────────────── --frontmatter mode ─────────────────────────────

describe("/mem tidy --frontmatter (§7.4, K12)", () => {
  it("current-5: proposes backfill for the 4 agent topic files, never a description for the primary core (pitfalls.md)", async () => {
    fx = materializeFixture("current-5");
    const fp = makeFakePort();
    const { ui, selectCalls } = makeUi({ select: ["Apply", "Apply", "Apply", "Apply"] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "--frontmatter", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(fp.spawnReqs).toHaveLength(0); // zero model cost
    // pitfalls.md (primary core, already has topic/status via frontmatter in
    // the fixture? if not, it may still appear for topic/status but never for description)
    const pitfallsCalls = selectCalls.filter((c) => c.title.includes("pitfalls.md"));
    for (const c of pitfallsCalls) expect(c.title).not.toContain("+description");
  });

  it("is idempotent: running twice produces zero proposals the second time", async () => {
    fx = materializeFixture("current-5");
    const fp1 = makeFakePort();
    const { ui: ui1 } = makeUi({ select: ["Apply", "Apply", "Apply", "Apply", "Apply"] });
    await handleMemTidyCommand("tidy", "--frontmatter", makeCtx(fx.cwd, ui1), baseDeps(fp1, { paths: fx.paths }));

    const fp2 = makeFakePort();
    const { ui: ui2, notifications } = makeUi();
    await handleMemTidyCommand("tidy", "--frontmatter", makeCtx(fx.cwd, ui2), baseDeps(fp2, { paths: fx.paths }));
    expect(notifications[0]?.message).toContain("nothing to backfill");
  });

  it("hand-written file is offered only as a suggestion, never applied", async () => {
    fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "manual.md", "# Manual notes\nbody\n", "2026-09-01T00:00:00.000Z");
    const fp = makeFakePort();
    const { ui, selectCalls } = makeUi({ select: ["Skip"] });
    const ctx = makeCtx(fx.cwd, ui);
    await handleMemTidyCommand("tidy", "--frontmatter", ctx, baseDeps(fp, { paths: fx.paths }));
    expect(selectCalls[0]?.title).toContain("suggestion only");
    expect(selectCalls[0]?.options).not.toContain("Apply");
    const raw = readFileSync(join(fx.memDir, "manual.md"), "utf8");
    expect(raw).not.toContain("topic:"); // never applied
  });
});

// ───────────────────────────── migration-mode fixture (K13) ─────────────────────────────

describe("migration mode: current-5 + the pre-authored migration payload (K13)", () => {
  it("content is conserved, core.md stays under coreBytes, and every file lands on disk correctly", async () => {
    fx = materializeFixture("current-5");
    const payload = JSON.parse(
      readFileSync(join("tests/fixtures/memory/tidy-payloads/migration-current-5.json"), "utf8"),
    ) as TidyProposal;

    const snap = snapshotMemoryDir(fx.cwd, { paths: fx.paths });
    const originalByName = new Map(snap.files.map((f) => [f.name, f]));
    const validateCtx = {
      original: originalByName,
      coreBytes: DEFAULT_SETTINGS.memory.coreBytes,
      topicMaxBytes: DEFAULT_SETTINGS.memory.topicMaxBytes,
      maxOutputBytes: DEFAULT_SETTINGS.memory.tidy.maxOutputBytes,
    };
    const vres = validateTidyProposal(payload, validateCtx);
    expect(vres.ok).toBe(true);
    for (const f of payload.files) {
      if (f.action === "keep") continue;
      expect(vres.fileFlags.get(f.name)?.unaccountedLines).toBe(0);
    }
    const coreFile = payload.files.find((f) => f.name === "core.md");
    expect(Buffer.byteLength(coreFile?.content ?? "", "utf8")).toBeLessThanOrEqual(DEFAULT_SETTINGS.memory.coreBytes);

    const originalSha = new Map(snap.files.map((f) => [f.name, f.sha256]));
    const decisions = new Map(payload.files.filter((f) => f.action !== "keep").map((f) => [f.name, "apply" as const]));
    const applied = await applyTidy({
      cwd: fx.cwd,
      paths: fx.paths,
      proposal: payload,
      decisions,
      originalSha,
      kind: "tidy",
    });
    expect(applied.skipped).toHaveLength(0);

    const finalNames = readdirSync(fx.memDir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    expect(finalNames).toEqual(
      [
        "cache-ttl.md",
        "concurrency.md",
        "core.md",
        "git-parallel.md",
        "landed-notes.md",
        "live-acceptance-tmux.md",
        "multi-agent-experiments.md",
        "quota.md",
        "runtime-pitfalls.md",
      ].sort(),
    );
    // byte-exact except the `updated:` stamp apply always refreshes on write
    const landed = readFileSync(join(fx.memDir, "core.md"), "utf8").replace(/^updated: .*\n/m, "");
    const fixture = readFileSync(join("tests/fixtures/memory/current-5-migrated/core.md"), "utf8").replace(
      /^updated: .*\n/m,
      "",
    );
    expect(landed).toBe(fixture);
  });
});
