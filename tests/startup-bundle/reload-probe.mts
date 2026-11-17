/** Real pi 1.5 RPC process + real private hub. No model/credentials or synthetic hello/epoch. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const piPackage = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
assert.equal(JSON.parse(readFileSync(join(piPackage, "package.json"), "utf8")).version, "1.5.0");
const mode = process.argv[2];
assert(mode === "fixed" || mode === "upgrade");
const base = mkdtempSync(join(tmpdir(), "pt-reload-"));
const home = join(base, "h");
const pkg = join(base, "package");
const oldVersion = "0.12.1";
const newVersion = "0.12.2";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(pred: () => boolean, label: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    assert(child?.exitCode === null && child?.signalCode === null, `agent exited: ${stderr}`);
    if (Date.now() >= end) throw new Error(`timeout: ${label}\n${stderr}`);
    await sleep(25);
  }
}

// An exact archived pre-fix dispatcher/core can be supplied for the one-time upgrade experiment.
// The default portable regression mutates only the import call, reproducing the same jiti boundary.
function installDispatcher(legacy: boolean): void {
  const archived = legacy ? process.env.PI_TOOLKIT_TEST_BASELINE_DIR : undefined;
  for (const file of ["index.ts", "src/core/bundle-entry.ts", "src/core/host-modules.ts"]) {
    const from = archived && file !== "src/core/host-modules.ts" ? archived : root;
    copyFileSync(join(from, file), join(pkg, file));
  }
  copyFileSync(join(root, "bundle-bridge.cjs"), join(pkg, "bundle-bridge.cjs"));
  if (legacy && !archived) {
    const path = join(pkg, "index.ts");
    const source = readFileSync(path, "utf8");
    assert(source.includes("const bundle = await nativeImport(bundleUrl);"));
    writeFileSync(
      path,
      source.replace("const bundle = await nativeImport(bundleUrl);", "const bundle = await import(bundleUrl);"),
    );
  }
}

async function rebuild(version: string, marker: string): Promise<void> {
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "pi-toolkit",
      version,
      type: "module",
      pi: { extensions: ["./index.ts"] },
    }),
  );
  // Test-only source, compiled into the actual bundle. get_commands observes executed code,
  // independently of the live package.json version reader and hello metadata.
  const result = await build({
    stdin: {
      contents: `import activate from ${JSON.stringify(join(root, "src/index.ts"))};\nexport default async function(pi) { await activate(pi); pi.registerCommand("t48-code", { description: ${JSON.stringify(marker)} + ":" + crypto.randomUUID(), handler: async () => {} }); }`,
      resolveDir: root,
      loader: "ts",
      sourcefile: "t48-behavior.ts",
    },
    outfile: join(pkg, "dist/bundle/index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.outputFiles?.length, 1);
  writeFileSync(join(pkg, "dist/bundle/index.js"), result.outputFiles![0]!.contents);
}

let child: ChildProcessWithoutNullStreams | undefined;
let stderr = "";
let stdout = "";
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let deps: Parameters<typeof createHttpFrontend>[0] | undefined;
const events: Array<{ type: string; [key: string]: unknown }> = [];
const replies = new Map<string, any>();
const rpc = async (type: string): Promise<any> => {
  const id = randomUUID();
  child!.stdin.write(JSON.stringify({ id, type }) + "\n");
  await until(() => replies.has(id), `RPC ${type}`);
  const reply = replies.get(id);
  assert.equal(reply.success, true, JSON.stringify(reply));
  return reply.data;
};
const card = (): any => deps!.registry.list().find((c) => c.pid === child!.pid);
const summary = (c: any): unknown => ({
  pid: c.pid,
  agentKey: c.agentKey,
  pluginVersion: c.pluginVersion,
  outdated: c.outdated,
  epoch: c.epoch,
  reload: c.status?.reload,
});
async function marker(): Promise<string> {
  return (await rpc("get_commands")).commands.find((c: any) => c.name === "t48-code")?.description;
}
async function stopAgent(): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const force = setTimeout(() => child!.kill("SIGKILL"), 3_000);
  force.unref();
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

try {
  mkdirSync(join(pkg, "src/core"), { recursive: true });
  mkdirSync(join(pkg, "dist/bundle"), { recursive: true });
  mkdirSync(join(home, ".pi/agent"), { recursive: true, mode: 0o700 });
  symlinkSync(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
  installDispatcher(mode === "upgrade" || process.env.PI_TOOLKIT_TEST_LEGACY_IMPORT === "1");
  await rebuild(oldVersion, "old-code");
  writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ packages: [pkg] }));
  writeFileSync(
    join(home, ".pi/agent/pi-toolkit.json"),
    JSON.stringify({
      webHub: {
        enabled: true,
        autoStart: false,
        port: 0,
        lan: { enabled: false },
        preview: "off",
        privacy: false,
        spawn: { enabled: false },
      },
      memory: { enabled: false },
      schedule: { enabled: false },
      fabric: { enabled: false },
      traffic: { enabled: false },
      quota: { enabled: false },
      load: { enabled: false },
      reflex: { enabled: false },
      topicSwitch: { enabled: false },
      title: { enabled: false },
      cacheTtl: { enabled: false },
    }),
  );
  // Hub explicit HOME, no discovery of the developer's ~/.pi/agent/web-hub.
  hub = await startHub(
    { v: 1, home, port: 0, idleExitMinutes: 60, pluginVersion: newVersion, buildId: `${newVersion}@unknown` },
    (d) => {
      deps = d;
      d.bus.subscribe((event) => {
        events.push(event as (typeof events)[number]);
      });
      return createHttpFrontend(d);
    },
  );
  assert(!("exists" in hub), "private hub must be newly started");
  assert(hub.paths.socketPath.startsWith(base + "/"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CACHE_HOME: join(base, "cache"),
    TMPDIR: join(base, "tmp"),
    NODE_OPTIONS: "",
    JITI_RESPECT_TMPDIR_ENV: "1",
  };
  mkdirSync(env.TMPDIR!, { mode: 0o700 });
  child = spawn(process.execPath, [join(piPackage, "dist/cli.js"), "--mode", "rpc"], { cwd: base, env, stdio: "pipe" });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const data = JSON.parse(line);
        if (data.type === "response" && data.id) replies.set(data.id, data);
      } catch {
        /* non-RPC diagnostics */
      }
    }
  });
  await until(() => !!card(), "initial hello");
  const old = { ...card() };
  assert.equal(old.pluginVersion, oldVersion);
  assert.equal(old.outdated, true);
  const oldActivation = await marker();
  assert(oldActivation.startsWith("old-code:"));
  console.log("BEFORE", JSON.stringify({ card: summary(old), code: oldActivation }));

  if (mode === "upgrade") installDispatcher(false);
  await rebuild(newVersion, "new-code");
  const origin = `http://127.0.0.1:${hub.httpPort}`;
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PWH": "1", Origin: origin },
    body: JSON.stringify({ token: readFileSync(hub.paths.tokenFile, "utf8").trim() }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const command = async (): Promise<string> => {
    const id = randomUUID();
    const response = await fetch(origin + "/api/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Origin: origin, Cookie: cookie },
      body: JSON.stringify({ id, agentKey: old.agentKey, op: "command", name: "agent", args: "reload", confirm: true }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, await response.text());
    return id;
  };
  const id = await command();
  if (process.env.PI_TOOLKIT_TEST_LEGACY_IMPORT === "1" && mode === "fixed") {
    await until(() => card()?.status?.reload?.cmdIds?.includes(id), "legacy reload started");
    await sleep(1_000);
    console.log("MUTATION_STALE", JSON.stringify({ card: summary(card()), code: await marker() }));
    // Deliberately the SAME success assertion as the fixed path. Mutation must make this red.
    assert.equal(card().pluginVersion, newVersion, "rebuilt code must replace stale namespace");
  }
  await until(
    () => card()?.pluginVersion === newVersion && card()?.status?.reload?.state === "completed",
    "new hello and completed",
  );
  const after = { ...card() };
  assert.equal(child.pid, old.pid);
  assert.equal(after.pid, old.pid);
  assert.equal(after.agentKey, old.agentKey);
  assert.notEqual(after.epoch, old.epoch);
  assert.equal(after.outdated, false);
  const afterActivation = await marker();
  assert(afterActivation.startsWith("new-code:"));
  assert.notEqual(afterActivation, oldActivation);
  assert.equal(after.status.reload.version, newVersion);
  assert.equal(after.status.reload.epoch, after.epoch);
  assert.equal(after.status.reload.open, false);
  assert(after.status.reload.cmdIds.includes(id));
  // handover is intentionally a silent claiming window, NOT agent_down.
  const logs = readFileSync(hub.paths.logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(logs.some((e) => e.msg === "agent reclaimed" && e.agentKey === old.agentKey && e.epochChanged === true));
  assert(
    events.some(
      (e) =>
        e.type === "agent_up" && (e.agent as any)?.agentKey === old.agentKey && (e.agent as any)?.epoch === after.epoch,
    ),
  );
  assert(events.some((e) => e.type === "gap" && e.agentKey === old.agentKey));
  console.log("AFTER", JSON.stringify({ card: summary(after), code: afterActivation }));

  const sameId = await command();
  await until(
    () => card()?.status?.reload?.cmdIds?.includes(sameId) && card()?.status?.reload?.state === "started",
    "same-build started",
  );
  // A per-activation command description is an observable reload barrier. Waiting only for
  // started would race the actual resource load and could pass before reactivation happened.
  const activationDeadline = Date.now() + 10_000;
  let sameActivation = await marker();
  while (sameActivation === afterActivation) {
    assert(Date.now() < activationDeadline, "same-build activation must actually execute");
    await sleep(25);
    sameActivation = await marker();
  }
  assert(sameActivation.startsWith("new-code:"));
  assert.equal((await rpc("get_state")).isStreaming, false);
  const same = card();
  assert.equal(same.epoch, after.epoch);
  assert.equal(same.pluginVersion, newVersion);
  assert.equal(same.outdated, false);
  assert.equal(same.status.reload.state, "started");
  assert.equal(same.status.reload.open, true);
  assert(same.status.reload.cmdIds.includes(sameId));
  assert(!same.status.reload.cmdIds.includes(id));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  console.log("SAME_BUILD_REUSED", JSON.stringify({ card: summary(same), code: sameActivation }));
  console.log(`PASS ${mode}: real pi 1.5 native rebuild/reload, same pid, code, identity and correlated result`);
} finally {
  await stopAgent();
  if (hub && !("exists" in hub)) await hub.close("t48-private-probe-finished");
  // No token/cookie in evidence; only bounded diagnostics on failure are printed by the parent.
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
