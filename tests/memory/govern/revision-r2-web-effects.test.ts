/** R2 E web ordering/observations. Real C barriers and real own-temp applier;
 * only individual syscall faults/owner lease cancellation are injected. */
import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fixture, action, host } from "./revision-e-helpers.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { commitAction, type RevisionCommitObservation } from "../../../src/memory/govern/revision-commit.js";
import * as application from "../../../src/memory/govern/revision-applier.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));

function effectSpies() {
  return {
    file: vi.spyOn(safeFs, "fsyncRevisionFile"),
    dir: vi.spyOn(safeFs, "fsyncDir"),
    temp: vi.spyOn(safeFs, "writeTempRegular"),
    applier: vi.spyOn(safeFs, "replaceRevisionObserved"),
    remove: vi.spyOn(safeFs, "deleteRevisionObserved"),
  };
}
function zeroEffects(spies: ReturnType<typeof effectSpies>) {
  for (const spy of Object.values(spies)) expect(spy).toHaveBeenCalledTimes(0);
}

it.each(["decline", "lease", "raw", "review", "gate"] as const)(
  "web %s refusal: zero NEW C mutation/fsync/applier, no postconsume observer",
  async (phase) => {
    const h = await fixture(),
      x = await host(h),
      observe = vi.fn();
    if (phase === "decline") x.state.confirmed = false;
    if (phase === "lease") x.state.lease = false;
    if (phase === "gate") h.state.current = false;
    if (phase === "raw") fs.writeFileSync(h.targetPath, h.raw("Changed original."));
    if (phase === "review") {
      const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
      index.review.suggestions = [];
      fs.writeFileSync(h.indexPath, JSON.stringify(index));
    }
    const spies = effectSpies();
    expect(
      await commitAction(h.dir, x.request("web-b3"), { ...x.deps, observeConfirmedLocked: observe }),
    ).toMatchObject({ kind: "skipped" });
    zeroEffects(spies);
    expect(observe).not.toHaveBeenCalled();
    expect(x.confirm).toHaveBeenCalledTimes(phase === "decline" ? 1 : 0);
  },
);

it("user delete hard prohibition precedes receipt and all NEW barrier I/O", async () => {
  const h = await fixture(false, "user"),
    o = await action(h, "delete"),
    x = await host(h, o);
  const before = fs.readFileSync(h.targetPath),
    spies = effectSpies();
  expect(await x.commit("web-b3")).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(x.confirm).not.toHaveBeenCalled();
  zeroEffects(spies);
  expect(fs.readFileSync(h.targetPath)).toEqual(before);
});

it("pure prepare and persisted two-action batch limit precede third web consume/barriers", async () => {
  const h = await fixture();
  fs.writeFileSync(join(h.blocks, "rules.003.md"), h.raw("Keep third rule."), { mode: 0o600 });
  const actions = ["rules.001", "rules.002", "rules.003"].map((id) => {
    const b = parseBlockFile(`${id}.md`, fs.readFileSync(join(h.blocks, `${id}.md`), "utf8"));
    if ("stray" in b) throw Error("test block");
    return { action: "expires" as const, target: { id, rev: b.rev } };
  });
  const owners = [];
  for (const a of actions) owners.push(await action(h, "expires", { targetId: a.target.id, actions }));
  const commits = [];
  for (const o of owners) commits.push(await host(h, o));
  expect(new Set(owners.map((o) => o.frozen.batchId)).size).toBe(1);
  expect(await commits[0]!.commit("web-b3")).toMatchObject({ kind: "committed" });
  expect(await commits[1]!.commit("web-b3")).toMatchObject({ kind: "committed" });
  const spies = effectSpies();
  expect(await commits[2]!.commit("web-b3")).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(commits[2]!.confirm).not.toHaveBeenCalled();
  zeroEffects(spies);
});

it("single consume under original lock precedes every real E barrier, applier and finalizer; scalar observations match C", async () => {
  const h = await fixture(),
    x = await host(h);
  const events: RevisionCommitObservation[] = [],
    order: string[] = [];
  const prepare = vi.spyOn(application, "prepareRevisionApplicationLocked");
  const confirm = x.deps.consumeConfirmedLocked!,
    sync = safeFs.fsyncRevisionFile,
    replace = safeFs.replaceRevisionObserved;
  let consumed = false;
  x.deps.consumeConfirmedLocked = (r, p) => {
    expect(fs.existsSync(join(h.dir, ".lock"))).toBe(true);
    expect(order).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1); // real pure serializer already complete
    consumed = true;
    order.push("consume");
    return confirm(r, p);
  };
  vi.spyOn(safeFs, "fsyncRevisionFile").mockImplementation((...args) => {
    expect(consumed).toBe(true);
    order.push(`sync:${args[1]}`);
    sync(...args);
  });
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    expect(consumed).toBe(true);
    order.push(args[0] === h.blocks ? "data" : "audit");
    return replace(...args);
  });
  const result = await commitAction(h.dir, x.request("web-b3"), {
    ...x.deps,
    observeConfirmedLocked: (event) => {
      expect(Object.isFrozen(event)).toBe(true);
      events.push(event);
    },
  });
  expect(result).toMatchObject({ kind: "committed" });
  expect(x.confirm).toHaveBeenCalledTimes(1);
  expect(order[0]).toBe("consume");
  expect(order.filter((s) => s === "data")).toHaveLength(1);
  expect(events.map((e) => [e.stage, e.audit, e.data, e.result ?? null])).toEqual([
    ["authorization", "not-entered", "not-called", null],
    ["prepared", "io-possible", "not-called", null],
    ["prepared", "barrier-observed", "not-called", null],
    ["expected-after", "io-possible", "not-called", null],
    ["expected-after", "barrier-observed", "not-called", null],
    ["data", "barrier-observed", "unknown", null],
    ["data", "barrier-observed", "applied", null],
    ["finalize", "io-possible", "applied", null],
    ["finalize", "barrier-observed", "applied", null],
    ["finalize", "barrier-observed", "applied", "committed"],
  ]);
  expect(events.every((e) => e.receipt === "consumed")).toBe(true);
  expect(await h.readAudit()).toMatchObject({
    kind: "ok",
    audit: {
      state: "committed",
      commitOrigin: "web-b3",
      commitObservation: { kind: "applied", proof: "rename-observed" },
    },
  });
});

it.each(["prepared-replay-sync", "expected-after-sync", "expected-after-audit"] as const)(
  "%s postconsume failure reports unknown audit possible + data not-called, never invokes applier",
  async (fault) => {
    const h = await fixture(),
      x = await host(h);
    const events: RevisionCommitObservation[] = [];
    const file = safeFs.fsyncRevisionFile,
      dir = safeFs.fsyncDir,
      rename = fs.renameSync;
    let afterWritten = false;
    vi.spyOn(safeFs, "fsyncRevisionFile").mockImplementation((...args) => {
      if (fault === "prepared-replay-sync") throw Error("replay fsync failed");
      file(...args);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      if (fault === "expected-after-audit" && afterWritten && String(args[1]).endsWith("/audit.json"))
        throw Error("proposed write failed");
      rename(...args);
      if (String(args[1]).endsWith("/after.md")) afterWritten = true;
    });
    vi.spyOn(safeFs, "fsyncDir").mockImplementation((d) => {
      if (fault === "expected-after-sync" && fs.existsSync(join(h.actionPath(), "after.md")))
        throw Error("expected directory barrier failed");
      dir(d);
    });
    const applier = vi.spyOn(safeFs, "replaceRevisionObserved");
    const result = await commitAction(h.dir, x.request("web-b3"), {
      ...x.deps,
      observeConfirmedLocked: (e) => events.push(e),
    });
    expect(result).toMatchObject({ kind: "effect-unknown", dataApplied: false });
    expect(x.confirm).toHaveBeenCalledTimes(1);
    expect(applier.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
    expect(events.at(-1)).toMatchObject({
      receipt: "consumed",
      audit: "io-possible",
      data: "not-called",
      result: "effect-unknown",
    });
    expect(events.some((e) => e.stage === "data")).toBe(false);
  },
);

it.each(["prepared", "expected-after", "data", "finalize"] as const)(
  "synchronous observer revocation before %s stops the next effect, preserving honest observations",
  async (stage) => {
    const h = await fixture(),
      x = await host(h),
      events: RevisionCommitObservation[] = [];
    const sync = vi.spyOn(safeFs, "fsyncRevisionFile"),
      replace = vi.spyOn(safeFs, "replaceRevisionObserved");
    let revoked = false;
    const result = await commitAction(h.dir, x.request("web-b3"), {
      ...x.deps,
      observeConfirmedLocked: (e) => {
        events.push(e);
        if (!revoked && e.stage === stage && (e.audit === "io-possible" || stage === "data")) {
          revoked = true;
          h.state.current = false;
        }
      },
    });
    expect(revoked).toBe(true);
    expect(x.confirm).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe(stage === "prepared" ? "skipped" : "effect-unknown");
    const dataCalls = replace.mock.calls.filter((c) => c[0] === h.blocks);
    expect(dataCalls).toHaveLength(stage === "finalize" ? 1 : 0);
    if (stage === "prepared") {
      expect(sync).not.toHaveBeenCalled();
      expect(events.at(-1)?.audit).toBe("not-entered");
    }
    if (stage !== "finalize") {
      expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
      expect(events.at(-1)?.data).toBe("not-called");
    } else {
      expect(fs.readFileSync(h.targetPath).equals(h.before)).toBe(false);
      expect(result).toMatchObject({ dataApplied: true });
      expect(events.at(-1)?.data).toBe("applied");
    }
  },
);

it("actual applied observation survives finalize failure; fresh replay never calls data again or upgrades unknown", async () => {
  const h = await fixture(),
    x = await host(h),
    events: RevisionCommitObservation[] = [];
  const rename = fs.renameSync;
  let applied = false,
    dataCalls = 0;
  const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (applied && String(to).endsWith("/audit.json")) throw Error("final audit write failed");
    rename(from, to);
    if (String(to) === h.targetPath) {
      applied = true;
      dataCalls++;
    }
  });
  const result = await commitAction(h.dir, x.request("web-b3"), {
    ...x.deps,
    observeConfirmedLocked: (e) => events.push(e),
  });
  expect(result).toMatchObject({ kind: "effect-unknown", dataApplied: true });
  expect(events.at(-1)).toMatchObject({
    stage: "finalize",
    data: "applied",
    audit: "io-possible",
    result: "effect-unknown",
  });
  expect(dataCalls).toBe(1);
  const bytes = fs.readFileSync(h.targetPath);
  renameSpy.mockRestore();
  expect(await x.commit("web-b3")).toMatchObject({ kind: "effect-unknown" });
  expect(fs.readFileSync(h.targetPath)).toEqual(bytes);
  expect(x.confirm).toHaveBeenCalledTimes(1);
});

it("p50-auto never invokes the web observer or confirmation and retains old order", async () => {
  const h = await fixture(),
    x = await host(h),
    observer = vi.fn();
  expect(await commitAction(h.dir, x.request(), { ...x.deps, observeConfirmedLocked: observer })).toMatchObject({
    kind: "committed",
  });
  expect(x.confirm).not.toHaveBeenCalled();
  expect(observer).not.toHaveBeenCalled();
});

it("consume callback synchronous revocation cannot enter first C barrier", async () => {
  const h = await fixture(),
    x = await host(h),
    spies = effectSpies();
  const confirm = x.deps.consumeConfirmedLocked!;
  const events: RevisionCommitObservation[] = [];
  expect(
    await commitAction(h.dir, x.request("web-b3"), {
      ...x.deps,
      consumeConfirmedLocked: (r, p) => {
        const ok = confirm(r, p);
        h.state.current = false;
        return ok;
      },
      observeConfirmedLocked: (e) => events.push(e),
    }),
  ).toMatchObject({ kind: "skipped", reason: "gate" });
  zeroEffects(spies);
  expect(x.confirm).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({
    receipt: "consumed",
    data: "not-called",
    audit: "not-entered",
    result: "skipped",
  });
});

it("async observer is not awaited and its rejected Promise cannot leak an unhandled rejection or authorize effects", async () => {
  const h = await fixture(),
    x = await host(h),
    spies = effectSpies();
  expect(
    await commitAction(h.dir, x.request("web-b3"), {
      ...x.deps,
      observeConfirmedLocked: async () => {
        throw Error("async hook forbidden");
      },
    }),
  ).toMatchObject({ kind: "skipped" });
  zeroEffects(spies);
  expect(x.confirm).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "opaque rename failure after-real-rename=%s stays data unknown, never inferred from current file",
  async (after) => {
    const h = await fixture(),
      x = await host(h),
      events: RevisionCommitObservation[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === h.targetPath) {
        if (after) rename(from, to);
        throw Object.assign(Error("opaque rename outcome"), { code: "EIO" });
      }
      rename(from, to);
    });
    expect(
      await commitAction(h.dir, x.request("web-b3"), { ...x.deps, observeConfirmedLocked: (e) => events.push(e) }),
    ).toMatchObject({ kind: "effect-unknown", dataApplied: "unknown" });
    expect(fs.readFileSync(h.targetPath).equals(h.before)).toBe(!after);
    expect(events.at(-1)).toMatchObject({ data: "unknown", result: "effect-unknown" });
    expect(events.some((e) => e.data === "applied")).toBe(false);
    expect(await h.readAudit()).toMatchObject({
      kind: "ok",
      audit: { state: "commit-unknown", commitObservation: { kind: "unknown" } },
    });
  },
);

it("actual no-link observation refines data unknown to not-applied, not a success inferred from audit", async () => {
  const h = await fixture(),
    o = await action(h, "delete"),
    x = await host(h, o);
  const events: RevisionCommitObservation[] = [],
    link = fs.linkSync;
  vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (String(from) === h.targetPath) throw Object.assign(Error("no hardlinks"), { code: "ENOTSUP" });
    link(from, to);
  });
  expect(
    await commitAction(h.dir, x.request("web-b3"), { ...x.deps, observeConfirmedLocked: (e) => events.push(e) }),
  ).toMatchObject({ kind: "skipped" });
  expect(events.filter((e) => e.stage === "data").map((e) => e.data)).toEqual(["unknown", "not-applied"]);
  expect(events.at(-1)).toMatchObject({ receipt: "consumed", data: "not-applied", result: "skipped" });
  expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  expect(fs.readdirSync(join(h.blocks, ".trash"))).toEqual([]);
});
