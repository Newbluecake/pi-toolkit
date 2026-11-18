/** Real preexisting ordinary O7239 independent process -> later standalone CLI ->
 * actual N SDK/native PTY. No ControlledScope, old observation patch, owner facts,
 * fake ACK/proof, signal, cgroup, inspector or history manufactured by the tool. */
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createTerminalTestBackend } from "../../src/web-hub/hub/terminal/v2/backend.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { oldLauncherBytes } from "../../scripts/web-hub/terminal-v2-retained/entries.js";
import type { InstallationProfile } from "../../scripts/web-hub/terminal-v2-retained/installation.js";
import {
  privateLogin,
  privatePost,
  privateSse,
  privateTerminalView,
  observeUntil,
} from "../../scripts/web-hub/terminal-v2-maintenance/http-client.js";
import { createTerminalSdkAgent } from "./helpers/terminal-v2-sdk.js";
import { makeTerminalFixture } from "./terminal-v2-backend-fixture.js";
import { probeRetainedBrowser } from "./helpers/terminal-retained-browser.js";
const id = () => randomBytes(24).toString("base64url");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const put = (p: string, value: unknown) => writeFileSync(p, JSON.stringify(value), { mode: 0o600 });
function ordinaryProcess(artifact: string, env: NodeJS.ProcessEnv) {
  const child = fork(artifact, ["__ordinary"], { env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const request = (body: object): Promise<any> =>
    new Promise((resolve, reject) => {
      const rid = id();
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        child.removeListener("message", message);
        child.removeListener("close", close);
        error ? reject(error) : resolve(value);
      };
      const message = (raw: any) => {
        if (raw.rid === rid) raw.ok ? finish(undefined, raw) : finish(new Error(raw.error));
      };
      const close = () => finish(new Error("ordinary process closed"));
      const timer = setTimeout(() => finish(new Error("ordinary process deadline")), 20000);
      timer.unref();
      child.on("message", message);
      child.once("close", close);
      child.send({ ...body, rid });
    });
  let stopped = false;
  return {
    child,
    request,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.connected) await request({ op: "stop" });
      expect(await closed).toBe(0);
    },
    abandon() {
      if (child.connected) child.disconnect();
    },
  };
}
it.each([0, 1, 2])(
  "ordinary O (%i resources; two uses distinct SDK sessions) retains debt through N/restart/new CLI/off rollback",
  async (oldCount) => {
    const native = makeTerminalFixture(),
      f = native.fixture,
      repo = resolve("."),
      selectedN = process.env.PI_TOOLKIT_RETAINED_CONSUMER_ROOT ?? repo,
      base = f.root;
    if (process.env.PI_TOOLKIT_RETAINED_CONSUMER_ROOT) expect(existsSync(join(selectedN, "node_modules"))).toBe(false);
    // Intentionally retain this entire private fixture as independent validation
    // evidence. Auth stays ONLY at its original private paths; it is never backed up.
    const old = join(base, "O"),
      output = join(base, "ordinary-runtime"),
      installation = join(base, "installation"),
      evidence = join(base, "evidence"),
      bin = join(base, "bin"),
      agentDir = join(f.home, ".pi/agent");
    for (const dir of [old, output, installation, evidence, bin, join(f.home, ".pi"), agentDir])
      mkdirSync(dir, { mode: 0o700 });
    const archive = execFileSync(
      "/usr/bin/git",
      [
        "archive",
        "7239dd115ac66039e2c4f80308ea5d08520aa6af",
        "src",
        "package.json",
        "index.ts",
        "index.js",
        "bundle-bridge.cjs",
      ],
      { cwd: repo, timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync("/usr/bin/tar", ["-xf", "-", "-C", old], { input: archive, timeout: 30000 });
    symlinkSync(join(repo, "node_modules"), join(old, "node_modules"), "dir");
    const artifact = join(old, "ordinary.mjs"),
      entry = `
import {startHub} from ${JSON.stringify(join(old, "src/web-hub/hub/hub.ts"))};
import {createHttpFrontend} from ${JSON.stringify(join(old, "src/web-hub/hub/http.ts"))};
import {wireWebHub} from ${JSON.stringify(join(old, "src/web-hub/agent/index.ts"))};
import {resolveHubPaths} from ${JSON.stringify(join(old, "src/web-hub/protocol/paths.ts"))};
import {DEFAULT_SETTINGS} from ${JSON.stringify(join(old, "src/config/settings.ts"))};
import {parseTerminalPolicy} from ${JSON.stringify(join(old, "src/web-hub/protocol/terminal-policy.ts"))};
import {createTerminalOwner} from ${JSON.stringify(join(old, "src/web-hub/agent/terminal/owner.ts"))};
import {createTerminalTestBackend} from ${JSON.stringify(join(old, "src/web-hub/agent/terminal/backend.ts"))};
import {runOrdinaryTerminalHost} from ${JSON.stringify(join(repo, "tests/integration/helpers/terminal-retained-ordinary-host.ts"))};
runOrdinaryTerminalHost({startHub,createHttpFrontend,wireWebHub,resolveHubPaths,defaults:DEFAULT_SETTINGS.webHub,parseTerminalPolicy,createTerminalOwner,createTerminalTestBackend});`;
    const consumed: Array<{ path: string; sha256: string }> = [];
    await build({
      absWorkingDir: repo,
      stdin: { contents: entry, resolveDir: repo, sourcefile: "ordinary-O7239.ts", loader: "ts" },
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      packages: "external",
      outfile: artifact,
      logLevel: "silent",
      plugins: [
        {
          name: "unpatched-source-measurement",
          setup(builder) {
            builder.onLoad({ filter: /\.ts$/ }, ({ path }) => {
              const bytes = readFileSync(path);
              consumed.push({ path, sha256: sha(bytes) });
              return { contents: bytes, loader: "ts", resolveDir: join(path, "..") };
            });
          },
        },
      ],
    });
    put(join(output, "measurement.json"), {
      v: 1,
      source: "7239dd115ac66039e2c4f80308ea5d08520aa6af",
      observationPatch: false,
      artifactSha256: sha(readFileSync(artifact)),
      inputs: consumed,
    });
    const paths = resolveHubPaths({ home: f.home, uid: process.getuid!() });
    if (paths.socketDir !== paths.stateDir) throw new Error("private original socket too long");
    const profile: InstallationProfile = {
      v: 1,
      kind: "terminal-retained-O7239",
      home: f.home,
      agentDir,
      stateDir: paths.stateDir,
      socketPath: paths.socketPath,
      piCli: realpathSync(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")),
      oldPackageRoot: old,
      newPackageRoot: selectedN,
      launchers: [join(bin, "pi")],
      autostartFiles: [],
    };
    put(join(installation, "profile.json"), profile);
    writeFileSync(profile.launchers[0]!, oldLauncherBytes(profile), { mode: 0o700 });
    put(join(agentDir, "settings.json"), { packages: [old] });
    put(join(agentDir, "pi-toolkit.json"), {
      webHub: { enabled: true, autoStart: false, control: true, webCommands: true, terminal: { enabled: true } },
    });
    const env = {
        ...process.env,
        HOME: f.home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_TOOLKIT_ENTRY: "src",
        NODE_OPTIONS: "",
      },
      cli = join(selectedN, "dist/maintenance/cli.mjs");
    copyFileSync(cli, join(output, "maintenance-cli.mjs"));
    copyFileSync(join(selectedN, "dist/maintenance/manifest.json"), join(output, "maintenance-manifest.json"));
    const run = (command: string, extra: string[] = [], stateFlag = true) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [cli, command, "--installation", installation, ...(stateFlag ? ["--state", paths.stateDir] : []), ...extra],
          { cwd: base, env, timeout: 30000, encoding: "utf8" },
        ),
      );
    const oldProcess = ordinaryProcess(artifact, env);
    let oldInfo: any, secondProcess: ReturnType<typeof ordinaryProcess> | undefined;
    const oldTargets: any[] = [];
    try {
      oldInfo = await oldProcess.request({ op: "start", home: f.home, fixture: f, socketDir: paths.socketDir });
      expect(typeof oldInfo.sessionFile).toBe("string");
      oldTargets.push(oldInfo);
      if (oldCount === 2) {
        secondProcess = ordinaryProcess(artifact, env);
        const second = await secondProcess.request({
          op: "start",
          agentOnly: true,
          home: f.home,
          fixture: f,
          socketDir: paths.socketDir,
        });
        const publicScope = await observeUntil(
          () => oldProcess.request({ op: "public-scope", sessionId: second.sessionId }),
          (v) => !!v.scope,
        );
        expect(publicScope.scope.sessionId).not.toBe(oldInfo.scope.sessionId);
        oldTargets.push({ ...second, scope: publicScope.scope });
      }
      const cookie = await privateLogin(oldInfo.port, paths.tokenFile),
        stream = await privateSse(oldInfo.port, cookie);
      try {
        const connection = await stream.wait((e) => e.event === "terminal_connection"),
          hello = await stream.wait((e) => e.event === "hello");
        for (let index = 0; index < oldCount; index++) {
          const selected = oldTargets[index];
          const common = {
            agentKey: selected.scope.agentKey,
            expect: { sessionId: selected.scope.sessionId, epoch: selected.scope.epoch },
            clientId: hello.data.clientId,
            connectionInstance: connection.data.connectionInstance,
            connectionToken: connection.data.connectionToken,
          };
          const post = async (op: string, body: object) => {
            const result = await privatePost(oldInfo.port, `/api/terminal/${op}`, { ...common, ...body }, cookie);
            expect(result.status).toBe(200);
            expect(result.body.ok).toBe(true);
            return result.body;
          };
          const prepared = await post("prepare", { cols: 80, rows: 24 }),
            opened = await post("open", {
              openId: prepared.openId,
              createTicket: prepared.createTicket,
              tabId: id(),
              cols: 80,
              rows: 24,
            });
          const writer = { termId: opened.termId, attachmentId: opened.attachmentId, writerLease: opened.writerLease };
          const replay = await stream.wait(
            (e) =>
              e.event === "terminal" &&
              e.data.attachmentId === opened.attachmentId &&
              e.data.event.kind === "replay_begin",
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
            (e) =>
              e.event === "terminal" && e.data.attachmentId === opened.attachmentId && e.data.event.kind === "cutover",
          );
          await post("input", {
            ...writer,
            inputSeq: opened.nextInputSeq,
            inputKind: "user",
            streamEpoch: cutover.data.event.newLiveEpoch,
            bytesB64: Buffer.from("printf 'T51_OLD_PID=%s\\n' \"$$\"\n").toString("base64"),
          });
          const output = await stream.wait(
            (e) =>
              e.event === "terminal" &&
              e.data.attachmentId === opened.attachmentId &&
              e.data.event.kind === "output" &&
              /T51_OLD_PID=\d+/.test(Buffer.from(e.data.event.bytesB64, "base64").toString()),
          );
          expect(/T51_OLD_PID=\d+/.test(Buffer.from(output.data.event.bytesB64, "base64").toString())).toBe(true);
        }
      } finally {
        stream.close();
      }
      await oldProcess.stop();
      await secondProcess?.stop();
    } catch (e) {
      secondProcess?.abandon();
      oldProcess.abandon();
      throw e;
    }
    const originalJournalPath = join(paths.stateDir, "terminal-v1/terminal-resource-fence-v1.json"),
      originalJournal = readFileSync(originalJournalPath),
      journal = JSON.parse(originalJournal.toString());
    expect(journal.resources).toHaveLength(oldCount); // No handmade dirty resource/identity.
    const token = readFileSync(paths.tokenFile);
    const init = run("retained-initialize", ["--evidence", evidence]);
    expect(init.legacyObligations).toBe(oldCount);
    const ledgerPath = join(paths.stateDir, "terminal-v2/ledger.json"),
      retained = JSON.parse(readFileSync(ledgerPath, "utf8")).legacyObligations;
    expect(retained).toHaveLength(oldCount);
    for (const row of retained) {
      expect(
        journal.resources.some((r: any) => JSON.stringify(r.entry.identity) === JSON.stringify(row.legacyIdentity)),
      ).toBe(true);
      expect(row.sessionBinding).toEqual({ kind: "verified", sessionId: row.legacyIdentity.agentSessionId });
    }
    expect(new Set(retained.map((r: any) => r.sessionBinding.sessionId)).size).toBe(oldCount);
    expect(run("publish-new", ["--expect-operation", init.operationId], false)).toMatchObject({
      phase: "publication-complete",
      mode: "new",
    });
    let app: RunningHub | undefined,
      sdk: Awaited<ReturnType<typeof createTerminalSdkAgent>> | undefined,
      service: any,
      backendCalls = 0,
      browserNativeDelta = 0,
      observedPrunes = 0;
    const startN = async (sameSession = true) => {
      let deps: any, initialized: Promise<void> | undefined;
      const originalEnv = [process.env.HOME, process.env.PI_CODING_AGENT_DIR, process.env.PI_WEBHUB_TERMINAL_SOURCE];
      try {
        process.env.HOME = f.home;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PI_WEBHUB_TERMINAL_SOURCE = "plain";
        const result = await startHub(
          {
            v: 1,
            home: f.home,
            port: 0,
            idleExitMinutes: 10,
            privacy: true,
            pluginVersion: "0.12.2",
            buildId: "real-retained-N",
          },
          (d) => {
            deps = d;
            return createHttpFrontend(d);
          },
          {
            terminalV2Test: {
              backend: (options) => {
                backendCalls++;
                return createTerminalTestBackend(options, f);
              },
              ready: (work, owner) => {
                initialized = work;
                service = owner;
              },
            },
          },
        );
        if (!("httpPort" in result)) throw new Error("real N start refused");
        app = result;
        await initialized;
      } finally {
        ["HOME", "PI_CODING_AGENT_DIR", "PI_WEBHUB_TERMINAL_SOURCE"].forEach((key, i) => {
          if (originalEnv[i] === undefined) delete process.env[key];
          else process.env[key] = originalEnv[i];
        });
      }
      sdk = await createTerminalSdkAgent({
        home: f.home,
        cwd: f.cwd,
        socketDir: paths.socketDir,
        version: "0.12.2",
        ...(sameSession ? { sessionFile: oldInfo.sessionFile } : {}),
      });
      const target = await observeUntil(
        async () =>
          deps.registry
            .list()
            .find(
              (agent: any) =>
                agent.session?.sessionId === sdk!.manager.getSessionId() && agent.status?.terminalSessionV2,
            ),
        (v) => !!v,
      );
      return {
        scope: { agentKey: target.agentKey, sessionId: target.session.sessionId, epoch: target.epoch },
        cookie: await privateLogin(app!.httpPort, paths.tokenFile),
      };
    };
    const stopN = async () => {
      if (sdk) {
        await sdk.close();
        sdk = undefined;
      }
      if (app) {
        await app.close("retained-test-stop");
        app = undefined;
      }
    };
    try {
      const current = await startN(),
        post = async (op: string, body: object) =>
          privatePost(app!.httpPort, `/api/terminal/v2/${op}`, body, current.cookie);
      const listed = await post("list", { scope: current.scope });
      expect(listed.status).toBe(200);
      expect(listed.body.unknownResources).toHaveLength(Math.min(1, oldCount));
      expect(listed.body.quota.principal).toMatchObject({ used: oldCount, unknown: oldCount });
      expect(listed.body.quota.session.used).toBe(Math.min(1, oldCount));
      const envelope = { scope: current.scope, hubInstance: listed.body.hubInstance };
      if (oldCount)
        expect((await post("close", { ...envelope, termId: retained[0].obligationId })).body.code).toBe(
          "E_CLEANUP_UNKNOWN",
        );
      expect(backendCalls).toBe(0);
      if (oldCount < 2) {
        const opened = await post("create", { ...envelope, requestId: id(), mode: "ensure-empty", cols: 80, rows: 24 });
        expect(opened.status).toBe(200);
        expect(opened.body.ok).toBe(true);
        expect(backendCalls).toBe(1);
        const term = { ...envelope, termId: opened.body.termId },
          view = await privateTerminalView(app!.httpPort, current.cookie, term);
        try {
          const attached = await view.wait((frame) => frame.t === "attached"),
            replay = await view.wait((frame) => frame.t === "replay-end"),
            writer = { ...term, viewId: attached.viewId };
          await post("ack", { ...writer, offset: replay.offset, replayComplete: true });
          await view.wait((frame) => frame.t === "ready");
          await post("input", {
            ...writer,
            seq: 1,
            kind: "user",
            bytesB64: Buffer.from("printf 'T51_NEW_PID=%s\\n' \"$$\"\n").toString("base64"),
          });
          const output = await view.wait(
            (frame) => frame.t === "output" && /T51_NEW_PID=\d+/.test(Buffer.from(frame.bytesB64, "base64").toString()),
          );
          expect(/T51_NEW_PID=\d+/.test(Buffer.from(output.bytesB64, "base64").toString())).toBe(true);
        } finally {
          view.close();
        }
        if (oldCount === 1) {
          const denied = await post("create", { ...envelope, requestId: id(), mode: "new", cols: 80, rows: 24 });
          expect(denied.body.code).toBe("E_LIMIT");
          expect(backendCalls).toBe(1);
        }
        await post("close", term);
        await observeUntil(
          async () => service.maintenanceSnapshot(),
          (s) => s.physicalPrunes === 1 && s.allocationCount === oldCount && s.ledger.allocations.length === 0,
        );
      } else {
        const denied = await post("create", { ...envelope, requestId: id(), mode: "ensure-empty", cols: 80, rows: 24 });
        expect(denied.body.code).toBe("E_LIMIT");
        expect(backendCalls).toBe(0);
      }
      if (oldCount > 0 && process.env.PI_TOOLKIT_RETAINED_BROWSER === "1") {
        const browser = await probeRetainedBrowser({
          port: app!.httpPort,
          tokenFile: paths.tokenFile,
          ledgerPath,
          scope: current.scope,
          legacyCount: oldCount as 1 | 2,
          output: base,
          backendCalls: () => backendCalls,
        });
        browserNativeDelta = browser.backendDelta;
        await observeUntil(
          async () => service.maintenanceSnapshot(),
          (s) =>
            s.physicalPrunes === (oldCount < 2 ? 1 : 0) + browser.physicalPrunes && s.ledger.allocations.length === 0,
        );
      }
      observedPrunes = service.maintenanceSnapshot().physicalPrunes;
      expect(observedPrunes).toBe((oldCount < 2 ? 1 : 0) + browserNativeDelta);
      expect(JSON.parse(readFileSync(ledgerPath, "utf8")).legacyObligations).toEqual(retained);
      await stopN();
      const restarted = await startN(oldCount < 2),
        list = await privatePost(app!.httpPort, "/api/terminal/v2/list", { scope: restarted.scope }, restarted.cookie);
      expect(list.body.quota.principal).toMatchObject({ used: oldCount, unknown: oldCount });
      expect(list.body.unknownResources).toHaveLength(oldCount === 2 ? 0 : oldCount);
      expect(list.body.quota.session.used).toBe(oldCount === 2 ? 0 : oldCount);
      expect(backendCalls).toBe((oldCount < 2 ? 1 : 0) + browserNativeDelta);
      if (oldCount === 2) {
        expect(restarted.scope.sessionId).not.toBe(oldInfo.scope.sessionId);
        const denied = await privatePost(
          app!.httpPort,
          "/api/terminal/v2/create",
          {
            scope: restarted.scope,
            hubInstance: list.body.hubInstance,
            requestId: id(),
            mode: "ensure-empty",
            cols: 80,
            rows: 24,
          },
          restarted.cookie,
        );
        expect(denied.body.code).toBe("E_LIMIT");
        expect(backendCalls).toBe(0);
        const publicStream = await privateSse(app!.httpPort, restarted.cookie);
        try {
          expect((await publicStream.wait((e) => e.event === "hello")).data.clientId).toBeTruthy();
        } finally {
          publicStream.close();
        }
      }
      await stopN();
      expect(run("resume", ["--operation", init.operationId])).toMatchObject({
        phase: "publication-complete",
        mode: "new",
        legacyObligations: oldCount,
      });
      expect(run("rollback-inspect")).toMatchObject({ oldTerminalOnAllowed: false, legacyObligations: oldCount });
      expect(run("publish-old-off", ["--expect-operation", init.operationId], false)).toMatchObject({
        phase: "publication-complete",
        mode: "old-off",
      });
      const offProcess = ordinaryProcess(artifact, env);
      try {
        const off = await offProcess.request({
          op: "start",
          expectTerminal: false,
          home: f.home,
          fixture: f,
          socketDir: paths.socketDir,
        });
        expect(off.terminalDeclared).toBe(false);
        expect(off.caps.filter((cap: string) => cap.startsWith("terminal."))).toEqual([]);
        const offCookie = await privateLogin(off.port, paths.tokenFile),
          publicStream = await privateSse(off.port, offCookie);
        try {
          expect((await publicStream.wait((e) => e.event === "hello")).data.clientId).toBeTruthy();
        } finally {
          publicStream.close();
        }
        const disabled = await privatePost(off.port, "/api/terminal/prepare", {}, offCookie);
        expect(disabled.status).toBe(404);
        expect(disabled.body.error).toBe("E_NOT_FOUND");
        await offProcess.stop();
      } catch (error) {
        offProcess.abandon();
        throw error;
      }
      expect(readFileSync(originalJournalPath)).toEqual(originalJournal);
      expect(readFileSync(paths.tokenFile)).toEqual(token);
      expect(JSON.parse(readFileSync(ledgerPath, "utf8")).legacyObligations).toEqual(retained);
      expect(run("publish-new", ["--expect-operation", init.operationId], false)).toMatchObject({
        phase: "publication-complete",
        mode: "new",
        sequence: 3,
      });
      const beforeReturn = backendCalls,
        returned = await startN();
      const returnedList = await privatePost(
        app!.httpPort,
        "/api/terminal/v2/list",
        { scope: returned.scope },
        returned.cookie,
      );
      expect(returnedList.body.quota.principal).toMatchObject({ used: oldCount, unknown: oldCount });
      expect(backendCalls).toBe(beforeReturn);
      expect(JSON.parse(readFileSync(ledgerPath, "utf8")).legacyObligations).toEqual(retained);
      await stopN();
      expect(readFileSync(originalJournalPath)).toEqual(originalJournal);
      expect(readFileSync(paths.tokenFile)).toEqual(token);
      put(join(base, "retained-existing-result.json"), {
        v: 1,
        oldRuntime: {
          source: "7239dd115ac66039e2c4f80308ea5d08520aa6af",
          observationPatch: false,
          artifactSha256: sha(readFileSync(artifact)),
        },
        operationId: init.operationId,
        sourceManifestSha256: init.sourceManifestSha256,
        legacyIds: retained.map((r: any) => r.obligationId),
        realOldCreates: oldCount,
        resourceBearingOldSessions: oldCount,
        normalOldShutdown: true,
        newNativeBackendCalls: backendCalls,
        realNewPhysicalPrunes: observedPrunes,
        actualRetainedBrowser: oldCount > 0 && process.env.PI_TOOLKIT_RETAINED_BROWSER === "1",
        independentResume: true,
        offPublication: true,
        actualOldOffServiceAuthAndPublicSse: true,
        actualOldOffTerminalPrepare: "404 E_NOT_FOUND",
        returnNewSameLegacyIdsAndQuota: true,
        realKernelReboot: false,
        fixtureRoot: base,
        selectedN,
        consumerWithoutNodeModules: !!process.env.PI_TOOLKIT_RETAINED_CONSUMER_ROOT,
      });
      console.log(`retained existing ordinary evidence: ${base}`);
    } finally {
      await stopN();
    }
  },
  120000,
);
