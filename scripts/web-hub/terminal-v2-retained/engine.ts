/** Retained initialization is NOT the strict fresh/ACK-cycle engine. It opens the
 * existing S; independent retries read immutable operation/source/backup records.
 * The caller must seal actual publishers and hold installation + original singleton
 * ownership for EVERY call. A callback alone is not CLI producer evidence. */
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  TerminalMarkerV2Schema,
  createInitialTerminalLedgerV2,
  terminalInitialLedgerV2Ok,
  terminalLedgerV2Ok,
  terminalMarkersV2Match,
  type LedgerV2,
  type LegacyUnattributedObligationV1,
  type TerminalMarkerV2,
} from "../../../src/web-hub/protocol/terminal-v2.js";
import { HeldDirectory, digest, json, parse, type CapturedFile } from "../terminal-v2-maintenance/files.js";
import { readRetirementArchive } from "../terminal-v2-maintenance/archive-reader.js";
import { captureTerminalSource, type TerminalSourceSnapshot } from "./snapshot.js";
import { readRetainedSource } from "./source-reader.js";
import { mapRetainedObligations } from "./mapping.js";
import { backupTerminalSource } from "./backup.js";
import { publishRetainedFile } from "./durable.js";
const closed = <T extends TProperties>(p: T) => Type.Object(p, { additionalProperties: false });
const sha = Type.String({ pattern: "^[a-f0-9]{64}$" }),
  token = Type.String({ pattern: "^[A-Za-z0-9_-]{32,64}$" });
const uint = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const stateSchema = closed({ path: Type.String({ minLength: 1, maxLength: 4096 }), dev: uint, ino: uint });
const anchorSchema = closed({
  v: Type.Literal(1),
  kind: Type.Literal("retained-installation-anchor"),
  state: stateSchema,
  oldStoreId: token,
  rootDev: uint,
  rootIno: uint,
  nonce: token,
});
const preparationSchema = closed({
  v: Type.Literal(1),
  kind: Type.Literal("retained-source-pinned"),
  operationId: token,
  installationSha256: sha,
  sourceManifestSha256: sha,
  state: stateSchema,
  evidencePath: Type.String({ minLength: 1, maxLength: 4096 }),
});
const intentSchema = closed({
  v: Type.Literal(1),
  kind: Type.Literal("retained-initialization-prepared"),
  operationId: token,
  installationSha256: sha,
  sourceManifestSha256: sha,
  mappingSha256: sha,
  backupCompleteSha256: sha,
  state: stateSchema,
  evidencePath: Type.String({ minLength: 1, maxLength: 4096 }),
  marker: TerminalMarkerV2Schema,
});
const completeSchema = closed({
  v: Type.Literal(1),
  kind: Type.Literal("retained-initialization-complete"),
  operationId: token,
  intentSha256: sha,
  initialLedgerSha256: sha,
  markerSha256: sha,
});
export type RetainedIntent = Static<typeof intentSchema>;
type Intent = RetainedIntent;
export function readRetainedIntent(directory: HeldDirectory): { intent: RetainedIntent; file: CapturedFile } {
  const file = directory.read("active-operation.json", 16384);
  return { intent: check<RetainedIntent>(intentSchema, parse(file.bytes)), file };
}
const mint = () => randomBytes(24).toString("base64url");
function check<T>(schema: Parameters<typeof Value.Check>[0], raw: unknown): T {
  if (!Value.Check(schema, raw)) throw new Error("E_RETAINED_RECORD_SHAPE");
  return raw as T;
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export interface RetainedInitializationResult {
  phase: "initialization-complete";
  operationId: string;
  sourceInstallationId: string;
  sourceManifestSha256: string;
  legacyObligations: number;
  normalAllocations: number;
  publication: "not-asserted";
  outcome: "committed" | "already-complete";
}
export interface RetainedInitializationInput {
  state: HeldDirectory;
  installation: HeldDirectory;
  evidence: HeldDirectory;
  /** Real caller ownership check, NOT an operator-supplied boolean/proof JSON. */
  guard(): void;
}
function readBackup(snapshot: TerminalSourceSnapshot, backup: HeldDirectory, guard: () => void): string {
  const manifest = backup.read("source-manifest.json", 2 * 1024 * 1024),
    indexFile = backup.read("backup-index.json", 2 * 1024 * 1024),
    complete = backup.read("backup-complete.json", 2048);
  if (!manifest.bytes.equals(json(snapshot.manifest))) throw new Error("E_RETAINED_SOURCE_CHANGED");
  const expectedIndex = {
    v: 1,
    sourceManifestSha256: snapshot.manifestSha256,
    files: [...snapshot.files.values()]
      .sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0))
      .map((f, n) => ({ source: f.entry.path, backup: `file-${String(n).padStart(4, "0")}`, sha256: f.entry.sha256 })),
  };
  if (
    !indexFile.bytes.equals(json(expectedIndex)) ||
    !complete.bytes.equals(
      json({
        v: 1,
        kind: "terminal-retained-backup",
        sourceManifestSha256: snapshot.manifestSha256,
        indexSha256: digest(indexFile.bytes),
        files: snapshot.files.size,
      }),
    )
  )
    throw new Error("E_RETAINED_BACKUP_CHANGED");
  const expected = [
    "source-manifest.json",
    "backup-index.json",
    "backup-complete.json",
    ...expectedIndex.files.map((f) => f.backup),
  ].sort();
  if (!same(readdirSync(`/proc/self/fd/${backup.fd}`).sort(), expected)) throw new Error("E_RETAINED_BACKUP_CHANGED");
  for (const entry of expectedIndex.files) {
    guard();
    const original = snapshot.files.get(entry.source)!,
      copied = backup.read(entry.backup, original.bytes.length);
    if (!copied.bytes.equals(original.bytes)) throw new Error("E_RETAINED_BACKUP_CHANGED");
    backup.syncFile(copied);
    guard();
  }
  for (const f of [manifest, indexFile, complete]) {
    guard();
    backup.syncFile(f);
  }
  backup.sync();
  guard();
  snapshot.verify();
  return digest(complete.bytes);
}
/** Must only be called with actual stopped publishers. Never publishes a package,
 * lowers a floor, runs O, restores auth or reimports missing/retired obligations. */
export function initializeRetained(input: RetainedInitializationInput): RetainedInitializationResult {
  if (process.platform !== "linux" || process.env.PI_SECURE_SESSION || process.env.PI_SECURE_VAULT)
    throw new Error("E_RETAINED_PLAIN_LINUX_REQUIRED");
  const { state, installation, evidence } = input;
  const guard = () => {
    input.guard();
    state.check();
    installation.check();
    evidence.check();
  };
  guard();
  const snapshot = captureTerminalSource(state, guard);
  let backup: HeldDirectory | undefined, root: HeldDirectory | undefined;
  try {
    const inventory = readRetainedSource(snapshot),
      oldRoot = snapshot.manifest.directories.find((d) => d.path === "terminal-v1")!;
    const stateIdentity = { path: state.path, dev: state.identity.dev, ino: state.identity.ino };
    let anchorFile: CapturedFile;
    if (installation.absent("installation-anchor.json")) {
      // A partial intent or existing v2 is not permission to create a different installation ID.
      if (
        !installation.absent("active-operation.json") ||
        !state.absent("terminal-v2") ||
        !state.absent(".terminal-initialized-v2")
      )
        throw new Error("E_RETAINED_ANCHOR_MISSING");
      anchorFile = publishRetainedFile(
        installation,
        "installation-anchor.json",
        json({
          v: 1,
          kind: "retained-installation-anchor",
          state: stateIdentity,
          oldStoreId: inventory.storeId,
          rootDev: oldRoot.metadata.dev,
          rootIno: oldRoot.metadata.ino,
          nonce: mint(),
        }),
        guard,
      );
    } else anchorFile = installation.read("installation-anchor.json", 4096);
    const anchor = check<Static<typeof anchorSchema>>(anchorSchema, parse(anchorFile.bytes));
    if (
      !same(anchor.state, stateIdentity) ||
      anchor.oldStoreId !== inventory.storeId ||
      anchor.rootDev !== oldRoot.metadata.dev ||
      anchor.rootIno !== oldRoot.metadata.ino
    )
      throw new Error("E_RETAINED_INSTALLATION_CHANGED");
    const sourceInstallationId = digest(anchorFile.bytes);
    let preparationFile: CapturedFile;
    if (installation.absent("source-prepared.json")) {
      if (!installation.absent("active-operation.json")) throw new Error("E_RETAINED_PREPARATION_MISSING");
      preparationFile = publishRetainedFile(
        installation,
        "source-prepared.json",
        json({
          v: 1,
          kind: "retained-source-pinned",
          operationId: mint(),
          installationSha256: sourceInstallationId,
          sourceManifestSha256: snapshot.manifestSha256,
          state: stateIdentity,
          evidencePath: evidence.path,
        }),
        guard,
      );
    } else preparationFile = installation.read("source-prepared.json", 16384);
    const preparation = check<Static<typeof preparationSchema>>(preparationSchema, parse(preparationFile.bytes));
    if (
      !same(preparation.state, stateIdentity) ||
      preparation.evidencePath !== evidence.path ||
      preparation.installationSha256 !== sourceInstallationId ||
      preparation.sourceManifestSha256 !== snapshot.manifestSha256
    )
      throw new Error("E_RETAINED_PREPARATION_CHANGED");
    const obligations = mapRetainedObligations(sourceInstallationId, snapshot.manifestSha256, inventory.resources);
    if (obligations.length > 32) throw new Error("E_RETAINED_LEDGER_CAPACITY");
    let intentFile: CapturedFile;
    const existing = !installation.absent("active-operation.json");
    if (!existing) {
      if (
        !state.absent("terminal-v2") ||
        !state.absent(".terminal-initialized-v2") ||
        !state.absent(".terminal-allocation-archive-v2")
      )
        throw new Error("E_RETAINED_EXISTING_V2");
      if (evidence.names().length) throw new Error("E_RETAINED_PARTIAL_EVIDENCE");
      backup = evidence.mkdir("backup");
      const backed = backupTerminalSource(snapshot, backup, guard);
      backed.verify();
      const mapping = publishRetainedFile(evidence, "mapping.json", json(obligations), guard);
      const marker: TerminalMarkerV2 = {
        v: 2,
        storeId: mint(),
        checkpointId: mint(),
        initialization: "offline-retained-unknown",
      };
      const initial = createInitialTerminalLedgerV2(marker, obligations);
      if (!terminalInitialLedgerV2Ok(initial, marker) || json(initial).length > 65536)
        throw new Error("E_RETAINED_LEDGER_CAPACITY");
      const prepared: Intent = {
        v: 1,
        kind: "retained-initialization-prepared",
        operationId: preparation.operationId,
        installationSha256: sourceInstallationId,
        sourceManifestSha256: snapshot.manifestSha256,
        mappingSha256: digest(mapping.bytes),
        backupCompleteSha256: backed.completeSha256,
        state: stateIdentity,
        evidencePath: evidence.path,
        marker,
      };
      intentFile = publishRetainedFile(installation, "active-operation.json", json(prepared), guard);
      evidence.sync();
      installation.sync();
      guard();
    } else {
      intentFile = installation.read("active-operation.json", 16384);
      backup = new HeldDirectory(join(evidence.path, "backup"));
    }
    const intent = check<Intent>(intentSchema, parse(intentFile.bytes));
    if (
      !same(intent.state, stateIdentity) ||
      intent.operationId !== preparation.operationId ||
      intent.evidencePath !== evidence.path ||
      intent.installationSha256 !== sourceInstallationId ||
      intent.sourceManifestSha256 !== snapshot.manifestSha256 ||
      intent.marker.initialization !== "offline-retained-unknown"
    )
      throw new Error("E_RETAINED_OPERATION_CHANGED");
    const mapping = evidence.read("mapping.json", 65536);
    if (
      digest(mapping.bytes) !== intent.mappingSha256 ||
      !mapping.bytes.equals(json(obligations)) ||
      readBackup(snapshot, backup, guard) !== intent.backupCompleteSha256
    )
      throw new Error("E_RETAINED_MAPPING_CHANGED");
    const initial = createInitialTerminalLedgerV2(intent.marker, obligations),
      initialBytes = json(initial),
      markerBytes = json(intent.marker);
    const expectedComplete = {
      v: 1,
      kind: "retained-initialization-complete",
      operationId: intent.operationId,
      intentSha256: digest(intentFile.bytes),
      initialLedgerSha256: digest(initialBytes),
      markerSha256: digest(markerBytes),
    };
    const completed = !evidence.absent("initialization-complete.json");
    let completionFile: CapturedFile | undefined;
    if (completed) {
      const f = evidence.read("initialization-complete.json", 4096);
      completionFile = f;
      const c = check<Static<typeof completeSchema>>(completeSchema, parse(f.bytes));
      if (!same(c, expectedComplete)) throw new Error("E_RETAINED_COMPLETION_CHANGED");
      evidence.syncFile(f);
      guard();
    }
    let ledger: LedgerV2;
    const v2Pins: Array<{ directory: HeldDirectory; file: CapturedFile }> = [];
    if (state.absent("terminal-v2")) {
      if (completed || !state.absent(".terminal-initialized-v2")) throw new Error("E_RETAINED_V2_MISSING");
      guard();
      root = state.mkdir("terminal-v2");
      v2Pins.push({ directory: root, file: publishRetainedFile(root, "ledger.json", initialBytes, guard) });
      v2Pins.push({ directory: root, file: publishRetainedFile(root, "marker.json", markerBytes, guard) });
      root.sync();
      state.sync();
      guard();
      v2Pins.push({
        directory: state,
        file: publishRetainedFile(state, ".terminal-initialized-v2", markerBytes, guard),
      });
      ledger = initial;
    } else {
      root = new HeldDirectory(join(state.path, "terminal-v2"));
      if (root.names().join(",") !== "ledger.json,marker.json") throw new Error("E_RETAINED_PARTIAL_V2");
      const l = root.read("ledger.json"),
        m = root.read("marker.json", 2048),
        w = state.read(".terminal-initialized-v2", 2048);
      const raw = parse(l.bytes);
      if (
        !terminalLedgerV2Ok(raw) ||
        raw.storeId !== intent.marker.storeId ||
        !terminalMarkersV2Match(intent.marker, parse(m.bytes)) ||
        !terminalMarkersV2Match(intent.marker, parse(w.bytes)) ||
        (!completed && !l.bytes.equals(initialBytes))
      )
        throw new Error("E_RETAINED_V2_CHANGED");
      ledger = raw;
      v2Pins.push({ directory: root, file: l }, { directory: root, file: m }, { directory: state, file: w });
      assertRetainedHistory(state, ledger, obligations, guard);
      for (const f of [l, m]) {
        guard();
        root.syncFile(f);
      }
      state.syncFile(w);
      guard();
    }
    root.sync();
    state.sync();
    guard();
    snapshot.verify();
    if (!completed)
      completionFile = publishRetainedFile(evidence, "initialization-complete.json", json(expectedComplete), guard);
    installation.verify(anchorFile);
    installation.verify(preparationFile);
    installation.verify(intentFile);
    evidence.verify(mapping);
    evidence.sync();
    installation.sync();
    guard();
    readBackup(snapshot, backup, guard);
    for (const pin of v2Pins) pin.directory.verify(pin.file);
    evidence.verify(completionFile!);
    installation.verify(anchorFile);
    installation.verify(preparationFile);
    installation.verify(intentFile);
    snapshot.verify();
    guard();
    return {
      phase: "initialization-complete",
      operationId: intent.operationId,
      sourceInstallationId,
      sourceManifestSha256: snapshot.manifestSha256,
      legacyObligations: ledger.legacyObligations!.length,
      normalAllocations: ledger.allocations.length,
      publication: "not-asserted",
      outcome: completed ? "already-complete" : "committed",
    };
  } finally {
    root?.close();
    backup?.close();
    snapshot.close();
  }
}
function assertRetainedHistory(
  state: HeldDirectory,
  ledger: LedgerV2,
  original: LegacyUnattributedObligationV1[],
  guard: () => void,
) {
  if (!ledger.legacyObligations) throw new Error("E_RETAINED_HISTORY_MISSING");
  const byId = new Map(original.map((row) => [row.obligationId, row]));
  for (const row of ledger.legacyObligations) {
    if (!same(byId.get(row.obligationId), row)) throw new Error("E_RETAINED_HISTORY_CHANGED");
    byId.delete(row.obligationId);
  }
  const archive = readRetirementArchive(state, ledger);
  try {
    for (const f of archive.files.filter((f) => f.file.name === "evidence.json")) {
      const parsed = parse(f.file.bytes) as { eligibleLegacy?: LegacyUnattributedObligationV1[] };
      for (const row of parsed.eligibleLegacy ?? []) {
        if (!same(byId.get(row.obligationId), row)) throw new Error("E_RETAINED_RETIREMENT_CHANGED");
        byId.delete(row.obligationId);
      }
    }
    if (byId.size) throw new Error("E_RETAINED_RETIREMENT_MISSING");
    archive.proveDurable(guard);
    archive.verify();
  } finally {
    archive.close();
  }
}
