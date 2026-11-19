import { probeDiagnostics, formatProbeDiagnostics } from "../../../scripts/ci/safe-diagnostics.mjs";
/** Private ordinary O setup copied from retained-existing: unpatched O, original
 * SDK, genuine journal. N runtime is deliberately NOT imported by this helper. */
import { execFileSync, fork, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect } from "vitest";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { oldLauncherBytes } from "../../../scripts/web-hub/terminal-v2-retained/entries.js";
import type { InstallationProfile } from "../../../scripts/web-hub/terminal-v2-retained/installation.js";
import {
  privateLogin,
  privatePost,
  privateSse,
  observeUntil,
} from "../../../scripts/web-hub/terminal-v2-maintenance/http-client.js";
import { makeTerminalFixture } from "../terminal-v2-backend-fixture.js";
const id = () => randomBytes(24).toString("base64url");
function consumerExec(file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  try {
    return execFileSync(file, args, options);
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer; status?: number; code?: string };
    const text = `${failure.stdout ?? ""}`;
    const internal = /"error":"(E_RETAINED_LOAD_PROBE_(?:DEADLINE|FAILED|RECEIPT))"/.exec(text)?.[1] ?? "unavailable";
    const outer = ["ETIMEDOUT", "EACCES", "ENOENT"].includes(failure.code ?? "") ? failure.code : "none";
    const status = Number.isInteger(failure.status) ? failure.status : "unknown";
    throw new Error(
      `consumer CLI failed status=${status} outer=${outer} internal=${internal} ${formatProbeDiagnostics(probeDiagnostics(String(failure.stderr ?? "")))}`,
    );
  }
}
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
export async function prepareStockRetained(consumer: string, oldCount: 1 | 2) {
  const native = makeTerminalFixture(),
    f = native.fixture,
    repo = resolve("."),
    selectedN = consumer,
    base = f.root;
  expect(existsSync(join(selectedN, "node_modules"))).toBe(false);
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
    webHub: {
      enabled: true,
      autoStart: true,
      port: 0,
      privacy: true,
      control: true,
      webCommands: true,
      terminal: { enabled: true },
    },
  });
  const env = {
      HOME: f.home,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME!,
      TMPDIR: process.env.TMPDIR!,
      JITI_FS_CACHE: "false",
      PI_CODING_AGENT_DIR: agentDir,
      PI_TOOLKIT_ENTRY: "src",
      NODE_OPTIONS: "",
    },
    cli = join(selectedN, "dist/maintenance/cli.mjs");
  copyFileSync(cli, join(output, "maintenance-cli.mjs"));
  copyFileSync(join(selectedN, "dist/maintenance/manifest.json"), join(output, "maintenance-manifest.json"));
  const run = (command: string, extra: string[] = [], stateFlag = true) =>
    JSON.parse(
      consumerExec(
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
  // Terminal-only test handoff for a SECOND independent Vitest process. No
  // token/auth bytes are copied: only a hash checks the original token in place.
  put(join(base, "stock-installation.json"), {
    base,
    f,
    profile,
    paths,
    installation,
    evidence,
    agentDir,
    init,
    ledgerPath,
    retained,
    originalJournalPath,
    oldInfo,
    originalJournalSha256: sha(originalJournal),
    tokenSha256: sha(token),
  });
  return {
    base,
    f,
    profile,
    paths,
    installation,
    evidence,
    agentDir,
    env,
    run,
    init,
    ledgerPath,
    retained,
    originalJournalPath,
    originalJournal,
    token,
    oldInfo,
  };
}
/** Reopen genuine prior fixture state, not a new runtime/constructor history. */
export function reopenStockRetained(base: string): Awaited<ReturnType<typeof prepareStockRetained>> {
  const saved = JSON.parse(readFileSync(join(base, "stock-installation.json"), "utf8"));
  expect(saved.base).toBe(base);
  const originalJournal = readFileSync(saved.originalJournalPath),
    token = readFileSync(saved.paths.tokenFile);
  expect(sha(originalJournal)).toBe(saved.originalJournalSha256);
  expect(sha(token)).toBe(saved.tokenSha256);
  expect(JSON.parse(readFileSync(saved.ledgerPath, "utf8")).legacyObligations).toEqual(saved.retained);
  const env = {
    HOME: saved.f.home,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME!,
    TMPDIR: process.env.TMPDIR!,
    PI_CODING_AGENT_DIR: saved.agentDir,
    JITI_FS_CACHE: "false",
    NODE_OPTIONS: "",
  };
  const cli = join(saved.profile.newPackageRoot, "dist/maintenance/cli.mjs");
  const run = (command: string, extra: string[] = [], stateFlag = true) =>
    JSON.parse(
      consumerExec(
        process.execPath,
        [
          cli,
          command,
          "--installation",
          saved.installation,
          ...(stateFlag ? ["--state", saved.paths.stateDir] : []),
          ...extra,
        ],
        { cwd: base, env, timeout: 30000, encoding: "utf8" },
      ),
    );
  return { ...saved, originalJournal, token, env, run };
}
