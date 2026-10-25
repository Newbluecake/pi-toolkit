// Shared backup/manifest primitives for `/mem tidy` apply and `/mem
// restore` (§7.3 step 7, §7.5) — todo #22 P4. Every fs touch goes through
// `../safe-fs.js`; this file has zero `node:fs` import itself (enforced by
// `tests/memory/fs-guard.test.ts`).
import { join } from "node:path";
import {
  assertEpoch,
  canonicalDir,
  createExclusive,
  ensurePrivateDir,
  listDirNames,
  readRegular,
  removeFlatDir,
  renameNoClobber,
  replaceAtomic,
  resolveLoc,
  statRegularIfExists,
  writeTempRegular,
  writeTxnTemp,
  fsyncDirBestEffort,
  type RunDirs,
} from "../safe-fs.js";
import {
  type TidyManifest,
  type TidyManifestEntry,
  type TidyManifestV2,
  type JournalEvent,
  type Loc,
  type Ident,
  type Obs,
  type OpSpec,
  type Phase,
} from "../contracts.js";
import { isV2Name } from "../safe-fs.js";
import { TMP_RE } from "../tmp-names.js";
import { validateRunEvents } from "./journal.js";

export const MANIFEST_NAME = "manifest.json";
export interface PlannedManifestOp {
  opId: string;
  seq: number;
  step: number;
  group?: number;
  phase: "archive" | "normalize" | "restore" | "frontmatter";
  op: import("../contracts.js").OpSpec;
}
type RunEventV2 = Extract<JournalEvent, { ev: "run" }> & { planned?: readonly PlannedManifestOp[] };
export const MAX_BACKUPS = 10;

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}
export function newTidyId(now: Date, pid: number, rand6: string): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}Z`;
  return `${stamp}-${pid}-${rand6}`;
}
function relBackupDir(id: string): string {
  return join(".backup", id);
}
function relBackupPath(id: string, name: string): string {
  return join(".backup", id, name);
}

export function backupLiveFile(dir: string, id: string, name: string): void {
  ensurePrivateDir(join(dir, relBackupDir(id)));
  renameNoClobber(dir, name, relBackupPath(id, name));
}
export function recreateFromBackup(dir: string, id: string, srcName: string, destName: string): void {
  const { text } = readRegular(join(dir, relBackupDir(id)), srcName);
  const tmp = writeTempRegular(dir, destName, Buffer.from(text, "utf8"), 0o600);
  createExclusive(dir, tmp, destName);
}
export function copyLiveFileToBackup(dir: string, id: string, name: string): void {
  const backupDir = join(dir, relBackupDir(id));
  ensurePrivateDir(backupDir);
  const { text } = readRegular(dir, name);
  const tmp = writeTempRegular(backupDir, name, Buffer.from(text, "utf8"), 0o600);
  createExclusive(backupDir, tmp, name);
}
export function readManifest(dir: string, id: string): TidyManifest | undefined {
  try {
    const value: unknown = JSON.parse(readRegular(join(dir, relBackupDir(id)), MANIFEST_NAME).text);
    if (isV1Manifest(value)) return value;
    if (isV2ManifestShape(value)) return legacyProjection(value);
    return undefined;
  } catch {
    return undefined;
  }
}

export interface BackupSummary {
  id: string;
  kind: TidyManifest["kind"];
  createdAt: string;
  fileCount: number;
}
const BACKUP_ID_RE = /^\d{8}T\d{9}Z-\d+-[0-9a-f]{6}$/;
export interface PruneBackupsResult {
  removedIds: string[];
  skipped: { id: string; reason: string }[];
}
export function listBackups(dir: string, keep = MAX_BACKUPS): BackupSummary[] {
  const out: BackupSummary[] = [];
  for (const id of listDirNames(join(dir, ".backup"))) {
    const m = readManifest(dir, id);
    if (!m) continue;
    out.push({ id, kind: m.kind, createdAt: m.createdAt, fileCount: m.entries.length });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out.slice(0, keep);
}
export function pruneBackups(dir: string, keep = MAX_BACKUPS): PruneBackupsResult {
  const removedIds: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const backupDir = join(dir, ".backup");
  const parent = canonicalDir(backupDir);
  if (!parent) return { removedIds, skipped };
  const ids = listDirNames(backupDir)
    .filter((id) => BACKUP_ID_RE.test(id))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const id of ids.slice(keep)) {
    try {
      const result = removeFlatDir(parent, id);
      result.removed ? removedIds.push(id) : skipped.push({ id, reason: result.reason });
    } catch (err) {
      skipped.push({ id, reason: (err as Error).message });
    }
  }
  return { removedIds, skipped };
}
export function listTrashEntries(dir: string): { id: string; name: string; fileName: string }[] {
  const out: { id: string; name: string; fileName: string }[] = [];
  const re = /^(\d{8}T\d{9}Z-\d+-[0-9a-f]{6})-(.+)$/;
  for (const fileName of listDirNames(join(dir, ".trash"))) {
    const m = re.exec(fileName);
    if (m?.[1] && m[2]) out.push({ id: m[1], name: m[2], fileName });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
export function vacateLiveFile(dir: string, id: string, name: string): void {
  const vacateDir = join(dir, relBackupDir(id), "__vacated__");
  ensurePrivateDir(vacateDir);
  renameNoClobber(dir, name, join(relBackupDir(id), "__vacated__", name));
}

// ───────────────────────────── v2 journal manifests ─────────────────────────────

export type ManifestParseResult =
  { ok: true; manifest: TidyManifestV2; legacy: false } | { ok: true; manifest: TidyManifest; legacy: true };
export class ManifestValidationError extends Error {
  readonly code = "INVALID_MANIFEST";
}
export function manifestPath(dirs: RunDirs, id: string): string {
  if (dirs.id !== id) throw new ManifestValidationError("manifest id does not match run directory");
  return join(dirs.backup.path, MANIFEST_NAME);
}

function own(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ManifestValidationError(`${where} must be an object`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object))
    if (!keys.includes(key)) throw new ManifestValidationError(`${where}.${key} is unknown`);
  return object;
}
function str(value: unknown, where: string): string {
  if (typeof value !== "string") throw new ManifestValidationError(`${where} must be a string`);
  return value;
}
function nonNegative(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ManifestValidationError(`${where} must be a non-negative integer`);
  return value as number;
}
function ident(value: unknown, where: string): Ident {
  const o = own(value, ["dev", "ino", "sha", "size"], where);
  const sha = str(o.sha, `${where}.sha`);
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new ManifestValidationError(`${where}.sha is not hex sha256`);
  return {
    dev: nonNegative(o.dev, `${where}.dev`),
    ino: nonNegative(o.ino, `${where}.ino`),
    sha,
    size: nonNegative(o.size, `${where}.size`),
  };
}
function loc(value: unknown, where: string): Loc {
  const o = own(value, ["area", "name", "within"], where);
  const area = str(o.area, `${where}.area`);
  const name = str(o.name, `${where}.name`);
  if (area === "tmp") {
    const within = str(o.within, `${where}.within`);
    if (!["root", "live", "archive", "backup", "trash"].includes(within) || !TMP_RE.test(name))
      throw new ManifestValidationError(`${where} invalid tmp`);
    return { area: "tmp", within: within as "root" | "live" | "archive" | "backup" | "trash", name };
  }
  if (!["live", "archive", "backup", "trash"].includes(area))
    throw new ManifestValidationError(`${where}.area invalid`);
  if ((area === "live" || area === "archive") && !isV2Name(name))
    throw new ManifestValidationError(`${where}.name invalid`);
  if (area === "backup" && !/^s\d{1,3}-\d{1,5}-(live|archive|trash)--[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(name))
    throw new ManifestValidationError(`${where}.name invalid`);
  return { area: area as "live" | "archive" | "backup" | "trash", name };
}
function op(value: unknown, where: string): OpSpec {
  const o = own(
    value,
    ["prim", "src", "dst", "obj", "target", "afterSha", "tmpContent", "before", "backup", "tmpBackup"],
    where,
  );
  const prim = str(o.prim, `${where}.prim`);
  if (prim === "MOVE")
    return {
      prim,
      src: loc(o.src, `${where}.src`),
      dst: loc(o.dst, `${where}.dst`),
      obj: ident(o.obj, `${where}.obj`),
    };
  const afterSha = str(o.afterSha, `${where}.afterSha`);
  if (!/^[0-9a-f]{64}$/.test(afterSha)) throw new ManifestValidationError(`${where}.afterSha invalid`);
  if (prim === "CREATE")
    return {
      prim,
      target: loc(o.target, `${where}.target`),
      afterSha,
      tmpContent: loc(o.tmpContent, `${where}.tmpContent`),
    };
  if (prim === "REPLACE")
    return {
      prim,
      target: loc(o.target, `${where}.target`),
      before: ident(o.before, `${where}.before`),
      afterSha,
      backup: loc(o.backup, `${where}.backup`),
      tmpBackup: loc(o.tmpBackup, `${where}.tmpBackup`),
      tmpContent: loc(o.tmpContent, `${where}.tmpContent`),
    };
  throw new ManifestValidationError(`${where}.prim invalid`);
}
function obs(value: unknown, where: string): Obs {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ManifestValidationError(`${where} invalid`);
  const o = value as Record<string, unknown>;
  const kind = str(o.kind, `${where}.kind`);
  if (kind === "absent") {
    own(value, ["kind"], where);
    return { kind };
  }
  if (kind === "file") {
    own(value, ["kind", "dev", "ino", "sha", "size"], where);
    const sha = str(o.sha, `${where}.sha`);
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new ManifestValidationError(`${where}.sha invalid`);
    return {
      kind,
      dev: nonNegative(o.dev, `${where}.dev`),
      ino: nonNegative(o.ino, `${where}.ino`),
      sha,
      size: nonNegative(o.size, `${where}.size`),
    };
  }
  if (kind === "other") {
    own(value, ["kind", "reason"], where);
    const reason = str(o.reason, `${where}.reason`);
    if (!["symlink", "not-file", "unreadable", "racing", "too-large"].includes(reason))
      throw new ManifestValidationError(`${where}.reason invalid`);
    return {
      kind,
      reason: reason as Obs extends never ? never : "symlink" | "not-file" | "unreadable" | "racing" | "too-large",
    };
  }
  throw new ManifestValidationError(`${where}.kind invalid`);
}
function eventValue(value: unknown, index: number): JournalEvent {
  const where = `events[${index}]`;
  const o = value as Record<string, unknown>;
  const ev = str(o?.ev, `${where}.ev`);
  if (ev === "run") {
    own(value, ["ev", "state", "owner", "epoch", "recoveryOwner", "planned"], where);
    const state = str(o.state, `${where}.state`);
    if (!["applying", "complete", "aborted", "interrupted", "recovered", "conflict-reported"].includes(state))
      throw new ManifestValidationError(`${where}.state invalid`);
    return {
      ev,
      state: state as never,
      epoch: nonNegative(o.epoch, `${where}.epoch`),
      ...(o.owner === undefined ? {} : { owner: o.owner as never }),
      ...(o.recoveryOwner === undefined ? {} : { recoveryOwner: o.recoveryOwner as never }),
      ...(o.planned === undefined ? {} : { planned: parsePlanned(o.planned, where) }),
    } as RunEventV2 as JournalEvent;
  }
  if (ev === "intent") {
    own(value, ["ev", "opId", "seq", "step", "group", "phase", "op"], where);
    const phase = str(o.phase, `${where}.phase`) as Phase;
    if (!["archive", "normalize", "restore", "frontmatter"].includes(phase))
      throw new ManifestValidationError(`${where}.phase invalid`);
    return {
      ev,
      opId: str(o.opId, `${where}.opId`),
      seq: nonNegative(o.seq, `${where}.seq`),
      step: nonNegative(o.step, `${where}.step`),
      phase,
      op: op(o.op, `${where}.op`),
      ...(o.group === undefined ? {} : { group: nonNegative(o.group, `${where}.group`) }),
    } as JournalEvent;
  }
  if (ev === "staged") {
    own(value, ["ev", "opId", "which", "tmp", "ident"], where);
    const which = str(o.which, `${where}.which`);
    if (which !== "backup" && which !== "content") throw new ManifestValidationError(`${where}.which invalid`);
    return {
      ev,
      opId: str(o.opId, `${where}.opId`),
      which,
      tmp: loc(o.tmp, `${where}.tmp`),
      ident: ident(o.ident, `${where}.ident`),
    } as JournalEvent;
  }
  if (ev === "attempt") {
    own(value, ["ev", "opId", "by", "n"], where);
    const by = str(o.by, `${where}.by`);
    if (by !== "owner" && by !== "recovery") throw new ManifestValidationError(`${where}.by invalid`);
    if (o.n !== 1) throw new ManifestValidationError(`${where}.n invalid`);
    return { ev, opId: str(o.opId, `${where}.opId`), by, n: 1 } as JournalEvent;
  }
  if (ev === "result") {
    own(value, ["ev", "opId", "state", "reason", "final", "leftovers"], where);
    const state = str(o.state, `${where}.state`);
    if (!["done", "rolled-back", "skipped", "conflict"].includes(state))
      throw new ManifestValidationError(`${where}.state invalid`);
    if (!Array.isArray(o.final)) throw new ManifestValidationError(`${where}.final missing`);
    const final = o.final.map((v, i) => {
      const x = own(v, ["loc", "obs"], `${where}.final[${i}]`);
      return { loc: loc(x.loc, `${where}.final[${i}].loc`), obs: obs(x.obs, `${where}.final[${i}].obs`) };
    });
    const leftovers =
      o.leftovers === undefined
        ? undefined
        : Array.isArray(o.leftovers)
          ? o.leftovers.map((v, i) => {
              const x = own(v, ["loc", "obs"], `${where}.leftovers[${i}]`);
              return {
                loc: loc(x.loc, `${where}.leftovers[${i}].loc`),
                obs: obs(x.obs, `${where}.leftovers[${i}].obs`),
              };
            })
          : (() => {
              throw new ManifestValidationError(`${where}.leftovers invalid`);
            })();
    return {
      ev,
      opId: str(o.opId, `${where}.opId`),
      state: state as never,
      ...(o.reason === undefined ? {} : { reason: str(o.reason, `${where}.reason`) }),
      final,
      ...(leftovers ? { leftovers } : {}),
    } as JournalEvent;
  }
  throw new ManifestValidationError(`${where}.ev invalid`);
}
function parsePlanned(value: unknown, where: string): PlannedManifestOp[] {
  if (!Array.isArray(value)) throw new ManifestValidationError(`${where}.planned must be an array`);
  const result: PlannedManifestOp[] = [];
  const ids = new Set<string>();
  let previous = 0;
  for (const [index, item] of value.entries()) {
    const o = own(item, ["opId", "seq", "step", "group", "phase", "op"], `${where}.planned[${index}]`);
    const opId = str(o.opId, `${where}.planned[${index}].opId`);
    const seq = nonNegative(o.seq, `${where}.planned[${index}].seq`);
    if (seq !== previous + 1) throw new ManifestValidationError(`${where}.planned sequence is not contiguous`);
    if (ids.has(opId)) throw new ManifestValidationError(`${where}.planned opId is duplicated`);
    ids.add(opId);
    previous = seq;
    const step = nonNegative(o.step, `${where}.planned[${index}].step`);
    const phase = str(o.phase, `${where}.planned[${index}].phase`) as PlannedManifestOp["phase"];
    if (!["archive", "normalize", "restore", "frontmatter"].includes(phase))
      throw new ManifestValidationError(`${where}.planned phase invalid`);
    result.push({
      opId,
      seq,
      step,
      ...(o.group === undefined ? {} : { group: nonNegative(o.group, `${where}.planned[${index}].group`) }),
      phase,
      op: op(o.op, `${where}.planned[${index}].op`),
    });
  }
  return result;
}
function isV1Manifest(value: unknown): value is TidyManifest {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { v?: unknown }).v === 1 &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}
function isV2ManifestShape(value: unknown): value is TidyManifestV2 {
  return !!value && typeof value === "object" && (value as { v?: unknown }).v === 2;
}
function legacyProjection(m: TidyManifestV2): TidyManifest {
  const entries: TidyManifestEntry[] = [];
  const intents = new Map<string, Extract<JournalEvent, { ev: "intent" }>>();
  const results = new Map<string, Extract<JournalEvent, { ev: "result" }>>();
  for (const e of m.events) {
    if (e.ev === "intent") intents.set(e.opId, e);
    else if (e.ev === "result") results.set(e.opId, e);
  }
  const done = (opId: string): boolean => results.get(opId)?.state === "done";
  for (const intent of intents.values()) {
    if (!done(intent.opId)) continue;
    const operation = intent.op;
    if (operation.prim === "CREATE" && operation.target.area === "live") {
      const move = [...intents.values()].find(
        (candidate) =>
          candidate.group === intent.group &&
          candidate.op.prim === "MOVE" &&
          candidate.op.src.area === "live" &&
          candidate.op.dst.area === "backup",
      );
      if (intent.group !== undefined && move && done(move.opId) && move.op.prim === "MOVE")
        entries.push({
          name: move.op.src.name,
          op: "rename",
          newName: operation.target.name,
          beforeSha256: move.op.obj.sha,
          afterSha256: operation.afterSha,
          backupFile: move.op.dst.name,
        });
      else entries.push({ name: operation.target.name, op: "create", afterSha256: operation.afterSha });
    } else if (operation.prim === "MOVE" && operation.src.area === "live" && operation.dst.area === "backup") {
      const create = [...intents.values()].find(
        (candidate) => candidate.group === intent.group && candidate.op.prim === "CREATE",
      );
      if (intent.group === undefined || !create || !done(create.opId))
        entries.push({
          name: operation.src.name,
          op: "delete",
          beforeSha256: operation.obj.sha,
          backupFile: operation.dst.name,
        });
    } else if (operation.prim === "REPLACE" && operation.target.area === "live")
      entries.push({
        name: operation.target.name,
        op: "rewrite",
        beforeSha256: operation.before.sha,
        afterSha256: operation.afterSha,
        backupFile: operation.backup.name,
      });
  }
  return { v: 1, id: m.id, kind: m.kind === "batch" ? "tidy" : m.kind, createdAt: m.createdAt, entries };
}

/** Strict v2 parser. It intentionally does not accept unknown keys in any
 * journal event or operation; this prevents recovery from acting on a shape
 * newer than the executor understands. */
export function parseManifestStrict(raw: unknown, dirId: string): ManifestParseResult {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      throw new ManifestValidationError("manifest is not valid JSON");
    }
  }
  if (isV1Manifest(raw)) {
    if (raw.id !== dirId) throw new ManifestValidationError("manifest id mismatch");
    return { ok: true, manifest: raw, legacy: true };
  }
  const top = own(raw, ["v", "id", "kind", "createdAt", "events"], "manifest");
  if (top.v !== 2 || top.id !== dirId || typeof top.id !== "string" || !BACKUP_ID_RE.test(top.id as string))
    throw new ManifestValidationError("invalid v2 header");
  const kind = str(top.kind, "manifest.kind");
  if (
    !["tidy", "frontmatter", "restore", "batch"].includes(kind) ||
    typeof top.createdAt !== "string" ||
    !Array.isArray(top.events)
  )
    throw new ManifestValidationError("invalid v2 header");
  const events = top.events.map(eventValue);
  const seen = new Set<string>();
  const attempts = new Set<string>();
  const results = new Set<string>();
  const stagedKinds = new Set<string>();
  let seq = 0;
  let previousStep = 0;
  let epoch = 0;
  for (const e of events) {
    if (e.ev === "run") {
      if (e.epoch < epoch) throw new ManifestValidationError("run epoch decreased");
      epoch = e.epoch;
    }
    if (e.ev === "intent") {
      if (e.seq !== seq + 1 || seen.has(e.opId) || e.step < previousStep)
        throw new ManifestValidationError(
          `invalid intent sequence seq=${e.seq} expected=${seq + 1} step=${e.step} previous=${previousStep}`,
        );
      seq = e.seq;
      previousStep = e.step;
      seen.add(e.opId);
    } else if (e.ev === "staged") {
      if (!seen.has(e.opId) || stagedKinds.has(`${e.opId}:${e.which}`))
        throw new ManifestValidationError("invalid staged event");
      stagedKinds.add(`${e.opId}:${e.which}`);
    } else if (e.ev === "attempt") {
      if (!seen.has(e.opId) || attempts.has(e.opId) || results.has(e.opId))
        throw new ManifestValidationError("invalid attempt event");
      attempts.add(e.opId);
    } else if (e.ev === "result") {
      if (!seen.has(e.opId) || results.has(e.opId)) throw new ManifestValidationError("invalid result event");
      results.add(e.opId);
    }
  }
  const locKey = (value: Loc): string =>
    value.area === "tmp" ? `tmp:${value.within}:${value.name}` : `${value.area}:${value.name}`;
  const opLocations = (value: OpSpec): Loc[] =>
    value.prim === "MOVE"
      ? [value.src, value.dst]
      : value.prim === "CREATE"
        ? [value.target, value.tmpContent]
        : [value.target, value.backup, value.tmpBackup, value.tmpContent];
  for (const result of events.filter((e): e is Extract<JournalEvent, { ev: "result" }> => e.ev === "result")) {
    const intent = events.find(
      (e): e is Extract<JournalEvent, { ev: "intent" }> => e.ev === "intent" && e.opId === result.opId,
    );
    if (!intent) throw new ManifestValidationError("result references unknown intent");
    const expected = opLocations(intent.op).map(locKey).sort();
    const actual = result.final.map((item) => locKey(item.loc)).sort();
    if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index]))
      throw new ManifestValidationError("result.final does not cover exactly the op locations");
  }
  const runWithPlan = [...events]
    .reverse()
    .find((event) => event.ev === "run" && (event as RunEventV2).planned !== undefined) as RunEventV2 | undefined;
  if (runWithPlan) {
    const plannedIds = new Set(runWithPlan.planned!.map((item) => item.opId));
    for (const intent of events.filter(
      (event): event is Extract<JournalEvent, { ev: "intent" }> => event.ev === "intent",
    ))
      if (!plannedIds.has(intent.opId))
        throw new ManifestValidationError("intent is not in the planned operation list");
  }
  const intentsInOrder = events.filter(
    (event): event is Extract<JournalEvent, { ev: "intent" }> => event.ev === "intent",
  );
  for (let index = 0; index < intentsInOrder.length; index++) {
    const current = intentsInOrder[index];
    if (!current || current.group === undefined) continue;
    const next = intentsInOrder[index + 1];
    if (!next) {
      // A crash between the two journal intents leaves a resumable partial
      // group; it is valid until the run reaches a terminal state.
      continue;
    }
    if (next.group !== current.group || current.op.prim !== "CREATE" || next.op.prim !== "MOVE")
      throw new ManifestValidationError("group must be adjacent CREATE then MOVE");
    index++;
  }
  const state = validateRunEvents(events);
  if (!state.ok) throw new ManifestValidationError(state.reason ?? "invalid run state");
  const terminal = [...events].reverse().find((e): e is RunEventV2 => e.ev === "run");
  const plannedIds = terminal?.planned?.map((item) => item.opId);
  if (
    terminal &&
    ["complete", "aborted", "recovered", "conflict-reported"].includes(terminal.state) &&
    (plannedIds ? plannedIds.some((opId) => !results.has(opId)) : results.size !== seen.size)
  )
    throw new ManifestValidationError("terminal manifest has incomplete operations");
  return {
    ok: true,
    legacy: false,
    manifest: { v: 2, id: top.id, kind: kind as TidyManifestV2["kind"], createdAt: top.createdAt as string, events },
  };
}

export function createManifestV2(
  dirs: RunDirs,
  id: string,
  kind: TidyManifestV2["kind"],
  first: RunEventV2,
): TidyManifestV2 {
  ensurePrivateDir(dirs.backup.path);
  const manifest: TidyManifestV2 = {
    v: 2,
    id,
    kind,
    createdAt: new Date().toISOString(),
    events: [first as JournalEvent],
  };
  const tmp = writeTxnTemp(dirs.backup.path, "m", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  replaceAtomic(dirs.backup.path, tmp, MANIFEST_NAME);
  fsyncDirBestEffort(dirs.backup.path, undefined, dirs.fsyncWarnings);
  return manifest;
}
export function readManifestV2(dirs: RunDirs, id: string): TidyManifestV2 | undefined {
  try {
    const value: unknown = JSON.parse(readRegular(dirs.backup.path, MANIFEST_NAME).text);
    const parsed = parseManifestStrict(value, id);
    return parsed.legacy ? undefined : parsed.manifest;
  } catch {
    return undefined;
  }
}
export function appendJournal(
  dirs: RunDirs,
  nameOrPath: string,
  event: JournalEvent | RunEventV2,
  epoch: number,
): TidyManifestV2 {
  assertEpoch(dirs, epoch);
  const path = nameOrPath.endsWith(MANIFEST_NAME) ? nameOrPath : join(dirs.backup.path, nameOrPath);
  const raw = JSON.parse(readRegular(dirs.backup.path, MANIFEST_NAME).text) as unknown;
  const parsed = parseManifestStrict(raw, dirs.id);
  if (parsed.legacy) throw new ManifestValidationError("v1 manifests are read-only");
  assertEpoch(dirs, epoch);
  const next: TidyManifestV2 = { ...parsed.manifest, events: [...parsed.manifest.events, event as JournalEvent] };
  const tmp = writeTxnTemp(dirs.backup.path, "m", Buffer.from(JSON.stringify(next, null, 2), "utf8"));
  assertEpoch(dirs, epoch);
  replaceAtomic(dirs.backup.path, tmp, path === manifestPath(dirs, dirs.id) ? MANIFEST_NAME : MANIFEST_NAME);
  fsyncDirBestEffort(dirs.backup.path, undefined, dirs.fsyncWarnings);
  return next;
}
