import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi, afterEach } from "vitest";
import { r4Host, r4Command, until } from "./revision-web-command-r4-helpers.js";
import { startCommandFlow, commandFlowConfirmationPlan } from "../../../src/memory/command-flow.js";
import { createRevisionWebCommand } from "../../../src/memory/govern/revision-web-command.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { createRevisionAuditPort, restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";
import { readIndex, revisionSemanticSuppression } from "../../../src/memory/jev/index-store.js";
import { parseMemoryCommandFacts } from "../../../src/web-hub/protocol/memory-command-facts.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import * as revision from "../../../src/memory/govern/revision.js";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
afterEach(() => vi.restoreAllMocks());
const chooseApply = async (req: { options: readonly string[] }) =>
  req.options.includes("apply") ? "apply" : "continue";
const chooseKeep = async (req: { options: readonly string[] }) => (req.options.includes("keep") ? "keep" : "continue");

it("original host settled custody + NEW actual kernel receipt/lease → original E real single-file change and C raw restore", async () => {
  const h = await r4Host();
  expect(h.result).toMatchObject({ kind: "settled", saved: 1, effects: 0 });
  const p = h.rows()[0]!.revision!,
    before = fs.readFileSync(join(h.blocks, `${p.targetId}.md`));
  const context = fs.readFileSync(join(h.blocks, `${p.contextId}.md`));
  const original = await withMemoryDirLock(h.dir, () => h.host.actionLocked(h.dir, p.actionId));
  expect(original).toBeDefined();
  h.state.lease = false; // generation activity lease is over; NOT web authority
  const f = r4Command(h),
    freeze = vi.spyOn(revision, "freezeRevisionInputsLocked");
  const consume = vi.spyOn(f.kernel, "consume"),
    data = vi.spyOn(safeFs, "replaceRevisionObserved");
  const task = startCommandFlow({ ...f, choose: chooseApply });
  const result = await task.done;
  expect(result.facts).toMatchObject({
    effect: "completed",
    omitted: 0,
    rows: [
      { receipt: "consumed", data: "applied", audit: "barrier-observed", stage: "finalize", outcome: "completed" },
    ],
  });
  expect(consume).toHaveBeenCalledTimes(1);
  expect(freeze).not.toHaveBeenCalled();
  expect(data.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(1);
  expect(fs.readFileSync(join(h.blocks, `${p.targetId}.md`)).equals(before)).toBe(false);
  expect(fs.readFileSync(join(h.blocks, `${p.contextId}.md`))).toEqual(context);
  expect(f.questions[0]).toContain(before.toString("utf8"));
  expect(f.questions[0]).toContain(p.generatedBody!);
  expect(f.questions[0]).toContain(p.proposalDigest);
  expect(f.questions[0]).toContain(h.dir);
  expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
  const audit = createRevisionAuditPort(h.dir, { isCurrent: () => true, now: f.deps.now });
  expect(await withMemoryDirLock(h.dir, () => audit.readActionLocked(p.batchId, p.actionId))).toMatchObject({
    kind: "ok",
    audit: { state: "committed", commitOrigin: "web-b3" },
  });
  // Normal command close/release does NOT reset host custody/job ownership.
  task.release();
  expect(h.host.inspect().jobs).toHaveLength(1);
  expect(
    await restoreRevisionRaw(h.dir, { actionId: p.actionId }, { isCurrent: () => true, now: f.deps.now }),
  ).toMatchObject({ kind: "restored" });
  expect(fs.readFileSync(join(h.blocks, `${p.targetId}.md`))).toEqual(before);
  expect(fs.readFileSync(join(h.blocks, `${p.contextId}.md`))).toEqual(context);
});

it.each([false, true])(
  "keep history=%s exact original kernel confirm + original locked review suppression, no E",
  async (history) => {
    const h = await r4Host(),
      p = h.rows()[0]!.revision!;
    if (history) h.host.reset("tree");
    const raw = fs.readFileSync(join(h.blocks, `${p.targetId}.md`));
    const f = r4Command(h),
      consume = vi.spyOn(f.kernel, "consume"),
      data = vi.spyOn(safeFs, "replaceRevisionObserved"),
      barrier = vi.spyOn(safeFs, "fsyncRevisionFile");
    const task = startCommandFlow({
      ...f,
      choose: async (r) => {
        if (r.options.includes("keep")) {
          expect(r.options.includes("apply")).toBe(!history);
          return "keep";
        }
        return "continue";
      },
    });
    const result = await task.done;
    expect(result.facts).toMatchObject({
      effect: "completed",
      rows: [
        {
          operation: "keep",
          stage: "review",
          receipt: "consumed",
          review: "changed",
          data: "not-called",
          audit: "not-entered",
        },
      ],
    });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(barrier).not.toHaveBeenCalled();
    expect(data).not.toHaveBeenCalled();
    expect(fs.readFileSync(join(h.blocks, `${p.targetId}.md`))).toEqual(raw);
    const index = readIndex(h.dir).index;
    expect(index.review!.suggestions).toHaveLength(0);
    expect(
      revisionSemanticSuppression(index, {
        action: p.action,
        reason: p.reason,
        target: { id: p.targetId, hash: "new-hash" },
        context: { id: p.contextId!, hash: "changed-hash" },
      }),
    ).toBe("dismissed");
    expect(f.questions[0]).toContain("永久语义抑制");
    expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
    task.release();
  },
);

it("history cannot gain E even by direct prepare or forged menu target, no freeze/consume/new C IO", async () => {
  const h = await r4Host();
  h.host.reset("session");
  const f = r4Command(h),
    snapshot = await f.domain.snapshot(),
    target = snapshot.targets[0]!;
  expect(target.live).toBe(false);
  const freeze = vi.spyOn(revision, "freezeRevisionInputsLocked"),
    consume = vi.spyOn(f.kernel, "consume"),
    barrier = vi.spyOn(safeFs, "fsyncRevisionFile");
  await expect(f.domain.prepare(target, "apply", 1)).rejects.toMatchObject({ code: "unavailable" });
  await expect(f.domain.prepare({ ...target, live: true }, "apply", 1)).rejects.toMatchObject({
    code: "E_MEM_PLAN_CHANGED",
  });
  expect(consume).not.toHaveBeenCalled();
  expect(freeze).not.toHaveBeenCalled();
  expect(barrier).not.toHaveBeenCalled();
});

it.each(["decline", "raw", "context", "review", "owner", "lease"] as const)(
  "%s after prepare never causes NEW C barrier/data write",
  async (fault) => {
    const h = await r4Host(),
      f = r4Command(h, { autoAnswer: false }),
      p = h.rows()[0]!.revision!;
    const consume = vi.spyOn(f.kernel, "consume"),
      barrier = vi.spyOn(safeFs, "fsyncRevisionFile"),
      data = vi.spyOn(safeFs, "replaceRevisionObserved");
    const task = startCommandFlow({ ...f, choose: chooseApply });
    await until(() => f.answers.length === 1);
    if (fault === "raw") h.write(p.targetId, "Changed same target.", "agent", 2);
    if (fault === "context") h.write(p.contextId!, "Changed context.", "agent", 2);
    if (fault === "review") {
      const path = join(h.blocks, ".jev/index.json"),
        index = JSON.parse(fs.readFileSync(path, "utf8"));
      index.review.suggestions[0].at = "2026-11-11T00:00:00.000Z";
      fs.writeFileSync(path, JSON.stringify(index));
    }
    if (fault === "owner") h.revoke();
    if (fault === "lease") f.command.abort();
    f.answers[0]!(fault === "decline" ? "拒绝（不执行）" : undefined);
    const result = await task.done;
    expect(result.facts.effect).toBe("none");
    expect(result.ok).toBe(false);
    if (fault === "decline") expect(result.facts.rows[0]!.code).toBe("E_MEM_CONFIRM_DECLINED");
    expect(consume).not.toHaveBeenCalled();
    expect(barrier).not.toHaveBeenCalled();
    expect(data).not.toHaveBeenCalled();
    expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
    task.release();
  },
);

it.each(["review", "raw", "context"] as const)(
  "keep %s CAS changes after approval are checked before consume",
  async (fault) => {
    const h = await r4Host();
    h.host.reset("session");
    const f = r4Command(h, { autoAnswer: false }),
      p = h.rows()[0]!.revision!;
    const consume = vi.spyOn(f.kernel, "consume");
    const task = startCommandFlow({ ...f, choose: chooseKeep });
    await until(() => f.answers.length === 1);
    if (fault === "raw") h.write(p.targetId, "Changed.", "agent", 2);
    if (fault === "context") h.write(p.contextId!, "Changed.", "agent", 2);
    if (fault === "review") {
      const path = join(h.blocks, ".jev/index.json"),
        index = JSON.parse(fs.readFileSync(path, "utf8"));
      index.review.resolved = ["revision:other"];
      index.review.suggestions[0].at = "2026-11-11T00:00:00.000Z";
      fs.writeFileSync(path, JSON.stringify(index));
    }
    f.answers[0]!();
    const result = await task.done;
    expect(result.facts.effect).toBe("none");
    expect(consume).not.toHaveBeenCalled();
    expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(0);
    expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
  },
);

it.each(["prepared", "expected-after", "data", "finalize", "keep-write"] as const)(
  "real %s fault is unknown, scalar observations survive facts codec, no rollback/retry",
  async (fault) => {
    const h = await r4Host(),
      f = r4Command(h),
      p = h.rows()[0]!.revision!;
    const before = fs.readFileSync(join(h.blocks, `${p.targetId}.md`));
    const file = safeFs.fsyncRevisionFile,
      rename = fs.renameSync;
    let applied = false;
    vi.spyOn(safeFs, "fsyncRevisionFile").mockImplementation((...args) => {
      if (
        fault === "prepared" ||
        (fault === "expected-after" &&
          fs.existsSync(join(h.blocks, ".jev/revisions", p.batchId, p.actionId, "after.md")))
      )
        throw Error("real barrier failure");
      file(...args);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      if (fault === "keep-write" && String(b).endsWith("/index.json")) throw Error("review write uncertain");
      if (fault === "finalize" && applied && String(b).endsWith("/audit.json")) throw Error("finalize uncertain");
      rename(a, b);
      if (String(b) === join(h.blocks, `${p.targetId}.md`)) {
        applied = true;
        if (fault === "data") throw Error("opaque postrename");
      }
    });
    const task = startCommandFlow({ ...f, choose: fault === "keep-write" ? chooseKeep : chooseApply });
    const result = await task.done;
    expect(result.facts.effect).toBe("unknown");
    expect(result.retryable).toBe(false);
    const row = result.facts.rows[0]!;
    expect(row.receipt).toBe("consumed");
    if (fault === "prepared" || fault === "expected-after")
      expect(row).toMatchObject({ data: "not-called", audit: "io-possible" });
    if (fault === "data") expect(row.data).toBe("unknown");
    if (fault === "finalize") expect(row).toMatchObject({ data: "applied", stage: "finalize", audit: "io-possible" });
    if (fault === "keep-write") expect(row.review).toBe("unknown");
    expect(fs.readFileSync(join(h.blocks, `${p.targetId}.md`)).equals(before)).toBe(
      !["data", "finalize"].includes(fault),
    );
    expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
    expect(task.cancel()).toBe(result);
    task.release();
  },
);

it("terminal unknown published during original observer cannot upgrade when E later returns exact completion", async () => {
  const h = await r4Host(),
    f = r4Command(h);
  let task!: ReturnType<typeof startCommandFlow>;
  const apply = safeFs.replaceRevisionObserved;
  let published: ReturnType<typeof task.cancel> | undefined;
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    if (args[0] === h.blocks) published = task.cancel();
    return apply(...args);
  });
  task = startCommandFlow({ ...f, choose: chooseApply });
  const result = await task.done;
  expect(result).toBe(published);
  expect(result.facts.effect).toBe("unknown");
  await until(() => f.kernel.binding(f.call) === undefined);
  await Promise.resolve();
  expect(task.cancel()).toBe(result);
  expect(result.facts.rows[0]!.data).toBe("unknown");
});

it("historical changed context explicitly says original unavailable; current text never pretends original or LIVE", async () => {
  const h = await r4Host(),
    p = h.rows()[0]!.revision!;
  h.host.reset("session");
  h.write(p.contextId!, "Current context is a new unrelated rule.", "agent", 2);
  const f = r4Command(h),
    { targets } = await f.domain.snapshot();
  const text = await f.domain.view(targets[0]!);
  expect(text).toContain("历史 context 原文字节不可得");
  expect(text).toContain("Current context is a new unrelated rule.");
  expect(text).toContain("history");
  await expect(f.domain.prepare(targets[0]!, "apply", 1)).rejects.toMatchObject({ code: "unavailable" });
});

it("same receipt cannot approve another plan; effect execution is one attempt even if called directly twice", async () => {
  const h = await r4Host(),
    f = r4Command(h),
    { targets } = await f.domain.snapshot();
  const prepared = await f.domain.prepare(targets[0]!, "keep", 1),
    plan = commandFlowConfirmationPlan(prepared.plan);
  const approval = await f.kernel.confirm(f.call, plan);
  if (!approval.approved) throw Error("expected approval");
  expect(f.kernel.reserve(f.call, approval.receipt, plan)).toBe(true);
  const consume = vi.spyOn(f.kernel, "consume");
  expect(await prepared.execute(approval.receipt, { ...plan, manifest: `${plan.manifest} ` }, () => {})).toMatchObject({
    outcome: "rejected",
    receipt: "not-consumed",
  });
  expect(consume).not.toHaveBeenCalled();
  // Failed/attempted calls revoke the same original receipt, never remint.
  expect(await prepared.execute(approval.receipt, plan, () => {})).toMatchObject({ outcome: "rejected" });
});

it("list-only rejects effect API and invalid grammar never resolves host/store", async () => {
  const h = await r4Host(),
    f = r4Command(h, { rawArgs: "review --list" }),
    { targets } = await f.domain.snapshot();
  await expect(f.domain.prepare(targets[0]!, "keep", 1)).rejects.toMatchObject({ code: "permission" });
  const spy = vi.spyOn(h.host, "actionLocked");
  expect(() => createRevisionWebCommand({ ...f.deps, rawArgs: "review --run" })).toThrow();
  expect(spy).not.toHaveBeenCalled();
});

it("keep last original writer gate rechecks CAS AFTER reentrant owner callback, preserving other review changes", async () => {
  const h = await r4Host();
  h.host.reset("session");
  const f = r4Command(h, { autoAnswer: false }),
    p = h.rows()[0]!.revision!;
  let consumeDone = false,
    reentered = false;
  const originalConsume = f.kernel.consume.bind(f.kernel);
  vi.spyOn(f.kernel, "consume").mockImplementation((...args) => {
    const result = originalConsume(...args);
    consumeDone = result;
    return result;
  });
  const domain = createRevisionWebCommand({
    ...f.deps,
    gate: {
      capture() {
        throw Error("never capture");
      },
      check() {
        if (consumeDone && !reentered) {
          reentered = true;
          h.write(p.targetId, "Changed by synchronous trusted callback.", "agent", 2);
        }
        return { ok: true };
      },
    },
  });
  const task = startCommandFlow({ ...f, domain, choose: chooseKeep });
  await until(() => f.answers.length === 1);
  f.answers[0]!();
  const result = await task.done;
  expect(reentered).toBe(true);
  expect(result.facts.effect).toBe("none");
  expect(result.facts.rows[0]!.receipt).toBe("consumed");
  expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(0);
  task.release();
});

it("original lock admission failure maps closed busy via phase, NEVER error message or fake authority", async () => {
  const h = await r4Host(),
    f = r4Command(h),
    lock = await import("../../../src/memory/lock.js");
  const host = vi.spyOn(h.host, "actionLocked"),
    consume = vi.spyOn(f.kernel, "consume");
  vi.spyOn(lock, "withMemoryDirLock").mockRejectedValueOnce(
    Error("permission denied / pretend success / do not parse this"),
  );
  const result = await startCommandFlow({ ...f, choose: chooseApply }).done;
  expect(result).toMatchObject({
    ok: false,
    code: "E_RATE",
    retryable: false,
    facts: { effect: "none", rows: [], omitted: 0 },
  });
  expect(result.message).toContain("E_MEM_BUSY");
  expect(result.message).not.toContain("pretend success");
  expect(host).not.toHaveBeenCalled();
  expect(consume).not.toHaveBeenCalled();
});

it.each(["rewrite-single", "expires", "retire", "delete"] as const)(
  "original D/C owned %s → original kernel and E, no alternative store/applier",
  async (kind) => {
    const { fixture, action, host } = await import("./revision-e-helpers.js");
    const h = await fixture(),
      owned = kind === "rewrite-single" ? undefined : await action(h, kind);
    const x = await host(h, owned);
    const custody = new AbortController(),
      manager = {},
      owner = { incarnation: {}, sid: "r4-operations", sessionEpoch: 1, branchGen: 0 };
    const f = r4Command({
      dir: h.dir,
      custody,
      manager,
      owner,
      policyVersion: x.owned.proposal.policyVersion,
      // Minimal trusted host port still returns the ORIGINAL first D object after
      // real C/review publication. No fabricated result and no JSON rights.
      host: {
        actionLocked(mem, id) {
          expect(mem).toBe(h.dir);
          return x.deps.actionLocked(id);
        },
      },
    });
    const contextBefore = fs.readFileSync(h.contextPath),
      before = fs.readFileSync(h.targetPath);
    const consume = vi.spyOn(f.kernel, "consume"),
      generate = vi.spyOn(h.client, "generateRevision");
    const task = startCommandFlow({ ...f, choose: chooseApply });
    const result = await task.done;
    expect(result.facts).toMatchObject({
      effect: "completed",
      rows: [{ operation: kind, receipt: "consumed", data: "applied", outcome: "completed", stage: "finalize" }],
    });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(fs.readFileSync(h.contextPath)).toEqual(contextBefore);
    if (kind === "delete") expect(fs.existsSync(h.targetPath)).toBe(false);
    else expect(fs.readFileSync(h.targetPath).equals(before)).toBe(false);
    expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
    task.release();
    f.kernel.dispose();
  },
);

it("user delete has NO apply menu or direct API escape despite original LIVE frozen bytes", async () => {
  const { fixture, action, host } = await import("./revision-e-helpers.js");
  const h = await fixture(false, "user"),
    x = await host(h, await action(h, "delete"));
  const f = r4Command({
    dir: h.dir,
    custody: new AbortController(),
    manager: {},
    owner: { incarnation: {}, sid: "r4-user", sessionEpoch: 1, branchGen: 0 },
    policyVersion: x.owned.proposal.policyVersion,
    host: { actionLocked: (_mem, id) => x.deps.actionLocked(id) },
  });
  const before = fs.readFileSync(h.targetPath),
    { targets } = await f.domain.snapshot();
  expect(targets[0]!.live).toBe(false);
  const consume = vi.spyOn(f.kernel, "consume"),
    barrier = vi.spyOn(safeFs, "fsyncRevisionFile");
  await expect(f.domain.prepare(targets[0]!, "apply", 1)).rejects.toMatchObject({ code: "unavailable" });
  expect(consume).not.toHaveBeenCalled();
  expect(barrier).not.toHaveBeenCalled();
  expect(fs.readFileSync(h.targetPath)).toEqual(before);
});

it("synchronous gate owner-current revocation AFTER consume cannot write keep, even before signal dispatch", async () => {
  const h = await r4Host();
  h.host.reset("tree");
  const f = r4Command(h);
  let consumed = false,
    current = true;
  const consume = f.kernel.consume.bind(f.kernel);
  vi.spyOn(f.kernel, "consume").mockImplementation((...args) => {
    const ok = consume(...args);
    consumed = ok;
    return ok;
  });
  const domain = createRevisionWebCommand({
    ...f.deps,
    isCurrent: () => current,
    gate: {
      capture() {
        throw Error("forbidden");
      },
      check() {
        if (consumed) current = false;
        return { ok: true };
      },
    },
  });
  const result = await startCommandFlow({ ...f, domain, choose: chooseKeep }).done;
  expect(consumed).toBe(true);
  expect(result.facts.effect).toBe("none");
  expect(result.facts.rows[0]!.receipt).toBe("consumed");
  expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(0);
});

it("JSON cloned frozen input/DTO fields never grant LIVE or force E, even with unchanged proposal digest", async () => {
  const h = await r4Host(),
    p = h.rows()[0]!.revision!,
    f = r4Command(h);
  const original = await withMemoryDirLock(h.dir, () => h.host.actionLocked(h.dir, p.actionId));
  expect(original).toBeDefined();
  const dto = JSON.parse(JSON.stringify(original));
  const domain = createRevisionWebCommand({ ...f.deps, host: { actionLocked: () => dto } });
  const { targets } = await domain.snapshot();
  expect(targets[0]!.live).toBe(false);
  const consume = vi.spyOn(f.kernel, "consume"),
    data = vi.spyOn(safeFs, "replaceRevisionObserved");
  await expect(domain.prepare(targets[0]!, "apply", 1)).rejects.toMatchObject({ code: "unavailable" });
  expect(consume).not.toHaveBeenCalled();
  expect(data).not.toHaveBeenCalled();
});

it("foreign same-content command receipt and non-closed operation/step cannot enter keep", async () => {
  const h = await r4Host(),
    a = r4Command(h, { cmdId: "a" }),
    b = r4Command(h, { cmdId: "b" });
  const { targets } = await a.domain.snapshot(),
    target = targets[0]!;
  await expect(a.domain.prepare(target, "keep", 17)).rejects.toMatchObject({ code: "permission" });
  await expect(a.domain.prepare(target, "delete" as "keep", 1)).rejects.toMatchObject({ code: "permission" });
  const prepared = await a.domain.prepare(target, "keep", 1),
    plan = commandFlowConfirmationPlan(prepared.plan);
  const approval = await b.kernel.confirm(b.call, plan);
  if (!approval.approved) throw Error("real remote approval expected");
  expect(b.kernel.reserve(b.call, approval.receipt, plan)).toBe(true);
  const consume = vi.spyOn(a.kernel, "consume");
  expect(await prepared.execute(approval.receipt, plan, () => {})).toMatchObject({
    outcome: "rejected",
    receipt: "not-consumed",
  });
  expect(consume).not.toHaveBeenCalled();
  expect(readIndex(h.dir).index.review!.dismissed).toHaveLength(0);
});

it("C committed observation before done continuation is preserved as completed by cancel, not downgraded to unknown", async () => {
  const h = await r4Host(),
    f = r4Command(h),
    p = h.rows()[0]!.revision!;
  const sync = safeFs.fsyncDir;
  let queued = false;
  let task!: ReturnType<typeof startCommandFlow>, canceled: ReturnType<typeof task.cancel> | undefined;
  vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
    sync(dir);
    if (!queued) {
      const path = join(h.blocks, ".jev/revisions", p.batchId, p.actionId, "audit.json");
      const audit = JSON.parse(fs.readFileSync(path, "utf8"));
      if (audit.state === "committed") {
        queued = true;
        queueMicrotask(() => {
          canceled = task.cancel();
        });
      }
    }
  });
  task = startCommandFlow({ ...f, choose: chooseApply });
  const result = await task.done;
  expect(queued).toBe(true);
  expect(result).toBe(canceled);
  expect(result.facts).toMatchObject({
    effect: "completed",
    rows: [
      { outcome: "completed", receipt: "consumed", data: "applied", stage: "finalize", audit: "barrier-observed" },
    ],
  });
  expect(parseMemoryCommandFacts(result.message, "r4-command").kind).toBe("facts");
  task.release();
});

it("new explicit command querying a durable unknown fence does not mint fake observations or retry data", async () => {
  const h = await r4Host(),
    f = r4Command(h),
    p = h.rows()[0]!.revision!,
    rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === join(h.blocks, `${p.targetId}.md`)) throw Error("opaque data failure");
    rename(from, to);
  });
  const first = startCommandFlow({ ...f, choose: chooseApply });
  const result = await first.done;
  expect(result.facts.effect).toBe("unknown");
  first.release();
  vi.restoreAllMocks();
  const fresh = r4Command(h, { cmdId: "fresh-after-unknown" }),
    consume = vi.spyOn(fresh.kernel, "consume"),
    data = vi.spyOn(safeFs, "replaceRevisionObserved");
  const task = startCommandFlow({ ...fresh, choose: chooseApply });
  const second = await task.done;
  expect(second.facts).toMatchObject({
    effect: "unknown",
    rows: [{ receipt: "not-consumed", data: "not-called", outcome: "unknown" }],
  });
  expect(consume).not.toHaveBeenCalled();
  expect(data).not.toHaveBeenCalled();
  expect(second.retryable).toBe(false);
  expect(parseMemoryCommandFacts(second.message, "fresh-after-unknown").kind).toBe("facts");
  task.release();
});
