/** Complete locked baseline + real separate-process harness. No production patching,
 * target.allowed substitution, fake authority, fake receipts or dependency installation. */
import assert from "node:assert/strict";
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
import { login, openSse, postJson, type SseConn } from "../web-hub/http/helpers.js";
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
export async function lockedBaseline() {
  assert.equal(
    execFileSync("git", ["rev-parse", `${OLD_SHA}^{commit}`], {
      cwd: CURRENT_ROOT,
      encoding: "utf8",
      timeout: 10000,
    }).trim(),
    OLD_SHA,
  );
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
  await new Promise<void>((done, fail) => {
    const child = spawn(
      join(CURRENT_ROOT, "node_modules/.bin/vite"),
      ["build", "--config", join(root, "src/web-hub/ui/vite.config.ts")],
      {
        cwd: CURRENT_ROOT,
        env: { ...process.env, PWH_UI_CACHE_DIR: join(root, "cache") },
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
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(join(CURRENT_ROOT, "node_modules/tsx/dist/loader.mjs")).href, script, ...args],
    {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
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
      await waitUntil(() => output.includes("READY") || child.exitCode !== null, 15000, "separate process ready").catch(
        (e) => {
          throw new Error(`${e}; ${errors}`);
        },
      );
      assert.equal(child.exitCode, null, errors);
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
  const result = await startHub(
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
  process.on("message", (m: any) => {
    if (m.op === "snapshot") process.send?.({ id: m.id, cards: frontend.registry.list(), caps: result.info.caps });
  });
  process.send?.({
    event: "ready",
    port: result.httpPort,
    paths: result.paths,
    caps: result.info.caps,
    pid: process.pid,
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
