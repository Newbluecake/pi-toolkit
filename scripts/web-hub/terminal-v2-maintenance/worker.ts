/** Actual owned child-process audit channel, not an external JSON proof port.
 * Parent forks ONLY its internally-built/pinned artifact. Child PID/starttime/ns,
 * artifact and channel are pinned before/after each request. Stop never means proof:
 * the coordinator separately checks the ORIGINAL owner's audited physical/ACK facts.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import type { MeasuredBuild } from "./build.js";
import type { ControlledScope } from "./scope.js";
import type { TerminalTestFixture } from "../../../src/web-hub/hub/terminal/v2/environment.js";
function processIdentity(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"),
    fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return {
    pid,
    starttime: fields[19],
    uid: readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1],
    namespaces: ["mnt", "pid", "net"].map((ns) => readlinkSync(`/proc/${pid}/ns/${ns}`)),
  };
}
export class OwnedSdkWorker {
  private readonly channel = randomBytes(24).toString("base64url");
  private readonly pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly child: ChildProcess;
  private readonly identity: ReturnType<typeof processIdentity>;
  private exited = false;
  private stopped = false;
  private errorTail = "";
  private constructor(
    private readonly build: MeasuredBuild,
    private readonly scope: ControlledScope,
  ) {
    build.verify();
    scope.check();
    this.child = fork(build.artifact, ["__owned_sdk_worker"], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: scope.home,
        TMPDIR: scope.directory.path,
        PI_CODING_AGENT_DIR: join(scope.home, ".pi/agent"),
        PI_WEBHUB_TERMINAL_SOURCE: "plain",
        T51_PRIVATE_CHANNEL: this.channel,
      },
    });
    if (!this.child.pid) throw new Error("owned worker spawn failed");
    this.identity = processIdentity(this.child.pid);
    if (this.identity.uid !== String(process.getuid!())) throw new Error("owned worker uid mismatch");
    this.child.stderr!.on("data", (bytes: Buffer) => {
      this.errorTail = (this.errorTail + bytes.toString()).slice(-8192);
    });
    this.child.on("message", (raw: any) => {
      if (!raw || raw.channel !== this.channel || typeof raw.rid !== "string") return;
      const pending = this.pending.get(raw.rid);
      if (!pending) return;
      this.pending.delete(raw.rid);
      clearTimeout(pending.timer);
      if (raw.ok === true) pending.resolve(raw.result);
      else pending.reject(new Error(`owned worker action failed: ${JSON.stringify(raw.result)}`));
    });
    const lost = () => {
      this.exited = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`owned worker lost: ${this.errorTail}`));
      }
      this.pending.clear();
    };
    this.child.once("exit", lost);
    this.child.once("error", lost);
  }
  static async start(
    build: MeasuredBuild,
    scope: ControlledScope,
    fixture: TerminalTestFixture,
  ): Promise<OwnedSdkWorker> {
    const worker = new OwnedSdkWorker(build, scope);
    try {
      await worker.call("start", { home: scope.home, cwd: fixture.cwd, socketDir: scope.socketDir, fixture });
      return worker;
    } catch (error) {
      try {
        await worker.stop();
        await worker.release();
      } catch {
        worker.abandon(); // owned unknown only; child withdraws/cleans on IPC loss
      }
      throw error;
    }
  }
  current(): boolean {
    return !this.exited && !!this.child.connected;
  }
  verify(): void {
    if (!this.current()) throw new Error("live audit worker unavailable");
    this.scope.check();
    this.build.verify();
    if (JSON.stringify(this.identity) !== JSON.stringify(processIdentity(this.identity.pid)))
      throw new Error("audit worker identity changed");
  }
  private async call(op: string, fields: object = {}): Promise<any> {
    this.verify();
    const rid = randomBytes(24).toString("base64url");
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("owned worker response deadline"));
      }, 12000);
      timer.unref();
      this.pending.set(rid, { resolve, reject, timer });
      this.child.send({ channel: this.channel, rid, op, ...fields }, (error) => {
        if (error) {
          const pending = this.pending.get(rid);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(rid);
            reject(error);
          }
        }
      });
    });
    if (!result || result.pid !== this.identity.pid) throw new Error("owned worker response identity mismatch");
    if (op !== "exit") this.verify();
    return result;
  }
  observe(): Promise<any> {
    return this.call("observe");
  }
  async stop(): Promise<any> {
    const result = await this.call("stop");
    this.stopped = true;
    return result;
  }
  /** Irreversible UNKNOWN path, never a drain/stop receipt. Disconnect only this
   * owned IPC child; its fixed parent-loss handler seals the host guard and runs
   * original cleanup. Unref/destroy parent handles so an unknown child cannot
   * wedge the executable. No unrelated/user process is signalled. */
  abandon(): void {
    this.exited = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("owned audit channel abandoned"));
    }
    this.pending.clear();
    if (this.child.connected) this.child.disconnect();
    this.child.stderr?.destroy();
    this.child.unref();
  }
  async release(): Promise<void> {
    if (!this.stopped) throw new Error("cannot release undrained owned worker");
    if (!this.current()) return;
    const exited = once(this.child, "exit");
    await this.call("exit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("owned worker exit deadline")), 8000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
