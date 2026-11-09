import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createRevisionAuditPort,
  revisionDirectoryIdentityDigest,
  restoreRevisionRaw,
  restoreRevisionRawLocked,
} from "../../../src/memory/govern/revision-audit.js";
import * as format from "../../../src/memory/blocks/format.js";
import * as store from "../../../src/memory/blocks/store.js";
import { replaceRevisionObserved, deleteRevisionObserved, writeTempRegular } from "../../../src/memory/safe-fs.js";
import type {
  FrozenRevisionInput,
  RevisionProposal,
  RevisionAuditDeps,
  ExpectedAfter,
  RevisionAudit,
} from "../../../src/memory/jev/contracts.js";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
const roots: string[] = [];
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
function raw(body: string, version: number, authority = "agent", extra = "") {
  return Buffer.from(
    `\uFEFF---\r\nkind: block\r\nauthority: ${authority}\r\n${authority === "user" ? "scope: global\r\n" : ""}status: active\r\n${extra}created: 2025-01-01\r\nupdated: 2025-01-01\r\nversion: ${version}\r\n---\r\n\r\n${body}\r\n`,
  );
}
function parsed(b: Buffer, id: string) {
  const p = format.parseBlockFile(`${id}.md`, b.toString());
  if ("stray" in p) throw Error("fixture");
  return p;
}
const deps: RevisionAuditDeps = { isCurrent: () => true, now: () => new Date("2026-11-10T00:00:00.000Z") };
function root() {
  const p = fs.mkdtempSync(join(tmpdir(), "revision-restore-"));
  roots.push(p);
  fs.mkdirSync(join(p, "blocks"), { mode: 0o700 });
  return p;
}
function fixture(
  mem = root(),
  targetId = "rules.001",
  action: "rewrite-single" | "delete" | "expires" | "retire" = "rewrite-single",
  d = deps,
  authority = "agent",
) {
  const before = raw("旧正文 café / 保留  空白", 2, authority),
    after =
      action === "retire" ? raw("after", 3, authority, "supersededBy: rules.099\r\n") : raw("after", 3, authority),
    st = fs.statSync(mem),
    b = parsed(before, targetId),
    identity = revisionDirectoryIdentityDigest(mem, st.dev, st.ino),
    batchId = hash("batch"),
    actionId = hash(targetId + action);
  fs.writeFileSync(join(mem, "blocks", `${targetId}.md`), before, { mode: 0o600 });
  const frozen: FrozenRevisionInput = {
    v: 1,
    directory: { realpath: mem, dev: st.dev, ino: st.ino, sessionEpoch: 1 },
    directoryIdentityDigest: identity,
    selectionBatchId: hash("selection"),
    batchId,
    actionId,
    policyVersion: "p50-v1",
    action,
    target: {
      id: targetId,
      rev: b.rev,
      rawBefore: before,
      rawDigest: hash(before),
      block: {
        id: targetId,
        rev: b.rev,
        topic: b.topic,
        authority: b.meta.authority,
        body: b.body,
        status: "active",
        private: false,
        secret: false,
        parseErrors: [],
      },
    },
  };
  if (action === "retire") {
    const cb = raw("survivor", 4, authority),
      cp = parsed(cb, "rules.099");
    fs.writeFileSync(join(mem, "blocks", "rules.099.md"), cb, { mode: 0o600 });
    (frozen as { context: FrozenRevisionInput["target"] }).context = {
      id: cp.id,
      rev: cp.rev,
      rawBefore: cb,
      rawDigest: hash(cb),
      block: {
        id: cp.id,
        rev: cp.rev,
        topic: cp.topic,
        authority: cp.meta.authority,
        body: cp.body,
        status: "active",
        private: false,
        secret: false,
        parseErrors: [],
      },
    };
  }
  const base = {
    v: 1 as const,
    batchId,
    actionId,
    targetId,
    expectedRev: b.rev,
    reason: "budget" as const,
    policyVersion: "p50-v1",
    directoryIdentityDigest: identity,
    evidenceBindings: {},
    autoEligible: false,
    ...(frozen.context ? { contextId: frozen.context.id, contextExpectedRev: frozen.context.rev } : {}),
  };
  const payload =
    action === "expires"
      ? { ...base, action, expiry: { op: "clear" as const, dateRuleVersion: "date-v1" } }
      : { ...base, action };
  const proposal = { ...payload, proposalDigest: hash(canonical(payload)) } as RevisionProposal;
  const port = createRevisionAuditPort(mem, d),
    path = join(mem, "blocks", ".jev", "revisions", batchId, actionId),
    target = join(mem, "blocks", `${targetId}.md`);
  const expected: ExpectedAfter =
    action === "delete"
      ? { kind: "missing" }
      : { kind: "file", raw: after, digest: hash(after), rev: parsed(after, targetId).rev };
  expect(port.persistPreparedBarrierLocked({ frozen, proposal, origin: "p50-suggestion" }).kind).toBe("ok");
  expect(
    port.persistExpectedAfterBarrierLocked({ batchId, actionId, proposalDigest: proposal.proposalDigest, expected })
      .kind,
  ).toBe("ok");
  const blocks = join(mem, "blocks");
  let observation;
  if (expected.kind === "file") {
    const t = writeTempRegular(blocks, `${targetId}.md`, expected.raw, 0o600);
    observation = replaceRevisionObserved(blocks, t, `${targetId}.md`, expected).observation;
  } else {
    const trash = join(blocks, ".trash");
    if (!fs.existsSync(trash)) fs.mkdirSync(trash, { mode: 0o700 });
    observation = deleteRevisionObserved(
      blocks,
      `${targetId}.md`,
      trash,
      `20261110T000000000Z-1-abcdef-${targetId}.md`,
      {
        digest: hash(before),
        rev: b.rev,
      },
    ).observation;
  }
  expect(
    port.finalizeCommitLocked({
      batchId,
      actionId,
      proposalDigest: proposal.proposalDigest,
      observation,
      dataDirectories: action === "delete" ? [blocks, join(blocks, ".trash")] : [blocks],
    }),
  ).toMatchObject({ kind: "committed" });
  return { mem, targetId, before, after, port, path, actionId, batchId, target, expected, frozen };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function audit(f: ReturnType<typeof fixture>): RevisionAudit {
  return JSON.parse(fs.readFileSync(join(f.path, "audit.json"), "utf8")) as RevisionAudit;
}
it.each([false, true])(
  "two independent single-file actions restore exact BOM/CRLF/version in reverse=%s",
  async (reverse) => {
    const mem = root(),
      a = fixture(mem, "rules.001"),
      b = fixture(mem, "rules.002"),
      serialize = vi.spyOn(format, "serializeBlock"),
      replace = vi.spyOn(store, "replaceBlockLocked");
    const actions = reverse ? [b, a] : [a, b];
    for (const [n, f] of actions.entries()) {
      expect(await restoreRevisionRaw(mem, { actionId: f.actionId }, deps)).toEqual({
        kind: "restored",
        actionId: f.actionId,
      });
      expect(fs.readFileSync(f.target)).toEqual(f.before);
      expect(parsed(fs.readFileSync(f.target), f.targetId).rev).toBe(f.frozen.target.rev);
      expect(audit(f).state).toBe("restored");
      const other = actions[1 - n]!;
      expect(fs.readFileSync(other.target)).toEqual(n === 0 ? other.after : other.before);
    }
    expect(serialize).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  },
);
it("committed user revision restores original authority/scope bytes without granting user-delete", () => {
  const f = fixture(undefined, undefined, "rewrite-single", deps, "user");
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toEqual({
    kind: "restored",
    actionId: f.actionId,
  });
  expect(fs.readFileSync(f.target)).toEqual(f.before);
  const del = fixture(undefined, undefined, "delete", deps, "user");
  expect(restoreRevisionRawLocked(del.mem, { actionId: del.actionId }, deps)).toEqual({
    kind: "refused",
    reason: "permission",
  });
  expect(fs.existsSync(del.target)).toBe(false);
});
it.each(["prepared", "proposed", "commit-unknown", "skipped", "failed", "restored"])(
  "ordinary restore refuses %s without data syscalls",
  (state) => {
    const f = fixture(),
      p = join(f.path, "audit.json"),
      a = audit(f);
    fs.writeFileSync(
      p,
      JSON.stringify({
        ...a,
        state,
        ...(state === "prepared" ? { expectedAfter: undefined, commitObservation: undefined } : {}),
        ...(state === "skipped" ? { commitObservation: { kind: "not-applied" } } : {}),
      }),
    );
    if (state === "prepared") fs.unlinkSync(join(f.path, "after.md"));
    const rename = vi.spyOn(fs, "renameSync"),
      link = vi.spyOn(fs, "linkSync");
    expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toEqual({
      kind: "refused",
      reason: "state",
    });
    expect(rename).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.target)).toEqual(f.after);
  },
);
it.each(["changed", "missing", "same-rev-different-raw"])(
  "raw+rev CAS rejects %s without intent or data writes",
  (mode) => {
    const f = fixture();
    if (mode === "missing") fs.unlinkSync(f.target);
    else
      fs.writeFileSync(f.target, mode === "changed" ? raw("user edit", 9) : Buffer.concat([f.after, Buffer.from(" ")]));
    const bytes = fs.existsSync(f.target) ? fs.readFileSync(f.target) : undefined,
      rename = vi.spyOn(fs, "renameSync");
    expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toEqual({
      kind: "refused",
      reason: "stale",
    });
    expect(rename).not.toHaveBeenCalled();
    expect(audit(f).restoreAttempt).toBeUndefined();
    if (bytes) expect(fs.readFileSync(f.target)).toEqual(bytes);
  },
);
it("delete restores with strict link and leaves trash evidence alone", () => {
  const f = fixture(undefined, undefined, "delete"),
    rename = vi.spyOn(fs, "renameSync"),
    link = vi.spyOn(fs, "linkSync");
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toEqual({
    kind: "restored",
    actionId: f.actionId,
  });
  expect(fs.readFileSync(f.target)).toEqual(f.before);
  expect(link).toHaveBeenCalledTimes(1);
  expect(rename.mock.calls.filter(([, to]) => String(to) === f.target)).toHaveLength(0);
  expect(fs.readFileSync(join(f.mem, "blocks", ".trash", `20261110T000000000Z-1-abcdef-${f.targetId}.md`))).toEqual(
    f.before,
  );
});
it.each(["gate-after-rename", "data-dir-fsync", "restored-audit-rename", "restored-audit-dir-fsync"])(
  "post-restore %s returns unknown, never compensates/reapplies",
  (fault) => {
    let allowed = true;
    const d = { ...deps, isCurrent: () => allowed },
      f = fixture(undefined, undefined, "rewrite-single", d),
      renameActual = fs.renameSync,
      fsyncActual = fs.fsyncSync;
    let applied = 0,
      restoredRename = false;
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      if (String(b) === join(f.path, "audit.json")) {
        const candidate = JSON.parse(fs.readFileSync(a, "utf8"));
        if (candidate.state === "restored") {
          if (fault === "restored-audit-rename") throw Error("audit fault");
          restoredRename = true;
        }
      }
      renameActual(a, b);
      if (String(b) === f.target) {
        applied++;
        if (fault === "gate-after-rename") allowed = false;
      }
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (
        fs.fstatSync(fd).isDirectory() &&
        ((fault === "data-dir-fsync" && applied > 0) || (fault === "restored-audit-dir-fsync" && restoredRename))
      )
        throw Error("fsync fault");
      fsyncActual(fd);
    });
    expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, d)).toMatchObject({
      kind: "effect-unknown",
      dataApplied: true,
    });
    expect(applied).toBe(1);
    expect(fs.readFileSync(f.target)).toEqual(f.before);
    allowed = true;
    vi.restoreAllMocks();
    const rename = vi.spyOn(fs, "renameSync"),
      link = vi.spyOn(fs, "linkSync");
    expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, d)).toEqual({ kind: "refused", reason: "state" });
    expect(rename).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.target)).toEqual(f.before);
    expect(audit(f).state).toBe(fault === "restored-audit-dir-fsync" ? "restored" : "committed");
  },
);
it.each(["intent-rename", "intent-file-fsync", "intent-dir-fsync"])(
  "restore %s failure is unknown before zero data CAS",
  (fault) => {
    const f = fixture(),
      renameActual = fs.renameSync,
      fsyncActual = fs.fsyncSync;
    let body = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      if (String(b) === f.target) body++;
      if (fault === "intent-rename") throw Error("intent rename");
      renameActual(a, b);
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fault === (fs.fstatSync(fd).isDirectory() ? "intent-dir-fsync" : "intent-file-fsync"))
        throw Error("intent fsync");
      fsyncActual(fd);
    });
    expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toMatchObject({
      kind: "effect-unknown",
      dataApplied: "unknown",
    });
    expect(body).toBe(0);
    expect(fs.readFileSync(f.target)).toEqual(f.after);
  },
);
it("restore link-success unlink-failure persists unresolved observation, both names, zero retry", () => {
  const f = fixture(undefined, undefined, "delete"),
    unlinkActual = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
    if (String(p).includes(".rules.001.md.") && String(p).endsWith(".tmp")) throw Error("temp unlink");
    unlinkActual(p);
  });
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toMatchObject({
    kind: "effect-unknown",
    dataApplied: true,
  });
  expect(fs.readFileSync(f.target)).toEqual(f.before);
  expect(audit(f)).toMatchObject({
    state: "committed",
    restoreAttempt: {
      state: "effect-unknown",
      observation: { kind: "applied", proof: "link-observed", paths: expect.any(Array) },
    },
  });
  const paths = audit(f).restoreAttempt!.observation!;
  if (paths.kind !== "not-applied" && paths.paths)
    expect(fs.existsSync(join(f.mem, "blocks", paths.paths[0].name))).toBe(true);
  vi.restoreAllMocks();
  const link = vi.spyOn(fs, "linkSync");
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toEqual({ kind: "refused", reason: "state" });
  expect(link).not.toHaveBeenCalled();
});
it.each(["EEXIST", "EPERM", "ENOTSUP", "EXDEV"])(
  "restore create %s never uses rename fallback or overwrites",
  (code) => {
    const f = fixture(undefined, undefined, "delete"),
      rename = vi.spyOn(fs, "renameSync");
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      if (code === "EEXIST") fs.writeFileSync(f.target, "concurrent user");
      throw Object.assign(Error(code), { code });
    });
    expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toMatchObject({ kind: "effect-unknown" });
    expect(rename.mock.calls.filter(([, p]) => String(p) === f.target)).toHaveLength(0);
    if (code === "EEXIST") expect(fs.readFileSync(f.target, "utf8")).toBe("concurrent user");
    else expect(fs.existsSync(f.target)).toBe(false);
  },
);
it("last pre-syscall CAS/gate recheck after restore temp file fsync catches user edits", () => {
  const f = fixture(),
    actual = fs.fsyncSync;
  let edit = false;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    actual(fd);
    if (!fs.fstatSync(fd).isDirectory() && fs.readFileSync(`/proc/self/fd/${fd}`).equals(f.before)) {
      fs.writeFileSync(f.target, raw("new user edit", 99));
      edit = true;
    }
  });
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toMatchObject({
    kind: "effect-unknown",
    dataApplied: "unknown",
  });
  expect(edit).toBe(true);
  expect(fs.readFileSync(f.target)).toEqual(raw("new user edit", 99));
});
it("abort/gate/epoch/permissions/root inode/Hub/bad snapshot refuse and never chmod or follow", () => {
  const f = fixture(),
    rename = vi.spyOn(fs, "renameSync"),
    ac = new AbortController();
  ac.abort();
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId, signal: ac.signal }, deps)).toEqual({
    kind: "refused",
    reason: "gate",
  });
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, { ...deps, isCurrent: () => false })).toEqual({
    kind: "refused",
    reason: "gate",
  });
  expect(
    restoreRevisionRawLocked(
      f.mem,
      { actionId: f.actionId },
      { ...deps, gate: { check: () => ({ ok: false, reason: "locked" }), capture: () => {} } },
    ),
  ).toEqual({ kind: "refused", reason: "gate" });
  fs.chmodSync(f.path, 0o755);
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toEqual({
    kind: "refused",
    reason: "permission",
  });
  expect(fs.statSync(f.path).mode & 0o777).toBe(0o755);
  fs.chmodSync(f.path, 0o700);
  const before = join(f.path, "before.md");
  fs.unlinkSync(before);
  fs.symlinkSync(f.target, before);
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps).kind).toBe("refused");
  expect(rename).not.toHaveBeenCalled();
});
it("duplicate actionId across batches refuses ambiguous without changing either audit", () => {
  const f = fixture(),
    batch = hash("another batch"),
    dir = join(f.path, "../..", batch, f.actionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const a = { ...audit(f), batchId: batch };
  for (const n of ["before.md", "after.md"]) fs.copyFileSync(join(f.path, n), join(dir, n));
  fs.writeFileSync(join(dir, "audit.json"), JSON.stringify(a), { mode: 0o600 });
  const rename = vi.spyOn(fs, "renameSync");
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toEqual({
    kind: "refused",
    reason: "ambiguous",
  });
  expect(rename).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.target)).toEqual(f.after);
});
it("absent revisions and invalid ids never create bookkeeping", async () => {
  const mem = root();
  expect(await restoreRevisionRaw(mem, { actionId: hash("absent") }, deps)).toEqual({
    kind: "refused",
    reason: "unavailable",
  });
  expect(fs.existsSync(join(mem, "blocks", ".jev"))).toBe(false);
  for (const actionId of ["../escape", "A".repeat(64), "x"]) {
    expect(restoreRevisionRawLocked(mem, { actionId }, deps)).toEqual({ kind: "refused", reason: "corrupted" });
  }
});
it.each(["expires", "retire"] as const)(
  "%s committed metadata action restores exact original bytes without store serialization",
  (action) => {
    const f = fixture(undefined, undefined, action),
      serialize = vi.spyOn(format, "serializeBlock"),
      replace = vi.spyOn(store, "replaceBlockLocked");
    expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toEqual({
      kind: "restored",
      actionId: f.actionId,
    });
    expect(fs.readFileSync(f.target)).toEqual(f.before);
    expect(serialize).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  },
);
it("directory identity swap at the final restore boundary prevents data syscall", () => {
  const f = fixture(),
    actualFsync = fs.fsyncSync;
  let swapped = false;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    actualFsync(fd);
    if (!swapped && !fs.fstatSync(fd).isDirectory() && fs.readFileSync(`/proc/self/fd/${fd}`).equals(f.before)) {
      swapped = true;
      fs.renameSync(join(f.mem, "blocks"), join(f.mem, "original-blocks"));
      fs.mkdirSync(join(f.mem, "blocks"), { mode: 0o700 });
      fs.writeFileSync(f.target, "replacement directory user data");
    }
  });
  expect(restoreRevisionRawLocked(f.mem, { actionId: f.actionId }, deps)).toMatchObject({
    kind: "effect-unknown",
    dataApplied: "unknown",
  });
  expect(swapped).toBe(true);
  expect(fs.readFileSync(f.target, "utf8")).toBe("replacement directory user data");
  expect(fs.readFileSync(join(f.mem, "original-blocks", `${f.targetId}.md`))).toEqual(f.after);
});
