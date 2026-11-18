/** Fixed controlled deployment adapter. The executable constructs its own scope and
 * measured builds; no external adapter path, snapshot JSON or drain boolean input.
 * Original O objects remain alive after real shutdown through checkpoint/rollback.
 */
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { resolveHubPaths, verifyBoundSocket, identityEquals } from "../../../src/web-hub/protocol/paths.js";
import { acquireSingleton } from "../../../src/web-hub/hub/singleton.js";
import { runMaintenance } from "./engine.js";
import { ControlledScope } from "./scope.js";
import { buildMeasuredRuntime, type MeasuredBuild } from "./build.js";
import { LiveRuntime } from "./live.js";
import { actualLegacyDrain, actualNewDrain } from "./drain.js";
import { createOwnedFixture } from "./fixture.js";
import { HeldDirectory, json, digest, type CapturedFile } from "./files.js";
import {
  fail,
  type MaintenanceAuditPort,
  type MaintenanceEvidence,
  type MaintenanceLease,
  type MaintenanceOperation,
} from "./audit.js";
const freeze = <T extends object>(value: T): T => {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
};
export class ControlledDeployment {
  readonly scope: ControlledScope;
  readonly newBuild: MeasuredBuild;
  private oldBuild: MeasuredBuild | undefined;
  private oldRuntime: LiveRuntime | undefined;
  private newRuntime: LiveRuntime | undefined;
  private oldPin: CapturedFile | undefined;
  private newPin: CapturedFile | undefined;
  private fixture: ReturnType<typeof createOwnedFixture> | undefined;
  private readonly runtimes: LiveRuntime[] = [];
  private closing: Promise<void> | undefined;
  private constructor(scope: ControlledScope, next: MeasuredBuild) {
    this.scope = scope;
    this.newBuild = next;
  }
  static async create(privateParent: string): Promise<ControlledDeployment> {
    const scope = ControlledScope.create(privateParent);
    try {
      const next = await buildMeasuredRuntime(scope.directory, "new");
      return new ControlledDeployment(scope, next);
    } catch (error) {
      scope.close();
      throw Object.assign(error instanceof Error ? error : new Error("controlled build failed"), {
        controlledScope: scope.directory.path,
      });
    }
  }
  private readonly audit: MaintenanceAuditPort = {
    acquire: async (input): Promise<MaintenanceLease> => {
      if (input.stateDir !== this.scope.state.path) fail("scope-mismatch");
      const control = this.scope.enterMaintenance();
      const paths = resolveHubPaths({
        home: this.scope.home,
        uid: process.getuid!(),
        xdgRuntimeDir: this.scope.socketDir,
      });
      let singleton: Awaited<ReturnType<typeof acquireSingleton>>;
      try {
        singleton = await acquireSingleton(paths, { signal: input.signal });
      } catch (error) {
        control.release();
        throw error;
      }
      if (singleton.kind !== "owner") {
        control.release();
        fail("actual-singleton-unavailable");
      }
      const owner = singleton,
        snapshots = new WeakSet<object>();
      let released = false,
        invalidated = false;
      const live = () =>
        !released &&
        !invalidated &&
        control.current() &&
        owner.server.listening &&
        !input.signal.aborted &&
        Date.now() < input.deadline &&
        (input.operation === "fresh" || !!this.oldRuntime?.current()) &&
        (input.operation !== "rollback" || !!this.newRuntime?.current());
      const physicalGuard = () => {
        try {
          if (!live()) fail("maintenance-owner-lost");
          this.scope.check();
          this.newBuild.verify();
          this.oldBuild?.verify();
          const socket = lstatSync(paths.socketPath),
            directory = lstatSync(dirname(paths.socketPath));
          if (
            !socket.isSocket() ||
            socket.uid !== process.getuid!() ||
            !directory.isDirectory() ||
            directory.uid !== process.getuid!() ||
            (directory.mode & 0o777) !== 0o700 ||
            !identityEquals(socket, owner.identity.socket) ||
            !identityEquals(directory, owner.identity.dir)
          )
            fail("maintenance-owner-lost");
          if (!live()) fail("maintenance-owner-lost");
        } catch (error) {
          invalidated = true;
          throw error;
        }
      };
      const verify = async () => {
        physicalGuard();
        const current = await verifyBoundSocket(paths.socketPath, owner.identity.dir);
        if (
          !live() ||
          !identityEquals(current.socket, owner.identity.socket) ||
          !identityEquals(current.dir, owner.identity.dir)
        )
          fail("maintenance-owner-lost");
        physicalGuard();
      };
      const actual = async (operation: MaintenanceOperation) => {
        if (operation === "fresh")
          return { history: { state: "never-initialized" as const, evidenceSha256: this.scope.freshHistory() } };
        if (!this.oldBuild || !this.oldRuntime || !this.oldPin) fail("old-live-bridge-required");
        const legacy = await actualLegacyDrain(this.oldRuntime);
        this.scope.directory.verify(this.oldPin);
        if (digest(this.oldPin.bytes) !== legacy.evidence.physicalProofPruneAckSha256) fail("old-observation-changed");
        // Actual original revoke used unlink; normalize its real directory durability
        // inside this stopped-owner/singleton window, never infer historical fsync.
        for (const path of ["terminal-v1/authority", "terminal-v1/receipts"]) {
          const directory = new HeldDirectory(`${this.scope.state.path}/${path}`);
          try {
            if (directory.names().length) fail("old-publisher-or-receipt-present");
            directory.sync();
          } finally {
            directory.close();
          }
        }
        if (operation === "checkpoint") return { oldVersion: this.oldBuild.version, legacy: legacy.evidence };
        if (!this.newRuntime || !this.newPin) fail("new-live-bridge-required");
        const next = await actualNewDrain(this.newRuntime);
        this.scope.directory.verify(this.newPin);
        if (digest(this.newPin.bytes) !== next.evidence.physicalProofPruneSha256) fail("new-observation-changed");
        const ledger = this.newRuntime.module.createTerminalAllocationLedgerV2({
          stateDir: input.stateDir,
          current: live,
        });
        const readback = await ledger.load(input.signal);
        if (
          !live() ||
          readback.kind !== "loaded" ||
          JSON.stringify(readback.ledger) !== JSON.stringify(next.facts.service.ledger)
        )
          fail("same-v2-ledger-readback-unproven");
        return { oldVersion: this.oldBuild.version, legacy: legacy.evidence, next: next.evidence };
      };
      return {
        observe: async () => {
          await verify();
          const facts = await actual(input.operation);
          await verify();
          const snapshot = freeze({
            kind: input.operation,
            stateIdentity: { dev: this.scope.state.identity.dev, ino: this.scope.state.identity.ino },
            generation: control.generation,
            proofId: this.scope.constructionSha256,
            publisherFence: {
              state: "disabled",
              generation: control.generation,
              evidenceSha256: control.evidenceSha256,
            },
            newVersion: this.newBuild.version,
            ...facts,
          }) as MaintenanceEvidence;
          snapshots.add(snapshot);
          return snapshot;
        },
        revalidate: async (snapshot) => {
          try {
            if (!snapshots.has(snapshot)) fail("foreign-snapshot");
            await verify();
            const facts = await actual(input.operation);
            if (
              (snapshot.kind === "checkpoint" || snapshot.kind === "rollback") &&
              JSON.stringify(snapshot.legacy) !== JSON.stringify((facts as any).legacy)
            )
              fail("old-observation-changed");
            if (snapshot.kind === "rollback" && JSON.stringify(snapshot.next) !== JSON.stringify((facts as any).next))
              fail("new-observation-changed");
            await verify();
          } catch (error) {
            invalidated = true;
            throw error;
          }
        },
        current: (snapshot) => live() && snapshots.has(snapshot),
        guardOwnership: (snapshot) => {
          if (!snapshots.has(snapshot)) fail("foreign-snapshot");
          physicalGuard();
        },
        release: async () => {
          if (released) return;
          released = true;
          try {
            await owner.release();
          } finally {
            control.release();
          }
        },
      };
    },
  };
  private async transact(operation: MaintenanceOperation) {
    return runMaintenance(operation, {
      stateDir: this.scope.state.path,
      evidenceDir: this.scope.evidence.path,
      audit: this.audit,
      timeoutMs: 30000,
    });
  }
  private summary() {
    return {
      scope: this.scope.directory.path,
      stateDir: this.scope.state.path,
      evidenceDir: this.scope.evidence.path,
      newVersion: this.newBuild.version,
      newMeasurement: this.newBuild.directory,
      ...(this.oldBuild ? { oldVersion: this.oldBuild.version, oldMeasurement: this.oldBuild.directory } : {}),
    };
  }
  async fresh() {
    const result = await this.transact("fresh");
    this.scope.checkpointCommitted();
    return { result, ...this.summary() };
  }
  async prepareCheckpoint() {
    if (this.oldRuntime || this.oldBuild) fail("controlled-stage-already-entered");
    this.oldBuild = await buildMeasuredRuntime(this.scope.directory, "old");
    const fixture = (this.fixture = createOwnedFixture(this.scope));
    const old = (this.oldRuntime = await LiveRuntime.start(this.oldBuild, this.scope, fixture));
    this.runtimes.push(old);
    const o = await old.exerciseOld();
    await old.stop();
    const oldDrain = await actualLegacyDrain(old);
    this.oldPin = this.scope.directory.create("old-drain.json", json(oldDrain.facts));
    this.scope.directory.sync();
    const checkpoint = await this.transact("checkpoint");
    this.scope.checkpointCommitted();
    return { checkpoint, o, oldDrain };
  }
  async useAndDrainNew() {
    const fixture = this.fixture;
    if (!fixture || this.newRuntime || !this.oldRuntime || !this.oldPin) fail("controlled-stage-unavailable");
    const next = (this.newRuntime = await LiveRuntime.start(this.newBuild, this.scope, fixture));
    this.runtimes.push(next);
    const n = await next.exerciseNew();
    await next.stop();
    const newDrain = await actualNewDrain(next);
    this.newPin = this.scope.directory.create("new-drain.json", json(newDrain.facts));
    this.scope.directory.sync();
    return { n, newDrain };
  }
  async inspectRollback() {
    return this.transact("rollback");
  }
  async cycle() {
    const { checkpoint, o, oldDrain } = await this.prepareCheckpoint();
    const { n, newDrain } = await this.useAndDrainNew();
    const rollback = await this.inspectRollback();
    this.scope.rollbackEligible();
    const returned = await LiveRuntime.start(this.oldBuild!, this.scope, this.fixture!);
    this.runtimes.push(returned);
    const o2 = await returned.exerciseOld();
    await returned.stop();
    const returnedDrain = await actualLegacyDrain(returned);
    this.scope.directory.create("returned-old-drain.json", json(returnedDrain.facts));
    const result = {
      checkpoint,
      rollback,
      ...this.summary(),
      realKernelReboot: false,
      shells: {
        old: { pid: o.pid, termId: o.termId },
        next: { pid: n.pid, termId: n.termId },
        returnedOld: { pid: o2.pid, termId: o2.termId },
      },
      proofHashes: {
        old: oldDrain.evidence.physicalProofPruneAckSha256,
        next: newDrain.evidence.physicalProofPruneSha256,
        returnedOld: returnedDrain.evidence.physicalProofPruneAckSha256,
      },
    };
    this.scope.directory.create("cycle-result.json", json(result));
    this.scope.directory.sync();
    return result;
  }
  close(): Promise<void> {
    return (this.closing ??= this.disposeAll());
  }
  private async disposeAll(): Promise<void> {
    let error: unknown;
    for (const runtime of [...this.runtimes].reverse()) {
      try {
        await runtime.stop();
        await runtime.release();
      } catch (failure) {
        error ??= failure;
      }
    }
    if (error) throw error;
    this.oldBuild?.close();
    this.newBuild.close();
    this.scope.close();
  }
}
