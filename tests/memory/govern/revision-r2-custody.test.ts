/** R2 component acceptance over real D/C/review/E and own temporary blocks.
 * Owner/command ports are local injected lifetimes; production I1 is separate. */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostFixture } from "./revision-host-helpers.js";
import { createRevisionHost, REVISION_HOST_CUSTODY_LIMITS } from "../../../src/memory/govern/revision-host.js";
import { commitAction, type RevisionCommitDeps } from "../../../src/memory/govern/revision-commit.js";
import { createRevisionAuditPort } from "../../../src/memory/govern/revision-audit.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import {
  freezeRevisionInputsLocked,
  revisionInputIsLiveLocked,
  revisionInputRetainedBytes,
} from "../../../src/memory/govern/revision.js";
import type { FrozenRevisionInput } from "../../../src/memory/jev/contracts.js";
import * as safeFs from "../../../src/memory/safe-fs.js";

const hosts: ReturnType<typeof createRevisionHost>[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  vi.restoreAllMocks();
});
async function liveHost(count = 2) {
  const h = await hostFixture(count);
  let owner: object = {},
    manager: object = {},
    ownerEpoch = 1;
  const lifetime = new AbortController();
  let tick = 0;
  const host = createRevisionHost({
    client: h.client,
    binding: () => h.binding,
    isCurrent: () => h.state.current,
    canAttempt: () => h.state.admit,
    autoEnabled: () => false,
    now: () => new Date(Date.parse("2026-11-10T00:00:00Z") + tick++),
    onAfterWrite: () => {
      throw Error("auto is off");
    },
    custody: () => ({
      owner,
      manager,
      epoch: ownerEpoch,
      signal: lifetime.signal,
      isCurrent: () => !lifetime.signal.aborted,
    }),
  });
  hosts.push(host);
  const batch = h.batch();
  const run = () => host.handle(batch, h.attempt);
  const rows = () => readIndex(h.dir).index.review?.suggestions.flatMap((s) => (s.revision ? [s.revision] : [])) ?? [];
  const get = (id: string) => withMemoryDirLock(h.dir, () => host.actionLocked(h.dir, id));
  return {
    ...h,
    host,
    batchValue: batch,
    run,
    rows,
    get,
    lifetime,
    replaceOwner: () => {
      owner = {};
    },
    replaceManager: () => {
      manager = {};
    },
    replaceEpoch: () => {
      ownerEpoch++;
    },
  };
}

it("first freeze uses owner custody, never attempt after settle; original object executes E under a NEW command lease", async () => {
  const h = await liveHost();
  const originalFreeze = vi.spyOn(await import("../../../src/memory/govern/revision.js"), "freezeRevisionInputsLocked");
  const oldAttempt = new AbortController();
  let generating = true;
  const result = await h.host.handle(h.batchValue, {
    ...h.attempt,
    signal: oldAttempt.signal,
    isCurrent: () => generating,
  });
  expect(result).toMatchObject({ kind: "settled", saved: 1, effects: 0 });
  const p = h.rows()[0]!;
  const original = originalFreeze.mock.results
    .map((r) => r.value as FrozenRevisionInput)
    .find((f) => f.actionId === p.actionId)!;
  expect(original).toBeDefined();
  const o = (await h.get(p.actionId))!;
  expect(o.frozen).toBe(original);
  generating = false;
  oldAttempt.abort();
  h.state.lease = false;
  expect((await h.get(p.actionId))?.frozen).toBe(original);
  expect(await withMemoryDirLock(h.dir, () => revisionInputIsLiveLocked(original))).toBe(true);
  expect(revisionInputRetainedBytes(original)).toBeGreaterThan(
    original.target.rawBefore.length + original.context!.rawBefore.length,
  );
  expect(JSON.stringify(original)).not.toContain("custody");
  expect(revisionInputIsLiveLocked(JSON.parse(JSON.stringify(original)) as FrozenRevisionInput)).toBe(false);
  const cmd = new AbortController();
  let newLease = true,
    consumed = 0;
  const deps: RevisionCommitDeps = {
    actionLocked: (id) => h.host.actionLocked(h.dir, id),
    runtime: () => ({
      plainMain: true,
      enabled: true,
      autoEnabled: false,
      sessionEpoch: 1,
      policyVersion: p.policyVersion,
      dateRuleVersion: "",
    }),
    signal: cmd.signal,
    isCurrent: () => !cmd.signal.aborted,
    leaseValid: () => newLease,
    now: () => new Date("2026-11-10T00:00:00Z"),
    consumeConfirmedLocked: () => {
      consumed++;
      return consumed === 1;
    },
  };
  const before = fs.readFileSync(join(h.blocks, `${p.targetId}.md`));
  const request = {
    origin: "web-b3" as const,
    actionId: p.actionId,
    expectedRev: p.expectedRev,
    proposalDigest: p.proposalDigest,
  };
  newLease = false;
  expect(await commitAction(h.dir, request, deps)).toMatchObject({ kind: "skipped", reason: "stale" });
  expect(consumed).toBe(0);
  newLease = true;
  expect(await commitAction(h.dir, request, deps)).toMatchObject({ kind: "committed" });
  expect(consumed).toBe(1);
  expect(fs.readFileSync(join(h.blocks, `${p.targetId}.md`)).equals(before)).toBe(false);
  expect(originalFreeze).toHaveBeenCalledTimes(3); // complete original menu, no refreeze/rebind for E
  expect(
    await withMemoryDirLock(h.dir, () =>
      createRevisionAuditPort(h.dir, { isCurrent: () => true, now: () => new Date() }).readActionLocked(
        p.batchId,
        p.actionId,
      ),
    ),
  ).toMatchObject({ kind: "ok", audit: { state: "committed" } });
});

it.each(["owner", "manager", "epoch", "signal", "abort", "session", "tree", "dispose"] as const)(
  "%s revokes original LIVE and published reference permanently, without clearing job fences",
  async (reason) => {
    const h = await liveHost();
    expect((await h.run()).saved).toBe(1);
    const p = h.rows()[0]!,
      original = (await h.get(p.actionId))!.frozen;
    if (reason === "owner") h.replaceOwner();
    else if (reason === "manager") h.replaceManager();
    else if (reason === "epoch") h.replaceEpoch();
    else if (reason === "signal") h.lifetime.abort();
    else if (reason === "dispose") h.host.dispose();
    else h.host.reset(reason);
    expect(await h.get(p.actionId)).toBeUndefined();
    expect(await withMemoryDirLock(h.dir, () => revisionInputIsLiveLocked(original))).toBe(false);
    if (reason !== "dispose") expect(h.host.inspect().jobs).toHaveLength(1);
    expect(h.rows()).toHaveLength(1); // history remains, no adoption or deletion
  },
);

it("reserve entire menu and full 128KiB slots before generation; capacity refuses without model/freeze/LRU/fence reset", async () => {
  const h = await liveHost();
  const freeze = vi.spyOn(await import("../../../src/memory/govern/revision.js"), "freezeRevisionInputsLocked");
  const generate = h.client.generateRevision.bind(h.client);
  vi.spyOn(h.client, "generateRevision").mockImplementation((req) => {
    expect(h.host.inspect().custody.reservedActions).toBe(3);
    expect(h.host.inspect().custody.reservedBytes).toBe(3 * 128 * 1024);
    return generate(req);
  });
  let first: FrozenRevisionInput | undefined;
  for (let n = 1; n <= 14; n++) {
    h.write("rules.001", `Keep budget and directory lock ${n}.`, "agent", n);
    const result = await h.host.handle(h.batch(), h.attempt);
    expect(result).toMatchObject({ kind: "settled", saved: 1 });
    const p = h.rows()[0]!;
    if (n === 1) first = (await h.get(p.actionId))!.frozen;
  }
  expect(h.host.inspect().custody).toMatchObject({ actions: 14, reservedActions: 0, reservedBytes: 0 });
  expect(h.host.inspect().custody.retainedBytes).toBeLessThan(REVISION_HOST_CUSTODY_LIMITS.totalBytes);
  const calls = h.calls.length,
    freezes = freeze.mock.calls.length;
  h.write("rules.001", "Keep budget and directory lock 15.", "agent", 15);
  expect(await h.host.handle(h.batch(), h.attempt)).toMatchObject({ kind: "cap-reached", reason: "capacity" });
  expect(h.calls).toHaveLength(calls);
  expect(freeze).toHaveBeenCalledTimes(freezes);
  expect(h.host.inspect().jobs).toHaveLength(14);
  expect(h.host.inspect().custody.actions).toBe(14);
  expect(first).toBeDefined();
});

it("failed C save leaves historical evidence but publishes nothing and releases the reservation", async () => {
  const h = await liveHost();
  const sync = safeFs.fsyncDir;
  vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
    if (dir.includes("/revisions/")) throw Error("barrier failure");
    sync(dir);
  });
  expect(await h.run()).toMatchObject({ kind: "cap-reached", reason: "blocked-job" });
  expect(h.host.inspect().custody).toEqual({ actions: 0, reservedActions: 0, retainedBytes: 0, reservedBytes: 0 });
  expect(h.rows()).toEqual([]);
  expect(fs.readdirSync(join(h.blocks, ".jev", "revisions"))).toHaveLength(1);
});

it("eight original directories retained; ninth refuses without discovery freeze or provider work", async () => {
  const h = await liveHost();
  const fixtures = await Promise.all(Array.from({ length: 8 }, () => hostFixture()));
  for (const f of [h, ...fixtures.slice(0, 7)])
    expect(await h.host.handle(f.batch(), f.attempt)).toMatchObject({ kind: "settled", saved: 1 });
  const calls = h.calls.length;
  expect(await h.host.handle(fixtures[7]!.batch(), fixtures[7]!.attempt)).toMatchObject({ reason: "capacity" });
  expect(h.calls).toHaveLength(calls);
  expect(h.host.inspect().custody.actions).toBe(8);
});

it("no custody preserves D's old attempt-bound LIVE; both lifetimes checked on first freeze", async () => {
  const h = await liveHost();
  const target = h.batchValue.corpus.candidates[0]!;
  const spec = {
    directory: h.batchValue.directory,
    selectionBatchId: "direct",
    policyVersion: "test",
    action: "expires" as const,
    target,
  };
  const attempt = new AbortController(),
    custody = new AbortController();
  const [legacy, owned] = await withMemoryDirLock(h.dir, () => [
    freezeRevisionInputsLocked(h.dir, spec, { signal: attempt.signal, isCurrent: () => !attempt.signal.aborted }),
    freezeRevisionInputsLocked(h.dir, spec, {
      signal: attempt.signal,
      isCurrent: () => !attempt.signal.aborted,
      custody: { signal: custody.signal, isCurrent: () => !custody.signal.aborted },
    }),
  ]);
  if (!legacy || !owned || "kind" in legacy || "kind" in owned) throw Error("freeze failed");
  attempt.abort();
  expect(revisionInputIsLiveLocked(legacy)).toBe(false);
  expect(revisionInputIsLiveLocked(owned)).toBe(true);
  const refused = await withMemoryDirLock(h.dir, () =>
    freezeRevisionInputsLocked(h.dir, spec, {
      signal: attempt.signal,
      isCurrent: () => false,
      custody: { signal: custody.signal, isCurrent: () => true },
    }),
  );
  expect(refused).toMatchObject({ kind: "refused" });
  custody.abort();
  expect(revisionInputIsLiveLocked(owned)).toBe(false);
});

it("aborted in-flight generation never publishes unpublished LIVE, and releases full reservation without refunding jobs", async () => {
  const h = await liveHost();
  const started: { resolve?: () => void } = {},
    released: { resolve?: () => void } = {};
  const entered = new Promise<void>((resolve) => {
    started.resolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    released.resolve = resolve;
  });
  const complete = h.registry.complete;
  vi.spyOn(h.registry, "complete").mockImplementation(async (...args) => {
    started.resolve!();
    await release;
    return complete(...args);
  });
  const controller = new AbortController();
  const pending = h.host.handle(h.batchValue, { ...h.attempt, signal: controller.signal });
  await entered;
  expect(h.host.inspect().custody.reservedActions).toBe(3);
  controller.abort();
  released.resolve!();
  expect(await pending).toMatchObject({ kind: "cap-reached", reason: "blocked-job" });
  expect(h.host.inspect().custody).toEqual({ actions: 0, reservedActions: 0, retainedBytes: 0, reservedBytes: 0 });
  expect(h.host.inspect().jobs).toHaveLength(1);
  expect(h.rows()).toEqual([]);
});

it("retire's scalar includes both private historical source raw copies in addition to target+context", async () => {
  const { setup } = await import("./revision-retire-helpers.js");
  const h = await setup();
  const base = await h.freezeRetire(false),
    source = await h.freezeRetire(true);
  const rawOnly = h.sourceFrozen.target.rawBefore.length + h.successorAfter.length;
  expect(revisionInputRetainedBytes(source) - revisionInputRetainedBytes(base)).toBeGreaterThan(rawOnly);
  expect(revisionInputRetainedBytes(source)).toBeLessThan(128 * 1024);
  const copy = source.context!.rawBefore;
  copy.fill(0);
  expect(revisionInputRetainedBytes(source)).toBeGreaterThan(0);
  expect(source.context!.rawBefore).toEqual(h.successorAfter);
});

it.each(["attempt", "custody"] as const)(
  "%s revocation during the first raw read refuses freeze despite the other lifetime staying alive",
  async (which) => {
    const h = await liveHost(),
      attempt = new AbortController(),
      custody = new AbortController();
    const read = safeFs.readRegularBytes;
    let readRaw = 0;
    vi.spyOn(safeFs, "readRegularBytes").mockImplementation((...args) => {
      const result = read(...args);
      if (args[0] === h.blocks && args[1].endsWith(".md")) {
        readRaw++;
        (which === "attempt" ? attempt : custody).abort();
      }
      return result;
    });
    const result = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: h.batchValue.directory,
          selectionBatchId: "during",
          policyVersion: "test",
          action: "expires",
          target: h.batchValue.corpus.candidates[0]!,
        },
        {
          signal: attempt.signal,
          isCurrent: () => !attempt.signal.aborted,
          custody: { signal: custody.signal, isCurrent: () => !custody.signal.aborted },
        },
      ),
    );
    expect(readRaw).toBeGreaterThan(0);
    expect(result).toMatchObject({ kind: "refused" });
    expect(which === "attempt" ? custody.signal.aborted : attempt.signal.aborted).toBe(false);
  },
);

it.each(
  (["raw", "gate"] as const).flatMap((boundary) =>
    (["attempt-signal", "attempt-current", "custody-signal", "custody-current"] as const).map((revocation) => ({
      boundary,
      revocation,
    })),
  ),
)(
  "last $boundary rejects $revocation during FIRST freeze, even with the other lifetime alive",
  async ({ boundary, revocation }) => {
    const h = await liveHost(1),
      attempt = new AbortController(),
      custody = new AbortController();
    let attemptCurrent = true,
      custodyCurrent = true,
      rawReads = 0,
      gates = 0,
      revoked = false;
    const revoke = () => {
      revoked = true;
      if (revocation === "attempt-signal") attempt.abort();
      else if (revocation === "attempt-current") attemptCurrent = false;
      else if (revocation === "custody-signal") custody.abort();
      else custodyCurrent = false;
    };
    const read = safeFs.readRegularBytes;
    vi.spyOn(safeFs, "readRegularBytes").mockImplementation((...args) => {
      const result = read(...args); // revoke AFTER the real, final raw read
      if (args[0] === h.blocks && args[1].endsWith(".md") && ++rawReads === 4 && boundary === "raw") revoke();
      return result;
    });
    const result = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: h.batchValue.directory,
          selectionBatchId: "tail",
          policyVersion: "test",
          action: "expires",
          target: h.batchValue.corpus.candidates[0]!,
        },
        {
          signal: attempt.signal,
          isCurrent: () => attemptCurrent,
          custody: { signal: custody.signal, isCurrent: () => custodyCurrent },
          gate: {
            capture: () => {
              throw Error("freeze must not capture/create a directory");
            },
            check: () => {
              if (++gates === 8 && boundary === "gate") {
                expect(rawReads).toBe(4); // the last LIVE tail gate, not an earlier refusal
                revoke();
              }
              return { ok: true };
            },
          },
        },
      ),
    );
    expect(revoked).toBe(true);
    expect(rawReads).toBe(4);
    if (boundary === "gate") expect(gates).toBe(8);
    expect(result).toMatchObject({ kind: "refused" });
    if (revocation.startsWith("attempt")) {
      expect(custody.signal.aborted).toBe(false);
      expect(custodyCurrent).toBe(true);
    } else {
      expect(attempt.signal.aborted).toBe(false);
      expect(attemptCurrent).toBe(true);
    }
    expect(h.calls).toEqual([]); // real D only, no provider or host downstream gate masking D's result
  },
);

it.each(["attempt", "custody"] as const)(
  "final attempt-current callback aborting %s but returning true cannot publish FIRST freeze",
  async (which) => {
    const h = await liveHost(1),
      attempt = new AbortController(),
      custody = new AbortController();
    let gates = 0,
      terminalChecks = 0;
    const result = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: h.batchValue.directory,
          selectionBatchId: "tail-current",
          policyVersion: "test",
          action: "expires",
          target: h.batchValue.corpus.candidates[0]!,
        },
        {
          signal: attempt.signal,
          isCurrent: () => {
            if (gates === 8) {
              terminalChecks++;
              (which === "attempt" ? attempt : custody).abort();
            }
            return true; // callback's pre-revocation answer must not hide the signal
          },
          custody: { signal: custody.signal, isCurrent: () => !custody.signal.aborted },
          gate: {
            capture: () => {
              throw Error("freeze must not capture/create a directory");
            },
            check: () => {
              gates++;
              return { ok: true };
            },
          },
        },
      ),
    );
    expect(gates).toBe(8); // no extra gate callback after the terminal attempt check
    expect(terminalChecks).toBe(1);
    expect(result).toMatchObject({ kind: "refused" });
    expect((which === "attempt" ? attempt : custody).signal.aborted).toBe(true);
    expect((which === "attempt" ? custody : attempt).signal.aborted).toBe(false);
  },
);
