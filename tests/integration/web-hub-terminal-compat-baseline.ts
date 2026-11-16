/** Complete locked baseline + real separate-process harness. No production patching,
 * target.allowed substitution, fake authority, fake receipts or dependency installation. */
import { ProcessStartup } from "./helpers/process-startup.js";
import assert from "node:assert/strict";
import { get } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { makeTerminalFixture, writeTerminalMachinePolicy } from "./web-hub-terminal-fixture.js";
import { login, openSse, postJson, rawRequest, type SseConn } from "../web-hub/http/helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { TERMINAL_HTTP_PATHS } from "../../src/web-hub/protocol/terminal-paths.js";

export const OLD_SHA = "4e15fac15ee42293eac7c19943655537bd21b7c2";
export const CURRENT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const LIMITS = {
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  inputIdleMs: 3600000,
  maxLifetimeMs: 28800000,
};
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
function treeHash(root: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    for (const f of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = join(rel, f.name);
      if (f.isDirectory()) walk(name);
      else if (f.isFile()) lines.push(`${name}\0${sha(readFileSync(join(root, name)))}`);
    }
  };
  walk("");
  return sha(lines.join("\n"));
}
/** Off parity runs both components as archive installs (neither has git metadata).
 * This preserves the normal bootHead absence rather than stripping its wire field. */
export function currentSourceSnapshot() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: CURRENT_ROOT,
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  const root = mkdtempSync(join(tmpdir(), "nb-"));
  chmodSync(root, 0o700);
  const tar = `${root}.tar`;
  execFileSync("git", ["archive", "--format=tar", `--output=${tar}`, commit], {
    cwd: CURRENT_ROOT,
    timeout: 30000,
    stdio: "inherit",
  });
  execFileSync("tar", ["-xf", tar, "-C", root], { cwd: CURRENT_ROOT, timeout: 30000, stdio: "inherit" });
  const provenance = { commit, archiveSha256: sha(readFileSync(tar)), sourceTreeHash: treeHash(root) };
  symlinkSync(join(CURRENT_ROOT, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "provenance.json"), JSON.stringify(provenance, null, 2));
  console.log(`CURRENT_SOURCE_PROVENANCE ${root} ${JSON.stringify(provenance)}`);
  return root;
}
export async function lockedBaseline() {
  let commit: string;
  try {
    commit = execFileSync("git", ["rev-parse", "--verify", `${OLD_SHA}^{commit}`], {
      cwd: CURRENT_ROOT,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new Error(
      `Terminal compatibility tests require the complete locked baseline ${OLD_SHA}. ` +
        "Full Git history is required: use actions/checkout with fetch-depth: 0 in CI, " +
        "or run git fetch --unshallow origin in a shallow local clone (git fetch origin in a full clone). " +
        "Restore the historical commit and rerun; old-component evidence must not be skipped.",
      { cause },
    );
  }
  assert.equal(commit, OLD_SHA);
  const root = mkdtempSync(join(tmpdir(), "ob-"));
  chmodSync(root, 0o700);
  const archivePath = `${root}.tar`;
  execFileSync("git", ["archive", "--format=tar", `--output=${archivePath}`, OLD_SHA], {
    cwd: CURRENT_ROOT,
    timeout: 30000,
    stdio: "inherit",
  });
  execFileSync("tar", ["-xf", archivePath, "-C", root], { cwd: CURRENT_ROOT, timeout: 30000, stdio: "inherit" });
  const archiveSha256 = sha(readFileSync(archivePath));
  const sourceTreeHash = treeHash(root);
  symlinkSync(join(CURRENT_ROOT, "node_modules"), join(root, "node_modules"), "dir");
  const log = join(root, "build.log");
  const buildEpoch = execFileSync("git", ["show", "-s", "--format=%ct", OLD_SHA], {
    cwd: CURRENT_ROOT,
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  await new Promise<void>((done, fail) => {
    const child = spawn(
      join(CURRENT_ROOT, "node_modules/.bin/vite"),
      ["build", "--config", join(root, "src/web-hub/ui/vite.config.ts")],
      {
        cwd: CURRENT_ROOT,
        env: {
          ...process.env,
          NODE_ENV: "production",
          SOURCE_DATE_EPOCH: buildEpoch,
          PWH_UI_CACHE_DIR: join(root, "cache"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let text = "";
    const output = (b: Buffer) => {
      text += b.toString();
      process.stdout.write(b);
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    const t = setTimeout(() => child.kill("SIGKILL"), 180000);
    t.unref();
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(t);
      writeFileSync(log, text);
      code === 0 ? done() : fail(new Error(`baseline build ${code}: ${log}`));
    });
  });
  const toolVersions = Object.fromEntries(
    [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-tui",
      "tsx",
      "vite",
      "vue",
      "@vitejs/plugin-vue",
    ].map((p) => [p, JSON.parse(readFileSync(join(CURRENT_ROOT, "node_modules", p, "package.json"), "utf8")).version]),
  );
  assert.equal(toolVersions["@earendil-works/pi-coding-agent"], "1.5.0");
  const provenance = {
    commit: OLD_SHA,
    buildEpoch,
    archiveSha256,
    sourceTreeHash,
    node: process.version,
    toolVersions,
    packageSha256: sha(readFileSync(join(root, "package.json"))),
    lockSha256: sha(readFileSync(join(root, "package-lock.json"))),
    uiManifestSha256: sha(readFileSync(join(root, "dist/web-hub-ui/build-info.json"))),
    uiArtifactTreeSha256: treeHash(join(root, "dist/web-hub-ui")),
    adapterSha256: sha(readFileSync(join(CURRENT_ROOT, "tests/integration/fixtures/terminal-agent.ts"))),
    harnessSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    fixtureSha256: sha(readFileSync(join(CURRENT_ROOT, "tests/integration/web-hub-terminal-fixture.ts"))),
  };
  writeFileSync(join(root, "provenance.json"), JSON.stringify(provenance, null, 2), { mode: 0o600 });
  console.log(`BASELINE_PROVENANCE ${join(root, "provenance.json")} ${JSON.stringify(provenance)}`);
  // Retain evidence under private TMPDIR, not a cache silently accepted across commits.
  return { root, provenance };
}

let sequence = 0;
export function processPeer(script: string, args: string[], options: { home: string; cwd: string; source?: string }) {
  const env = { ...process.env, HOME: options.home, NODE_OPTIONS: "" };
  delete env.XDG_RUNTIME_DIR;
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_WEBHUB_TERMINAL_SOURCE;
  if (options.source !== undefined) env.PI_WEBHUB_TERMINAL_SOURCE = options.source;
  const boot = new ProcessStartup();
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(join(CURRENT_ROOT, "node_modules/tsx/dist/loader.mjs")).href, script, ...args],
    {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  boot.observe(child, "terminal peer");
  const messages: any[] = [];
  let errors = "",
    output = "";
  child.stdout!.on("data", (b) => {
    output = (output + b.toString()).slice(-8192);
  });
  child.stderr!.on("data", (b) => {
    errors = (errors + b.toString()).slice(-8192);
  });
  child.on("message", (m) => messages.push(m));
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  return {
    child,
    messages,
    errors: () => errors,
    async ready() {
      await boot.wait(
        () => output.includes("READY"),
        (ready) => ready,
        "separate process ready",
      );
      assert.equal(child.exitCode, null, boot.diagnostic());
      return messages.find((m) => m.event === "ready");
    },
    async command(op: string, data: object = {}) {
      const id = ++sequence;
      child.send({ id, op, ...data });
      await waitUntil(() => messages.some((m) => m.id === id), 10000, `IPC ${op}`);
      const m = messages.find((m) => m.id === id);
      assert(!m.error, m.error);
      return m;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin!.end("STOP\n");
      const t = setTimeout(() => child.kill("SIGKILL"), 8000);
      t.unref();
      await exited;
      clearTimeout(t);
    },
  };
}
export type Peer = ReturnType<typeof processPeer>;
export function isolatedMachine(enabled = true, limits: object = {}) {
  const root = mkdtempSync(join(tmpdir(), "tm-"));
  chmodSync(root, 0o700);
  const home = join(root, "h"),
    processCwd = join(root, "p");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(processCwd, { mode: 0o700 });
  writeTerminalMachinePolicy(home, enabled, limits);
  const peers: Peer[] = [],
    streams: SseConn[] = [],
    fixtures: ReturnType<typeof makeTerminalFixture>[] = [];
  return {
    root,
    home,
    processCwd,
    peers,
    streams,
    async hub(
      componentRoot = CURRENT_ROOT,
      options: {
        source?: string;
        legacy?: boolean;
        uiRoot?: string;
        privacy?: boolean;
        legacyLimits?: object;
        spawn?: boolean;
        viaLauncher?: boolean;
        oldLauncherRoot?: string;
        launchDomain?: "locked";
      } = {},
    ) {
      const path = join(root, `hub-${sequence++}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          componentRoot,
          home,
          legacy: options.legacy ?? false,
          uiRoot: options.uiRoot,
          privacy: options.privacy ?? false,
          legacyLimits: options.legacyLimits,
          spawn: options.spawn,
          viaLauncher: options.viaLauncher,
          oldLauncherRoot: options.oldLauncherRoot,
          launchDomain: options.launchDomain,
        }),
      );
      const peer = processPeer(fileURLToPath(import.meta.url), ["--hub", path], {
        home,
        cwd: processCwd,
        ...(options.source === undefined ? {} : { source: options.source }),
      });
      peers.push(peer);
      const info = await peer.ready();
      return { peer, ...info } as { peer: Peer; port: number; paths: any; caps: string[]; pid: number };
    },
    async agent(
      componentRoot = CURRENT_ROOT,
      options: { sessionId?: string; terminalOff?: boolean; limits?: object } = {},
    ) {
      const f = makeTerminalFixture();
      fixtures.push(f);
      const path = join(f.fixture.root, "agent.json");
      writeFileSync(
        path,
        JSON.stringify({ componentRoot, home, fixture: f.fixture, pluginVersion: "0.12.1", ...options }),
      );
      const peer = processPeer(join(CURRENT_ROOT, "tests/integration/fixtures/terminal-agent.ts"), [path], {
        home,
        cwd: processCwd,
        source: "plain",
      });
      peers.push(peer);
      await peer.ready();
      return { peer, fixture: f.fixture, sessionId: options.sessionId ?? "child-terminal-session" };
    },
    async browser(hub: { port: number; paths: any }, cookie?: string) {
      cookie ??= await login(hub.port, hub.paths.tokenFile);
      const sse = await openSse(hub.port, { cookie });
      streams.push(sse);
      const hello = await sse.waitFor((e) => e.event === "hello");
      const connection = await sse.waitFor((e) => e.event === "terminal_connection");
      return terminalBrowser(hub.port, cookie, sse, hello, connection);
    },
    async close() {
      for (const s of streams) s.close();
      for (const p of peers.reverse()) await p.close();
      for (const f of fixtures.reverse()) f.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function terminalBrowser(port: number, cookie: string, sse: SseConn, hello: any, connection: any) {
  const identity = {
    clientId: hello.data.clientId,
    connectionInstance: connection.data.connectionInstance,
    connectionToken: connection.data.connectionToken,
  };
  const writer = (a: any) => ({ termId: a.termId, attachmentId: a.attachmentId, writerLease: a.writerLease });
  const post = async (card: any, op: keyof typeof TERMINAL_HTTP_PATHS, extra: object = {}) => {
    const r = await postJson(
      port,
      TERMINAL_HTTP_PATHS[op],
      {
        ...identity,
        agentKey: card.agentKey,
        expect: { sessionId: card.session.sessionId, epoch: card.epoch },
        ...extra,
      },
      { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
    );
    return { status: r.status, body: JSON.parse(r.body) };
  };
  return {
    cookie,
    sse,
    identity,
    writer,
    post,
    output(termId: string) {
      return sse.events
        .filter((e) => e.event === "terminal" && e.data.event.termId === termId && e.data.event.kind === "output")
        .map((e) => Buffer.from(e.data.event.bytesB64, "base64").toString())
        .join("");
    },
    async open(card: any) {
      const p = await post(card, "prepare", { cols: 80, rows: 24 });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      const o = await post(card, "open", {
        openId: p.body.openId,
        createTicket: p.body.createTicket,
        tabId: "test-tab",
        cols: 80,
        rows: 24,
      });
      assert.equal(o.status, 200, JSON.stringify(o.body));
      const a = o.body;
      const begin = await sse.waitFor(
        (e) => e.event === "terminal" && e.data.attachmentId === a.attachmentId && e.data.event.kind === "replay_begin",
      );
      const ack = await post(card, "ack", {
        ...writer(a),
        ack: {
          phase: "replay_ready",
          attemptId: begin.data.event.attemptId,
          replayEpoch: begin.data.event.replayEpoch,
          renderedThrough: begin.data.event.N0,
        },
      });
      assert.equal(ack.status, 200, JSON.stringify(ack.body));
      const cut = await sse.waitFor(
        (e) => e.event === "terminal" && e.data.attachmentId === a.attachmentId && e.data.event.kind === "cutover",
      );
      return { ...a, streamEpoch: cut.data.event.newLiveEpoch, inputSeq: a.nextInputSeq };
    },
    async input(card: any, a: any, text: string) {
      const r = await post(card, "input", {
        ...writer(a),
        inputSeq: a.inputSeq++,
        inputKind: "user",
        streamEpoch: a.streamEpoch,
        bytesB64: Buffer.from(text).toString("base64"),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    },
    async close(card: any, a: any) {
      const r = await post(card, "close", {
        termId: a.termId,
        closeId: `close-${a.termId}`,
        expectedRevision: a.revision,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    },
  };
}
export async function cardFor(hub: { peer: Peer }, sessionId: string, claim = true) {
  let card: any;
  // waitUntil deliberately accepts sync predicates; IPC status is sampled explicitly.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const snapshot = await hub.peer.command("snapshot");
    card = snapshot.cards.find((v: any) => v.session?.sessionId === sessionId);
    if (card && (!claim || card.status?.terminalSession)) return card;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`target not ready: ${sessionId}`);
}
export async function drained(hub: { paths: any }, minRevision = 0) {
  const dir = join(hub.paths.stateDir, "terminal-v1");
  await waitUntil(
    () => {
      const j = JSON.parse(readFileSync(join(dir, "terminal-resource-fence-v1.json"), "utf8"));
      return j.resources.length === 0 && j.revision >= minRevision && readdirSync(join(dir, "receipts")).length === 0;
    },
    65000,
    "actual durable prune + receipt ACK",
  ).catch((error) => {
    const journal = JSON.parse(readFileSync(join(dir, "terminal-resource-fence-v1.json"), "utf8"));
    const receipts = readdirSync(join(dir, "receipts")).map((f) => {
      const r = JSON.parse(readFileSync(join(dir, "receipts", f), "utf8"));
      return { identity: r.identity, physical: r.physical };
    });
    throw new Error(`${error}; ${JSON.stringify({ journal, receipts })}`);
  });
}

/** Identity-only projection. No feature/cap/status/HTTP keys are removed or sorted. */
export async function offBytes(hub: any, agent: any) {
  await cardFor(hub, agent.sessionId, false);
  const frames = agent.peer.messages.filter((m: any) => m.event === "agent-wire");
  const first = (type: string) => frames.find((m: any) => JSON.parse(m.raw).t === type).raw as string;
  const hello = JSON.parse(first("hello")),
    ack = JSON.parse(first("hello_ack"));
  const cookie = await login(hub.port, hub.paths.tokenFile);
  const rawSse = await new Promise<string>((resolve, reject) => {
    let raw = "";
    const req = get({ host: "127.0.0.1", port: hub.port, path: "/api/events", headers: { Cookie: cookie } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        const start = raw.indexOf("event: fleet\n");
        const end = start < 0 ? -1 : raw.indexOf("\n\n", start);
        if (end >= 0) {
          req.destroy();
          clearTimeout(timer);
          resolve(raw.slice(0, end + 2));
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("off raw SSE deadline"));
    }, 5000);
    timer.unref();
    req.on("error", reject);
  });
  const blocks = rawSse
    .trim()
    .split("\n\n")
    .map((x) =>
      JSON.parse(
        x
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      ),
    );
  const info = blocks[1];
  const literals: Array<[string, string]> = [
    [JSON.stringify(hello.agentId.nonce), JSON.stringify("<agent-nonce>")],
    [JSON.stringify(hello.epoch), JSON.stringify("<epoch>")],
    [JSON.stringify(hello.cwd), JSON.stringify("<ctx-cwd>")],
    [JSON.stringify(hello.launcher), JSON.stringify(["<node>", "<fixture-host>"])],
    [JSON.stringify(ack.agentKey), JSON.stringify("<agent-key>")],
    [JSON.stringify(blocks[0].clientId), JSON.stringify("<sse-client>")],
  ];
  const normalize = (raw: string) => {
    for (const [from, to] of literals) raw = raw.split(from).join(to);
    return raw
      .replaceAll(`"pid":${hello.agentId.pid}`, `"pid":"<agent-pid>"`)
      .replaceAll(`"pid":${info.pid}`, `"pid":"<hub-pid>"`)
      .replaceAll(`"port":${hub.port}`, `"port":"<http-port>"`)
      .replaceAll(`"startedAt":${info.startedAt}`, `"startedAt":"<boot-time>"`)
      .replace(/"sampledAt":\d+/g, '"sampledAt":"<model-sampled-time>"');
  };
  const routes = [];
  for (const path of Object.values(TERMINAL_HTTP_PATHS)) {
    const r = await rawRequest(hub.port, { path, headers: { Cookie: cookie } });
    routes.push({ path, status: r.status, body: r.body });
  }
  return {
    wire: ["hello", "hello_ack", "session", "status"].map((t) => normalize(first(t)) + "\n"),
    sse: normalize(rawSse),
    routes,
  };
}

// Production hub entry in its own Node process; only UI root selection is DI.
if (process.argv[2] === "--hub") {
  const input = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  const load = (file: string) => import(pathToFileURL(join(input.componentRoot, file)).href);
  const { startHub } = await load("src/web-hub/hub/hub.ts");
  const { createHttpFrontend } = await load("src/web-hub/hub/http.ts");
  const { createUiServer } = await load("src/web-hub/hub/static.ts");
  let frontend: any;
  let spawnConfig: object | undefined;
  if (input.spawn) {
    const pkg = join(input.home, "launcher", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(pkg, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.0" }),
    );
    const entry = join(pkg, "pi.mjs");
    // Audited fake-pi host observation, not an authority/target/verifier replacement.
    writeFileSync(
      entry,
      `import {readFileSync,writeFileSync} from "node:fs";
      import {join} from "node:path";
      const i=process.argv.indexOf("--session-id"),id=i<0?null:process.argv[i+1];
      const privacy=JSON.parse(readFileSync(join(process.env.HOME,".pi/agent/web-hub/privacy.json"),"utf8"));
      writeFileSync(join(process.cwd(),".privacy-entry.json"),JSON.stringify({id,pid:process.pid,marked:privacy.locked[id]===true}));
      await import(${JSON.stringify(pathToFileURL(join(CURRENT_ROOT, "tests/integration/fixtures/fake-rpc-pi.mjs")).href)});`,
    );
    spawnConfig = {
      launcher: [process.execPath, entry],
      spawn: {
        roots: [input.home],
        maxProcesses: 2,
        maxPerPrincipal: 2,
        ratePerMinute: 30,
        maxLifetimeMinutes: 10,
        registerTimeoutS: 10,
        lan: "off",
        history: true,
        restore: false,
      },
    };
  }
  const launchProduction = async () => {
    const { initSecureDomain } = await load("src/secure/domain.ts");
    if (input.launchDomain === "locked") {
      process.env.PI_SECURE_VAULT = "tps-unconfigured-vault";
      process.env.PI_WEBHUB_TERMINAL_SOURCE = "plain"; // inherited marker must not override frozen locked verdict
    }
    assert.equal(initSecureDomain().kind, input.launchDomain ?? "plain");
    const { wireWebHub } = await load("src/web-hub/agent/index.ts");
    const { fakePi, fakeCtx, SETTINGS } = await load("tests/web-hub/agent/helpers.ts");
    const { resolveHubPaths } = await load("src/web-hub/protocol/paths.ts");
    const a = fakePi(),
      c = fakeCtx({ sessionId: "unqualified-launcher", mode: "rpc" });
    const paths = resolveHubPaths({ home: input.home, uid: process.getuid!() });
    const boot = new ProcessStartup();
    let child: ChildProcess | undefined, launchConfig: any;
    const observeSpawn = (...args: any[]) => {
      launchConfig = JSON.parse(args[2].env.PI_WEBHUB_CONFIG);
      child = boot.spawn(...(args as Parameters<typeof spawn>));
      return child;
    };
    if (input.oldLauncherRoot) {
      // Actual locked O launcher implementation starts the actual N main entry.
      // No marker deletion, fake version flag or patched production code.
      const { resolveJitiCli, spawnHub } = await import(
        pathToFileURL(join(input.oldLauncherRoot, "src/web-hub/agent/launcher.ts")).href
      );
      const argv1 = join(CURRENT_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
      const jiti = resolveJitiCli({ argv1, override: "" });
      assert(jiti.ok, "locked old jiti resolver");
      const launched = spawnHub(
        { execPath: process.execPath, jitiCli: jiti.jitiCli, argv1 },
        join(input.componentRoot, "src/web-hub/hub/main.ts"),
        {
          v: 1,
          home: input.home,
          port: 0,
          idleExitMinutes: 10,
          pluginVersion: "0.12.1",
          buildId: "terminal-old-launcher",
          terminal: LIMITS,
        },
        observeSpawn,
      );
      assert.equal(launched.blocked, false);
      await boot.wait(
        () => existsSync(paths.hubJson),
        (ready) => ready,
        "actual old spawnHub starts new main",
      );
      assert(Object.hasOwn(launchConfig, "terminal"), "old launcher supplies its actual legacy config");
    } else {
      const ctl = wireWebHub(a.pi, {
        settings: { ...SETTINGS, autoStart: true, terminal: { enabled: false, ...LIMITS } },
        terminalGuard: () => false,
        fleet: () => [],
        paths,
        env: { HOME: input.home },
        argv1: join(CURRENT_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        buildInfo: async () => ({ pluginVersion: "0.12.1", buildId: "terminal-launcher-integration" }),
        spawnImpl: observeSpawn,
      });
      a.fire("session_start", { type: "session_start" }, c.ctx);
      await boot.wait(
        () => existsSync(paths.hubJson) && ctl.status().state === "live",
        (ready) => ready,
        "real spawnHub main entry",
      );
      assert(!Object.hasOwn(launchConfig, "terminal"), "unqualified launcher must not supply terminal config");
    }
    const record = JSON.parse(readFileSync(paths.hubJson, "utf8"));
    const cookie = await login(record.port, paths.tokenFile);
    const snapshot = async () => {
      const stream = await openSse(record.port, { cookie });
      try {
        const agents = await stream.waitFor((e) => e.event === "agents");
        const info = await stream.waitFor((e) => e.event === "hub");
        return { cards: agents.data.agents, caps: info.data.caps };
      } finally {
        stream.close();
      }
    };
    frontend = { registry: { list: async () => (await snapshot()).cards } };
    const info = await snapshot();
    return {
      httpPort: record.port,
      paths,
      info: { ...info, pid: record.pid },
      close: async () => {
        a.fire("session_shutdown", { reason: "quit" }, c.ctx);
        if (child?.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((done) => child!.once("exit", () => done()));
          child.kill("SIGTERM");
          await exited;
        }
      },
    };
  };
  const result = input.viaLauncher
    ? await launchProduction()
    : await startHub(
        {
          v: 1,
          home: input.home,
          port: 0,
          idleExitMinutes: 10,
          pluginVersion: "0.12.1",
          buildId: "terminal-per-session-integration",
          privacy: input.privacy,
          ...spawnConfig,
          ...(input.legacy ? { terminal: input.legacyLimits ?? LIMITS } : {}),
        },
        (deps: any) => {
          frontend = deps;
          return createHttpFrontend({
            ...deps,
            ...(input.uiRoot
              ? {
                  ui: createUiServer({
                    candidates: [{ ok: true, spec: { kind: "package", dir: join(input.uiRoot, "dist/web-hub-ui") } }],
                    hubVersion: "0.12.1",
                    log: deps.log,
                    onStatus: deps.onUiStatus,
                    onServed: deps.onUiServed,
                  }),
                }
              : {}),
          });
        },
      );
  assert(!("exists" in result), "private hub already exists");
  process.on("message", async (m: any) => {
    if (m.op === "snapshot")
      process.send?.({ id: m.id, cards: await frontend.registry.list(), caps: result.info.caps });
  });
  process.send?.({
    event: "ready",
    port: result.httpPort,
    paths: result.paths,
    caps: result.info.caps,
    pid: result.info.pid ?? process.pid,
  });
  process.stdout.write("READY\n");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await result.close("test");
    process.exit(0);
  };
  process.stdin.on("data", () => void stop());
  process.stdin.on("end", () => void stop());
}

/** FROZEN locked 4e15fac1 true-off raw bytes; no recapture/update switch.
 * SOURCE_DATE_EPOCH is the locked commit timestamp. Only enumerated runtime identities normalized. */
export const OFF_RAW_GOLDEN = {
  wire: [
    '{"t":"hello","proto":{"major":1,"minor":2},"pluginVersion":"0.12.1","buildId":"child-terminal-integration","agentId":{"pid":"<agent-pid>","nonce":"<agent-nonce>"},"epoch":"<epoch>","kind":"rpc","launcher":["<node>","<fixture-host>"],"cwd":"<ctx-cwd>","caps":["ev.v1","fleet.v1","snapshot.v1","branch.v1","runtx.v1","runtx.lan.v1","cmd.v1","dialog.v1","command.v1","cmd.args.v1","upload.v1","upload.lan.v1","hold.v1"]}\n',
    '{"t":"hello_ack","hubVersion":"0.12.1","buildId":"terminal-per-session-integration","proto":{"major":1,"minor":2},"agentKey":"<agent-key>","pingMs":10000,"leaseMs":30000,"http":{"port":"<http-port>"},"caps":["ctl.v1","cmd.v1","dialog.v1","command.v1","ctl.v2","upload.v1","dialog.bg.v1","hold.v1","runtx.v1","quota.pools.v1","todo.archive.v1","cmd.history.v1","version.v1"]}\n',
    '{"t":"session","sessionId":"child-terminal-session","cwd":"<ctx-cwd>","reason":"startup","leafId":"e1","mode":"rpc","sessionFile":"/tmp/fake-session.jsonl","model":{"provider":"p","id":"m"},"thinkingLevel":"high","models":{"status":"error","items":[],"total":0,"policy":{"model":"allow","thinking":"allow"},"sampledAt":"<model-sampled-time>","levels":["off"]}}\n',
    '{"t":"status","leafId":"e1","busy":false,"pending":false,"contextUsage":{"tokens":1000,"contextWindow":200000,"percent":0.5},"costUsd":0,"features":["resume.v1","cmd.history.v1","unknown-slash-text.v1"]}\n',
  ],
  sse: 'event: hello\ndata: {"clientId":"<sse-client>"}\n\nevent: hub\ndata: {"version":"0.12.1","buildId":"terminal-per-session-integration","pid":"<hub-pid>","startedAt":"<boot-time>","proto":{"major":1,"minor":2},"caps":["ctl.v1","cmd.v1","dialog.v1","command.v1","ctl.v2","upload.v1","dialog.bg.v1","hold.v1","runtx.v1","quota.pools.v1","todo.archive.v1","cmd.history.v1","version.v1"],"ui":{"source":"package","version":"0.12.1","commit":"unknown","builtAt":"2026-11-15T03:21:18.000Z","assets":["/assets/AppIcon.vue_vue_type_script_setup_true_lang-DujjANIo.js","/assets/index-BRKsxlj8.js","/assets/preload-helper-DfZQVC28.js","/assets/style-Nkt-DJwI.css"]},"port":"<http-port>"}\n\nevent: agents\ndata: {"agents":[{"agentKey":"<agent-key>","kind":"rpc","pid":"<agent-pid>","cwd":"<ctx-cwd>","state":"live","pluginVersion":"0.12.1","outdated":false,"prompts":[],"session":{"sessionId":"child-terminal-session","cwd":"<ctx-cwd>","reason":"startup","leafId":"e1","mode":"rpc","sessionFile":"/tmp/fake-session.jsonl","model":{"provider":"p","id":"m"},"thinkingLevel":"high","models":{"status":"error","items":[],"total":0,"policy":{"model":"allow","thinking":"allow"},"sampledAt":"<model-sampled-time>","levels":["off"]}},"status":{"leafId":"e1","busy":false,"pending":false,"contextUsage":{"tokens":1000,"contextWindow":200000,"percent":0.5},"costUsd":0,"features":["resume.v1","cmd.history.v1","unknown-slash-text.v1"]},"control":true,"epoch":"<epoch>","dialogs":{"epoch":"<epoch>","open":[],"closed":[]},"commands":[{"name":"session","kind":"builtin","policy":"allow"},{"name":"name","kind":"builtin","policy":"deny"},{"name":"thinking","kind":"builtin","policy":"deny"},{"name":"model","kind":"builtin","policy":"deny"},{"name":"compact","kind":"builtin","policy":"allow","policyBusy":"confirm"},{"name":"new","kind":"builtin","policy":"confirm"},{"name":"reload","kind":"builtin","policy":"confirm"},{"name":"settings","kind":"builtin","policy":"deny"},{"name":"tree","kind":"builtin","policy":"deny"},{"name":"scoped-models","kind":"builtin","policy":"deny"},{"name":"export","kind":"builtin","policy":"deny"},{"name":"import","kind":"builtin","policy":"deny"},{"name":"share","kind":"builtin","policy":"deny"},{"name":"bug","kind":"builtin","policy":"deny"},{"name":"copy","kind":"builtin","policy":"deny"},{"name":"changelog","kind":"builtin","policy":"deny"},{"name":"hotkeys","kind":"builtin","policy":"deny"},{"name":"fork","kind":"builtin","policy":"deny"},{"name":"clone","kind":"builtin","policy":"deny"},{"name":"trust","kind":"builtin","policy":"deny"},{"name":"login","kind":"builtin","policy":"deny"},{"name":"logout","kind":"builtin","policy":"deny"},{"name":"resume","kind":"builtin","policy":"deny"},{"name":"quit","kind":"builtin","policy":"deny"},{"name":"debug","kind":"builtin","policy":"deny"},{"name":"exit","kind":"builtin","policy":"deny"},{"name":"arminsayshi","kind":"builtin","policy":"deny"},{"name":"dementedelves","kind":"builtin","policy":"deny"}],"upload":true,"uploadLan":true,"runTranscript":true,"runTranscriptLan":true,"hold":true}]}\n\nevent: fleet\ndata: {"agentKey":"<agent-key>","runs":[]}\n\n',
  routes: [
    {
      path: "/api/terminal/prepare",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/open",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/list",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/attach",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/detach",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/input",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/resize",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/ack",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/renew",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/state",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
    {
      path: "/api/terminal/close",
      status: 404,
      body: '{"error":"E_NOT_FOUND"}',
    },
  ],
} as const;
