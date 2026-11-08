import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync, renameSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandConfirmKernel } from "../../../src/memory/command-confirm.js";
import { executeConfirmedMemoryWrite } from "../../../src/memory/command.js";
import type { AskUserRemotePort, RemoteOutcome } from "../../../src/ask-user/remote.js";
import { createSessionMemoryStore } from "../../../src/memory/scopes/session-store.js";
import { SESSION_MEMORY_ENTRY_TYPE, type MemoryOwner } from "../../../src/memory/scopes/types.js";
import { createSessionPoisonRegistry } from "../../../src/memory/scopes/session-poison.js";

const stamp = "2026-11-07T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function harness(
  kind: "fork" | "spawn",
  snapshot: boolean,
  withFile = false,
  monotonicNow?: () => number,
  queueLimit?: number,
) {
  const dir = mkdtempSync(join(tmpdir(), "mem-web-"));
  dirs.push(dir);
  const file = withFile ? join(dir, "session.jsonl") : undefined;
  if (file) writeFileSync(file, "original\n");
  const owner: MemoryOwner = {
    incarnation: {},
    sid: "writer",
    sessionEpoch: 1,
    branchGen: 1,
    ...(file ? { sessionFile: file } : {}),
  };
  const manager = {};
  const item = {
    id: "n1",
    text: "inherited body",
    authority: "user",
    created: stamp,
    updated: stamp,
    originSid: "parent",
    from: "session:n1",
    grant: { via: "command" },
  };
  const wrapped = (data: unknown) => ({ type: "custom", customType: SESSION_MEMORY_ENTRY_TYPE, data });
  const branch: unknown[] =
    kind === "fork"
      ? [wrapped({ v: 1, sid: "parent", op: "put", item })]
      : [
          wrapped({
            v: 1,
            sid: "writer",
            op: "snap",
            items: [item],
            nextN: 2,
            inherit: { kind: "spawn", fromSid: "parent", fromLeaf: "leaf-1", frozenAt: stamp },
          }),
        ];
  // Put the original inherited item back into the base if needed; 31 operations after a base snap.
  if (snapshot) {
    if (kind === "fork") {
      // A snap by the parent produces fork inheritance, followed by 31 tolerated no-op deletions.
      branch.splice(0, branch.length, wrapped({ v: 1, sid: "parent", op: "snap", items: [item], nextN: 2 }));
    }
    for (let i = 0; i < 31; i++) branch.push(wrapped({ v: 1, sid: "parent", op: "del", id: "n0" }));
  }
  let answerRemote: ((outcome: RemoteOutcome) => boolean) | undefined;
  let affirm = "";
  const remote: AskUserRemotePort = {
    open(request) {
      affirm = request.questions[0]!.options[1]!.label;
      return {
        setOnRemote(callback) {
          answerRemote = callback;
        },
        close() {},
      };
    },
  };
  const kernel = createCommandConfirmKernel({
    channel: { kind: "web", remote },
    isOwnerCurrent: () => true,
  });
  const consume = vi.spyOn(kernel, "consume");
  const append = vi.fn((type: string, data: unknown) => branch.push({ type: "custom", customType: type, data }));
  const getBranch = vi.fn(() => branch);
  const store = createSessionMemoryStore({
    currentOwner: () => owner,
    isLocked: () => false,
    getBranch,
    getSessionId: () => owner.sid,
    getSessionFile: () => file,
    getManager: () => manager,
    appendCustomEntry: append,
    now: () => stamp,
    webConfirm: () => kernel,
    poisonRegistry: createSessionPoisonRegistry(),
    stableSessionIdentity: () => dir,
    ...(monotonicNow ? { monotonicNow } : {}),
    ...(queueLimit !== undefined ? { queueLimit } : {}),
  });
  const controller = new AbortController();
  const call = kernel.start("session add new body", {
    cmdId: "id",
    commandOwner: "activation",
    operationGeneration: 1,
    owner,
    manager,
    deadline: Date.now() + 60000,
    signal: controller.signal,
    current: () => true,
  })!;
  async function prepare(reserve = true) {
    const prepared = await store.prepareWebAdd(call, {
      kind: "session.add",
      rawArgs: "session add new body",
      text: "new body",
    });
    if (!prepared.ok) throw Error(prepared.code);
    const pending = kernel.confirm(call, prepared.plan.commandPlan);
    expect(
      answerRemote?.({ kind: "answer", answers: { MEMCMD: affirm }, origin: "test", originKind: "loopback" }),
    ).toBe(true);
    const answer = await pending;
    if (!answer.approved) throw Error(answer.code);
    if (reserve) expect(kernel.reserve(call, answer.receipt, prepared.plan.commandPlan)).toBe(true);
    return { plan: prepared.plan, receipt: answer.receipt };
  }
  return {
    owner,
    manager,
    branch,
    item,
    file,
    store,
    kernel,
    call,
    append,
    consume,
    prepare,
    wrapped,
    getBranch,
    answer: () =>
      answerRemote?.({ kind: "answer", answers: { MEMCMD: affirm }, origin: "test", originKind: "loopback" }),
  };
}

describe("confirmed session Web consumer, real fold and planner", () => {
  it("revokes the real receipt on the command gate's changed plan without releasing the store observation", async () => {
    const h = harness("fork", false, true);
    const { plan, receipt } = await h.prepare();
    expect(h.kernel.check(h.call, receipt, plan.commandPlan)).toBe(true);
    const result = await executeConfirmedMemoryWrite(
      h.call,
      { kind: "session.add", rawArgs: "session add altered", text: "altered" },
      plan,
      receipt,
      { kernel: h.kernel, currentOwnerMatches: () => true, store: h.store },
    );
    expect(result).toMatchObject({ ok: false, code: "E_MEM_PLAN_CHANGED", effect: "none" });
    expect(h.kernel.check(h.call, receipt, plan.commandPlan)).toBe(false);
    expect(h.kernel.reserve(h.call, receipt, plan.commandPlan)).toBe(false);
    expect(h.kernel.consume(h.call, receipt, plan.commandPlan)).toBe(false);
    expect(h.answer()).toBe(false);
    expect(h.append).not.toHaveBeenCalled();
    expect(h.store.ownsWebPlan(h.call, plan)).toBe(true);
    expect(h.store.cancelWeb(h.call, "abort")).toMatchObject({ ok: false, effect: "none" });
    h.store.releaseWeb(h.call);
    expect(h.store.ownsWebPlan(h.call, plan)).toBe(false);
  });
  it("revokes the real receipt when the frozen plan belongs to a different store", async () => {
    const first = harness("fork", false);
    const second = harness("fork", false);
    const { plan, receipt } = await first.prepare();
    const result = await executeConfirmedMemoryWrite(
      first.call,
      { kind: "session.add", rawArgs: "session add new body", text: "new body" },
      plan,
      receipt,
      { kernel: first.kernel, currentOwnerMatches: () => true, store: second.store },
    );
    expect(result).toMatchObject({ ok: false, code: "E_MEM_PLAN_CHANGED", effect: "none" });
    expect(first.kernel.check(first.call, receipt, plan.commandPlan)).toBe(false);
    expect(first.kernel.reserve(first.call, receipt, plan.commandPlan)).toBe(false);
    expect(first.kernel.consume(first.call, receipt, plan.commandPlan)).toBe(false);
    expect(first.store.ownsWebPlan(first.call, plan)).toBe(true);
    expect(first.append).not.toHaveBeenCalled();
    expect(second.append).not.toHaveBeenCalled();
    first.store.releaseWeb(first.call);
  });
  it.each([
    ["fork", false, "fork inheritance + put"],
    ["spawn", false, "spawn inheritance + put"],
    ["fork", true, "fork inheritance + 32nd snapshot"],
    ["spawn", true, "spawn inheritance + 32nd snapshot"],
  ] as const)("%s snap=%s: %s", async (kind, snapshot) => {
    const h = harness(kind, snapshot);
    const before = h.store.fold();
    expect(before.items[0]?.inherited?.kind).toBe(kind);
    const { plan, receipt } = await h.prepare();
    expect(plan.entry.op).toBe(snapshot ? "snap" : "put");
    if (plan.entry.op === "snap") {
      expect(plan.entry.sid).toBe("writer");
      expect(plan.entry).not.toHaveProperty("inherit");
      expect(plan.affected).toEqual([
        { id: "n1", beforeRev: before.items[0]?.rev, afterRev: before.items[0]?.rev, change: "retained-in-snapshot" },
        { id: "n2", beforeRev: null, afterRev: expect.any(String), change: "create" },
      ]);
      expect(plan.commandPlan.presentation).toContain(h.item.text);
    }
    const outcome = await h.store.enqueueConfirmedCommand(h.call, plan, receipt);
    expect(outcome).toMatchObject({ ok: true, effect: "completed", id: "n2" });
    expect(h.append).toHaveBeenCalledTimes(1);
    expect(h.consume).toHaveBeenCalledTimes(1);
    const after = h.store.fold();
    expect(after.items[0]?.item).toEqual(h.item);
    expect(after.items[0]?.rev).toBe(before.items[0]?.rev);
    expect(after.opsSinceSnap).toBe(snapshot ? 0 : before.opsSinceSnap + 1);
    expect(after.items[1]?.item.text).toBe("new body");
    expect(after.items[0]?.inherited?.kind).toBe(snapshot ? undefined : kind);
    expect(h.store.cancelWeb(h.call, "abort")).toMatchObject({ ok: true, effect: "completed" });
  });
  it.each(["body", "revision", "nextN", "from", "originSid", "grant"] as const)(
    "rejects changed retained %s before consume",
    async (change) => {
      const h = harness("fork", false);
      const { plan, receipt } = await h.prepare();
      const frozenBefore = h.store.fold();
      if (change === "body")
        h.branch[0] = h.wrapped({ v: 1, sid: "parent", op: "put", item: { ...h.item, text: "changed" } });
      if (change === "revision")
        h.branch[0] = h.wrapped({
          v: 1,
          sid: "parent",
          op: "put",
          item: { ...h.item, updated: "2026-11-08T00:00:00.000Z" },
        });
      if (change === "nextN")
        h.branch.splice(
          0,
          1,
          h.wrapped({ v: 1, sid: "parent", op: "snap", items: [h.item], nextN: 90 }),
          h.wrapped({ v: 1, sid: "parent", op: "put", item: h.item }),
        );
      if (change === "from")
        h.branch[0] = h.wrapped({ v: 1, sid: "parent", op: "put", item: { ...h.item, from: "session:n2" } });
      if (change === "originSid")
        h.branch[0] = h.wrapped({ v: 1, sid: "parent", op: "put", item: { ...h.item, originSid: "another" } });
      if (change === "grant")
        h.branch[0] = h.wrapped({
          v: 1,
          sid: "parent",
          op: "put",
          item: { ...h.item, grant: { via: "dialog", turn: "12345678", cap: "01234567", channel: "web" } },
        });
      const changedFold = h.store.fold();
      expect(changedFold.dropped).toEqual([]);
      if (change === "nextN") {
        expect(changedFold.items.map(({ item, rev }) => ({ item, rev }))).toEqual(
          frozenBefore.items.map(({ item, rev }) => ({ item, rev })),
        );
        expect(changedFold.opsSinceSnap).toBe(frozenBefore.opsSinceSnap);
        expect(changedFold.nextN).not.toBe(frozenBefore.nextN);
      }
      expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
        ok: false,
        code: "E_MEM_PLAN_CHANGED",
        effect: "none",
      });
      expect(h.consume).not.toHaveBeenCalled();
      expect(h.append).not.toHaveBeenCalled();
    },
  );
  it("rejects a changed session file before consuming", async () => {
    const h = harness("fork", false, true);
    const { plan, receipt } = await h.prepare();
    writeFileSync(h.file!, "changed!\n");
    expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
      ok: false,
      code: "E_MEM_PLAN_CHANGED",
    });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it("rejects an unbound legacy call before reading the branch", async () => {
    const h = harness("fork", false);
    h.kernel.close(h.call);
    const legacy = h.kernel.start("session add new body")!;
    expect(
      await h.store.prepareWebAdd(legacy, { kind: "session.add", rawArgs: "session add new body", text: "new body" }),
    ).toMatchObject({ ok: false, code: "E_MEM_NEEDS_HUMAN_COMMAND" });
    expect(h.getBranch).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it("rejects a minted but unreserved receipt without appending", async () => {
    const h = harness("fork", false);
    const { plan, receipt } = await h.prepare(false);
    expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
      ok: false,
      code: "E_MEM_CONFIRM_STALE",
      effect: "none",
    });
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.append).not.toHaveBeenCalled();
  });
  it("rejects a cloned plan even when it has the same contents", async () => {
    const h = harness("fork", false);
    const { plan, receipt } = await h.prepare();
    const clone = { ...plan };
    expect(h.store.ownsWebPlan(h.call, clone)).toBe(false);
    expect(await h.store.enqueueConfirmedCommand(h.call, clone, receipt)).toMatchObject({
      ok: false,
      code: "E_MEM_PLAN_CHANGED",
    });
    expect(h.kernel.check(h.call, receipt, plan.commandPlan)).toBe(false);
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it("native writes can proceed between prepare and confirmation and invalidate the frozen plan", async () => {
    const h = harness("fork", false);
    const { plan, receipt } = await h.prepare();
    const native = await h.store.enqueue({
      owner: h.owner,
      operation: { storageScope: "session", op: "create", authority: "agent", text: "native" },
    });
    expect(native).toMatchObject({ ok: true, id: "n2" });
    expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
      ok: false,
      code: "E_MEM_PLAN_CHANGED",
    });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.append).toHaveBeenCalledTimes(1); // only native append
  });
  it("stores a busy outcome when the shared FIFO is full before commit", async () => {
    const h = harness("fork", false, false, undefined, 1);
    const { plan, receipt } = await h.prepare();
    const native = h.store.enqueue({
      owner: h.owner,
      operation: { storageScope: "session", op: "create", authority: "agent", text: "native" },
    });
    const result = h.store.enqueueConfirmedCommand(h.call, plan, receipt);
    expect(h.store.cancelWeb(h.call, "abort")).toMatchObject({ ok: false, code: "E_MEM_BUSY" });
    expect(await result).toMatchObject({ ok: false, code: "E_MEM_BUSY" });
    expect(await native).toMatchObject({ ok: true });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.append).toHaveBeenCalledTimes(1);
  });
  it("cancellation while the commit waits in the FIFO prevents consumption", async () => {
    const h = harness("fork", false);
    const { plan, receipt } = await h.prepare();
    const pending = h.store.enqueueConfirmedCommand(h.call, plan, receipt);
    expect(h.store.cancelWeb(h.call, "abort")).toMatchObject({ ok: false, effect: "none" });
    expect(await pending).toMatchObject({ ok: false, effect: "none" });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it("a reentrant cancel during append observes unknown, never a false none", async () => {
    const h = harness("fork", false);
    const { plan, receipt } = await h.prepare();
    let during: ReturnType<typeof h.store.cancelWeb> | undefined;
    h.append.mockImplementationOnce((type, data) => {
      during = h.store.cancelWeb(h.call, "abort");
      return h.branch.push({ type: "custom", customType: type, data });
    });
    expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
      ok: true,
      effect: "completed",
    });
    expect(during).toMatchObject({ ok: false, effect: "unknown", code: "E_PERSIST_UNKNOWN" });
    expect(h.append).toHaveBeenCalledTimes(1);
  });
  it("an append failure is unknown, poisons the writer and is retained for cancellation", async () => {
    const h = harness("fork", false);
    const { plan, receipt } = await h.prepare();
    h.append.mockImplementationOnce(() => {
      throw new Error("unknown append effect");
    });
    expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
      ok: false,
      effect: "unknown",
      code: "E_PERSIST_UNKNOWN",
    });
    expect(h.append).toHaveBeenCalledTimes(1);
    expect(h.store.poisonedNow()).toBe(true);
    expect(h.store.cancelWeb(h.call, "abort")).toMatchObject({ ok: false, effect: "unknown" });
  });
  it("refuses over 8MiB of entire JSONL before any receipt or append", async () => {
    const h = harness("fork", false, true);
    writeFileSync(h.file!, Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(
      await h.store.prepareWebAdd(h.call, { kind: "session.add", rawArgs: "session add new body", text: "new body" }),
    ).toMatchObject({ ok: false, code: "E_MEM_FILE_TOO_LARGE" });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it("100ms monotonic budget fails before consume", async () => {
    let ticks = 0;
    const h = harness("fork", false, false, () => (ticks++ === 0 ? 0 : 100));
    expect(
      await h.store.prepareWebAdd(h.call, { kind: "session.add", rawArgs: "session add new body", text: "new body" }),
    ).toMatchObject({ ok: false, code: "E_MEM_PLAN_BUDGET" });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it.each(["same-size-restore-mtime", "inode-replace", "symlink", "absent-to-present"] as const)(
    "refuses file race %s",
    async (race) => {
      const h = harness("fork", false, true);
      if (race === "absent-to-present") unlinkSync(h.file!);
      const { plan, receipt } = await h.prepare();
      if (race === "same-size-restore-mtime") {
        const stat = statSync(h.file!);
        writeFileSync(h.file!, "modified\n");
        utimesSync(h.file!, stat.atime, stat.mtime);
      } else if (race === "inode-replace") {
        writeFileSync(`${h.file!}.new`, "original\n");
        renameSync(`${h.file!}.new`, h.file!);
      } else if (race === "symlink") {
        unlinkSync(h.file!);
        symlinkSync("/dev/null", h.file!);
      } else writeFileSync(h.file!, "new\n");
      expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
        ok: false,
        effect: "none",
        code: "E_MEM_PLAN_CHANGED",
      });
      expect(h.consume).not.toHaveBeenCalled();
      expect(h.append).not.toHaveBeenCalled();
    },
  );
  it("ignores only derived inherited identity while preserving the actual item", async () => {
    const h = harness("fork", false);
    const { plan, receipt } = await h.prepare();
    // Same stored item, revision, order, nextN and ops count; only entry writer differs.
    h.branch[0] = h.wrapped({ v: 1, sid: "writer", op: "put", item: h.item });
    expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
      ok: true,
      effect: "completed",
    });
    expect(h.append).toHaveBeenCalledTimes(1);
  });
  it("accepts an exact 8MiB whole file without truncation", async () => {
    const h = harness("fork", false, true, () => 0);
    writeFileSync(h.file!, Buffer.alloc(8 * 1024 * 1024));
    const { plan, receipt } = await h.prepare();
    expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({ ok: true });
    expect(h.append).toHaveBeenCalledTimes(1);
  });
  it("checks the commit budget again after the confirmation gap", async () => {
    let commit = false;
    let counter = 0;
    const h = harness("fork", false, false, () => (commit ? (counter++ === 0 ? 0 : 100) : 0));
    const { plan, receipt } = await h.prepare();
    commit = true;
    expect(await h.store.enqueueConfirmedCommand(h.call, plan, receipt)).toMatchObject({
      ok: false,
      code: "E_MEM_PLAN_BUDGET",
      effect: "none",
    });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it("returns the completed observation when cancel arrives after sync append but before promise continuation", async () => {
    const h = harness("fork", false);
    const { plan, receipt } = await h.prepare();
    const pending = h.store.enqueueConfirmedCommand(h.call, plan, receipt);
    await Promise.resolve(); // run the FIFO's synchronous critical section, not the caller's continuation
    expect(h.store.cancelWeb(h.call, "abort")).toMatchObject({ ok: true, effect: "completed" });
    expect(await pending).toMatchObject({ ok: true, effect: "completed" });
    expect(h.append).toHaveBeenCalledTimes(1);
  });
});
