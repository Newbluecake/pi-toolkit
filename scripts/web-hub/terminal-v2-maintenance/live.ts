/** Actual measured O/N components in a constructed private deployment. O's actual
 * SDK owner lives in a retained owned child, hub/fence/service stay original objects.
 * Observation getters are ONLY in the measured fixed O tool patch. No fake context,
 * backend, physical proof, journal, ACK or JSON audit injection is accepted here.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { TerminalTestFixture } from "../../../src/web-hub/hub/terminal/v2/environment.js";
import { ControlledScope } from "./scope.js";
import type { MeasuredBuild } from "./build.js";
import { OwnedSdkWorker } from "./worker.js";
import {
  privateLogin,
  privatePost,
  privateSse,
  privateTerminalView,
  observeUntil,
  type PrivateSse,
} from "./http-client.js";
const id = () => randomBytes(24).toString("base64url");
export class LiveRuntime {
  readonly module: any;
  readonly hub: any;
  readonly deps: any;
  readonly worker: OwnedSdkWorker;
  readonly service: any;
  private stopped = false;
  private stopWork: Promise<any> | undefined;
  private disposeResult: unknown;
  private beforeStop: unknown;
  private stream: PrivateSse | undefined;
  private constructor(
    private readonly build: MeasuredBuild,
    private readonly scope: ControlledScope,
    private readonly publisher: ReturnType<ControlledScope["beginPublisher"]>,
    module: any,
    hub: any,
    deps: any,
    worker: OwnedSdkWorker,
    service: any,
    private readonly backends: Array<{ backend: any; physical?: any }>,
  ) {
    this.module = module;
    this.hub = hub;
    this.deps = deps;
    this.worker = worker;
    this.service = service;
  }
  static async start(build: MeasuredBuild, scope: ControlledScope, fixture: TerminalTestFixture): Promise<LiveRuntime> {
    const publisher = scope.beginPublisher(build.kind);
    let worker: OwnedSdkWorker | undefined;
    let hub: any;
    try {
      const module = await build.load();
      let deps: any, service: any, initialized: Promise<void> | undefined;
      const backends: Array<{ backend: any; physical?: any }> = [];
      const names = ["HOME", "PI_CODING_AGENT_DIR", "PI_WEBHUB_TERMINAL_SOURCE"] as const;
      const original = names.map((name) => process.env[name]);
      try {
        process.env.HOME = scope.home;
        process.env.PI_CODING_AGENT_DIR = join(scope.home, ".pi/agent");
        process.env.PI_WEBHUB_TERMINAL_SOURCE = "plain";
        hub = await module.startHub(
          {
            v: 1,
            home: scope.home,
            port: 0,
            idleExitMinutes: 10,
            privacy: true,
            pluginVersion: "0.12.2",
            buildId: "t51-fixed-controlled-runtime",
          },
          (current: any) => {
            deps = current;
            return module.createHttpFrontend(current);
          },
          {
            xdgRuntimeDir: scope.socketDir,
            ...(build.kind === "new"
              ? {
                  terminalV2Test: {
                    backend: (options: any) => {
                      const backend = module.createTerminalTestBackend(options, fixture),
                        observed = { backend, physical: undefined as any };
                      backends.push(observed);
                      void backend.done.then(
                        (physical: any) => {
                          observed.physical = physical;
                        },
                        () => {},
                      );
                      return backend;
                    },
                    ready: (work: Promise<void>, owner: any) => {
                      initialized = work;
                      service = owner;
                    },
                  },
                }
              : {}),
          },
        );
        if (!hub || !("httpPort" in hub)) throw new Error("actual controlled hub startup refused");
        await initialized;
      } finally {
        names.forEach((name, i) => {
          if (original[i] === undefined) delete process.env[name];
          else process.env[name] = original[i];
        });
      }
      worker = await OwnedSdkWorker.start(build, scope, fixture);
      const live = new LiveRuntime(build, scope, publisher, module, hub, deps, worker, service, backends);
      await observeUntil(
        async () => ({ worker: await worker!.observe(), agents: deps.registry.list() }),
        (value) => {
          const target = value.agents.find((agent: any) => agent.session?.sessionId === value.worker.sessionId);
          return !!target?.status?.[build.kind === "old" ? "terminalSession" : "terminalSessionV2"];
        },
      );
      return live;
    } catch (error) {
      let clean = false;
      try {
        if (worker) {
          await worker.stop();
          await worker.release();
        }
        clean = true;
      } catch (failure) {
        worker?.abandon();
        throw failure;
      } finally {
        if (hub?.close) await hub.close("controlled-start-failed");
        if (clean) publisher.stopped();
      }
      throw error;
    }
  }
  async facts(): Promise<any> {
    this.scope.check();
    this.build.verify();
    const worker = await this.worker.observe();
    return this.build.kind === "old"
      ? {
          worker,
          beforeStop: this.beforeStop,
          fence: this.hub.maintenanceTerminal?.maintenanceFence(),
          service: this.hub.maintenanceTerminal?.service.maintenanceSnapshot(),
        }
      : {
          worker,
          beforeStop: this.beforeStop,
          service: this.service?.maintenanceSnapshot(),
          disposeResult: this.disposeResult,
          backends: this.backends.map(({ backend, physical }) => ({ spawnSettled: backend.spawnSettled, physical })),
        };
  }
  current(): boolean {
    return this.worker.current() && (!this.stopped ? this.publisher.current() : true);
  }
  private async target(): Promise<any> {
    const worker = await this.worker.observe();
    const target = this.deps.registry.list().find((agent: any) => agent.session?.sessionId === worker.sessionId);
    if (!target) throw new Error("actual SDK target missing");
    return target;
  }
  async exerciseOld(): Promise<any> {
    if (this.build.kind !== "old" || this.stopped) throw new Error("not a live O runtime");
    const target = await this.target(),
      cookie = await privateLogin(this.hub.httpPort, this.hub.paths.tokenFile);
    const stream = (this.stream = await privateSse(this.hub.httpPort, cookie));
    const connection = await stream.wait((e) => e.event === "terminal_connection"),
      hello = await stream.wait((e) => e.event === "hello");
    const common = {
      agentKey: target.agentKey,
      expect: { sessionId: target.session.sessionId, epoch: target.epoch },
      clientId: hello.data.clientId,
      connectionInstance: connection.data.connectionInstance,
      connectionToken: connection.data.connectionToken,
    };
    const post = async (op: string, body: object = {}) => {
      const response = await privatePost(this.hub.httpPort, `/api/terminal/${op}`, { ...common, ...body }, cookie);
      if (response.status !== 200 || response.body.ok !== true)
        throw new Error(`actual O ${op} refused: ${response.status}/${response.body.code}`);
      return response.body;
    };
    const prepared = await post("prepare", { cols: 80, rows: 24 });
    const opened = await post("open", {
      openId: prepared.openId,
      createTicket: prepared.createTicket,
      tabId: id(),
      cols: 80,
      rows: 24,
    });
    const writer = { termId: opened.termId, attachmentId: opened.attachmentId, writerLease: opened.writerLease };
    const replay = await stream.wait(
      (e) =>
        e.event === "terminal" && e.data.attachmentId === opened.attachmentId && e.data.event.kind === "replay_begin",
    );
    await post("ack", {
      ...writer,
      ack: {
        phase: "replay_ready",
        attemptId: replay.data.event.attemptId,
        replayEpoch: replay.data.event.replayEpoch,
        renderedThrough: replay.data.event.N0,
      },
    });
    const cutover = await stream.wait(
      (e) => e.event === "terminal" && e.data.attachmentId === opened.attachmentId && e.data.event.kind === "cutover",
    );
    await post("input", {
      ...writer,
      inputSeq: opened.nextInputSeq,
      inputKind: "user",
      streamEpoch: cutover.data.event.newLiveEpoch,
      bytesB64: Buffer.from("printf 'T51_O_PID=%s\\n' \"$$\"\n").toString("base64"),
    });
    const output = await stream.wait(
      (e) =>
        e.event === "terminal" &&
        e.data.event.kind === "output" &&
        /T51_O_PID=\d+/.test(Buffer.from(e.data.event.bytesB64, "base64").toString()),
    );
    const pid = Number(/T51_O_PID=(\d+)/.exec(Buffer.from(output.data.event.bytesB64, "base64").toString())![1]);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("real O shell PID missing");
    readFileSync(`/proc/${pid}/stat`);
    await post("close", { termId: opened.termId, closeId: id(), expectedRevision: opened.revision });
    const facts = await observeUntil(
      () => this.facts(),
      (facts) =>
        facts.worker.owner?.resources.length === 0 &&
        facts.worker.owner?.acks.length > 0 &&
        facts.fence?.journal.resources.length === 0,
    );
    stream.close();
    this.stream = undefined;
    return { termId: opened.termId, pid, facts };
  }
  async exerciseNew(): Promise<any> {
    if (this.build.kind !== "new" || this.stopped) throw new Error("not a live N runtime");
    const target = await this.target(),
      cookie = await privateLogin(this.hub.httpPort, this.hub.paths.tokenFile);
    const scope = { agentKey: target.agentKey, sessionId: target.session.sessionId, epoch: target.epoch };
    const post = async (op: string, body: object) => {
      const response = await privatePost(this.hub.httpPort, `/api/terminal/v2/${op}`, body, cookie);
      if (response.status !== 200 || response.body.ok !== true)
        throw new Error(`actual N ${op} refused: ${response.status}/${response.body.code}`);
      return response.body;
    };
    const list = await post("list", { scope }),
      envelope = { scope, hubInstance: list.hubInstance };
    const opened = await post("create", { ...envelope, requestId: id(), mode: "ensure-empty", cols: 80, rows: 24 });
    const term = { ...envelope, termId: opened.termId };
    const view = await privateTerminalView(this.hub.httpPort, cookie, term);
    let pid: number;
    try {
      const attached = await view.wait((frame) => frame.t === "attached"),
        replay = await view.wait((frame) => frame.t === "replay-end");
      const writer = { ...term, viewId: attached.viewId };
      await post("ack", { ...writer, offset: replay.offset, replayComplete: true });
      await view.wait((frame) => frame.t === "ready");
      await post("input", {
        ...writer,
        seq: 1,
        kind: "user",
        bytesB64: Buffer.from("printf 'T51_N_PID=%s\\n' \"$$\"\n").toString("base64"),
      });
      const output = await view.wait(
        (frame) => frame.t === "output" && /T51_N_PID=\d+/.test(Buffer.from(frame.bytesB64, "base64").toString()),
      );
      pid = Number(/T51_N_PID=(\d+)/.exec(Buffer.from(output.bytesB64, "base64").toString())![1]);
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("real N shell PID missing");
      readFileSync(`/proc/${pid}/stat`);
    } finally {
      view.close();
    }
    const renamed = await post("rename", { ...term, name: "controlled real N shell" });
    await post("close", term);
    const facts = await observeUntil(
      () => this.facts(),
      (facts) =>
        facts.service?.physicalPrunes >= 1 &&
        facts.service?.allocationCount === 0 &&
        facts.service?.runtimes.length === 0,
    );
    return { termId: opened.termId, pid, renamed: renamed.ok, facts };
  }
  stop(): Promise<any> {
    return (this.stopWork ??= this.stopActual());
  }
  private async stopActual(): Promise<any> {
    this.stream?.close();
    this.stream = undefined;
    let failure: unknown;
    try {
      this.beforeStop = await this.facts();
    } catch (error) {
      failure = error;
    }
    if (this.build.kind === "new") {
      try {
        this.disposeResult = await this.service.dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await this.worker.stop();
    } catch (error) {
      failure ??= error;
    }
    // Always close the ORIGINAL owned hub even if observation/IPC failed. A failure
    // is UNKNOWN, never permission to mark the publisher stopped or start another.
    try {
      await this.hub.close("controlled-maintenance-stop");
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      this.worker.abandon();
      throw failure;
    }
    try {
      const facts = await this.facts();
      this.stopped = true;
      this.publisher.stopped();
      return facts;
    } catch (error) {
      this.worker.abandon();
      throw error;
    }
  }
  async release(): Promise<void> {
    if (!this.stopped) throw new Error("runtime not stopped");
    await this.worker.release();
  }
}
