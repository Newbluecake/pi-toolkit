/** A8: SIGKILL ONLY our owned private hub at three original rotate commit windows.
 * A measured private bundle adds ONLY an async observation pause after the exact
 * original operation. Restart/recovery uses UNPATCHED production startHub + SQLite.
 * No PTY is created; this is not kernel reboot or resource-drain evidence.
 */
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { login } from "../web-hub/http/helpers.js";
import { build, version as esbuildVersion } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { terminalV2AuthFixture } from "./helpers/terminal-v2-auth-fixture.js";
import { config, connectClient, hello } from "../web-hub/hub/helpers.js";
import { lanRequest } from "../web-hub/http/lan-helpers.js";
import { readRotateIntentSync } from "../../src/web-hub/protocol/rotate-intent.js";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type Phase = "intent" | "token-written" | "lan-revoked";
function message(child: ChildProcess, t: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`owned hub IPC timeout ${t}`));
    }, 15000);
    timer.unref();
    const onMessage = (raw: any) => {
      if (raw?.t === t) {
        cleanup();
        resolve(raw);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`owned hub exited before ${t}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
async function snapshotHub(h: Awaited<ReturnType<typeof terminalV2AuthFixture>>, phase: Phase) {
  const root = resolve("."),
    dir = join(h.privatePty.fixture.root, `crash-${phase}`);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "package.json"), readFileSync(join(root, "package.json")), { mode: 0o600 });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir"); // new private link; target read-only
  const sourceFile = join(root, "src/web-hub/hub/admin.ts"),
    source = readFileSync(sourceFile, "utf8");
  const exact: Record<Phase, string> = {
    intent: "writeRotateIntentSync(deps.rotateIntentFile, intent);",
    "token-written": 'intent = advanceRotateIntentSync(deps.rotateIntentFile, intent, "token-written");',
    "lan-revoked": "deps.bumpLanRevokeGen();",
  };
  expect(source.split(exact[phase])).toHaveLength(2);
  const patched = source.replace(
    exact[phase],
    `${exact[phase]}\nawait new Promise<void>(() => { process.send?.({t:"crash-window",phase:${JSON.stringify(phase)}}); });`,
  );
  writeFileSync(join(dir, "admin-original.ts"), source, { mode: 0o600 });
  writeFileSync(join(dir, "admin-observed.ts"), patched, { mode: 0o600 });
  const cfg = config({
    home: h.privatePty.fixture.home,
    lan: { port: h.lanPort, extraHosts: [], trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.test"] },
  });
  const entry = `import {startHub} from ${JSON.stringify(join(root, "src/web-hub/hub/hub.ts"))};
    import {createHttpFrontend} from ${JSON.stringify(join(root, "src/web-hub/hub/http.ts"))};
    const hub=await startHub(${JSON.stringify(cfg)},createHttpFrontend,{xdgRuntimeDir:${JSON.stringify(h.hub.paths.socketDir)}});
    if (!("httpPort" in hub)) throw new Error("owned crash hub failed startup");
    process.send?.({t:"ready",httpPort:hub.httpPort});`;
  const outfile = join(dir, "hub.mjs");
  const result = await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: "owned-auth-crash-entry.ts", loader: "ts" },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    metafile: true,
    banner: {
      js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "observe-original-rotate-window",
        setup(b) {
          b.onLoad({ filter: /\/web-hub\/hub\/admin\.ts$/ }, () => ({ contents: patched, loader: "ts" }));
        },
      },
    ],
  });
  const measurement = {
    sourceCommit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    phase,
    originalSha256: sha(source),
    observedSha256: sha(patched),
    artifactSha256: sha(readFileSync(outfile)),
    inputHashes: Object.keys(result.metafile!.inputs)
      .filter((p) => p !== "owned-auth-crash-entry.ts")
      .map((p) => ({ path: p, sha256: sha(readFileSync(resolve(root, p))) })),
    node: process.version,
    esbuild: esbuildVersion,
    realKernelReboot: false,
    observationOnly: true,
  };
  writeFileSync(join(dir, "measurement.json"), JSON.stringify(measurement, null, 2), { mode: 0o600 });
  const child = fork(outfile, [], {
    env: {
      ...process.env,
      HOME: h.privatePty.fixture.home,
      PI_CODING_AGENT_DIR: join(h.privatePty.fixture.home, ".pi/agent"),
      PI_WEBHUB_TERMINAL_SOURCE: "plain",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-20000);
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  closers.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  try {
    await message(child, "ready");
  } catch (err) {
    throw new Error(`${String(err)} ${stderr}`);
  }
  return { child, exited, dir };
}
it.each(
  [false, true].flatMap((corrupt) =>
    (["intent", "token-written", "lan-revoked"] as Phase[]).map((phase) => ({ corrupt, phase })),
  ),
)(
  "A8 actual owned SIGKILL $phase corrupt=$corrupt",
  async ({ corrupt, phase }) => {
    const h = await terminalV2AuthFixture(closers, corrupt, true, { retain: true }),
      oldCookie = h.lanCookie;
    const ledger = readFileSync(`${h.state}/terminal-v2/ledger.json`),
      tokenBefore = sha(readFileSync(h.hub.paths.tokenFile));
    h.agent.sock.destroy();
    await h.hub.close("owned-crash-rehearsal");
    const owned = await snapshotHub(h, phase),
      agent = await connectClient(h.hub.paths.socketPath);
    closers.push(() => {
      agent.sock.destroy();
    });
    agent.send(
      hello({
        agentId: { pid: process.pid, nonce: randomBytes(16).toString("hex") },
        epoch: randomBytes(16).toString("hex"),
      }),
    );
    await agent.waitFrame((f) => f.t === "hello_ack");
    const window = message(owned.child, "crash-window");
    agent.send({ t: "hub_ctl", rid: randomBytes(16).toString("hex"), op: "rotate_token" });
    expect((await window).phase).toBe(phase);
    const intent = readRotateIntentSync(h.hub.paths.rotateIntentFile!);
    expect(intent.state).toBe("present");
    if (intent.state !== "present") throw new Error("original rotate intent missing at real window");
    expect(intent.intent.phase).toBe(phase === "intent" ? "intent" : "token-written");
    expect(sha(readFileSync(h.hub.paths.tokenFile)) === tokenBefore).toBe(phase === "intent");
    expect(owned.child.kill("SIGKILL")).toBe(true);
    await owned.exited;
    expect(owned.child.signalCode).toBe("SIGKILL");
    const restarted = await h.restart(); // original unpatched code, SAME files and original SQLite recovery
    expect(existsSync(h.hub.paths.rotateIntentFile!)).toBe(false);
    expect(sha(readFileSync(h.hub.paths.tokenFile))).not.toBe(tokenBefore);
    const old = await lanRequest(restarted.lanPort, {
      method: "GET",
      path: "/api/lan/sessions",
      headers: { ...restarted.lanHeaders, Cookie: oldCookie, "X-PWH": "1" },
    });
    expect(old.status).toBe(401);
    expect((await restarted.loginLan()).status).toBe(200);
    expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(ledger);
    expect(restarted.backendCalls).toBe(0);
    expect(readdirSync(h.state).filter((name) => /terminal.*auth|auth.*terminal/i.test(name))).toEqual([]);
    writeFileSync(
      join(owned.dir, "result.json"),
      JSON.stringify({
        phase,
        corrupt,
        signal: owned.child.signalCode,
        oldSidStatus: old.status,
        originalIntentRemoved: true,
        resourceBytesUnchanged: true,
        realKernelReboot: false,
      }),
      { mode: 0o600 },
    );
  },
  30000,
);

it.each([false, true])(
  "A8 original recovery keeps LAN blocked without DB; terminal corrupt=%s cannot clear it",
  async (corrupt) => {
    const h = await terminalV2AuthFixture(closers, corrupt, true, { retain: true });
    const before = readFileSync(`${h.state}/terminal-v2/ledger.json`);
    h.agent.sock.destroy();
    await h.hub.close("owned-crash-rehearsal");
    const owned = await snapshotHub(h, "token-written"),
      agent = await connectClient(h.hub.paths.socketPath);
    closers.push(() => {
      agent.sock.destroy();
    });
    agent.send(hello({ agentId: { pid: process.pid, nonce: randomBytes(16).toString("hex") } }));
    await agent.waitFrame((f) => f.t === "hello_ack");
    const window = message(owned.child, "crash-window");
    agent.send({ t: "hub_ctl", rid: randomBytes(16).toString("hex"), op: "rotate_token" });
    await window;
    owned.child.kill("SIGKILL");
    await owned.exited;
    chmodSync(h.hub.paths.dbFile, 0); // explicit owned original-DB permission fault, NOT a terminal fault or success mock
    try {
      const blocked = await startHub(
        config({
          home: h.privatePty.fixture.home,
          lan: {
            port: h.lanPort,
            extraHosts: [],
            trustProxyFrom: ["127.0.0.1"],
            externalOrigins: ["https://hub.test"],
          },
        }),
        createHttpFrontend,
        { xdgRuntimeDir: h.hub.paths.socketDir },
      );
      if (!("httpPort" in blocked)) throw new Error("original blocked recovery hub did not start");
      closers.push(() => blocked.close("private-blocked-recovery"));
      expect(blocked.lanStatus()).toMatchObject({ state: "off", reason: "rotate-pending" });
      expect(readRotateIntentSync(h.hub.paths.rotateIntentFile!).state).toBe("present");
      expect((await login(blocked.httpPort, blocked.paths.tokenFile)).length).toBeGreaterThan(0); // actual other-listener auth succeeds
      expect(blocked.lanStatus()).toMatchObject({ state: "off", reason: "rotate-pending" });
      expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
      await blocked.close("private-lift-db-fault");
    } finally {
      chmodSync(h.hub.paths.dbFile, 0o600);
    }
    const recovered = await h.restart();
    expect((await recovered.loginLan()).status).toBe(200);
    expect(existsSync(h.hub.paths.rotateIntentFile!)).toBe(false);
    expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
  },
  30000,
);
