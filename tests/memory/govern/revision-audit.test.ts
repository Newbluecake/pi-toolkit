import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createRevisionAuditPort,
  revisionDirectoryIdentityDigest,
  REVISION_SCAN_BATCH_LIMIT,
} from "../../../src/memory/govern/revision-audit.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { replaceRevisionObserved, deleteRevisionObserved, writeTempRegular } from "../../../src/memory/safe-fs.js";
import type {
  FrozenRevisionInput,
  RevisionProposal,
  RevisionAuditDeps,
  ExpectedAfter,
  RevisionAuditPort,
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
const raw = (body = "old", version = 7, extra = "") =>
  Buffer.from(
    `\uFEFF---\r\nkind: block\r\nauthority: agent\r\nstatus: active\r\n${extra}created: 2026-01-01\r\nupdated: 2026-01-01\r\nversion: ${version}\r\n---\r\n\r\n${body}\r\n`,
  );
const parsed = (b: Buffer, id = "rules.001") => {
  const p = parseBlockFile(`${id}.md`, b.toString());
  if ("stray" in p) throw Error("fixture");
  return p;
};
const deps: RevisionAuditDeps = { isCurrent: () => true, now: () => new Date("2026-11-10T00:00:00.000Z") };
function setup(action: RevisionProposal["action"] = "rewrite-single", d = deps) {
  const mem = fs.mkdtempSync(join(tmpdir(), "revision-audit-"));
  roots.push(mem);
  fs.mkdirSync(join(mem, "blocks"), { mode: 0o700 });
  const before = raw("旧正文 café"),
    after = raw("new body", 8),
    st = fs.statSync(mem),
    target = parsed(before);
  fs.writeFileSync(join(mem, "blocks", "rules.001.md"), before, { mode: 0o600 });
  const identity = revisionDirectoryIdentityDigest(mem, st.dev, st.ino),
    batchId = hash("batch"),
    actionId = hash("action");
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
      id: target.id,
      rev: target.rev,
      rawBefore: before,
      rawDigest: hash(before),
      block: {
        id: target.id,
        rev: target.rev,
        topic: target.topic,
        authority: "agent",
        body: target.body,
        status: "active",
        private: false,
        secret: false,
        parseErrors: [],
      },
    },
  };
  const base = {
    v: 1 as const,
    batchId,
    actionId,
    targetId: target.id,
    expectedRev: target.rev,
    reason: "budget" as const,
    policyVersion: "p50-v1",
    directoryIdentityDigest: identity,
    evidenceBindings: {},
    autoEligible: false,
  };
  const payload =
    action === "expires"
      ? { ...base, action, expiry: { op: "clear" as const, dateRuleVersion: "date-v1" } }
      : { ...base, action };
  const proposal = { ...payload, proposalDigest: hash(canonical(payload)) } as RevisionProposal;
  const port = createRevisionAuditPort(mem, d),
    path = join(mem, "blocks", ".jev", "revisions", batchId, actionId);
  const expected: ExpectedAfter =
    action === "delete"
      ? { kind: "missing" }
      : { kind: "file", raw: after, digest: hash(after), rev: parsed(after).rev };
  return { mem, before, after, frozen, proposal, port, path, expected };
}
type Fixture = ReturnType<typeof setup>;
function prepare(f: Fixture) {
  return f.port.persistPreparedBarrierLocked({ frozen: f.frozen, proposal: f.proposal, origin: "p50-suggestion" });
}
function propose(f: Fixture) {
  expect(prepare(f).kind).toBe("ok");
  return f.port.persistExpectedAfterBarrierLocked({
    batchId: f.frozen.batchId,
    actionId: f.frozen.actionId,
    proposalDigest: f.proposal.proposalDigest,
    expected: f.expected,
  });
}
function read(f: Fixture) {
  return f.port.readActionLocked(f.frozen.batchId, f.frozen.actionId);
}
function apply(f: Fixture) {
  const blocks = join(f.mem, "blocks");
  if (f.expected.kind === "file") {
    const t = writeTempRegular(blocks, "rules.001.md", f.expected.raw, 0o600);
    return replaceRevisionObserved(blocks, t, "rules.001.md", f.expected).observation;
  }
  const trash = join(blocks, ".trash");
  fs.mkdirSync(trash, { mode: 0o700 });
  return deleteRevisionObserved(blocks, "rules.001.md", trash, "20261110T000000000Z-1-abcdef-rules.001.md", {
    digest: hash(f.before),
    rev: f.frozen.target.rev,
  }).observation;
}
function finish(f: Fixture, observation = apply(f)) {
  return f.port.finalizeCommitLocked({
    batchId: f.frozen.batchId,
    actionId: f.frozen.actionId,
    proposalDigest: f.proposal.proposalDigest,
    observation,
    dataDirectories:
      f.expected.kind === "missing"
        ? [join(f.mem, "blocks"), join(f.mem, "blocks", ".trash")]
        : [join(f.mem, "blocks")],
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
it("writes two durable raw barriers, idempotently replays without replacing snapshots, and copies custody", () => {
  const f = setup();
  expect(prepare(f).kind).toBe("ok");
  expect(fs.readFileSync(join(f.path, "before.md"))).toEqual(f.before);
  expect(fs.existsSync(join(f.path, "after.md"))).toBe(false);
  const ino = fs.statSync(join(f.path, "before.md")).ino;
  expect(prepare(f).kind).toBe("ok");
  expect(fs.statSync(join(f.path, "before.md")).ino).toBe(ino);
  const r = read(f);
  expect(r.kind).toBe("ok");
  if (r.kind === "ok") {
    r.before.fill(0);
    (r.audit as { state: string }).state = "failed";
  }
  expect(read(f)).toMatchObject({ kind: "ok", audit: { state: "prepared" }, before: f.before });
  expect(propose(f).kind).toBe("ok");
  const afterRead = read(f);
  if (afterRead.kind === "ok" && afterRead.expectedAfter?.kind === "file") afterRead.expectedAfter.raw.fill(0);
  expect(read(f)).toMatchObject({
    kind: "ok",
    audit: { state: "proposed" },
    expectedAfter: { kind: "file", raw: f.after },
  });
  for (const name of ["audit.json", "before.md", "after.md"])
    expect(fs.statSync(join(f.path, name)).mode & 0o777).toBe(0o600);
  for (const path of [f.path, join(f.path, ".."), join(f.path, "../.."), join(f.path, "../../..")])
    expect(fs.statSync(path).mode & 0o777).toBe(0o700);
});
it.each(["before.md", "after.md", "audit.json"])("tampering %s is corrupted, never overwritten on replay", (name) => {
  const f = setup();
  expect(propose(f).kind).toBe("ok");
  const file = join(f.path, name);
  if (name === "audit.json") {
    const a = JSON.parse(fs.readFileSync(file, "utf8"));
    a.proposalDigest = hash("tamper");
    fs.writeFileSync(file, JSON.stringify(a));
  } else fs.writeFileSync(file, "tampered");
  const bytes = fs.readFileSync(file);
  expect(prepare(f).kind).toBe("corrupted");
  expect(fs.readFileSync(file)).toEqual(bytes);
  expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.before);
});
it.each(["file-fsync", "dir-fsync", "audit-rename"])("prepared barrier %s failure has zero body CAS", (fault) => {
  const f = setup(),
    renameActual = fs.renameSync,
    fsyncActual = fs.fsyncSync;
  let bodyCAS = 0;
  vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
    if (String(b).endsWith("blocks/rules.001.md")) bodyCAS++;
    if (fault === "audit-rename" && String(b).endsWith("audit.json")) throw Error("fault");
    renameActual(a, b);
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const dir = fs.fstatSync(fd).isDirectory();
    if (fault === (dir ? "dir-fsync" : "file-fsync")) throw Error("fault");
    fsyncActual(fd);
  });
  expect(prepare(f).kind).toBe("unavailable");
  expect(bodyCAS).toBe(0);
  expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.before);
});
it.each(["file-fsync", "dir-fsync", "audit-rename"])("expected-after barrier %s failure has zero body CAS", (fault) => {
  const f = setup();
  expect(prepare(f).kind).toBe("ok");
  const renameActual = fs.renameSync,
    fsyncActual = fs.fsyncSync;
  let bodyCAS = 0;
  vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
    if (String(b).endsWith("blocks/rules.001.md")) bodyCAS++;
    if (fault === "audit-rename" && String(b).endsWith("audit.json")) throw Error("fault");
    renameActual(a, b);
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const dir = fs.fstatSync(fd).isDirectory();
    if (fault === (dir ? "dir-fsync" : "file-fsync")) throw Error("fault");
    fsyncActual(fd);
  });
  expect(
    f.port.persistExpectedAfterBarrierLocked({
      batchId: f.frozen.batchId,
      actionId: f.frozen.actionId,
      proposalDigest: f.proposal.proposalDigest,
      expected: f.expected,
    }).kind,
  ).toBe("unavailable");
  expect(bodyCAS).toBe(0);
  expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.before);
});
it.each(["before", "after", "other", "missing"])("proposed file scan %s is read-only and conservative", (current) => {
  const f = setup();
  expect(propose(f).kind).toBe("ok");
  const target = join(f.mem, "blocks", "rules.001.md");
  if (current === "missing") fs.unlinkSync(target);
  else if (current !== "before") fs.writeFileSync(target, current === "after" ? f.after : raw("user edit", 9));
  const auditBytes = fs.readFileSync(join(f.path, "audit.json"));
  const result = f.port.scanPendingLocked();
  expect(result).toEqual([
    {
      kind: "action",
      batchId: f.frozen.batchId,
      actionId: f.frozen.actionId,
      state: current === "before" ? "skipped" : "commit-unknown",
      reason:
        current === "before"
          ? "no-commit-observed"
          : current === "after"
            ? "expected-after-without-commit-marker"
            : "unexpected-current",
    },
  ]);
  expect(f.port.scanPendingLocked()).toEqual(result);
  expect(fs.readFileSync(join(f.path, "audit.json"))).toEqual(auditBytes);
});
it.each(["before", "missing", "other"])("proposed delete scan %s never infers proven deletion", (current) => {
  const f = setup("delete");
  expect(propose(f).kind).toBe("ok");
  const target = join(f.mem, "blocks", "rules.001.md");
  if (current === "missing") fs.unlinkSync(target);
  if (current === "other") fs.writeFileSync(target, raw("edit", 9));
  expect(f.port.scanPendingLocked()).toMatchObject([
    {
      state: current === "before" ? "skipped" : "commit-unknown",
      reason:
        current === "before"
          ? "no-commit-observed"
          : current === "missing"
            ? "expected-missing-without-commit-marker"
            : "unexpected-current",
    },
  ]);
  expect(fs.existsSync(join(f.path, "after.md"))).toBe(false);
});
it("prepared delete + user deletion is unexpected-current, without after evidence", () => {
  const f = setup("delete");
  expect(prepare(f).kind).toBe("ok");
  fs.unlinkSync(join(f.mem, "blocks", "rules.001.md"));
  expect(f.port.scanPendingLocked()).toMatchObject([{ state: "commit-unknown", reason: "unexpected-current" }]);
  expect(f.port.scanPendingLocked()).toMatchObject([{ state: "commit-unknown", reason: "unexpected-current" }]);
});
it.each(["committed", "restored", "skipped", "failed", "commit-unknown"])("scan leaves terminal %s alone", (state) => {
  const f = setup();
  expect(propose(f).kind).toBe("ok");
  const p = join(f.path, "audit.json"),
    a = JSON.parse(fs.readFileSync(p, "utf8"));
  a.state = state;
  fs.writeFileSync(p, JSON.stringify(a));
  fs.writeFileSync(join(f.mem, "blocks", "rules.001.md"), raw("user later edit", 9));
  expect(f.port.scanPendingLocked()).toMatchObject([{ state }]);
  expect(f.port.scanPendingLocked()).toMatchObject([{ state }]);
  expect(JSON.parse(fs.readFileSync(p, "utf8")).state).toBe(state);
});
it("real rename observation precedes data directory fsync and committed marker", () => {
  const f = setup();
  expect(propose(f).kind).toBe("ok");
  const trace: string[] = [],
    actualRename = fs.renameSync,
    actualFsync = fs.fsyncSync;
  vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
    actualRename(a, b);
    trace.push(String(b).endsWith("rules.001.md") ? "data-rename" : "audit-rename");
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    trace.push(fs.fstatSync(fd).isDirectory() ? "dir-fsync" : "file-fsync");
    actualFsync(fd);
  });
  expect(finish(f)).toMatchObject({ kind: "committed" });
  expect(trace).toEqual(["file-fsync", "data-rename", "dir-fsync", "file-fsync", "audit-rename", "dir-fsync"]);
  expect(read(f)).toMatchObject({ kind: "ok", audit: { state: "committed" } });
});
it.each(["gate", "data-fsync", "commit-rename"])(
  "post-data %s failure retains actual bytes, unknown, no compensation",
  (fault) => {
    let current = true;
    const f = setup("rewrite-single", { ...deps, isCurrent: () => current });
    expect(propose(f).kind).toBe("ok");
    const o = apply(f);
    const rename = vi.spyOn(fs, "renameSync"),
      actualFsync = fs.fsyncSync;
    if (fault === "gate") current = false;
    if (fault === "data-fsync")
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory()) throw Error("post-data fsync");
        actualFsync(fd);
      });
    if (fault === "commit-rename")
      rename.mockImplementation(() => {
        throw Error("commit rename");
      });
    expect(finish(f, o)).toMatchObject({ kind: "effect-unknown", dataApplied: true });
    expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.after);
    current = true;
    vi.restoreAllMocks();
    expect(f.port.scanPendingLocked()).toMatchObject([{ state: "commit-unknown" }]);
    expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.after);
  },
);
it("unknown observations cannot finalize by post-hoc matching bytes; retries stay unknown", () => {
  const f = setup();
  expect(propose(f).kind).toBe("ok");
  apply(f);
  expect(finish(f, { kind: "unknown", reason: "unproven" })).toMatchObject({
    kind: "effect-unknown",
    dataApplied: "unknown",
  });
  expect(finish(f, { kind: "not-applied" })).toMatchObject({ kind: "effect-unknown" });
  expect(read(f)).toMatchObject({ kind: "ok", audit: { state: "commit-unknown" } });
});
it("missing/symlink/wide permissions/invalid JSON/unknown fields and incomplete scans fail closed", () => {
  const f = setup();
  expect(f.port.scanPendingLocked()).toEqual([]);
  expect(fs.existsSync(join(f.mem, "blocks", ".jev"))).toBe(false);
  expect(prepare(f).kind).toBe("ok");
  const audit = join(f.path, "audit.json"),
    bytes = fs.readFileSync(audit);
  fs.writeFileSync(audit, "{");
  expect(read(f).kind).toBe("corrupted");
  fs.writeFileSync(audit, bytes);
  const a = JSON.parse(bytes.toString());
  a.unrecognized = true;
  fs.writeFileSync(audit, JSON.stringify(a));
  expect(read(f).kind).toBe("corrupted");
  fs.writeFileSync(audit, bytes);
  fs.chmodSync(f.path, 0o755);
  expect(read(f)).toMatchObject({ kind: "unavailable", reason: "permission" });
  expect(fs.statSync(f.path).mode & 0o777).toBe(0o755);
  fs.chmodSync(f.path, 0o700);
  fs.unlinkSync(join(f.path, "before.md"));
  expect(read(f).kind).toBe("corrupted");
  fs.symlinkSync(join(f.mem, "blocks", "rules.001.md"), join(f.path, "before.md"));
  expect(read(f).kind).toBe("unavailable");
  const revs = join(f.path, "../..");
  for (let i = 0; i < REVISION_SCAN_BATCH_LIMIT; i++) fs.mkdirSync(join(revs, hash(String(i))), { mode: 0o700 });
  expect(f.port.scanPendingLocked()).toMatchObject([{ kind: "unavailable" }]);
});
it("identity/gate are rechecked after prepared work, and foreign directory frozen evidence is refused", () => {
  let enabled = true;
  const f = setup("rewrite-single", { ...deps, isCurrent: () => enabled });
  expect(prepare(f).kind).toBe("ok");
  enabled = false;
  expect(read(f)).toMatchObject({ kind: "unavailable", reason: "gate" });
  enabled = true;
  const blocks = join(f.mem, "blocks");
  fs.renameSync(blocks, join(f.mem, "saved"));
  fs.mkdirSync(blocks, { mode: 0o700 });
  expect(read(f)).toMatchObject({ kind: "unavailable", reason: "permission" });
  const other = setup();
  expect(
    other.port.persistPreparedBarrierLocked({ frozen: f.frozen, proposal: f.proposal, origin: "p50-suggestion" }).kind,
  ).not.toBe("ok");
});
it("bounded JSON and snapshots reject overflow, invalid enums, filenames and unexpected after", () => {
  const f = setup();
  expect(prepare(f).kind).toBe("ok");
  const p = join(f.path, "audit.json"),
    original = fs.readFileSync(p);
  for (const patch of [
    { v: 2 },
    { state: "invented" },
    { origin: "foreign" },
    { action: "rename" },
    { beforeFile: "../secret" },
    { expectedAfter: { kind: "missing" } },
    { targetId: "../x" },
    { batchId: "A".repeat(64) },
    { expectedRev: "not-rev" },
    { restoreAttempt: { state: "intent", startedAt: "bad" } },
  ]) {
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(original.toString()), ...patch }));
    expect(read(f).kind).toBe("corrupted");
  }
  fs.writeFileSync(p, " ".repeat(65537));
  expect(read(f).kind).not.toBe("ok");
  fs.writeFileSync(p, original);
  fs.writeFileSync(join(f.path, "after.md"), f.after, { mode: 0o600 });
  expect(read(f).kind).toBe("corrupted");
});
it("gate and actual uid/dev/mode are admission evidence, never JSON self-attestation", () => {
  const f = setup();
  expect(prepare(f).kind).toBe("ok");
  const actual = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
    const stat = actual(path);
    if (String(path) === join(f.path, "before.md"))
      Object.defineProperty(stat, "uid", { value: (process.getuid?.() ?? 0) + 1 });
    return stat;
  }) as typeof fs.lstatSync);
  expect(read(f)).toMatchObject({ kind: "unavailable", reason: "permission" });
});
it("unknown finalization never reopens the expected-after barrier for blind retry", () => {
  const f = setup();
  expect(propose(f).kind).toBe("ok");
  expect(finish(f, { kind: "unknown", reason: "unproven" }).kind).toBe("effect-unknown");
  const rename = vi.spyOn(fs, "renameSync");
  expect(
    f.port.persistExpectedAfterBarrierLocked({
      batchId: f.frozen.batchId,
      actionId: f.frozen.actionId,
      proposalDigest: f.proposal.proposalDigest,
      expected: f.expected,
    }),
  ).toMatchObject({ kind: "unavailable", reason: "expected-after-barrier:terminal-state" });
  expect(rename).not.toHaveBeenCalled();
});
it("commit-marker dir-fsync failure returns unknown but never downgrades already-written committed terminal", () => {
  const f = setup();
  expect(propose(f).kind).toBe("ok");
  const o = apply(f),
    actualFsync = fs.fsyncSync,
    actualRename = fs.renameSync;
  let marker = false;
  vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
    actualRename(a, b);
    if (String(b) === join(f.path, "audit.json")) marker = true;
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (marker && fs.fstatSync(fd).isDirectory()) throw Error("commit action dir fsync");
    actualFsync(fd);
  });
  expect(finish(f, o)).toMatchObject({ kind: "effect-unknown", dataApplied: true });
  expect(read(f)).toMatchObject({ kind: "ok", audit: { state: "committed" } });
  expect(f.port.scanPendingLocked()).toMatchObject([{ state: "committed" }]);
  vi.restoreAllMocks();
  const rename = vi.spyOn(fs, "renameSync");
  expect(finish(f, { kind: "not-applied" })).toMatchObject({ kind: "committed" });
  expect(rename).not.toHaveBeenCalled();
  expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.after);
});
it("delete finalization fsyncs blocks AND trash before its commit marker", () => {
  const f = setup("delete");
  expect(propose(f).kind).toBe("ok");
  const o = apply(f),
    trace: string[] = [],
    actualFsync = fs.fsyncSync,
    actualRename = fs.renameSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (fs.fstatSync(fd).isDirectory()) trace.push(fs.realpathSync(`/proc/self/fd/${fd}`));
    actualFsync(fd);
  });
  vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
    trace.push("marker");
    actualRename(a, b);
  });
  expect(finish(f, o)).toMatchObject({ kind: "committed" });
  expect(trace).toEqual([join(f.mem, "blocks"), join(f.mem, "blocks", ".trash"), "marker", f.path]);
});
it("delete source-unlink failure stays unknown even with matching post-hoc bytes", () => {
  const f = setup("delete");
  expect(propose(f).kind).toBe("ok");
  const blocks = join(f.mem, "blocks"),
    trash = join(blocks, ".trash");
  fs.mkdirSync(trash, { mode: 0o700 });
  vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
    throw Error("source unlink fault");
  });
  const result = deleteRevisionObserved(blocks, "rules.001.md", trash, "20261110T000000000Z-1-abcdef-rules.001.md", {
    digest: hash(f.before),
    rev: f.frozen.target.rev,
  });
  expect(result.observation.kind).toBe("unknown");
  expect(finish(f, result.observation)).toMatchObject({ kind: "effect-unknown", dataApplied: "unknown" });
  expect(fs.readFileSync(join(blocks, "rules.001.md"))).toEqual(f.before);
  expect(fs.readFileSync(join(trash, "20261110T000000000Z-1-abcdef-rules.001.md"))).toEqual(f.before);
  expect(f.port.scanPendingLocked()).toMatchObject([{ state: "commit-unknown" }]);
});
it("commit unknown preserves strict two-path evidence in the SAME audit across factory restart", () => {
  const f = setup("delete");
  expect(propose(f).kind).toBe("ok");
  const blocks = join(f.mem, "blocks"),
    trash = join(blocks, ".trash"),
    trashName = "20261110T000000000Z-1-abcdef-rules.001.md";
  fs.mkdirSync(trash, { mode: 0o700 });
  const actualUnlink = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
    if (String(p) === join(blocks, "rules.001.md")) throw Error("delete source unlink");
    actualUnlink(p);
  });
  const o = deleteRevisionObserved(blocks, "rules.001.md", trash, trashName, {
    digest: hash(f.before),
    rev: f.frozen.target.rev,
  }).observation;
  expect(finish(f, o)).toMatchObject({ kind: "effect-unknown", dataApplied: "unknown" });
  const restarted = createRevisionAuditPort(f.mem, deps),
    r = restarted.readActionLocked(f.frozen.batchId, f.frozen.actionId);
  expect(r).toMatchObject({
    kind: "ok",
    audit: {
      state: "commit-unknown",
      commitObservation: {
        kind: "unknown",
        paths: [
          { area: "blocks", name: "rules.001.md" },
          { area: "trash", name: trashName },
        ],
      },
    },
  });
  if (r.kind === "ok" && r.audit.commitObservation?.kind === "unknown" && r.audit.commitObservation.paths) {
    (r.audit.commitObservation.paths[0] as { name: string }).name = "tampered";
  }
  expect(restarted.readActionLocked(f.frozen.batchId, f.frozen.actionId)).toMatchObject({
    kind: "ok",
    audit: { commitObservation: o },
  });
  expect(fs.readFileSync(join(blocks, "rules.001.md"))).toEqual(f.before);
  expect(fs.readFileSync(join(trash, trashName))).toEqual(f.before);
  expect(restarted.scanPendingLocked()).toMatchObject([{ state: "commit-unknown" }]);
});
it.each(["/tmp/absolute", "../escape", "rules.002.md", "a\\b", "x".repeat(256)])(
  "audit observation path %s is corrupted, never a readback write target",
  (name) => {
    const f = setup();
    expect(propose(f).kind).toBe("ok");
    const p = join(f.path, "audit.json"),
      a = JSON.parse(fs.readFileSync(p, "utf8"));
    a.state = "commit-unknown";
    a.commitObservation = { kind: "unknown", reason: "unproven", paths: [{ area: "blocks", name }] };
    fs.writeFileSync(p, JSON.stringify(a));
    const rename = vi.spyOn(fs, "renameSync"),
      link = vi.spyOn(fs, "linkSync");
    expect(read(f).kind).toBe("corrupted");
    expect(f.port.scanPendingLocked()).toMatchObject([{ state: "corrupted" }]);
    expect(rename).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.before);
  },
);
it("observation malformed shape/oversized paths/invalid proof is rejected without retaining arbitrary payload", () => {
  for (const observation of [
    { kind: "applied", expectedAfter: { kind: "missing" }, proof: "link-observed" },
    {
      kind: "unknown",
      reason: "unproven",
      paths: [
        { area: "blocks", name: "rules.001.md" },
        { area: "blocks", name: "rules.001.md" },
        { area: "blocks", name: "rules.001.md" },
      ],
    },
    { kind: "unknown", reason: "unproven", paths: [{ area: "trash", name: "arbitrary-file.md" }] },
    { kind: "unknown", reason: "unproven", paths: [{ area: "temp", name: ".foreign.001.md.1.abcdef00.tmp" }] },
    { kind: "unknown", reason: "unproven", paths: [{ area: "root", name: "rules.001.md" }] },
  ]) {
    const f = setup();
    expect(propose(f).kind).toBe("ok");
    const r = finish(f, observation as never);
    expect(r.kind).toBe("effect-unknown");
    const a = read(f);
    expect(a).toMatchObject({ kind: "ok", audit: { state: "commit-unknown" } });
    if (a.kind === "ok") expect(a.audit.commitObservation).toBeUndefined();
  }
});
it("oversized live edits are unexpected-current without unbounded reads or after fabrication", () => {
  const f = setup();
  expect(propose(f).kind).toBe("ok");
  fs.writeFileSync(join(f.mem, "blocks", "rules.001.md"), Buffer.alloc(65536, 65));
  expect(f.port.scanPendingLocked()).toMatchObject([{ state: "commit-unknown", reason: "unexpected-current" }]);
  expect(fs.readFileSync(join(f.path, "after.md"))).toEqual(f.after);
  expect(fs.statSync(join(f.mem, "blocks", "rules.001.md")).size).toBe(65536);
});

const replayCases = (["prepared", "proposed"] as const).flatMap((stage) =>
  ["same-instance", "restart"].flatMap((owner) =>
    [
      "action",
      "batch",
      "revisions",
      "jev",
      "blocks",
      "memory",
      "before.md",
      ...(stage === "proposed" ? ["after.md"] : []),
      "audit.json",
    ].map((point) => ({ stage, owner, point })),
  ),
);
it.each(replayCases)(
  "$stage marker replay $owner re-establishes full barrier after $point fsync failure",
  ({ stage, owner, point }) => {
    const f = setup();
    if (stage === "proposed") expect(prepare(f).kind).toBe("ok");
    const dirs = [
      f.path,
      join(f.path, ".."),
      join(f.path, "../.."),
      join(f.path, "../../.."),
      join(f.mem, "blocks"),
      f.mem,
    ];
    const byName: Record<string, string> = {
      action: dirs[0]!,
      batch: dirs[1]!,
      revisions: dirs[2]!,
      jev: dirs[3]!,
      blocks: dirs[4]!,
      memory: dirs[5]!,
    };
    const faultPath = byName[point] ?? join(f.path, point),
      trace: string[] = [];
    const actualRename = fs.renameSync,
      actualFsync = fs.fsyncSync;
    let markerRenamed = false,
      fault = true,
      dataCAS = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      actualRename(from, to);
      if (String(to) === join(f.mem, "blocks", "rules.001.md")) dataCAS++;
      if (String(to) === join(f.path, "audit.json") && JSON.parse(fs.readFileSync(to, "utf8")).state === stage)
        markerRenamed = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const path = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (markerRenamed) {
        trace.push(path);
        if (fault && path === faultPath) throw Error(`persistent ${point} fsync fault`);
      }
      actualFsync(fd);
    });
    const invoke = (port: RevisionAuditPort) =>
      stage === "prepared"
        ? port.persistPreparedBarrierLocked({ frozen: f.frozen, proposal: f.proposal, origin: "p50-suggestion" })
        : port.persistExpectedAfterBarrierLocked({
            batchId: f.frozen.batchId,
            actionId: f.frozen.actionId,
            proposalDigest: f.proposal.proposalDigest,
            expected: f.expected,
          });
    expect(invoke(f.port).kind).toBe("unavailable");
    expect(markerRenamed).toBe(true);
    expect(read(f)).toMatchObject({ kind: "ok", audit: { state: stage } });
    const names = ["before.md", ...(stage === "proposed" ? ["after.md"] : []), "audit.json"];
    const evidence = names.map((name) => ({
      name,
      bytes: fs.readFileSync(join(f.path, name)),
      ino: fs.statSync(join(f.path, name)).ino,
    }));
    const port = owner === "restart" ? createRevisionAuditPort(f.mem, deps) : f.port;
    for (let retry = 0; retry < 2; retry++) {
      trace.length = 0;
      expect(invoke(port).kind).toBe("unavailable");
      expect(trace).toContain(faultPath);
      expect(dataCAS).toBe(0);
      expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.before);
    }
    fault = false;
    trace.length = 0;
    expect(invoke(port).kind).toBe("ok");
    // Replay requests every file AND every directory, not just the failed last
    // component. No rename/replacement of already valid evidence is permitted.
    expect(trace).toEqual([...names.map((name) => join(f.path, name)), ...dirs]);
    for (const e of evidence) {
      expect(fs.readFileSync(join(f.path, e.name))).toEqual(e.bytes);
      expect(fs.statSync(join(f.path, e.name)).ino).toBe(e.ino);
    }
    expect(dataCAS).toBe(0);
    expect(propose(f).kind).toBe("ok");
    expect(finish(f)).toMatchObject({ kind: "committed" });
    expect(dataCAS).toBe(1);
    expect(fs.readFileSync(join(f.mem, "blocks", "rules.001.md"))).toEqual(f.after);
  },
);

it("delete proposed replay fsyncs before/audit and full parent chain without fabricating after.md", () => {
  const f = setup("delete");
  expect(propose(f).kind).toBe("ok");
  const actual = fs.fsyncSync,
    trace: string[] = [];
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    trace.push(fs.realpathSync(`/proc/self/fd/${fd}`));
    actual(fd);
  });
  const replay = createRevisionAuditPort(f.mem, deps).persistExpectedAfterBarrierLocked({
    batchId: f.frozen.batchId,
    actionId: f.frozen.actionId,
    proposalDigest: f.proposal.proposalDigest,
    expected: f.expected,
  });
  expect(replay.kind).toBe("ok");
  expect(trace).toEqual([
    join(f.path, "before.md"),
    join(f.path, "audit.json"),
    f.path,
    join(f.path, ".."),
    join(f.path, "../.."),
    join(f.path, "../../.."),
    join(f.mem, "blocks"),
    f.mem,
  ]);
  expect(fs.existsSync(join(f.path, "after.md"))).toBe(false);
});
