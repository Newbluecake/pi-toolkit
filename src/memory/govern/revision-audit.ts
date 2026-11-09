/** P50 factory-only raw audit/recovery kernel. No production wiring, model,
 * proposal owner, commitAction or body applier. Locked methods are synchronous
 * and require the existing canonical memory-directory lock (never nested).
 * Path checks narrow races; they are not a transaction against hostile same-uid
 * writers between arbitrary syscalls. All actual fs access stays in safe-fs. */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  canonicalDir,
  inspectDirSecurityNoFollow,
  inspectRevisionFileSecurity,
  ensureRevisionPrivateDir,
  listRevisionNamesBounded,
  readRegularBytes,
  statRegularIfExists,
  writeTempRegular,
  replaceRevisionObserved,
  createRevisionObserved,
  fsyncDir,
  fsyncRevisionFile,
} from "../safe-fs.js";
import { parseBlockFile, BLOCK_BODY_MAX_BYTES, MAX_FRONTMATTER_BYTES } from "../blocks/format.js";
import { parseBlockName } from "../blocks/naming.js";
import { looksSecret } from "../secret-patterns.js";
import { withMemoryDirLock } from "../lock.js";
import type {
  ApplyObservation,
  AuditReadResult,
  ExpectedAfter,
  FrozenRevisionInput,
  RevisionAudit,
  RevisionAuditDeps,
  RevisionAuditPort,
  RevisionProposal,
  RevisionRecoveryDiagnostic,
  RestoreRevisionRaw,
  RestoreRevisionRawLocked,
  CommitActionResult,
} from "../jev/contracts.js";

export const REVISION_RAW_MAX_BYTES = MAX_FRONTMATTER_BYTES + BLOCK_BODY_MAX_BYTES + 64;
export const REVISION_AUDIT_MAX_BYTES = 64 * 1024;
export const REVISION_SCAN_BATCH_LIMIT = 128;
export const REVISION_SCAN_ACTION_LIMIT = 256;
const HEX = /^[a-f0-9]{64}$/;
const REV = /^[1-9][0-9]*-[a-f0-9]{6}$/;
const ACTIONS = ["rewrite-single", "merge-survivor", "retire", "delete", "expires"];
const STATES = ["prepared", "proposed", "committed", "skipped", "failed", "commit-unknown", "restored"];
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** Shared pure identity formula; sessionEpoch is deliberately NOT included. */
export function revisionDirectoryIdentityDigest(realpath: string, dev: number, ino: number): string {
  return hash(JSON.stringify([realpath, dev, ino]));
}
/** Canonical JSON here binds already validated local payloads, never calls
 * toJSON/getters from disk (disk input is JSON.parse only). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function keys(v: Record<string, unknown>, allowed: string): boolean {
  return Object.keys(v).every((k) => allowed.split(" ").includes(k));
}
function text(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    Buffer.byteLength(v) <= 1024 &&
    Buffer.from(v).toString("utf8") === v &&
    !/[\u0000-\u001f]/.test(v)
  );
}
function digest(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}
function rev(v: unknown): v is string {
  return typeof v === "string" && REV.test(v);
}
function id(v: unknown): v is string {
  return typeof v === "string" && !!parseBlockName(`${v}.md`);
}
function date(v: unknown): boolean {
  return (
    typeof v === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
  );
}
function provenance(v: unknown): boolean {
  if (
    !record(v) ||
    !keys(
      v,
      "provider model adapterId chainVersion routeIdentity routeAliases requestChainId requestDigest inputDigest trusted requestedProvider requestedModel canonicalProvider canonicalModel",
    )
  )
    return false;
  return (
    ["adapterId", "chainVersion", "requestChainId"].every((k) => text(v[k])) &&
    // B preserves unknown actual identity as empty strings, never requested-id
    // fallback. Retain that evidence for suggestions; trusted identity stays strict.
    ["provider", "model"].every((k) => text(v[k]) || (v.trusted === false && v[k] === "")) &&
    (digest(v.routeIdentity) || (v.trusted === false && v.routeIdentity === "unknown")) &&
    digest(v.requestDigest) &&
    digest(v.inputDigest) &&
    typeof v.trusted === "boolean" &&
    Array.isArray(v.routeAliases) &&
    v.routeAliases.length <= 32 &&
    v.routeAliases.every(text) &&
    ["requestedProvider", "requestedModel", "canonicalProvider", "canonicalModel"].every(
      (k) => v[k] === undefined || text(v[k]),
    )
  );
}
function bindings(v: unknown): boolean {
  return (
    record(v) &&
    keys(v, "relation generation coverage") &&
    Object.values(v).every(
      (b) => record(b) && keys(b, "requestDigest inputDigest") && digest(b.requestDigest) && digest(b.inputDigest),
    )
  );
}
function expiry(v: unknown): boolean {
  if (!record(v) || !text(v.dateRuleVersion)) return false;
  return v.op === "clear"
    ? keys(v, "op dateRuleVersion")
    : v.op === "set" &&
        keys(v, "op nextExpires dateRuleVersion") &&
        typeof v.nextExpires === "string" &&
        /^\d{4}-\d\d-\d\d$/.test(v.nextExpires) &&
        Number.isFinite(Date.parse(v.nextExpires)) &&
        new Date(v.nextExpires).toISOString().slice(0, 10) === v.nextExpires;
}
function observationValid(v: unknown): v is ApplyObservation {
  if (!record(v) || !keys(v, "kind expectedAfter proof paths reason")) return false;
  if (
    v.paths !== undefined &&
    (!Array.isArray(v.paths) ||
      v.paths.length < 1 ||
      v.paths.length > 2 ||
      !v.paths.every(
        (p) =>
          record(p) &&
          keys(p, "area name") &&
          ["blocks", "trash", "temp"].includes(String(p.area)) &&
          typeof p.name === "string" &&
          Buffer.byteLength(p.name) <= 255 &&
          /^[^/\\\u0000]+$/.test(p.name) &&
          p.name !== "." &&
          p.name !== "..",
      ))
  )
    return false;
  if (v.kind === "not-applied") return keys(v, "kind");
  if (v.kind === "unknown") return keys(v, "kind reason paths") && text(v.reason);
  if (v.kind !== "applied" || !keys(v, "kind expectedAfter proof paths") || !record(v.expectedAfter)) return false;
  return v.expectedAfter.kind === "missing"
    ? keys(v.expectedAfter, "kind") && v.proof === "unlink-observed"
    : v.expectedAfter.kind === "file" &&
        keys(v.expectedAfter, "kind digest rev") &&
        digest(v.expectedAfter.digest) &&
        rev(v.expectedAfter.rev) &&
        ["link-observed", "rename-observed"].includes(String(v.proof));
}
/** Evidence is never an I/O target. Even so, bind every relative basename to
 * this audit target and the existing controlled temp/trash grammars. */
function contextualObservation(v: unknown, targetId: string): v is ApplyObservation {
  if (!observationValid(v)) return false;
  if (v.kind === "not-applied" || !v.paths) return true;
  const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return v.paths.every(
    (p) =>
      !p ||
      (p.area === "blocks"
        ? p.name === `${targetId}.md`
        : p.area === "temp"
          ? new RegExp(`^\\.${escaped}\\.md\\.[1-9][0-9]*\\.[a-f0-9]{8}\\.tmp$`).test(p.name)
          : new RegExp(`^[0-9]{8}T[0-9]{9}Z-[1-9][0-9]*-[a-f0-9]{6}-${escaped}\\.md$`).test(p.name)),
  );
}
function auditValid(v: unknown): v is RevisionAudit {
  if (
    !record(v) ||
    !keys(
      v,
      "v origin commitOrigin batchId actionId directoryIdentityDigest action targetId expectedRev contextId contextExpectedRev contextRawDigest inputDigest proposalDigest expiry relation generationProvenance generationInputComplete outputDigest coverage evidenceBindings budget beforeDigest expectedAfter beforeFile policyVersion state reason createdAt settledAt commitObservation restoreAttempt",
    )
  )
    return false;
  if (
    v.v !== 1 ||
    !["p50-auto", "p50-suggestion", "web-b3"].includes(String(v.origin)) ||
    (v.commitOrigin !== undefined &&
      (v.state === "prepared" ||
        typeof v.commitOrigin !== "string" ||
        !["p50-auto", "web-b3"].includes(v.commitOrigin))) ||
    !ACTIONS.includes(String(v.action)) ||
    !STATES.includes(String(v.state)) ||
    !id(v.targetId) ||
    !rev(v.expectedRev) ||
    !text(v.policyVersion) ||
    v.beforeFile !== "before.md" ||
    !date(v.createdAt)
  )
    return false;
  if (
    ![v.batchId, v.actionId, v.directoryIdentityDigest, v.inputDigest, v.proposalDigest, v.beforeDigest].every(digest)
  )
    return false;
  if (v.contextId !== undefined || v.contextExpectedRev !== undefined || v.contextRawDigest !== undefined) {
    if (!id(v.contextId) || !rev(v.contextExpectedRev) || !digest(v.contextRawDigest) || v.contextId === v.targetId)
      return false;
  }
  if ((v.reason !== undefined && !text(v.reason)) || (v.settledAt !== undefined && !date(v.settledAt))) return false;
  if (v.action === "expires" ? !expiry(v.expiry) : v.expiry !== undefined) return false;
  if (v.evidenceBindings !== undefined && !bindings(v.evidenceBindings)) return false;
  if (
    v.relation !== undefined &&
    (!record(v.relation) ||
      !keys(v.relation, "kind p inputDigest provenance") ||
      !["conflict", "supersedes"].includes(String(v.relation.kind)) ||
      typeof v.relation.p !== "number" ||
      !Number.isFinite(v.relation.p) ||
      v.relation.p < 0 ||
      v.relation.p > 1 ||
      !digest(v.relation.inputDigest) ||
      !provenance(v.relation.provenance))
  )
    return false;
  if (
    v.coverage !== undefined &&
    (!record(v.coverage) ||
      !keys(v.coverage, "v verdict targetRev beforeDigest candidateDigest promptVersion provenance evidenceDigest") ||
      v.coverage.v !== 1 ||
      v.coverage.verdict !== "complete" ||
      v.coverage.targetRev !== v.expectedRev ||
      ![v.coverage.beforeDigest, v.coverage.candidateDigest, v.coverage.evidenceDigest].every(digest) ||
      !text(v.coverage.promptVersion) ||
      !provenance(v.coverage.provenance))
  )
    return false;
  if (v.generationProvenance !== undefined || v.outputDigest !== undefined || v.generationInputComplete !== undefined) {
    if (
      !["rewrite-single", "merge-survivor"].includes(String(v.action)) ||
      !provenance(v.generationProvenance) ||
      !digest(v.outputDigest) ||
      typeof v.generationInputComplete !== "boolean"
    )
      return false;
  }
  if (v.budget !== undefined) {
    if (
      !record(v.budget) ||
      !keys(
        v.budget,
        "settledCostUsd reservedCostUsd reservedCalls outstanding zombies queued costSource overReservedUsd adjustmentUsd exhausted disposed",
      ) ||
      !["settledCostUsd", "reservedCostUsd", "reservedCalls", "outstanding", "zombies", "overReservedUsd"].every(
        (k) =>
          typeof v.budget === "object" &&
          v.budget !== null &&
          typeof (v.budget as Record<string, unknown>)[k] === "number" &&
          Number.isFinite((v.budget as Record<string, number>)[k]) &&
          (v.budget as Record<string, number>)[k]! >= 0,
      ) ||
      typeof v.budget.adjustmentUsd !== "number" ||
      !Number.isFinite(v.budget.adjustmentUsd) ||
      typeof v.budget.exhausted !== "boolean" ||
      typeof v.budget.disposed !== "boolean" ||
      !["none", "usage", "reserve", "mixed"].includes(String(v.budget.costSource)) ||
      !record(v.budget.queued) ||
      !keys(v.budget.queued, "sync background") ||
      ![v.budget.queued.sync, v.budget.queued.background].every(
        (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0,
      )
    )
      return false;
  }
  if (v.expectedAfter !== undefined) {
    if (!record(v.expectedAfter)) return false;
    if (v.expectedAfter.kind === "missing") {
      if (!keys(v.expectedAfter, "kind") || v.action !== "delete") return false;
    } else if (
      v.expectedAfter.kind !== "file" ||
      v.action === "delete" ||
      !keys(v.expectedAfter, "kind digest rev file") ||
      !digest(v.expectedAfter.digest) ||
      !rev(v.expectedAfter.rev) ||
      v.expectedAfter.file !== "after.md"
    )
      return false;
  }
  if (["proposed", "committed", "restored"].includes(String(v.state)) && v.expectedAfter === undefined) return false;
  if (v.state === "prepared" && v.expectedAfter !== undefined) return false;
  if (v.commitObservation !== undefined) {
    if (v.state === "prepared" || !contextualObservation(v.commitObservation, v.targetId as string)) return false;
    const o = v.commitObservation;
    if (["committed", "restored"].includes(String(v.state))) {
      if (
        o.kind !== "applied" ||
        !record(v.expectedAfter) ||
        o.expectedAfter.kind !== v.expectedAfter.kind ||
        (o.expectedAfter.kind === "file" &&
          (o.expectedAfter.digest !== v.expectedAfter.digest || o.expectedAfter.rev !== v.expectedAfter.rev))
      )
        return false;
    }
    if (v.state === "skipped" && o.kind !== "not-applied") return false;
  }
  if (v.restoreAttempt !== undefined) {
    if (
      !["committed", "restored"].includes(String(v.state)) ||
      !record(v.restoreAttempt) ||
      !keys(v.restoreAttempt, "state startedAt observation reason") ||
      !["intent", "effect-unknown"].includes(String(v.restoreAttempt.state)) ||
      !date(v.restoreAttempt.startedAt) ||
      (v.restoreAttempt.observation !== undefined &&
        !contextualObservation(v.restoreAttempt.observation, v.targetId as string)) ||
      (v.restoreAttempt.reason !== undefined && !text(v.restoreAttempt.reason))
    )
      return false;
  }
  return true;
}
class Refusal extends Error {
  constructor(readonly reason: "permission" | "gate" | "corrupted" | "unavailable" | "stale") {
    super(reason);
  }
}
function fail(reason: Refusal["reason"]): never {
  throw new Refusal(reason);
}
function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}
function block(raw: Buffer, targetId: string) {
  if (raw.length > REVISION_RAW_MAX_BYTES || !Buffer.from(raw.toString("utf8")).equals(raw)) return fail("corrupted");
  const parsed = parseBlockFile(`${targetId}.md`, raw.toString("utf8"));
  if ("stray" in parsed || parsed.errors.length || parsed.id !== targetId) return fail("corrupted");
  if (
    parsed.meta.storageScope ||
    parsed.meta.origin ||
    parsed.meta.residue ||
    parsed.meta.private ||
    looksSecret(parsed.body)
  )
    return fail("permission");
  return parsed;
}
type Identity = ReturnType<typeof inspectDirSecurityNoFollow>;
function same(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
}

class Kernel {
  readonly mem: string;
  readonly blocks: string;
  readonly revisions: string;
  readonly root: Identity;
  readonly data: Identity;
  readonly identityDigest: string;
  private readonly identities = new Map<string, Identity>();
  constructor(
    memDir: string,
    readonly deps: RevisionAuditDeps,
  ) {
    const c = canonicalDir(memDir);
    if (!c) fail("unavailable");
    this.mem = c.real;
    this.blocks = join(this.mem, "blocks");
    this.revisions = join(this.blocks, ".jev", "revisions");
    this.root = inspectDirSecurityNoFollow(this.mem);
    this.data = inspectDirSecurityNoFollow(this.blocks);
    if (this.root.dev !== this.data.dev || this.root.uid !== process.getuid?.() || this.data.uid !== this.root.uid)
      fail("permission");
    this.identityDigest = revisionDirectoryIdentityDigest(this.mem, this.root.dev, this.root.ino);
  }
  check(write = false): void {
    if (this.deps.signal?.aborted || !this.deps.isCurrent() || this.deps.gate?.check(this.mem).ok === false)
      fail("gate");
    if (
      canonicalDir(this.mem)?.real !== this.mem ||
      !same(this.root, inspectDirSecurityNoFollow(this.mem)) ||
      !same(this.data, inspectDirSecurityNoFollow(this.blocks))
    )
      fail("permission");
    // Recheck every private ancestor already encountered on this operation.
    for (const [path, identity] of this.identities) {
      const actual = this.privateDir(path);
      if (!same(actual, identity)) fail("permission");
    }
    void write;
  }
  privateDir(path: string): Identity {
    const s = inspectDirSecurityNoFollow(path);
    if (s.uid !== this.root.uid || s.dev !== this.root.dev || (s.mode & 0o077) !== 0) fail("permission");
    return s;
  }
  path(batchId: string, actionId: string, create = false): string {
    if (!digest(batchId) || !digest(actionId)) fail("corrupted");
    this.check(create);
    let p = this.blocks;
    for (const name of [".jev", "revisions", batchId, actionId]) {
      this.check(create);
      if (create) ensureRevisionPrivateDir(p, name, this.root.dev);
      p = join(p, name);
      const s = this.privateDir(p),
        old = this.identities.get(p);
      if (old && !same(old, s)) fail("permission");
      this.identities.set(p, s);
    }
    return p;
  }
  bytes(dir: string, name: string, max: number): Buffer {
    this.check();
    const s = inspectRevisionFileSecurity(dir, name);
    if (s.uid !== this.root.uid || s.dev !== this.root.dev || (s.mode & 0o077) !== 0) fail("permission");
    const r = readRegularBytes(dir, name, { maxBytes: max });
    const after = inspectRevisionFileSecurity(dir, name);
    if (s.ino !== r.stat.ino || s.dev !== r.stat.dev || !same(s, after) || (after.mode & 0o077) !== 0)
      fail("permission");
    this.check();
    return r.bytes;
  }
  current(targetId: string): Buffer | undefined {
    if (!id(targetId)) fail("corrupted");
    this.check();
    const entry = statRegularIfExists(this.blocks, `${targetId}.md`);
    if (entry === undefined) return undefined;
    if (entry.size > REVISION_RAW_MAX_BYTES) fail("stale");
    // Live block modes retain the existing memory trust policy. Snapshot files,
    // unlike pre-existing blocks, must be private. Still verify live uid/device.
    const r = readRegularBytes(this.blocks, `${targetId}.md`, { maxBytes: REVISION_RAW_MAX_BYTES });
    const s = inspectRevisionFileSecurity(this.blocks, `${targetId}.md`);
    if (s.uid !== this.root.uid || s.dev !== this.root.dev || s.ino !== r.stat.ino) fail("permission");
    this.check();
    return r.bytes;
  }
  read(batchId: string, actionId: string): AuditReadResult {
    let pathExists = false;
    try {
      const p = this.path(batchId, actionId);
      pathExists = true;
      const raw = this.bytes(p, "audit.json", REVISION_AUDIT_MAX_BYTES);
      if (!Buffer.from(raw.toString("utf8")).equals(raw)) fail("corrupted");
      let a: unknown;
      try {
        a = JSON.parse(raw.toString("utf8"));
      } catch {
        fail("corrupted");
      }
      if (
        !auditValid(a) ||
        a.batchId !== batchId ||
        a.actionId !== actionId ||
        a.directoryIdentityDigest !== this.identityDigest
      )
        fail("corrupted");
      const before = this.bytes(p, "before.md", REVISION_RAW_MAX_BYTES);
      if (
        hash(before) !== a.beforeDigest ||
        block(before, a.targetId).rev !== a.expectedRev ||
        block(before, a.targetId).meta.status !== "active"
      )
        fail("corrupted");
      let expectedAfter: ExpectedAfter | undefined;
      if (a.expectedAfter?.kind === "file") {
        const rawAfter = this.bytes(p, "after.md", REVISION_RAW_MAX_BYTES);
        if (hash(rawAfter) !== a.expectedAfter.digest || block(rawAfter, a.targetId).rev !== a.expectedAfter.rev)
          fail("corrupted");
        const b = block(before, a.targetId),
          next = block(rawAfter, a.targetId);
        if (
          b.meta.authority !== next.meta.authority ||
          b.meta.scope !== next.meta.scope ||
          (a.action === "retire"
            ? next.meta.status !== "superseded" || next.meta.supersededBy !== a.contextId
            : next.meta.status !== "active")
        )
          fail("permission");
        expectedAfter = {
          kind: "file",
          raw: Buffer.from(rawAfter),
          digest: a.expectedAfter.digest,
          rev: a.expectedAfter.rev,
        };
      } else if (a.expectedAfter?.kind === "missing") {
        if (statRegularIfExists(p, "after.md") !== undefined) fail("corrupted");
        expectedAfter = { kind: "missing" };
      } else if (statRegularIfExists(p, "after.md") !== undefined) fail("corrupted");
      return {
        kind: "ok",
        audit: JSON.parse(JSON.stringify(a)) as RevisionAudit,
        before: Buffer.from(before),
        ...(expectedAfter ? { expectedAfter } : {}),
      };
    } catch (e) {
      if (errno(e) === "ENOENT")
        return pathExists ? { kind: "corrupted", reason: "incomplete-action-evidence" } : { kind: "missing" };
      return {
        kind: e instanceof Refusal && e.reason === "corrupted" ? "corrupted" : "unavailable",
        reason: e instanceof Refusal ? e.reason : "audit-read-failure",
      };
    }
  }
  writeFile(dir: string, name: string, bytes: Buffer): void {
    this.check(true);
    const current = statRegularIfExists(dir, name);
    if (current) this.bytes(dir, name, REVISION_AUDIT_MAX_BYTES);
    const tmp = writeTempRegular(dir, name, Buffer.from(bytes), 0o600);
    const result = replaceRevisionObserved(
      dir,
      tmp,
      name,
      { digest: hash(bytes), rev: "1-000000" },
      { beforeSyscall: () => this.check(true) },
    );
    if (result.error || result.observation.kind !== "applied") fail("unavailable");
    this.check(true);
  }
  /** A valid marker proves content identity, NOT that a prior fsync completed.
   * Replays (including a fresh factory after restart) re-establish every evidence
   * file and every ancestor directory barrier without rewriting any evidence. */
  completeBarrier(a: RevisionAudit): AuditReadResult {
    const p = this.path(a.batchId, a.actionId);
    const checked = this.read(a.batchId, a.actionId);
    if (checked.kind !== "ok" || canonical(checked.audit) !== canonical(a)) fail("corrupted");
    for (const name of ["before.md", ...(a.expectedAfter?.kind === "file" ? ["after.md"] : []), "audit.json"]) {
      this.check(true);
      fsyncRevisionFile(p, name, inspectRevisionFileSecurity(p, name));
      this.check(true);
    }
    for (const dir of [
      p,
      join(this.revisions, a.batchId),
      this.revisions,
      join(this.blocks, ".jev"),
      this.blocks,
      this.mem,
    ]) {
      this.check(true);
      fsyncDir(dir);
      this.check(true);
    }
    const durable = this.read(a.batchId, a.actionId);
    if (durable.kind !== "ok" || canonical(durable.audit) !== canonical(a)) fail("corrupted");
    return durable;
  }
  writeAudit(a: RevisionAudit, full = false): void {
    if (!auditValid(a)) fail("corrupted");
    const bytes = Buffer.from(canonical(a));
    if (bytes.length > REVISION_AUDIT_MAX_BYTES) fail("corrupted");
    const p = this.path(a.batchId, a.actionId);
    this.writeFile(p, "audit.json", bytes);
    if (full) this.completeBarrier(a);
    else {
      this.check(true);
      fsyncDir(p);
    }
  }
  prepare(input: {
    frozen: FrozenRevisionInput;
    proposal: RevisionProposal;
    origin: RevisionAudit["origin"];
  }): AuditReadResult {
    try {
      this.check(true);
      const { frozen: f, proposal: p, origin } = input;
      const before = Buffer.from(f.target.rawBefore);
      const parsed = block(before, f.target.id);
      const { proposalDigest: pd, ...payload } = p;
      if (
        hash(canonical(payload)) !== pd ||
        !digest(pd) ||
        f.directory.realpath !== this.mem ||
        f.directory.dev !== this.root.dev ||
        f.directory.ino !== this.root.ino ||
        f.directoryIdentityDigest !== this.identityDigest ||
        p.directoryIdentityDigest !== this.identityDigest ||
        p.actionId !== f.actionId ||
        p.batchId !== f.batchId ||
        p.targetId !== f.target.id ||
        p.expectedRev !== f.target.rev ||
        p.policyVersion !== f.policyVersion ||
        p.action !== f.action ||
        parsed.rev !== f.target.rev ||
        hash(before) !== f.target.rawDigest ||
        parsed.meta.status !== "active" ||
        parsed.meta.authority !== f.target.block.authority ||
        parsed.body !== f.target.block.body ||
        p.contextId !== f.context?.id ||
        p.contextExpectedRev !== f.context?.rev
      )
        fail("corrupted");
      const inputDigest = hash(
        JSON.stringify([
          [f.target.id, f.target.rev, f.target.rawDigest],
          ...(f.context ? [[f.context.id, f.context.rev, f.context.rawDigest]] : []),
        ]),
      );
      const a: RevisionAudit = {
        v: 1,
        origin,
        batchId: f.batchId,
        actionId: f.actionId,
        directoryIdentityDigest: this.identityDigest,
        action: p.action,
        targetId: p.targetId,
        expectedRev: p.expectedRev,
        inputDigest,
        proposalDigest: pd,
        ...(f.context
          ? { contextId: f.context.id, contextExpectedRev: f.context.rev, contextRawDigest: f.context.rawDigest }
          : {}),
        ...(p.expiry ? { expiry: p.expiry } : {}),
        ...(p.relation ? { relation: p.relation } : {}),
        ...(p.generationProvenance
          ? {
              generationProvenance: p.generationProvenance,
              generationInputComplete: p.generationInputComplete,
              outputDigest: p.outputDigest,
            }
          : {}),
        ...(p.coverage ? { coverage: p.coverage } : {}),
        evidenceBindings: p.evidenceBindings,
        beforeDigest: f.target.rawDigest,
        beforeFile: "before.md",
        policyVersion: f.policyVersion,
        state: "prepared",
        createdAt: this.deps.now().toISOString(),
      };
      if (!auditValid(a)) fail("corrupted");
      const old = this.read(f.batchId, f.actionId);
      if (old.kind === "ok") {
        const {
          state: _s,
          createdAt: _c,
          settledAt: _at,
          reason: _r,
          expectedAfter: _e,
          restoreAttempt: _ra,
          commitObservation: _co,
          commitOrigin: _origin,
          ...oldBase
        } = old.audit;
        const { state: _ns, createdAt: _nc, ...newBase } = a;
        if (canonical(oldBase) !== canonical(newBase) || !old.before.equals(before))
          return { kind: "corrupted", reason: "replay-mismatch" };
        return this.completeBarrier(old.audit);
      }
      if (old.kind !== "missing") return old;
      if (!this.current(f.target.id)?.equals(before)) fail("stale");
      if (f.context) {
        const context = Buffer.from(f.context.rawBefore),
          cp = block(context, f.context.id);
        if (
          cp.rev !== f.context.rev ||
          hash(context) !== f.context.rawDigest ||
          cp.meta.status !== "active" ||
          !this.current(f.context.id)?.equals(context)
        )
          fail("stale");
      }
      const dir = this.path(f.batchId, f.actionId, true);
      // Existing partial evidence is never overwritten, even without audit.json.
      if (listRevisionNamesBounded(dir, 16).length) fail("corrupted");
      this.writeFile(dir, "before.md", before);
      this.writeAudit(a, true);
      return this.read(f.batchId, f.actionId);
    } catch (e) {
      return this.failure(e, "prepared-barrier");
    }
  }
  failure(e: unknown, phase: string): AuditReadResult {
    return {
      kind: e instanceof Refusal && e.reason === "corrupted" ? "corrupted" : "unavailable",
      reason: `${phase}:${e instanceof Refusal ? e.reason : "io"}`,
    };
  }
  expected(input: {
    batchId: string;
    actionId: string;
    proposalDigest: string;
    commitOrigin?: "p50-auto" | "web-b3";
    expected: ExpectedAfter;
  }): AuditReadResult {
    try {
      const r = this.read(input.batchId, input.actionId);
      if (r.kind !== "ok") return r;
      if (
        r.audit.proposalDigest !== input.proposalDigest ||
        (input.commitOrigin !== undefined &&
          (typeof input.commitOrigin !== "string" || !["p50-auto", "web-b3"].includes(input.commitOrigin)))
      )
        fail("corrupted");
      const expected: ExpectedAfter =
        input.expected.kind === "file"
          ? { ...input.expected, raw: Buffer.from(input.expected.raw) }
          : { kind: "missing" };
      if (
        expected.kind === "file" &&
        (hash(expected.raw) !== expected.digest || block(expected.raw, r.audit.targetId).rev !== expected.rev)
      )
        fail("corrupted");
      if ((r.audit.action === "delete") !== (expected.kind === "missing")) fail("corrupted");
      const ea: NonNullable<RevisionAudit["expectedAfter"]> =
        expected.kind === "file"
          ? { kind: "file", digest: expected.digest, rev: expected.rev, file: "after.md" }
          : { kind: "missing" };
      if (["commit-unknown", "skipped", "failed", "restored"].includes(r.audit.state))
        return { kind: "unavailable", reason: "expected-after-barrier:terminal-state" };
      if (r.audit.state !== "prepared") {
        if (
          (input.commitOrigin !== undefined && r.audit.commitOrigin !== input.commitOrigin) ||
          canonical(r.audit.expectedAfter) !== canonical(ea)
        )
          return { kind: "corrupted", reason: "expected-replay-mismatch" };
        return this.completeBarrier(r.audit);
      }
      if (expected.kind === "file") {
        const dir = this.path(input.batchId, input.actionId);
        if (statRegularIfExists(dir, "after.md")) fail("corrupted");
        this.writeFile(dir, "after.md", expected.raw);
      }
      this.writeAudit(
        {
          ...r.audit,
          state: "proposed",
          expectedAfter: ea,
          ...(input.commitOrigin === undefined ? {} : { commitOrigin: input.commitOrigin }),
        },
        true,
      );
      return this.read(input.batchId, input.actionId);
    } catch (e) {
      return this.failure(e, "expected-after-barrier");
    }
  }
  markUnknown(a: RevisionAudit, reason: string, observation: ApplyObservation): void {
    // Best effort only. A proposed disk state is still conservatively scanned.
    try {
      const disk = this.read(a.batchId, a.actionId);
      if (disk.kind === "ok" && !["prepared", "proposed"].includes(disk.audit.state)) return;
      this.writeAudit({
        ...a,
        state: "commit-unknown",
        reason,
        settledAt: this.deps.now().toISOString(),
        ...(contextualObservation(observation, a.targetId) ? { commitObservation: observation } : {}),
      });
    } catch {
      /* preserve existing evidence */
    }
  }
  finalize(input: Parameters<RevisionAuditPort["finalizeCommitLocked"]>[0]): CommitActionResult {
    const actionId = input.actionId;
    const unknown = (
      dataApplied: boolean | "unknown",
      reason: "post-apply-failure" | "observation-mismatch" | "finalization-failure",
      a?: RevisionAudit,
    ): CommitActionResult => {
      if (a && a.state === "proposed") this.markUnknown(a, reason, input.observation);
      return {
        kind: "effect-unknown",
        actionId,
        dataApplied,
        reason,
        ...(a?.expectedAfter?.kind === "file" ? { expectedAfterRev: a.expectedAfter.rev } : {}),
      };
    };
    const o = input.observation;
    const applied = o.kind === "applied" ? true : o.kind === "not-applied" ? false : "unknown";
    const r = this.read(input.batchId, input.actionId);
    if (r.kind !== "ok")
      return applied === false
        ? { kind: "skipped", actionId, reason: "unavailable" }
        : unknown(applied, "finalization-failure");
    const a = r.audit;
    if (a.proposalDigest !== input.proposalDigest) return unknown(applied, "observation-mismatch", a);
    if (a.state === "committed" || a.state === "restored")
      return {
        kind: "committed",
        actionId,
        ...(a.expectedAfter?.kind === "file" ? { afterRev: a.expectedAfter.rev } : {}),
      };
    if (a.state === "commit-unknown") return unknown("unknown", "finalization-failure");
    if (a.state !== "proposed")
      return applied === false
        ? { kind: "skipped", actionId, reason: "stale" }
        : unknown(applied, "observation-mismatch");
    try {
      if (!contextualObservation(o, a.targetId)) return unknown("unknown", "observation-mismatch", a);
      if (o.kind === "not-applied") {
        this.writeAudit({
          ...a,
          state: "skipped",
          commitObservation: o,
          reason: "no-commit-observed",
          settledAt: this.deps.now().toISOString(),
        });
        return { kind: "skipped", actionId, reason: "stale" };
      }
      if (o.kind === "unknown") return unknown("unknown", "post-apply-failure", a);
      const expected = a.expectedAfter;
      if (
        !expected ||
        expected.kind !== o.expectedAfter.kind ||
        (expected.kind === "file" &&
          (o.expectedAfter.kind !== "file" ||
            expected.digest !== o.expectedAfter.digest ||
            expected.rev !== o.expectedAfter.rev))
      )
        return unknown(true, "observation-mismatch", a);
      this.check(true);
      const current = this.current(a.targetId);
      if (
        expected.kind === "file"
          ? !current || hash(current) !== expected.digest || block(current, a.targetId).rev !== expected.rev
          : current !== undefined
      )
        return unknown(true, "observation-mismatch", a);
      const required = a.action === "delete" ? [this.blocks, join(this.blocks, ".trash")] : [this.blocks];
      if (
        canonical([...new Set(input.dataDirectories.map((d) => resolve(d)))].sort()) !== canonical([...required].sort())
      )
        return unknown(true, "observation-mismatch", a);
      for (const d of required) {
        this.check(true);
        if (d !== this.blocks) this.privateDir(d);
        fsyncDir(d);
      }
      this.check(true);
      this.writeAudit({ ...a, state: "committed", commitObservation: o, settledAt: this.deps.now().toISOString() });
      return { kind: "committed", actionId, ...(expected.kind === "file" ? { afterRev: expected.rev } : {}) };
    } catch {
      return unknown(applied, "post-apply-failure", a);
    }
  }
  enumerate(): { batchId: string; actionId: string }[] {
    this.check();
    let p = this.blocks;
    for (const n of [".jev", "revisions"]) {
      p = join(p, n);
      try {
        this.identities.set(p, this.privateDir(p));
      } catch (e) {
        if (errno(e) === "ENOENT") return [];
        throw e;
      }
    }
    const batches = listRevisionNamesBounded(this.revisions, REVISION_SCAN_BATCH_LIMIT);
    const result: { batchId: string; actionId: string }[] = [];
    for (const b of batches) {
      this.check();
      if (!digest(b)) fail("corrupted");
      this.identities.set(join(this.revisions, b), this.privateDir(join(this.revisions, b)));
      for (const a of listRevisionNamesBounded(join(this.revisions, b), REVISION_SCAN_ACTION_LIMIT)) {
        if (!digest(a)) fail("corrupted");
        if (result.length >= REVISION_SCAN_ACTION_LIMIT) fail("unavailable");
        result.push({ batchId: b, actionId: a });
      }
    }
    this.check();
    return result;
  }
  scan(): readonly RevisionRecoveryDiagnostic[] {
    try {
      return this.enumerate().map(({ batchId, actionId }): RevisionRecoveryDiagnostic => {
        const r = this.read(batchId, actionId);
        if (r.kind === "unavailable") return { kind: "unavailable", reason: r.reason ?? "audit-read-unavailable" };
        if (r.kind !== "ok")
          return { kind: "action", batchId, actionId, state: "corrupted", reason: r.reason ?? r.kind };
        const a = r.audit;
        if (!["prepared", "proposed"].includes(a.state))
          return { kind: "action", batchId, actionId, state: a.state, ...(a.reason ? { reason: a.reason } : {}) };
        let current: Buffer | undefined;
        try {
          current = this.current(a.targetId);
        } catch (e) {
          if (e instanceof Refusal && e.reason === "stale")
            return { kind: "action", batchId, actionId, state: "commit-unknown", reason: "unexpected-current" };
          throw e;
        }
        if (current?.equals(r.before))
          return { kind: "action", batchId, actionId, state: "skipped", reason: "no-commit-observed" };
        const expected = r.expectedAfter;
        const reason =
          a.state === "proposed" &&
          expected?.kind === "file" &&
          current &&
          hash(current) === expected.digest &&
          block(current, a.targetId).rev === expected.rev
            ? "expected-after-without-commit-marker"
            : a.state === "proposed" && expected?.kind === "missing" && current === undefined
              ? "expected-missing-without-commit-marker"
              : "unexpected-current";
        return { kind: "action", batchId, actionId, state: "commit-unknown", reason };
      });
    } catch {
      return [{ kind: "unavailable", reason: "revision scan incomplete/unavailable" }];
    }
  }
}

export function createRevisionAuditPort(memDir: string, deps: RevisionAuditDeps): RevisionAuditPort {
  // Lazy construction: absent read/scan never mkdir. The factory pins its first
  // observed directory identity; frozen/audit identity also survives restart.
  let kernel: Kernel | undefined;
  const get = (): Kernel => (kernel ??= new Kernel(memDir, deps));
  const unavailable = (e: unknown): AuditReadResult => ({
    kind: "unavailable",
    reason: e instanceof Refusal ? e.reason : "audit-unavailable",
  });
  return {
    readActionLocked(batchId, actionId) {
      try {
        return get().read(batchId, actionId);
      } catch (e) {
        return unavailable(e);
      }
    },
    persistPreparedBarrierLocked(input) {
      try {
        return get().prepare(input);
      } catch (e) {
        return unavailable(e);
      }
    },
    persistExpectedAfterBarrierLocked(input) {
      try {
        return get().expected(input);
      } catch (e) {
        return unavailable(e);
      }
    },
    finalizeCommitLocked(input) {
      try {
        return get().finalize(input);
      } catch {
        return input.observation.kind === "not-applied"
          ? { kind: "skipped", actionId: input.actionId, reason: "unavailable" }
          : {
              kind: "effect-unknown",
              actionId: input.actionId,
              dataApplied: "unknown",
              reason: "finalization-failure",
            };
      }
    },
    scanPendingLocked() {
      try {
        return get().scan();
      } catch {
        return [{ kind: "unavailable", reason: "revision scan unavailable" }];
      }
    },
  };
}

export const restoreRevisionRawLocked: RestoreRevisionRawLocked = (memDir, request, deps) => {
  let k: Kernel;
  let audit: RevisionAudit | undefined;
  let observation: ApplyObservation = { kind: "not-applied" };
  let intent = false;
  try {
    if (!digest(request.actionId)) return { kind: "refused", reason: "corrupted" };
    k = new Kernel(memDir, deps);
    const check = (): void => {
      if (request.signal?.aborted) fail("gate");
      k.check(true);
    };
    check();
    const matches = k.enumerate().filter((a) => a.actionId === request.actionId);
    if (matches.length > 1) return { kind: "refused", reason: "ambiguous" };
    if (!matches.length) return { kind: "refused", reason: "unavailable" };
    const found = matches[0]!;
    const r = k.read(found.batchId, found.actionId);
    if (r.kind !== "ok")
      return {
        kind: "refused",
        reason:
          r.kind === "corrupted"
            ? "corrupted"
            : r.reason === "permission"
              ? "permission"
              : r.reason === "gate"
                ? "gate"
                : "unavailable",
      };
    audit = r.audit;
    const a = audit;
    if (a.state !== "committed" || a.restoreAttempt) return { kind: "refused", reason: "state" };
    if (a.action === "delete" && block(r.before, a.targetId).meta.authority === "user")
      return { kind: "refused", reason: "permission" };
    const expected = r.expectedAfter;
    if (!expected) return { kind: "refused", reason: "corrupted" };
    const cas = (): void => {
      check();
      const current = k.current(a.targetId);
      if (
        expected.kind === "missing"
          ? current !== undefined
          : !current || hash(current) !== expected.digest || block(current, a.targetId).rev !== expected.rev
      )
        fail("stale");
    };
    cas();
    const startedAt = deps.now().toISOString();
    // Intent is durable BEFORE even the restore temp write. Its presence is a
    // conservative poison on ordinary retry, including failures before data CAS.
    intent = true;
    k.writeAudit({ ...a, restoreAttempt: { state: "intent", startedAt } });
    check();
    const tmp = writeTempRegular(k.blocks, `${a.targetId}.md`, Buffer.from(r.before), 0o600);
    cas();
    const opts = {
      beforeSyscall: cas,
      observe: (o: ApplyObservation) => {
        observation = o;
      },
    };
    const binding = { digest: a.beforeDigest, rev: a.expectedRev };
    const result =
      expected.kind === "missing"
        ? createRevisionObserved(k.blocks, tmp, `${a.targetId}.md`, binding, opts)
        : replaceRevisionObserved(k.blocks, tmp, `${a.targetId}.md`, binding, opts);
    observation = result.observation;
    if (result.error || observation.kind !== "applied")
      throw new Error(result.error ?? "restore observation unavailable");
    check();
    fsyncDir(k.blocks);
    check();
    // Drop intent only in the final durable restored state. Never roll data back.
    k.writeAudit({ ...a, state: "restored", settledAt: deps.now().toISOString() });
    return { kind: "restored", actionId: a.actionId };
  } catch (e) {
    if (intent && audit) {
      try {
        const disk = k!.read(audit.batchId, audit.actionId);
        if (disk.kind !== "ok" || disk.audit.state !== "restored")
          k!.writeAudit({
            ...audit,
            restoreAttempt: {
              state: "effect-unknown",
              startedAt: deps.now().toISOString(),
              observation,
              reason: "restore-finalization-failure",
            },
          });
      } catch {
        /* durable intent, or even restored marker, remains; no compensation */
      }
      return {
        kind: "effect-unknown",
        dataApplied: observation.kind === "applied" ? true : "unknown",
        reason: "restore-attempt-unresolved",
      };
    }
    return { kind: "refused", reason: e instanceof Refusal ? e.reason : "unavailable" };
  }
};

export const restoreRevisionRaw: RestoreRevisionRaw = async (memDir, request, deps) => {
  try {
    // Do not create even .lock if the read-only root probe/gate refuses.
    const k = new Kernel(memDir, deps);
    k.check();
    const canonical = k.mem;
    return await withMemoryDirLock(canonical, () => restoreRevisionRawLocked(canonical, request, deps));
  } catch (e) {
    return { kind: "refused", reason: e instanceof Refusal ? e.reason : "unavailable" };
  }
};
