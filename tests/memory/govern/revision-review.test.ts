import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { createBlockLocked, replaceBlockLocked } from "../../../src/memory/blocks/store.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { createJevCommandPort } from "../../../src/memory/jev/command-port.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { writeGovernIndexLocked, readGovernBlock } from "../../../src/memory/govern/supersede.js";
import {
  handleReviewLite,
  upsertRevisionSuggestion,
  revisionSuggestionSuppressed,
  type RevisionReviewDeps,
} from "../../../src/memory/govern/review-lite.js";
import { blockReviewDisplay } from "../../../src/memory/govern/display.js";
import {
  freezeRevisionInputsLocked,
  planRevisionActions,
  revisionFrozenRelationDigest,
  type RevisionReviewInput,
} from "../../../src/memory/govern/revision.js";
import type {
  AuditReadResult,
  FrozenRevisionInput,
  RevisionAudit,
  RevisionAuditPort,
  RevisionProposal,
} from "../../../src/memory/jev/contracts.js";
const roots: string[] = [];
const now = new Date("2026-11-10T00:00:00Z");
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(action: RevisionProposal["action"] = "expires", withContext = false) {
  const dir = mkdtempSync(join(tmpdir(), "p50-d-review-"));
  roots.push(dir);
  mkdirSync(join(dir, "blocks"));
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  const a = createBlockLocked(
    join(dir, "blocks"),
    "rules",
    { authority: "agent" },
    "Keep the exact original body.",
    now,
  );
  const b = createBlockLocked(join(dir, "blocks"), "rules", { authority: "agent" }, "Keep context.", now);
  const { dev, ino } = safeFs.inspectDirNoFollow(dir);
  const state = { current: true, lease: true, allowed: true };
  const gate = {
    capture() {},
    check: () => (state.allowed ? { ok: true as const } : { ok: false as const, reason: "locked" as const }),
  };
  async function freeze(epoch = 1): Promise<FrozenRevisionInput> {
    const live = readGovernBlock(dir, a.id);
    const value = await withMemoryDirLock(dir, () =>
      freezeRevisionInputsLocked(
        dir,
        {
          directory: { realpath: dir, dev, ino, sessionEpoch: epoch },
          selectionBatchId: `selection-${epoch}`,
          policyVersion: "policy-v1",
          action,
          target: live,
          ...(withContext ? { context: readGovernBlock(dir, b.id) } : {}),
        },
        { gate, isCurrent: () => state.current },
      ),
    );
    if ("kind" in value) throw new Error(`fixture freeze: ${value.reason}`);
    return value;
  }
  const frozen = await freeze();
  const plan = (f: FrozenRevisionInput) =>
    planRevisionActions({
      candidates: [
        {
          frozen: f,
          reason: "expired",
          ...(action === "expires"
            ? { expiry: { op: "set" as const, nextExpires: "2027-01-01", dateRuleVersion: "date-rule-v1" } }
            : {}),
        },
      ],
      autoEnabled: true,
      leaseValid: true,
    })[0]!;
  const proposal = plan(frozen);
  const input: RevisionReviewInput = { frozen, proposal, origin: "p50-suggestion" };
  const trace: string[] = [];
  const audits: RevisionAudit[] = [];
  // C0 injection seam ONLY: these tests do not claim real audit fsync/recovery.
  const prepared = vi.fn((arg: RevisionReviewInput): AuditReadResult => {
    expect(existsSync(join(dir, ".lock"))).toBe(true);
    trace.push("audit-prepared");
    const f = arg.frozen,
      p = arg.proposal;
    const audit: RevisionAudit = {
      v: 1,
      origin: arg.origin,
      batchId: f.batchId,
      actionId: f.actionId,
      directoryIdentityDigest: f.directoryIdentityDigest,
      action: f.action,
      targetId: f.target.id,
      expectedRev: f.target.rev,
      ...(f.context ? { contextId: f.context.id, contextExpectedRev: f.context.rev } : {}),
      inputDigest: revisionFrozenRelationDigest(f),
      proposalDigest: p.proposalDigest,
      ...(p.action === "expires" ? { expiry: p.expiry } : {}),
      beforeDigest: f.target.rawDigest,
      beforeFile: "before.md",
      policyVersion: f.policyVersion,
      state: "prepared",
      createdAt: now.toISOString(),
    };
    audits.push(audit);
    return { kind: "ok", audit, before: f.target.rawBefore };
  });
  const unexpected = () => {
    throw new Error("no E applier/restore in D");
  };
  const audit: RevisionAuditPort = {
    persistPreparedBarrierLocked: prepared,
    readActionLocked: unexpected,
    persistExpectedAfterBarrierLocked: unexpected,
    finalizeCommitLocked: unexpected,
    scanPendingLocked: unexpected,
  };
  const deps: { -readonly [K in keyof RevisionReviewDeps]: RevisionReviewDeps[K] } = {
    audit,
    gate,
    isCurrent: () => state.current,
    leaseValid: () => state.lease,
    now: () => now,
  };
  const client = { status: () => ({ kind: "full" as const, model: "unused" }), ask: unexpected, probe: unexpected };
  const port = () =>
    createJevCommandPort({
      client,
      entryIndex: new EntryIndex(),
      dirFor: () => dir,
      now: () => now.getTime(),
      isChildSession: false,
      triggerBulk() {},
    });
  return {
    dir,
    a,
    b,
    state,
    input,
    deps,
    prepared,
    trace,
    audits,
    freeze,
    plan,
    port,
    indexPath: join(dir, "blocks/.jev/index.json"),
  };
}
it("owns one real lock across prepared barrier then index persistence; restart roundtrip is exact", async () => {
  const h = await fixture();
  const original = readFileSync(join(h.dir, "blocks", `${h.a.id}.md`));
  h.prepared.mockImplementationOnce((arg) => {
    expect(existsSync(join(h.dir, ".lock"))).toBe(true);
    expect(existsSync(h.indexPath)).toBe(false);
    const f = arg.frozen,
      p = arg.proposal;
    h.trace.push("audit-prepared");
    return {
      kind: "ok",
      before: f.target.rawBefore,
      audit: {
        v: 1,
        origin: arg.origin,
        batchId: f.batchId,
        actionId: f.actionId,
        directoryIdentityDigest: f.directoryIdentityDigest,
        action: f.action,
        targetId: f.target.id,
        expectedRev: f.target.rev,
        inputDigest: revisionFrozenRelationDigest(f),
        proposalDigest: p.proposalDigest,
        beforeDigest: f.target.rawDigest,
        beforeFile: "before.md",
        policyVersion: f.policyVersion,
        state: "prepared",
        createdAt: now.toISOString(),
      },
    };
  });
  const replace = safeFs.replaceAtomic;
  vi.spyOn(safeFs, "replaceAtomic").mockImplementation((dir, temp, name) => {
    if (name === "index.json") {
      expect(existsSync(join(h.dir, ".lock"))).toBe(true);
      h.trace.push("index-rename");
    }
    replace(dir, temp, name);
  });
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("saved");
  expect(h.trace).toEqual(["audit-prepared", "index-rename"]);
  const saved = readIndex(h.dir).index.review!.suggestions[0]!;
  expect(saved.revision).toEqual(h.input.proposal);
  expect(saved.id).toBe(`revision:${h.input.proposal.actionId}`);
  expect(JSON.parse(readFileSync(h.indexPath, "utf8")).review.suggestions[0].revision).toEqual(h.input.proposal);
  expect(readFileSync(join(h.dir, "blocks", `${h.a.id}.md`))).toEqual(original);
  expect(existsSync(join(h.dir, ".lock"))).toBe(false);
});
it.each(["rev", "raw-only", "authority", "status", "location", "directory", "context", "epoch", "gate"])(
  "stale %s writes neither audit nor index",
  async (change) => {
    const h = await fixture("expires", true),
      path = join(h.dir, "blocks", `${h.a.id}.md`);
    if (change === "rev")
      replaceBlockLocked(join(h.dir, "blocks"), h.a.id, h.a.rev, { meta: h.a.meta, body: "changed" }, now);
    if (change === "raw-only") writeFileSync(path, readFileSync(path, "utf8") + "\n");
    if (change === "authority")
      writeFileSync(path, readFileSync(path, "utf8").replace("authority: agent", "authority: user"));
    if (change === "status")
      writeFileSync(path, readFileSync(path, "utf8").replace("status: active", "status: archived"));
    if (change === "location") renameSync(path, `${path}.away`);
    if (change === "context") writeFileSync(join(h.dir, "blocks", `${h.b.id}.md`), "changed context");
    if (change === "directory") {
      renameSync(join(h.dir, "blocks"), join(h.dir, "old-blocks"));
      mkdirSync(join(h.dir, "blocks"));
      for (const name of [".layout.json", `${h.a.id}.md`, `${h.b.id}.md`])
        writeFileSync(join(h.dir, "blocks", name), readFileSync(join(h.dir, "old-blocks", name)));
    }
    if (change === "epoch") h.state.current = false;
    if (change === "gate") h.state.allowed = false;
    expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("stale");
    expect(h.prepared).not.toHaveBeenCalled();
    expect(existsSync(h.indexPath)).toBe(false);
  },
);
it.each(["missing", "failed", "corrupted", "bad-binding"])(
  "missing or invalid audit barrier %s never persists the suggestion",
  async (which) => {
    const h = await fixture();
    if (which === "missing") delete h.deps.audit;
    else if (which === "bad-binding") {
      const original = h.prepared.getMockImplementation()!;
      h.prepared.mockImplementation((arg) => {
        const out = original(arg);
        if (out.kind !== "ok") return out;
        return { ...out, audit: { ...out.audit, proposalDigest: "a".repeat(64) } };
      });
    } else h.prepared.mockReturnValue({ kind: which === "failed" ? "unavailable" : "corrupted" });
    expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("unavailable");
    expect(existsSync(h.indexPath)).toBe(false);
  },
);
it("index failure leaves prepared evidence and original body, never tries a data CAS", async () => {
  const h = await fixture(),
    before = readFileSync(join(h.dir, "blocks", `${h.a.id}.md`));
  const original = safeFs.replaceAtomic;
  vi.spyOn(safeFs, "replaceAtomic").mockImplementation((dir, tmp, name) => {
    if (name === "index.json") throw new Error("injected index rename failure");
    original(dir, tmp, name);
  });
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("unavailable");
  expect(h.audits).toHaveLength(1);
  expect(h.audits[0]?.state).toBe("prepared");
  expect(readFileSync(join(h.dir, "blocks", `${h.a.id}.md`))).toEqual(before);
  expect(existsSync(h.indexPath)).toBe(false);
});
it.each(["epoch", "body", "abort"])("after prepared %s change cannot publish a late index", async (which) => {
  const h = await fixture(),
    original = h.prepared.getMockImplementation()!,
    controller = new AbortController();
  h.deps.signal = controller.signal;
  h.prepared.mockImplementation((arg) => {
    const result = original(arg);
    if (which === "epoch") h.state.current = false;
    if (which === "body") writeFileSync(join(h.dir, "blocks", `${h.a.id}.md`), "external edit");
    if (which === "abort") controller.abort();
    return result;
  });
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("stale");
  expect(h.audits).toHaveLength(1);
  expect(existsSync(h.indexPath)).toBe(false);
});
it("lease loss freezes a suggestion-only final digest before audit", async () => {
  const h = await fixture();
  expect(h.input.proposal.autoEligible).toBe(true);
  h.state.lease = false;
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("saved");
  const p = readIndex(h.dir).index.review!.suggestions[0]!.revision!;
  expect(p.autoEligible).toBe(false);
  expect(p.proposalDigest).not.toBe(h.input.proposal.proposalDigest);
  expect(h.audits[0]?.proposalDigest).toBe(p.proposalDigest);
});
it.each(["dismissed", "resolved"])(
  "stable %s survives body/rev/batch/epoch and restart; concurrent late upsert cannot revive",
  async (which) => {
    const h = await fixture();
    expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("saved");
    const id = readIndex(h.dir).index.review!.suggestions[0]!.id;
    const port = h.port();
    if (which === "dismissed") await port.review.dismiss("cwd", id);
    else await port.review.resolve("cwd", id);
    if (which === "dismissed")
      expect(readIndex(h.dir).index.review?.dismissed[0]).toMatchObject({
        kind: "expired-user",
        suggestionKey: JSON.stringify(["revision", "expires", h.a.id]),
      });
    replaceBlockLocked(
      join(h.dir, "blocks"),
      h.a.id,
      h.a.rev,
      { meta: h.a.meta, body: "New body with a new rev." },
      now,
    );
    const frozen = await h.freeze(2);
    const fresh = { ...h.input, frozen, proposal: h.plan(frozen) };
    expect(await revisionSuggestionSuppressed(h.dir, frozen, h.deps)).toBe(which);
    expect(await upsertRevisionSuggestion(h.dir, fresh, h.deps)).toBe(which);
    expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("stale");
    expect(readIndex(h.dir).index.review!.suggestions).toEqual([]);
    expect(h.prepared).toHaveBeenCalledTimes(1);
  },
);
it("revision interactive review offers only open/keep/skip, never legacy extend/delete/archive", async () => {
  const h = await fixture();
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("saved");
  const before = readFileSync(join(h.dir, "blocks", `${h.a.id}.md`));
  const seen: string[][] = [];
  await handleReviewLite(
    h.dir,
    "",
    {
      notify() {},
      confirm: async () => false,
      select: async <T extends string>(_title: string, options: readonly { value: T; label: string }[]) => {
        seen.push(options.map((o) => o.value));
        return "extend" as T;
      },
    },
    { interactive: true, enabled: false, residentBudget: 8192, now },
  );
  expect(seen).toEqual([["open", "keep", "skip"]]);
  expect(readFileSync(join(h.dir, "blocks", `${h.a.id}.md`))).toEqual(before);
  await handleReviewLite(
    h.dir,
    "",
    {
      notify() {},
      confirm: async () => false,
      select: async (_title, options) => options.find((o) => o.value === "keep")?.value,
    },
    { interactive: true, enabled: false, residentBudget: 8192, now },
  );
  expect(readIndex(h.dir).index.review!.suggestions).toEqual([]);
  expect(readIndex(h.dir).index.review?.dismissed[0]?.suggestionKey).toBe(
    JSON.stringify(["revision", "expires", h.a.id]),
  );
});
it("display is read-only: exact frozen expires/rule-version and metadata-only rev staleness", async () => {
  const h = await fixture();
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("saved");
  const before = readFileSync(h.indexPath);
  const livePath = join(h.dir, "blocks", `${h.a.id}.md`);
  expect(blockReviewDisplay(h.dir, "2099-01-01")).toContain(`@${h.a.rev}`);
  expect(blockReviewDisplay(h.dir, "2099-01-01")).toContain("expires=2027-01-01 dateRuleVersion=date-rule-v1");
  const raw = readFileSync(livePath, "utf8");
  writeFileSync(livePath, raw.replace("version: 1", "version: 2"));
  expect(blockReviewDisplay(h.dir)).toContain("·stale");
  expect(readFileSync(h.indexPath)).toEqual(before);
  const frozen = await h.freeze(2);
  const p = planRevisionActions({
    candidates: [{ frozen, reason: "expired", expiry: { op: "clear", dateRuleVersion: "clear-v2" } }],
    autoEnabled: false,
    leaseValid: true,
  })[0]!;
  await withMemoryDirLock(h.dir, () =>
    writeGovernIndexLocked(h.dir, {
      v: 1,
      entries: {},
      review: {
        lastRunAt: "",
        corpusFp: "",
        suggestions: [
          {
            id: `revision:${p.actionId}`,
            kind: "expired-user",
            a: { hash: "unused", anchor: h.a.id },
            at: "",
            p: 0,
            revision: p,
          },
        ],
        dismissed: [],
      },
    }),
  );
  expect(blockReviewDisplay(h.dir)).toContain("expires=clear dateRuleVersion=clear-v2");
});

it("a late proposal cannot overwrite a different newer suggestion for the same frozen revisions", async () => {
  const h = await fixture();
  const newer = planRevisionActions({
    candidates: [{ frozen: h.input.frozen, reason: "expired", expiry: { op: "clear", dateRuleVersion: "new-rule" } }],
    autoEnabled: false,
    leaseValid: true,
  })[0]!;
  expect(await upsertRevisionSuggestion(h.dir, { ...h.input, proposal: newer }, h.deps)).toBe("saved");
  // Even a later completion timestamp does not make the old model request newer.
  expect(await upsertRevisionSuggestion(h.dir, h.input, { ...h.deps, now: () => new Date("2027-01-01") })).toBe(
    "stale",
  );
  expect(h.prepared).toHaveBeenCalledTimes(1);
  expect(readIndex(h.dir).index.review?.suggestions[0]?.revision).toEqual(newer);
});

it("lease invalidation inside the prepared barrier publishes no automatic hint", async () => {
  const h = await fixture(),
    original = h.prepared.getMockImplementation()!;
  h.prepared.mockImplementation((input) => {
    const result = original(input);
    h.state.lease = false;
    return result;
  });
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("stale");
  expect(h.audits).toHaveLength(1);
  expect(existsSync(h.indexPath)).toBe(false);
});
it("epoch invalidated after index temp write cannot rename the late suggestion", async () => {
  const h = await fixture(),
    original = safeFs.writeTempRegular;
  vi.spyOn(safeFs, "writeTempRegular").mockImplementation((...args) => {
    const tmp = original(...args);
    if (args[1] === "index.json") h.state.current = false;
    return tmp;
  });
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.deps)).toBe("stale");
  expect(existsSync(h.indexPath)).toBe(false);
  expect(readGovernBlock(h.dir, h.a.id).rev).toBe(h.a.rev);
});
