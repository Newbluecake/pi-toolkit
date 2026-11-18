/** Maintenance transaction engine. NO production imports this directory.
 * Pre-mutation refusal: effect none (private preparation evidence may remain).
 * Attempted state mutation, completion publication or durability reproof failure:
 * effect unknown; no replay/repair. A surviving filename is never a durable ACK.
 */
import { randomBytes } from "node:crypto";
import { clampSpanMs } from "../../../src/core/deadline.js";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  TerminalMarkerV2Schema,
  terminalMarkersV2Match,
  terminalInitialLedgerV2Ok,
  createInitialTerminalLedgerV2,
  terminalLedgerV2Ok,
  type TerminalMarkerV2,
  type LedgerV2,
} from "../../../src/web-hub/protocol/terminal-v2.js";
import { terminalV2Files } from "../../../src/web-hub/protocol/terminal-v2-paths.js";
import {
  MaintenanceError,
  fail,
  type MaintenanceEvidence,
  type MaintenanceLease,
  type MaintenanceOptions,
  type MaintenanceOperation,
  type MaintenanceTestHooks,
} from "./audit.js";
import { HeldDirectory, digest, exactKeys, json, parse } from "./files.js";
import { PinnedEvidence, PREPARED_COMPLETION } from "./evidence.js";
import { OLD_SOURCE, readLegacy, type LegacySnapshot, type SnapshotFile } from "./legacy-reader.js";
export interface MaintenanceResult {
  operation: MaintenanceOperation;
  checkpointId: string;
  transaction: string;
  outcome: "committed" | "already-complete" | "rollback-eligible";
  /** Never implies old binary recognizes the v2 marker or enforces a downgrade gate. */
  deploymentChanged: false;
}
const mint = () => randomBytes(24).toString("base64url");
const sha = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
function validateEvidence(
  e: MaintenanceEvidence,
  operation: MaintenanceOperation,
  state: HeldDirectory,
  legacy: LegacySnapshot,
  ledger?: LedgerV2,
): void {
  const version = (v: MaintenanceEvidence["newVersion"]) =>
    v &&
    /^[a-f0-9]{40}$/.test(v.sourceCommit) &&
    typeof v.build === "string" &&
    v.build.length > 0 &&
    v.build.length <= 128 &&
    sha(v.artifactSha256);
  if (
    e.kind !== operation ||
    e.stateIdentity.dev !== state.identity.dev ||
    e.stateIdentity.ino !== state.identity.ino ||
    !e.generation ||
    !e.proofId ||
    e.publisherFence.state !== "disabled" ||
    !e.publisherFence.generation ||
    !sha(e.publisherFence.evidenceSha256) ||
    !version(e.newVersion)
  )
    fail("invalid-audit-evidence");
  if (e.kind === "fresh") {
    if (legacy.kind !== "fresh" || e.history.state !== "never-initialized" || !sha(e.history.evidenceSha256))
      fail("fresh-history-unproven");
  } else {
    if (legacy.kind !== "checkpoint" || !version(e.oldVersion) || e.oldVersion.sourceCommit !== OLD_SOURCE)
      fail("old-version-unproven");
    const v = e.legacy;
    if (
      [v.resources, v.receipts, v.active, v.starting, v.pendingSpawn].some((n) => n !== 0) ||
      !["revoked", "safe-old-boot-completed"].includes(v.authority) ||
      v.durableRevision !== legacy.revision ||
      !sha(v.physicalProofPruneAckSha256)
    )
      fail("legacy-drain-unproven");
    if (e.kind === "rollback") {
      const n = e.next;
      if (
        [n.allocations, n.backend, n.pendingSpawn].some((count) => count !== 0) ||
        n.dispose !== "clean" ||
        n.durableRevision !== ledger?.revision ||
        !sha(n.physicalProofPruneSha256)
      )
        fail("v2-drain-unproven");
    }
  }
}
interface V2Snapshot {
  marker: TerminalMarkerV2;
  ledger: LedgerV2;
  files: SnapshotFile[];
  verify(): void;
  close(): void;
}
function readV2(state: HeldDirectory): V2Snapshot | undefined {
  const layout = terminalV2Files(state.path);
  // P1's old-kernel retirement archive is not a reset/rollback permission. Until
  // its full audit reader is integrated, conservatively require independent review.
  if (!state.absent(".terminal-allocation-archive-v2")) fail("v2-archive-review-required");
  if (state.absent("terminal-v2")) {
    if (!state.absent(".terminal-initialized-v2")) fail("partial-v2-checkpoint");
    return undefined;
  }
  const root = new HeldDirectory(layout.root);
  try {
    if (root.names().join(",") !== ["ledger.json", "marker.json"].join(",")) fail("unknown-v2-layout");
    const markerFile = root.read("marker.json", 2048),
      ledgerFile = root.read("ledger.json"),
      witnessFile = state.read(".terminal-initialized-v2", 2048);
    const marker: unknown = parse(markerFile.bytes),
      ledger: unknown = parse(ledgerFile.bytes);
    if (
      !Value.Check(TerminalMarkerV2Schema, marker) ||
      !terminalLedgerV2Ok(ledger) ||
      ledger.storeId !== marker.storeId ||
      !terminalMarkersV2Match(marker, parse(witnessFile.bytes))
    )
      fail("invalid-v2-checkpoint");
    if (ledger.allocations.length) fail("v2-allocations-not-empty");
    const files = [
      { path: "terminal-v2/marker.json", directory: root, file: markerFile },
      { path: "terminal-v2/ledger.json", directory: root, file: ledgerFile },
      { path: ".terminal-initialized-v2", directory: state, file: witnessFile },
    ];
    return {
      marker,
      ledger,
      files,
      verify() {
        if (root.names().join(",") !== "ledger.json,marker.json") fail("v2-state-changed");
        for (const f of files) f.directory.verify(f.file);
      },
      close() {
        root.close();
      },
    };
  } catch (e) {
    root.close();
    throw e;
  }
}
function safeEnvironment(): void {
  if (process.env.PI_SECURE_SESSION || process.env.PI_SECURE_VAULT) fail("secure-domain");
}
/** Required audit adapters cannot be loaded from a user-specified module/JSON.
 * P6 supplies the audited real in-process adapter in an explicitly authorized entry. */
export async function runMaintenance(
  operation: MaintenanceOperation,
  options: MaintenanceOptions,
  hooks: MaintenanceTestHooks = {},
): Promise<MaintenanceResult> {
  safeEnvironment();
  if (!options.audit) fail("trusted-adapter-required");
  const requested = options.timeoutMs ?? 10000;
  if (!Number.isFinite(requested) || requested < 1 || requested > 30000) fail("invalid-timeout");
  const span = clampSpanMs(Math.trunc(requested));
  if (span === undefined) fail("invalid-timeout");
  const deadline = Date.now() + span,
    controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, span);
  timer.unref();
  const checkDeadline = () => {
    if (controller.signal.aborted || Date.now() >= deadline) fail("maintenance-deadline");
  };
  // Bound the adapter as well as post-await work. No future mutation is scheduled by
  // this engine after timeout. A late acquire is released, never adopted.
  const bounded = async <T>(promise: Promise<T>, late?: (value: T) => void): Promise<T> => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      // The Promise already exists: always attach rejection handling, even when
      // the deadline expired while the adapter call itself was being entered.
      void promise.then(
        (value) => late?.(value),
        () => undefined,
      );
      throw new MaintenanceError("maintenance-deadline");
    }
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const expired = () => {
        done = true;
        reject(new MaintenanceError("maintenance-deadline"));
      };
      controller.signal.addEventListener("abort", expired, { once: true });
      promise.then(
        (value) => {
          controller.signal.removeEventListener("abort", expired);
          if (done || controller.signal.aborted || Date.now() >= deadline) {
            late?.(value);
            reject(new MaintenanceError("maintenance-deadline"));
          } else {
            done = true;
            resolve(value);
          }
        },
        (error) => {
          controller.signal.removeEventListener("abort", expired);
          if (!done) {
            done = true;
            reject(error);
          }
        },
      );
    });
  };
  let lease: MaintenanceLease | undefined, state: HeldDirectory | undefined, evidence: HeldDirectory | undefined;
  let legacy: LegacySnapshot | undefined,
    next: V2Snapshot | undefined,
    tx: HeldDirectory | undefined,
    root: HeldDirectory | undefined;
  const originalDirectories: HeldDirectory[] = [];
  let attemptedState = false,
    attemptedPublication = false,
    workFailed = false;
  try {
    checkDeadline();
    state = new HeldDirectory(options.stateDir);
    evidence = new HeldDirectory(options.evidenceDir);
    if (
      options.stateDir === options.evidenceDir ||
      options.stateDir.startsWith(options.evidenceDir + "/") ||
      options.evidenceDir.startsWith(options.stateDir + "/")
    )
      fail("overlapping-paths");
    if (state.identity.dev === evidence.identity.dev && state.identity.ino === evidence.identity.ino)
      fail("overlapping-paths");
    lease = await bounded(
      options.audit.acquire({ stateDir: state.path, operation, signal: controller.signal, deadline }),
      (value) => {
        void value.release().catch(() => undefined);
      },
    );
    checkDeadline();
    state.check();
    evidence.check();
    const snapshot = await bounded(lease.observe());
    checkDeadline();
    if (!lease.current(snapshot)) fail("lease-invalidated");
    legacy = readLegacy(state);
    next = readV2(state);
    if (operation === "rollback" && !next) fail("v2-checkpoint-required");
    if (operation !== "rollback" && legacy.kind !== (operation === "fresh" ? "fresh" : "checkpoint"))
      fail("initialization-kind-mismatch");
    validateEvidence(snapshot, operation, state, legacy, next?.ledger);
    const created: SnapshotFile[] = [];
    const pins: PinnedEvidence[] = [];
    let evidenceNames = evidence.names();
    let transactionPins: PinnedEvidence | undefined;
    const guard = () => {
      checkDeadline();
      if (!lease!.current(snapshot)) fail("lease-invalidated");
      state!.check();
      evidence!.check();
      if (evidence!.names().join(",") !== evidenceNames.join(",")) fail("evidence-members-changed");
      for (const pin of pins) pin.check();
      legacy!.verify();
      next?.verify();
      tx?.check();
      root?.check();
      for (const f of created) f.directory.verify(f.file);
      if (
        root &&
        root.names().join(",") !==
          created
            .filter((f) => f.directory === root)
            .map((f) => f.file.name)
            .sort()
            .join(",")
      )
        fail("v2-state-changed");
      if (!next && !attemptedState && (!state!.absent("terminal-v2") || !state!.absent(".terminal-initialized-v2")))
        fail("v2-state-changed");
    };
    const revalidate = async () => {
      guard();
      await bounded(lease!.revalidate(snapshot));
      guard();
    };
    // A surviving completion filename is only a publication observation, not a
    // durability guarantee. Reprove exact files and both directory levels on retry.
    const proveDurability = () => {
      guard();
      // Re-confirming an earlier publication is also an uncertainty window:
      // a failed file/parent sync must never be reported as durable completion.
      attemptedPublication = true;
      for (const pin of pins) pin.proveDurable(guard);
      const directories = new Set<HeldDirectory>();
      for (const f of next?.files ?? []) {
        guard();
        f.directory.syncFile(f.file);
        guard();
        directories.add(f.directory);
      }
      for (const directory of directories) {
        guard();
        directory.sync();
        guard();
      }
      guard();
      state!.sync();
      guard();
      evidence!.sync();
      guard();
    };
    await revalidate();
    const marker: TerminalMarkerV2 = next?.marker ?? {
      v: 2,
      storeId: mint(),
      initialization: operation === "fresh" ? "fresh" : "v1-clean-checkpoint",
      checkpointId: mint(),
    };
    const transaction = operation === "rollback" ? `rollback-${marker.checkpointId}` : marker.checkpointId;
    const files = [...legacy.files, ...(next?.files ?? [])];
    const fileManifest = files.map((f) => ({ path: f.path, fingerprint: f.file.fingerprint }));
    const targetMatches = (target: unknown) =>
      exactKeys(target, ["marker", "ledger", "witnessSha256"]) &&
      terminalMarkersV2Match(target.marker, marker) &&
      terminalLedgerV2Ok(target.ledger) &&
      target.ledger.storeId === marker.storeId &&
      target.ledger.allocations.length === 0 &&
      sha(target.witnessSha256);
    const verifyCompleted = (pin: PinnedEvidence, rollback: boolean) => {
      const count = rollback ? files.length : legacy!.files.length;
      pin.expectNames([
        "prepared.json",
        PREPARED_COMPLETION,
        "complete.json",
        ...Array.from({ length: count }, (_, i) => `snapshot-${i}`),
      ]);
      const prepared = parse(pin.read("prepared.json", 262144).bytes),
        completed = parse(pin.readCompletion().bytes);
      if (
        !exactKeys(prepared, ["v", "operation", "checkpointId", "audit", "files", "target"]) ||
        prepared.v !== 1 ||
        prepared.operation !== operation ||
        prepared.checkpointId !== marker.checkpointId ||
        !exactKeys(completed, ["v", "checkpointId", "kind"]) ||
        completed.v !== 1 ||
        completed.checkpointId !== marker.checkpointId ||
        completed.kind !== (rollback ? "rollback-eligible" : "checkpoint-durable")
      )
        fail("incomplete-maintenance-evidence");
      if (!targetMatches(prepared.target)) fail("evidence-target-mismatch");
      // Check original v1 byte identities; v2 files are expected only for rollback.
      const expected = rollback
        ? fileManifest
        : legacy!.files.map((f) => ({ path: f.path, fingerprint: f.file.fingerprint }));
      if (JSON.stringify(prepared.files) !== JSON.stringify(expected)) fail("evidence-state-mismatch");
      for (let i = 0; i < (rollback ? files.length : legacy!.files.length); i++) {
        const source = (rollback ? files : legacy!.files)[i]!;
        if (!pin.read(`snapshot-${i}`, source.file.bytes.length).bytes.equals(source.file.bytes))
          fail("evidence-state-mismatch");
      }
      if (rollback) {
        if (!next) fail("v2-checkpoint-required");
      } else if (
        !next ||
        !terminalInitialLedgerV2Ok(next.ledger, marker) ||
        marker.initialization !== (operation === "fresh" ? "fresh" : "v1-clean-checkpoint")
      )
        fail("checkpoint-already-used");
    };
    if (!evidence.absent(transaction)) {
      tx = new HeldDirectory(join(evidence.path, transaction));
      transactionPins = new PinnedEvidence(tx);
      pins.push(transactionPins);
      verifyCompleted(transactionPins, operation === "rollback");
      await revalidate();
      proveDurability();
      return {
        operation,
        checkpointId: marker.checkpointId,
        transaction,
        outcome: "already-complete",
        deploymentChanged: false,
      };
    }
    // Existing v2 cannot be adopted solely from its marker. Original durable tool
    // evidence is mandatory (including fresh); no replay or healing of partials.
    if (next && operation !== "rollback") fail("checkpoint-evidence-missing");
    if (next && marker.initialization === "fresh" && operation === "rollback") fail("no-legacy-checkpoint-to-rollback");
    if (operation === "rollback") {
      const original = new HeldDirectory(join(evidence.path, marker.checkpointId));
      originalDirectories.push(original);
      const originalPins = new PinnedEvidence(original);
      pins.push(originalPins);
      originalPins.expectNames([
        "prepared.json",
        PREPARED_COMPLETION,
        "complete.json",
        ...legacy.files.map((_, i) => `snapshot-${i}`),
      ]);
      {
        const completed = parse(originalPins.readCompletion().bytes);
        if (
          !exactKeys(completed, ["v", "checkpointId", "kind"]) ||
          completed.v !== 1 ||
          completed.checkpointId !== marker.checkpointId ||
          completed.kind !== "checkpoint-durable"
        )
          fail("checkpoint-evidence-missing");
        const prepared = parse(originalPins.read("prepared.json", 262144).bytes);
        if (
          !exactKeys(prepared, ["v", "operation", "checkpointId", "audit", "files", "target"]) ||
          prepared.operation !== "checkpoint" ||
          prepared.checkpointId !== marker.checkpointId ||
          JSON.stringify(prepared.files) !==
            JSON.stringify(legacy.files.map((f) => ({ path: f.path, fingerprint: f.file.fingerprint })))
        )
          fail("legacy-changed-since-checkpoint");
        if (!targetMatches(prepared.target)) fail("evidence-target-mismatch");
        for (let i = 0; i < legacy.files.length; i++)
          if (
            !originalPins
              .read(`snapshot-${i}`, legacy.files[i]!.file.bytes.length)
              .bytes.equals(legacy.files[i]!.file.bytes)
          )
            fail("legacy-changed-since-checkpoint");
      }
      await revalidate();
      proveDurability();
    }
    // Keep accumulated evidence, including partial transactions. Never auto-GC.
    if (evidence.names().length >= 64) fail("maintenance-evidence-capacity");
    guard();
    tx = evidence.mkdir(transaction);
    evidenceNames = [...evidenceNames, transaction].sort();
    transactionPins = new PinnedEvidence(tx);
    transactionPins.expectNames([]);
    pins.push(transactionPins);
    const writeEvidence = (name: string, bytes: Buffer) => {
      guard();
      hooks.before?.("evidence-write");
      guard();
      transactionPins!.create(name, bytes);
      guard();
    };
    for (let i = 0; i < files.length; i++) writeEvidence(`snapshot-${i}`, files[i]!.file.bytes);
    const ledger = createInitialTerminalLedgerV2(marker);
    const witnessBytes = json(marker);
    writeEvidence(
      "prepared.json",
      json({
        v: 1,
        operation,
        checkpointId: marker.checkpointId,
        audit: snapshot,
        files: fileManifest,
        target: { marker, ledger: next?.ledger ?? ledger, witnessSha256: digest(witnessBytes) },
      }),
    );
    guard();
    hooks.before?.("evidence-sync");
    guard();
    tx.sync();
    evidence.sync();
    await revalidate();
    if (operation !== "rollback") {
      const stateWrite = (directory: HeldDirectory, name: string, bytes: Buffer) => {
        guard();
        hooks.before?.("state-write");
        guard();
        attemptedState = true;
        const file = directory.create(name, bytes);
        created.push({ path: name, directory, file });
      };
      // Witness first, so a crash never makes a missing root look fresh.
      stateWrite(state, ".terminal-initialized-v2", witnessBytes);
      guard();
      hooks.before?.("state-sync");
      guard();
      state.sync();
      guard();
      attemptedState = true;
      root = state.mkdir("terminal-v2");
      stateWrite(root, "ledger.json", json(ledger));
      stateWrite(root, "marker.json", json(marker));
      guard();
      hooks.before?.("state-sync");
      guard();
      root.sync();
      state.sync();
    }
    // Durable state before completion preparation. Exclusive temporary content is
    // file-fsynced before no-clobber publication; parent durability is established
    // afterwards. Partial preparations are never replayed into a completion.
    guard();
    hooks.before?.("complete-write");
    guard();
    transactionPins.create(
      PREPARED_COMPLETION,
      json({
        v: 1,
        checkpointId: marker.checkpointId,
        kind: operation === "rollback" ? "rollback-eligible" : "checkpoint-durable",
      }),
    );
    guard();
    attemptedPublication = true;
    transactionPins.publishCompletion(guard);
    guard();
    tx.sync();
    guard();
    evidence.sync();
    guard();
    return {
      operation,
      checkpointId: marker.checkpointId,
      transaction,
      outcome: operation === "rollback" ? "rollback-eligible" : "committed",
      deploymentChanged: false,
    };
  } catch (error) {
    workFailed = true;
    if (error instanceof MaintenanceError)
      throw new MaintenanceError(error.code, attemptedState || attemptedPublication ? "unknown" : error.effect);
    const code = (error as NodeJS.ErrnoException).code;
    throw new MaintenanceError(
      code && /^[A-Z0-9_]+$/.test(code) ? `io-${code}` : "maintenance-failed",
      attemptedState || attemptedPublication ? "unknown" : "none",
    );
  } finally {
    for (const dir of originalDirectories) dir.close();
    root?.close();
    tx?.close();
    next?.close();
    legacy?.close();
    evidence?.close();
    state?.close();
    // The trusted adapter is also responsible for bounded nonblocking release.
    // Retain the timer while release settles; no writes can occur afterwards.
    try {
      if (lease) await bounded(lease.release());
    } catch {
      if (!workFailed)
        throw new MaintenanceError(
          "lease-release-unknown",
          attemptedState || attemptedPublication ? "unknown" : "none",
        );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
