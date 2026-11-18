/** Controlled-scope deployment owner. Not a general existing-site adapter.
 * Fresh history is construction, NEVER inferred from a directory supplied by an operator.
 * This filesystem lock covers the whole private deployment, not merely one net namespace.
 * Only this live object can publish O/N, and all publishers must already be stopped before
 * maintenance. Same-uid trusted tool model; arbitrary external publishers aren't covered.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HeldDirectory, digest, json } from "./files.js";
import { fail } from "./audit.js";
export type PublisherKind = "old" | "new";
const token = () => randomBytes(16).toString("hex");
export class ControlledScope {
  readonly directory: HeldDirectory;
  readonly state: HeldDirectory;
  readonly evidence: HeldDirectory;
  readonly home: string;
  readonly socketDir: string;
  readonly constructionSha256: string;
  private readonly parent: HeldDirectory;
  private readonly deployment: HeldDirectory;
  private readonly construction: ReturnType<HeldDirectory["create"]>;
  private readonly lock: ReturnType<HeldDirectory["create"]>;
  private publisher: { kind: PublisherKind; owner: object } | undefined;
  private maintenance: object | undefined;
  private floor: "old" | "new" = "old";
  private generation = 0;
  private closed = false;
  private initialized = false;
  private publishedEver = false;
  private rollbackPermission = false;
  private constructor(parent: HeldDirectory, directory: HeldDirectory) {
    this.parent = parent;
    this.directory = directory;
    this.deployment = directory.mkdir("deployment-lock");
    this.lock = this.deployment.create(
      "owner.json",
      json({
        v: 1,
        id: token(),
        pid: process.pid,
        processStat: readFileSync("/proc/self/stat", "utf8"),
        kernelBootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      }),
    );
    const home = directory.mkdir("home");
    this.home = home.path;
    const pi = home.mkdir(".pi"),
      agent = pi.mkdir("agent");
    this.state = agent.mkdir("web-hub");
    agent.create("pi-toolkit.json", json({ webHub: { terminal: { enabled: true } } }));
    this.evidence = directory.mkdir("evidence");
    const sockets = directory.mkdir("s");
    this.socketDir = sockets.path;
    this.construction = directory.create(
      "construction.json",
      json({
        v: 1,
        scope: directory.identity.ino,
        state: { dev: this.state.identity.dev, ino: this.state.identity.ino },
        home: home.identity.ino,
        deployment: this.deployment.identity.ino,
        created: token(),
        history: "created-by-this-live-constructor",
      }),
    );
    this.constructionSha256 = this.construction.fingerprint.sha256;
    agent.sync();
    pi.sync();
    home.sync();
    sockets.sync();
    this.state.sync();
    this.evidence.sync();
    this.deployment.sync();
    directory.sync();
    parent.sync();
    agent.close();
    pi.close();
    home.close();
    sockets.close();
  }
  static create(privateParent: string): ControlledScope {
    if (process.platform !== "linux" || process.env.PI_SECURE_SESSION || process.env.PI_SECURE_VAULT)
      fail("plain-linux-tool-required");
    const parent = new HeldDirectory(privateParent);
    // Never writes to an inferred default or existing deployment. One exclusive mkdir;
    // no retry/adoption/cleanup of a colliding name. Constructor history stays live only.
    const scope = parent.mkdir(`m-${token().slice(0, 16)}`);
    return new ControlledScope(parent, scope);
  }
  check(): void {
    if (this.closed) fail("controlled-scope-closed");
    this.parent.check();
    this.directory.verify(this.construction);
    this.deployment.verify(this.lock);
    this.state.check();
    this.evidence.check();
  }
  beginPublisher(kind: PublisherKind): { current(): boolean; stopped(): void } {
    this.check();
    if (this.publisher || this.maintenance) fail("deployment-busy");
    if (kind === "old" && this.floor === "new" && !this.rollbackPermission) fail("deployment-floor");
    if (kind === "new" && !this.initialized) fail("checkpoint-required");
    const owner = {},
      publisher = { kind, owner };
    this.publisher = publisher;
    this.publishedEver = true;
    this.rollbackPermission = false;
    this.generation++;
    let stopped = false;
    return {
      current: () => !stopped && !this.closed && this.publisher === publisher && !this.maintenance,
      stopped: () => {
        if (stopped) return;
        this.check();
        if (this.publisher !== publisher) fail("publisher-replaced");
        stopped = true;
        this.publisher = undefined;
        this.generation++;
      },
    };
  }
  enterMaintenance(): { generation: string; evidenceSha256: string; current(): boolean; release(): void } {
    this.check();
    if (this.publisher || this.maintenance) fail("publisher-active");
    const owner = {};
    this.maintenance = owner;
    const generation = String(++this.generation);
    let released = false;
    return {
      generation,
      evidenceSha256: digest(
        json({
          construction: this.constructionSha256,
          lock: this.lock.fingerprint,
          state: this.state.identity.ino,
          generation,
        }),
      ),
      current: () =>
        !released &&
        !this.closed &&
        this.maintenance === owner &&
        !this.publisher &&
        String(this.generation) === generation,
      release: () => {
        if (released) return;
        released = true;
        if (this.maintenance === owner) {
          this.maintenance = undefined;
          this.generation++;
        }
      },
    };
  }
  freshHistory(): string {
    this.check();
    if (this.initialized || this.publishedEver || this.publisher || !this.maintenance) fail("fresh-history-unproven");
    return this.constructionSha256;
  }
  checkpointCommitted(): void {
    this.check();
    this.initialized = true;
    this.floor = "new";
  }
  rollbackEligible(): void {
    this.check();
    if (!this.initialized || this.publisher || this.maintenance) fail("rollback-window");
    this.rollbackPermission = true;
  }
  close(): void {
    this.check();
    if (this.publisher || this.maintenance) fail("deployment-busy");
    // Preserve ALL files and the immutable lock as evidence. No stale lock recovery,
    // scope adoption, GC, unlink or future publisher after the original object dies.
    this.closed = true;
    this.state.close();
    this.evidence.close();
    this.deployment.close();
    this.directory.close();
    this.parent.close();
  }
}
