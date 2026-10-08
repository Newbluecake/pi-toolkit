/**
 * web-hub-spawn plan §SP13 — H4 conformance: the REAL devDependency `pi --mode rpc`, launched
 * exactly the way the hub's supervisor forks it (`node <cli.js> --mode rpc`, pinned cwd, env
 * carrying `PI_WEBHUB_HEADLESS=1` + `PI_WEBHUB_SPAWN_ID`, a temp HOME whose settings.json lists
 * THIS package the regular way — never `-e`, see the child-extension-missing diagnostic).
 *
 * Pins the pi-side facts the managed-spawn design leans on (arch §7.4/§4.4):
 *
 *  C1 `hello` arrives on `<HOME>/.pi/agent/web-hub/hub.sock` with `kind:"rpc"`, the child's own
 *     pid, and `cwd === <the pinned workdir>` — the exact fields ⑥ binds and cwd-checks.
 *  C2 a `session` frame follows (sessionId + mode "rpc") — ⑦'s live gate.
 *  C3 `/proc/<pid>/cmdline` shows the rewritten `pi` title and NO `--mode` — the reason identity
 *     verification never trusts cmdline (L5 uses bootId+starttime+uid only).
 *  C4 `verifySpawnedIdentity` against the real /proc returns ok for the captured identity.
 *  C5 stdin EOF ⇒ orderly exit within 8s (the supervisor's primary stop lever).
 *  C6 every live `extension_ui_request` stdout line is `{"type":"extension_ui_request","id":…` —
 *     `type` first, `id` second (assumption V1: SP4's ≤512-byte head matcher) — asserted on the
 *     REAL frames pi emits at boot, plus a source pin of rpc-mode's `output({type, id, …})` and
 *     jsonl's plain `JSON.stringify` so the ordering can never silently drift.
 *
 * Skipped when the pi devDependency CLI is not installed (CI without it).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESTORE_SESSION_ID_RE, isValidRestoreSessionFile } from "../../src/web-hub/protocol/spawn.js";
import { PROTO } from "../../src/web-hub/protocol/version.js";
import { MODEL_REJECT_RE, stripAnsiCodes } from "../../src/web-hub/hub/spawn/supervisor.js";
import { parseStartTicks, readStatSync, verifySpawnedIdentity } from "../../src/web-hub/protocol/proc-identity.js";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PI_CLI = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const PI_RPC_MODE = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js");
const PI_JSONL = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/jsonl.js");
const IS_LINUX = process.platform === "linux";

interface HelloLike {
  kind?: unknown;
  cwd?: unknown;
  agentId?: { pid?: unknown };
  launcher?: unknown;
  caps?: unknown;
  proto?: { major?: unknown };
}
interface SessionLike {
  sessionId?: unknown;
  mode?: unknown;
  cwd?: unknown;
}

// ---------------------------------------------------------------------------
// File-level CR/HC helpers (session-history plan §4.1): the restore-argv (CR)
// section's prepareHome/launch/until/allJson/messagesOf, hoisted so the history
// argv-tails section (HC1–HC7) reuses the exact same launch shape. `launch`
// additionally records the hello frame (HC needs hello.cwd), accepts a cwd
// override (HC1b's process cwd ≠ header cwd), and prepareHome realpath's the
// temp home so byte-exact path comparisons hold under a symlinked tmpdir.
// ---------------------------------------------------------------------------

interface PreparedHome {
  home: string;
  workdir: string;
  agentDir: string;
}

interface SessionFrame {
  sessionId?: unknown;
  sessionFile?: unknown;
  mode?: unknown;
}

interface RestoreRun {
  child: ChildProcess;
  home: string;
  workdir: string;
  stderr: string;
  helloSeen: HelloLike[];
  sessionsSeen: SessionFrame[];
  stdoutLines: string[];
  exit: Promise<{ code: number | null; signal: string | null }>;
  cleanup(): void;
}

function prepareHome(): PreparedHome {
  // §4.1: home = realpathSync(mkdtempSync(…)) — HC1's byte-exact sessionFile
  // equality assumes pi's resolvePath is the identity on the paths we hand it.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pwh-conf-r-")));
  const workdir = join(home, "work");
  mkdirSync(workdir, { recursive: true });
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
  writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify({ webHub: { enabled: true } }));
  return { home, workdir, agentDir };
}

function launch(prepared: PreparedHome, tail: readonly string[], opts: { cwd?: string } = {}): RestoreRun {
  const { home, workdir, agentDir } = prepared;
  const stateDir = join(agentDir, "web-hub");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const socketPath = join(stateDir, "hub.sock");
  rmSync(socketPath, { force: true });
  const helloSeen: HelloLike[] = [];
  const sessionsSeen: SessionFrame[] = [];
  const stdoutLines: string[] = [];
  const server = net.createServer((sock) => {
    const dec = new NdjsonDecoder({
      maxFrameBytes: 512 * 1024,
      onFrame: (raw: unknown) => {
        const frame = raw as Record<string, unknown>;
        if (frame["t"] === "hello") {
          helloSeen.push(frame as unknown as HelloLike);
          sock.write(
            `${JSON.stringify({
              t: "hello_ack",
              hubVersion: "1.2.3",
              buildId: "1.2.3@conf",
              proto: { major: PROTO.major, minor: PROTO.minor },
              agentKey: "a-conf-restore-00001",
              pingMs: 10_000,
              leaseMs: 30_000,
              http: { port: 0 },
              caps: ["ctl.v1", "cmd.v1", "dialog.v1", "command.v1", "ctl.v2"],
            })}\n`,
          );
          return;
        }
        if (frame["t"] === "session") sessionsSeen.push(frame as unknown as SessionFrame);
      },
      onError: () => {},
    });
    sock.on("data", (c: Buffer) => dec.push(c));
    sock.on("error", () => {});
  });
  server.listen(socketPath);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("PI_WEBHUB_") || k === "FORCE_COLOR") continue;
    env[k] = v;
  }
  env["HOME"] = home;
  env["PI_WEBHUB_HEADLESS"] = "1";
  env["PI_WEBHUB_SPAWN_ID"] = `conf-restore-${Date.now().toString(36)}`;
  // the restore fork shape: fixed prefix + session tail, never --model (D8)
  const child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", ...tail], {
    cwd: opts.cwd ?? workdir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
  child.stdout?.setEncoding("utf8");
  let buf = "";
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > 0) stdoutLines.push(line);
    }
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    home,
    workdir,
    get stderr() {
      return Buffer.concat(stderrChunks).toString("utf8");
    },
    helloSeen,
    sessionsSeen,
    stdoutLines,
    exit,
    cleanup() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      server.close();
      server.closeAllConnections?.();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

const until = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
};

function allJson(lines: readonly string[]): boolean {
  return lines.every((l) => {
    try {
      JSON.parse(l);
      return true;
    } catch {
      return false;
    }
  });
}

async function messagesOf(run: RestoreRun): Promise<unknown[]> {
  run.child.stdin?.write(`${JSON.stringify({ id: "cr-get-messages", type: "get_messages" })}\n`);
  await until(() => run.stdoutLines.some((l) => l.includes('"command":"get_messages"')), 15_000, "get_messages");
  const line = run.stdoutLines.find((l) => l.includes('"command":"get_messages"'))!;
  const parsed = JSON.parse(line) as { success?: boolean; data?: { messages?: unknown[] } };
  expect(parsed.success).toBe(true);
  return parsed.data?.messages ?? [];
}

describe.skipIf(!existsSync(PI_CLI))("rpc-spawn conformance — real pi --mode rpc (plan §SP13 H4)", () => {
  let home: string | undefined;
  let workdir: string | undefined;
  let child: ChildProcess | undefined;
  let server: net.Server | undefined;
  const helloSeen: HelloLike[] = [];
  const sessionsSeen: SessionLike[] = [];
  const stdoutLines: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "pwh-conf-"));
    workdir = join(home, "work");
    mkdirSync(workdir, { recursive: true });
    // regular installation shape (never -e): settings.json lists THIS package
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
    writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify({ webHub: { enabled: true } }));

    // fake hub socket at the exact path the agent side derives from HOME
    const stateDir = join(agentDir, "web-hub");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const socketPath = join(stateDir, "hub.sock");
    rmSync(socketPath, { force: true });
    server = net.createServer((sock) => {
      const dec = new NdjsonDecoder({
        maxFrameBytes: 512 * 1024,
        onFrame: (raw: unknown) => {
          const frame = raw as Record<string, unknown>;
          if (frame["t"] === "hello") {
            helloSeen.push(frame as unknown as HelloLike);
            sock.write(
              `${JSON.stringify({
                t: "hello_ack",
                hubVersion: "1.2.3",
                buildId: "1.2.3@conf",
                proto: { major: PROTO.major, minor: PROTO.minor },
                agentKey: "a-conf-hub-key-00001",
                pingMs: 10_000,
                leaseMs: 30_000,
                http: { port: 0 },
                caps: ["ctl.v1", "cmd.v1", "dialog.v1", "command.v1", "ctl.v2"],
              })}\n`,
            );
            return;
          }
          if (frame["t"] === "session") sessionsSeen.push(frame as unknown as SessionLike);
          // snapshot_req / ping / dialogs — deliberately ignored
        },
        onError: () => {},
      });
      sock.on("data", (c: Buffer) => dec.push(c));
      sock.on("error", () => {});
    });
    await new Promise<void>((res) => server!.listen(socketPath, res));

    // the exact fork shape the supervisor uses: argv [cli.js, --mode, rpc], PI_WEBHUB_* env
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith("PI_WEBHUB_")) continue;
      env[k] = v;
    }
    env["HOME"] = home;
    env["PI_WEBHUB_HEADLESS"] = "1";
    env["PI_WEBHUB_SPAWN_ID"] = "conf-spawn-000001";
    child = spawn(process.execPath, [PI_CLI, "--mode", "rpc"], {
      cwd: workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    let buf = "";
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) stdoutLines.push(line);
      }
    });
    child.stderr?.resume(); // drain (pi-toolkit warns about unconfigured providers there)
    child.on("exit", (code, signal) => stdoutLines.push(`__EXIT__ code=${code} signal=${signal}`));
  }, 30_000);

  afterAll(() => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    server?.close();
    server?.closeAllConnections?.();
    if (home !== undefined) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const until = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  it("C1+C2: hello{kind:rpc, own pid, pinned cwd} then session frame — the ⑥/⑦ wire contract", async () => {
    await until(() => helloSeen.length > 0, 30_000, "hello on the hub socket");
    const hello = helloSeen[0]!;
    expect(hello.kind).toBe("rpc");
    expect(hello.agentId?.pid).toBe(child?.pid);
    expect(hello.cwd).toBe(workdir);
    expect(typeof hello.launcher).toBe("object");
    expect(Array.isArray(hello.caps)).toBe(true);
    expect((hello.proto as { major?: unknown })?.major).toBe(PROTO.major);
    await until(() => sessionsSeen.length > 0, 30_000, "session frame");
    const session = sessionsSeen[0]!;
    expect(typeof session.sessionId).toBe("string");
    expect((session.sessionId as string).length).toBeGreaterThan(0);
    expect(session.mode).toBe("rpc");
    expect(session.cwd).toBe(workdir);
  }, 70_000);

  it("C3: /proc/<pid>/cmdline carries the rewritten pi title and no --mode (identity never reads cmdline)", async () => {
    await until(() => helloSeen.length > 0, 30_000, "hello (process up)");
    if (!IS_LINUX) return; // /proc identity checks are Linux-only by design
    const cmdline = readFileSync(`/proc/${child!.pid}/cmdline`, "utf8");
    expect(cmdline).not.toContain("--mode");
    expect(cmdline).toContain("pi");
  }, 40_000);

  it("C4: verifySpawnedIdentity ok against the real /proc (bootId + starttime + uid)", async () => {
    await until(() => helloSeen.length > 0, 30_000, "hello (process up)");
    if (!IS_LINUX) return;
    const stat = readStatSync(child!.pid);
    expect(stat).toBeDefined();
    const startTicks = parseStartTicks(stat!);
    expect(startTicks).toBeDefined();
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const verdict = await verifySpawnedIdentity(
      { pid: child!.pid, procStartTicks: startTicks!, bootId, uid: process.getuid?.() ?? 0 },
      { group: false },
    );
    // the conformance child is NOT detached (no own process group) — pin both the ok verdict
    // and the pgrp-mismatch degradation the reaper's group kill handles.
    expect(verdict).toEqual({ ok: true });
    const groupVerdict = await verifySpawnedIdentity(
      { pid: child!.pid, procStartTicks: startTicks!, bootId, uid: process.getuid?.() ?? 0 },
      { group: true },
    );
    expect(groupVerdict).toEqual({ ok: false, reason: "pgrp-mismatch" }); // not detached ⇒ single-pid fallback
  }, 40_000);

  it("C6: live extension_ui_request lines are type-first/id-second (V1), and pi's rpc-mode source pins it", async () => {
    // pi emits several fire-and-forget ui frames at boot (setStatus/setWidget from this very
    // package) — real traffic, no scripting needed.
    await until(
      () => stdoutLines.some((l) => l.startsWith('{"type":"extension_ui_request"')),
      30_000,
      "ui_request frames",
    );
    const uiLines = stdoutLines.filter((l) => l.startsWith('{"type":"extension_ui_request"'));
    expect(uiLines.length).toBeGreaterThan(0);
    for (const line of uiLines) {
      // V1: `type` first, `id` second — the exact head SP4's prefix matcher and the ≤512-byte
      // id extractor assume. A pi that reorders fields breaks the hub's over-limit defense.
      expect(line).toMatch(/^\{"type":"extension_ui_request","id":"[^"\\]{1,128}"/);
    }
    // source pins: the frame is built as `output({ type, id, ...request })` and serialized by
    // plain JSON.stringify (insertion order) — if either changes, this fails before the wire does.
    const rpcMode = readFileSync(PI_RPC_MODE, "utf8");
    expect(rpcMode).toContain('output({ type: "extension_ui_request", id, ...request })');
    const jsonl = readFileSync(PI_JSONL, "utf8");
    expect(jsonl).toContain("JSON.stringify(value)");
  }, 40_000);

  it("C5: stdin EOF ⇒ orderly exit within 8s (the supervisor's primary stop lever)", async () => {
    await until(() => helloSeen.length > 0, 30_000, "hello (process up)");
    const t0 = Date.now();
    child!.stdin?.end();
    await until(() => stdoutLines.some((l) => l.startsWith("__EXIT__")), 8_000, "child exit after EOF");
    const exitLine = stdoutLines.find((l) => l.startsWith("__EXIT__"))!;
    expect(exitLine).toContain("code=0");
    expect(Date.now() - t0).toBeLessThanOrEqual(8_000);
  }, 45_000);
});

// ---------------------------------------------------------------------------
// default-model plan §6/§10 R2-1: CM1–CM5 — the REAL pi `--model` startup contract.
//
// The hub forks `pi --mode rpc --model <ref>` and D5's delayed breaker verdict trusts TWO
// pi-side facts: (a) the exact wording of the two startup rejections the regex exempts, and
// (b) that a known-provider + typo'd id degrades to a custom model with only a WARNING (stays
// live — R1/A6b, never exempt). These five pin both against the real devDependency CLI, with a
// temp HOME whose models.json declares two custom providers (`p1`/`p2`) that share the id
// `dup/m` — the ambiguity probe. If CM1/CM2 ever fail after a pi upgrade, D5 degrades to
// fail-safe (count + no hint) and A6 must NOT be claimed as verified (plan §6 conformance row).
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(PI_CLI))("rpc-spawn conformance — real pi --model (default-model plan CM1–CM5)", () => {
  const MODELS_JSON = {
    providers: {
      p1: {
        baseUrl: "http://127.0.0.1:9",
        api: "anthropic-messages",
        apiKey: "test-key-p1",
        models: [
          {
            id: "dup/m",
            name: "Dup M p1",
            contextWindow: 100_000,
            maxTokens: 4_096,
            input: ["text"],
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
          },
          {
            id: "real/m",
            name: "Real M",
            contextWindow: 100_000,
            maxTokens: 4_096,
            input: ["text"],
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
          },
        ],
      },
      p2: {
        baseUrl: "http://127.0.0.1:9",
        api: "anthropic-messages",
        apiKey: "test-key-p2",
        models: [
          {
            id: "dup/m",
            name: "Dup M p2",
            contextWindow: 100_000,
            maxTokens: 4_096,
            input: ["text"],
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
          },
        ],
      },
    },
  };

  interface ModelRun {
    child: ChildProcess;
    home: string;
    stderr: string;
    helloSeen: HelloLike[];
    sessionsSeen: SessionLike[];
    stdoutLines: string[];
    exit: Promise<{ code: number | null; signal: string | null }>;
    cleanup(): void;
  }

  /** Boot a real `pi --mode rpc --model <ref>` against a fresh temp HOME + fake hub socket. */
  function launchModelRun(modelRef: string, opts: { forceColor?: boolean } = {}): ModelRun {
    const home = mkdtempSync(join(tmpdir(), "pwh-conf-m-"));
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
    writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify({ webHub: { enabled: true } }));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(MODELS_JSON));

    const stateDir = join(agentDir, "web-hub");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const socketPath = join(stateDir, "hub.sock");
    rmSync(socketPath, { force: true });
    const helloSeen: HelloLike[] = [];
    const sessionsSeen: SessionLike[] = [];
    const stdoutLines: string[] = [];
    const server = net.createServer((sock) => {
      const dec = new NdjsonDecoder({
        maxFrameBytes: 512 * 1024,
        onFrame: (raw: unknown) => {
          const frame = raw as Record<string, unknown>;
          if (frame["t"] === "hello") {
            helloSeen.push(frame as unknown as HelloLike);
            sock.write(
              `${JSON.stringify({
                t: "hello_ack",
                hubVersion: "1.2.3",
                buildId: "1.2.3@conf",
                proto: { major: PROTO.major, minor: PROTO.minor },
                agentKey: `a-conf-model-${helloSeen.length}`,
                pingMs: 10_000,
                leaseMs: 30_000,
                http: { port: 0 },
                caps: ["ctl.v1", "cmd.v1", "dialog.v1", "command.v1", "ctl.v2"],
              })}\n`,
            );
            return;
          }
          if (frame["t"] === "session") sessionsSeen.push(frame as unknown as SessionLike);
        },
        onError: () => {},
      });
      sock.on("data", (c: Buffer) => dec.push(c));
      sock.on("error", () => {});
    });
    server.listen(socketPath);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith("PI_WEBHUB_") || k === "FORCE_COLOR") continue;
      env[k] = v;
    }
    env["HOME"] = home;
    env["PI_WEBHUB_HEADLESS"] = "1";
    env["PI_WEBHUB_SPAWN_ID"] = `conf-model-${Date.now().toString(36)}`;
    if (opts.forceColor === true) env["FORCE_COLOR"] = "1";

    const child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--model", modelRef], {
      cwd: home,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    child.stdout?.setEncoding("utf8");
    let buf = "";
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) stdoutLines.push(line);
      }
    });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return {
      child,
      home,
      get stderr() {
        return Buffer.concat(stderrChunks).toString("utf8");
      },
      helloSeen,
      sessionsSeen,
      stdoutLines,
      exit,
      cleanup() {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        server.close();
        server.closeAllConnections?.();
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      },
    };
  }

  const until2 = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  it("CM1: unknown-provider ref ⇒ exit 1, NO session, stderr matches MODEL_REJECT_RE", async () => {
    const run = launchModelRun("nosuch-prov/zz-nope");
    try {
      const exited = await Promise.race([
        run.exit,
        new Promise<{ code: number | null; signal: string | null }>((_, rej) =>
          setTimeout(() => rej(new Error("CM1: child did not exit")), 20_000),
        ),
      ]);
      expect(exited.code).toBe(1);
      expect(run.helloSeen).toHaveLength(0);
      expect(MODEL_REJECT_RE.test(run.stderr)).toBe(true);
      expect(run.stderr).toContain('Model "nosuch-prov/zz-nope" not found.');
    } finally {
      run.cleanup();
    }
  }, 40_000);

  it("CM2: bare ambiguous id across two authenticated providers ⇒ exit 1, ambiguous branch", async () => {
    const run = launchModelRun("dup/m");
    try {
      const exited = await Promise.race([
        run.exit,
        new Promise<{ code: number | null; signal: string | null }>((_, rej) =>
          setTimeout(() => rej(new Error("CM2: child did not exit")), 20_000),
        ),
      ]);
      expect(exited.code).toBe(1);
      expect(run.helloSeen).toHaveLength(0);
      expect(run.stderr).toContain('Model "dup/m" is ambiguous across providers');
      expect(MODEL_REJECT_RE.test(run.stderr)).toBe(true);
    } finally {
      run.cleanup();
    }
  }, 40_000);

  it("CM3: known provider + typo'd id ⇒ WARNING-only custom model, child goes LIVE (R1/A6b — never exempt)", async () => {
    const run = launchModelRun("p1/typo-xyz");
    try {
      await until2(() => run.sessionsSeen.length > 0, 30_000, "CM3 session frame");
      await until2(() => run.stderr.includes("Using custom model id."), 10_000, "CM3 custom-id warning");
      expect(run.stderr.startsWith("Warning:") || run.stderr.includes("\nWarning:")).toBe(true);
      expect(MODEL_REJECT_RE.test(run.stderr)).toBe(false); // the Warning line can NEVER match
    } finally {
      run.cleanup();
    }
  }, 60_000);

  it("CM4: FORCE_COLOR=1 paints the CM1 diagnostic — stripped, MODEL_REJECT_RE still matches", async () => {
    const run = launchModelRun("nosuch-prov/zz-nope", { forceColor: true });
    try {
      const exited = await Promise.race([
        run.exit,
        new Promise<{ code: number | null; signal: string | null }>((_, rej) =>
          setTimeout(() => rej(new Error("CM4: child did not exit")), 20_000),
        ),
      ]);
      expect(exited.code).toBe(1);
      expect(run.stderr).toContain("\x1b["); // chalk actually painted it
      expect(MODEL_REJECT_RE.test(run.stderr)).toBe(false); // raw: escape sits BEFORE "Error:"
      expect(MODEL_REJECT_RE.test(stripAnsiCodes(run.stderr))).toBe(true); // stripped: matches
    } finally {
      run.cleanup();
    }
  }, 40_000);

  it("CM5: a valid provider/id ⇒ rpc get_state reports that exact model (the A3 evidence cmdline can't give)", async () => {
    const run = launchModelRun("p1/real/m");
    try {
      await until2(() => run.sessionsSeen.length > 0, 30_000, "CM5 session frame");
      run.child.stdin?.write(`${JSON.stringify({ id: "cm5-get-state", type: "get_state" })}\n`);
      await until2(
        () => run.stdoutLines.some((l) => l.includes('"command":"get_state"')),
        15_000,
        "CM5 get_state response",
      );
      const line = run.stdoutLines.find((l) => l.includes('"command":"get_state"'))!;
      const resp = JSON.parse(line) as { success?: boolean; data?: { model?: unknown } };
      expect(resp.success).toBe(true);
      // `session.model` is a Model OBJECT — serialize and pin its identity fields
      const modelJson = JSON.stringify(resp.data?.model);
      expect(modelJson).toContain('"id":"real/m"');
      expect(modelJson).toContain('"provider":"p1"');
    } finally {
      run.cleanup();
    }
  }, 60_000);
});

/**
 * web-hub-spawn-restore plan v1 §12.3 — CR1–CR3: the pi-side facts the restore fork leans on.
 *
 *  CR1 `--session <abs path>` opens THAT file: the session frame's sessionId = the header id and
 *      sessionFile = the path; stdout stays pure JSON (no readline prompt — F21 is the id form
 *      only); history is there (`get_messages` returns the user message); stdin EOF ⇒ exit ≤8s.
 *  CR2 `--session-id <new id>` (no such session in the project) ⇒ a session with exactly that id,
 *      stdout pure JSON, pi's "creating a new session with that id" warning on stderr (F23).
 *  CR3 `--session <missing abs path>` ⇒ pi goes LIVE on an EMPTY session (F22) — the reason the
 *      hub preflights the file itself. If pi ever starts refusing instead, this fails as a hint
 *      that the preflight could be simplified.
 */
describe.skipIf(!existsSync(PI_CLI))("rpc-spawn conformance — restore argv tails (spawn-restore plan CR1–CR3)", () => {
  it("CR1: --session <abs path> opens that file (header id, same path), pure-JSON stdout, history present, EOF exit ≤8s", async () => {
    const prepared = prepareHome();
    // a REAL pi session file written through pi's own SessionManager (one user message ⇒ persisted)
    const pi = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      SessionManager: {
        create(
          cwd: string,
          sessionDir?: string,
        ): {
          appendMessage(m: unknown): string;
          getSessionFile(): string | undefined;
          getSessionId(): string;
        };
      };
    };
    const sessionDir = join(prepared.agentDir, "sessions", "--work--");
    mkdirSync(sessionDir, { recursive: true });
    const sm = pi.SessionManager.create(prepared.workdir, sessionDir);
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "restore me" }], timestamp: Date.now() });
    const file = sm.getSessionFile()!;
    const id = sm.getSessionId();
    expect(existsSync(file)).toBe(true);
    expect(file.startsWith("/")).toBe(true);
    // the hub only persists coordinates passing these (§5.1) — pin that pi's real ones do
    const { RESTORE_SESSION_ID_RE, isValidRestoreSessionFile } = await import("../../src/web-hub/protocol/spawn.js");
    expect(RESTORE_SESSION_ID_RE.test(id)).toBe(true);
    expect(isValidRestoreSessionFile(file)).toBe(true);
    const run = launch(prepared, ["--session", file]);
    try {
      await until(() => run.sessionsSeen.length > 0, 25_000, "CR1 session frame");
      expect(run.sessionsSeen[0]).toMatchObject({ sessionId: id, sessionFile: file, mode: "rpc" });
      const messages = await messagesOf(run);
      expect(JSON.stringify(messages)).toContain("restore me");
      expect(allJson(run.stdoutLines)).toBe(true);
      expect(run.stdoutLines.join("\n")).not.toContain("Fork this session");
      run.child.stdin?.end();
      const t0 = Date.now();
      await Promise.race([
        run.exit,
        new Promise((_, reject) => setTimeout(() => reject(new Error("CR1: no exit within 8s of EOF")), 8_000)),
      ]);
      expect(Date.now() - t0).toBeLessThan(8_000);
    } finally {
      run.cleanup();
    }
  }, 60_000);

  it("CR2: --session-id <new id> ⇒ that exact id, pure-JSON stdout, pi's new-session warning on stderr", async () => {
    const prepared = prepareHome();
    const id = `crtwo-${Date.now().toString(36)}`;
    const run = launch(prepared, ["--session-id", id]);
    try {
      await until(() => run.sessionsSeen.length > 0, 25_000, "CR2 session frame");
      expect(run.sessionsSeen[0]).toMatchObject({ sessionId: id, mode: "rpc" });
      expect(allJson(run.stdoutLines)).toBe(true);
      expect(run.stderr).toContain(`No project session found with id '${id}'`);
    } finally {
      run.cleanup();
    }
  }, 60_000);

  it("CR3: --session <missing abs path> ⇒ LIVE on an EMPTY session at that path (F22 — why the hub preflights)", async () => {
    const prepared = prepareHome();
    const missing = join(prepared.agentDir, "sessions", "--work--", "gone-session.jsonl");
    const run = launch(prepared, ["--session", missing]);
    try {
      await until(() => run.sessionsSeen.length > 0, 25_000, "CR3 session frame");
      expect(run.sessionsSeen[0]).toMatchObject({ mode: "rpc" });
      expect(typeof run.sessionsSeen[0]!.sessionId).toBe("string");
      expect(await messagesOf(run)).toEqual([]);
      expect(allJson(run.stdoutLines)).toBe(true);
    } finally {
      run.cleanup();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// web-hub session-history plan §4.1 (P-conf) — HC1–HC7: the pi-side argv facts
// the history resume/fork path leans on. HC1/HC1b pin §4.5.6's post-live
// byte-exact sessionFile premise and the moved-gray basis (hello.cwd reports the
// SESSION cwd even when the process cwd differs — E10). HC2/HC6 pin PD12: the
// fork goes through a hub-rule snapshot (complete lines only, 0600, outside
// sessionsRoot), leaving the source and the snapshot byte-identical. HC7 is the
// counter-proof pinning E1 — a DIRECT --fork on a half-line source rewrites the
// source (+1 byte "\n", loadEntriesFromFile's repair append). If pi ever fixes
// that, HC7 goes red to force re-reviewing PD12's premise (the snapshot path
// stays either way). Source sessions are always written through pi's own
// SessionManager into the cwd's DEFAULT session dir — exactly what the hub scans.
// ---------------------------------------------------------------------------
describe.skipIf(!existsSync(PI_CLI))("history argv tails (session-history plan HC1–HC7)", () => {
  /** A truncated JSON message line — what a concurrent writer's mid-write tail looks like. */
  const HALF_LINE = '{"type":"message","id":"half-tail","role":"user","content":[{"type":"text","text":"half-wri';

  function sha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  /** pi's getDefaultSessionDirPath: `--<cwd with "/", "\", ":" as "-">--` under <agentDir>/sessions. */
  function encodedSessionDir(agentDir: string, cwd: string): string {
    const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(agentDir, "sessions", safe);
  }

  interface PiSessionManagerLike {
    appendMessage(m: unknown): string;
    getSessionFile(): string | undefined;
    getSessionId(): string;
  }

  async function createSourceSession(
    agentDir: string,
    cwd: string,
    text: string,
  ): Promise<{ file: string; id: string }> {
    const pi = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      SessionManager: { create(cwd: string, sessionDir?: string): PiSessionManagerLike };
    };
    // explicit sessionDir: getDefaultSessionDir() inside THIS process would use
    // the real HOME, not the temp home — so mirror the encoding ourselves.
    const sm = pi.SessionManager.create(cwd, encodedSessionDir(agentDir, cwd));
    sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
    const file = sm.getSessionFile();
    expect(file).toBeDefined();
    expect(existsSync(file!)).toBe(true);
    return { file: file!, id: sm.getSessionId() };
  }

  /** The hub's fork-snapshot rule (PD12 / §4.5.7, mirrored): complete lines only, 0600, <home>/hubstate/fork-src/. */
  function makeForkSnapshot(home: string, sourceFile: string): string {
    const forkSrcDir = join(home, "hubstate", "fork-src");
    mkdirSync(forkSrcDir, { recursive: true });
    chmodSync(forkSrcDir, 0o700);
    const raw = readFileSync(sourceFile);
    const cut = raw.lastIndexOf(0x0a); // complete lines only — a half-written tail is dropped
    const body = cut >= 0 ? raw.subarray(0, cut + 1) : Buffer.alloc(0);
    const snap = join(forkSrcDir, `snap-${randomBytes(12).toString("base64url")}.jsonl`);
    const fd = openSync(snap, "wx", 0o600);
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return snap;
  }

  function firstHeaderLine(file: string): { type?: unknown; id?: unknown; cwd?: unknown; parentSession?: unknown } {
    const first = readFileSync(file, "utf8").split("\n", 1)[0]!;
    return JSON.parse(first) as { type?: unknown; id?: unknown; cwd?: unknown; parentSession?: unknown };
  }

  async function exitWithin(
    run: RestoreRun,
    ms: number,
    what: string,
  ): Promise<{ code: number | null; signal: string | null }> {
    return Promise.race([
      run.exit,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: no exit within ${ms}ms`)), ms)),
    ]);
  }

  it("HC1: --session <abs> ⇒ sessionFile byte-exact, hello.cwd = header.cwd, pure-JSON stdout, no fork prompt, EOF exit ≤8s", async () => {
    const prepared = prepareHome();
    const src = await createSourceSession(prepared.agentDir, prepared.workdir, "hc1 resume source");
    const header = firstHeaderLine(src.file);
    const run = launch(prepared, ["--session", src.file]);
    try {
      await until(() => run.helloSeen.length > 0, 30_000, "HC1 hello frame");
      expect(run.helloSeen[0]!.cwd).toBe(header.cwd);
      await until(() => run.sessionsSeen.length > 0, 25_000, "HC1 session frame");
      expect(run.sessionsSeen[0]!.sessionId).toBe(header.id);
      expect(run.sessionsSeen[0]!.sessionFile).toBe(src.file); // byte-exact — §4.5.6 post-live check premise
      expect(run.sessionsSeen[0]!.mode).toBe("rpc");
      expect(allJson(run.stdoutLines)).toBe(true);
      expect(run.stdoutLines.join("\n")).not.toContain("Fork this session");
      run.child.stdin?.end();
      const t0 = Date.now();
      const exited = await exitWithin(run, 8_000, "HC1");
      expect(exited.code).toBe(0);
      expect(Date.now() - t0).toBeLessThanOrEqual(8_000);
    } finally {
      run.cleanup();
    }
  }, 60_000);

  it("HC1b: --session with process cwd ≠ header cwd ⇒ hello.cwd reports the header cwd literally (E10, moved-gray basis)", async () => {
    const prepared = prepareHome();
    const sessionCwd = join(prepared.home, "project-a");
    const procCwd = join(prepared.home, "project-b");
    mkdirSync(sessionCwd, { recursive: true });
    mkdirSync(procCwd, { recursive: true });
    const src = await createSourceSession(prepared.agentDir, sessionCwd, "hc1b session cwd wins");
    const header = firstHeaderLine(src.file);
    const run = launch(prepared, ["--session", src.file], { cwd: procCwd });
    try {
      await until(() => run.helloSeen.length > 0, 30_000, "HC1b hello frame");
      expect(run.helloSeen[0]!.cwd).toBe(header.cwd); // literal equality with the SESSION cwd…
      expect(run.helloSeen[0]!.cwd).not.toBe(procCwd); // …even though the process cwd differs
      await until(() => run.sessionsSeen.length > 0, 25_000, "HC1b session frame");
      expect(run.sessionsSeen[0]!.sessionId).toBe(header.id);
      expect(run.sessionsSeen[0]!.sessionFile).toBe(src.file);
    } finally {
      run.cleanup();
    }
  }, 60_000);

  it("HC2: --fork <snapshot> --session-id <uuid> ⇒ new file in encoded dir before live, parentSession=snap, source+snapshot unchanged, history copied", async () => {
    const prepared = prepareHome();
    const src = await createSourceSession(prepared.agentDir, prepared.workdir, "hc2 fork through snapshot");
    const snap = makeForkSnapshot(prepared.home, src.file);
    const srcBefore = readFileSync(src.file);
    const snapBefore = readFileSync(snap);
    const uuid = randomUUID();
    const run = launch(prepared, ["--fork", snap, "--session-id", uuid]);
    try {
      const newDir = encodedSessionDir(prepared.agentDir, realpathSync(prepared.workdir));
      const matches = () => readdirSync(newDir).filter((f) => f.endsWith(`_${uuid}.jsonl`));
      let sightedAtFrameCount = -1;
      await until(
        () => {
          if (sightedAtFrameCount < 0 && existsSync(newDir) && matches().length > 0) {
            sightedAtFrameCount = run.sessionsSeen.length; // 0 ⇒ the file existed BEFORE live
          }
          return run.sessionsSeen.length > 0;
        },
        25_000,
        "HC2 session frame",
      );
      expect(sightedAtFrameCount).toBe(0);
      expect(run.sessionsSeen[0]!.sessionId).toBe(uuid);
      const newFile = join(newDir, matches()[0]!);
      expect(firstHeaderLine(newFile)).toMatchObject({
        type: "session",
        id: uuid,
        cwd: realpathSync(prepared.workdir),
        parentSession: snap,
      });
      expect(RESTORE_SESSION_ID_RE.test(uuid)).toBe(true);
      expect(isValidRestoreSessionFile(newFile)).toBe(true);
      expect(sha256(readFileSync(src.file))).toBe(sha256(srcBefore)); // source untouched
      expect(sha256(readFileSync(snap))).toBe(sha256(snapBefore)); // snapshot untouched
      const messages = await messagesOf(run);
      expect(JSON.stringify(messages)).toContain("hc2 fork through snapshot");
    } finally {
      run.cleanup();
    }
  }, 90_000);

  it("HC3: --session <abs> with deleted header cwd ⇒ exit≠0 ≤15s, no session frame, missing-cwd stderr hint", async () => {
    const prepared = prepareHome();
    const goneCwd = join(prepared.home, "gone-project");
    mkdirSync(goneCwd, { recursive: true });
    const src = await createSourceSession(prepared.agentDir, goneCwd, "hc3 cwd is gone");
    rmSync(goneCwd, { recursive: true, force: true });
    const run = launch(prepared, ["--session", src.file]);
    try {
      const exited = await exitWithin(run, 15_000, "HC3");
      expect(exited.code).not.toBe(0);
      expect(run.sessionsSeen).toHaveLength(0);
      expect(run.stderr).toContain("Stored session working directory does not exist");
    } finally {
      run.cleanup();
    }
  }, 40_000);

  it("HC4: --fork <snap> --session-id <existing id> ⇒ exit 1, 'Session already exists with id'", async () => {
    const prepared = prepareHome();
    const src = await createSourceSession(prepared.agentDir, prepared.workdir, "hc4 id collision");
    const snap = makeForkSnapshot(prepared.home, src.file);
    const run = launch(prepared, ["--fork", snap, "--session-id", src.id]);
    try {
      const exited = await exitWithin(run, 15_000, "HC4");
      expect(exited.code).toBe(1);
      expect(run.stderr).toContain("Session already exists with id");
      expect(run.sessionsSeen).toHaveLength(0);
    } finally {
      run.cleanup();
    }
  }, 40_000);

  it("HC5: fork from snapshot with source header cwd deleted ⇒ still live (fork never reads the source cwd)", async () => {
    const prepared = prepareHome();
    const goneCwd = join(prepared.home, "hc5-gone-project");
    mkdirSync(goneCwd, { recursive: true });
    const src = await createSourceSession(prepared.agentDir, goneCwd, "hc5 orphaned source cwd");
    const snap = makeForkSnapshot(prepared.home, src.file);
    rmSync(goneCwd, { recursive: true, force: true });
    const uuid = randomUUID();
    const run = launch(prepared, ["--fork", snap, "--session-id", uuid]);
    try {
      await until(() => run.sessionsSeen.length > 0, 25_000, "HC5 session frame");
      expect(run.sessionsSeen[0]!.sessionId).toBe(uuid);
      expect(run.sessionsSeen[0]!.mode).toBe("rpc");
    } finally {
      run.cleanup();
    }
  }, 60_000);

  it("HC6: half-line source tail ⇒ snapshot drops it, fork leaves source byte-identical (sha256+size), new file fully parseable", async () => {
    const prepared = prepareHome();
    const src = await createSourceSession(prepared.agentDir, prepared.workdir, "hc6 writer mid-line");
    appendFileSync(src.file, HALF_LINE); // a concurrent writer's half-written line
    const srcBefore = readFileSync(src.file);
    expect(srcBefore.length).toBeGreaterThan(Buffer.byteLength(HALF_LINE));
    const snap = makeForkSnapshot(prepared.home, src.file);
    const snapBytes = readFileSync(snap);
    expect(snapBytes.includes(Buffer.from(HALF_LINE, "utf8"))).toBe(false); // no half-line in the snapshot
    expect(snapBytes.length).toBe(srcBefore.length - Buffer.byteLength(HALF_LINE)); // exactly the complete lines
    const uuid = randomUUID();
    const run = launch(prepared, ["--fork", snap, "--session-id", uuid]);
    try {
      await until(() => run.sessionsSeen.length > 0, 25_000, "HC6 session frame");
      const after = readFileSync(src.file);
      expect(after.length).toBe(srcBefore.length); // size unchanged…
      expect(sha256(after)).toBe(sha256(srcBefore)); // …and byte-for-byte unchanged
      const newDir = encodedSessionDir(prepared.agentDir, realpathSync(prepared.workdir));
      const name = readdirSync(newDir).find((f) => f.endsWith(`_${uuid}.jsonl`));
      expect(name).toBeDefined();
      const lines = readFileSync(join(newDir, name!), "utf8").split("\n");
      expect(lines.length).toBeGreaterThan(2); // header + copied message + trailing ""
      for (const [i, line] of lines.entries()) {
        if (line.length === 0) continue;
        let parsed = false;
        try {
          JSON.parse(line);
          parsed = true;
        } catch {
          parsed = false;
        }
        expect(parsed, `HC6 new-file line ${i} is not JSON: ${line.slice(0, 80)}`).toBe(true);
      }
    } finally {
      run.cleanup();
    }
  }, 60_000);

  it("HC7 (counter-proof, pins E1): DIRECT --fork <source with half-line tail> ⇒ pi rewrites the source (+1 byte newline)", async () => {
    const prepared = prepareHome();
    const src = await createSourceSession(prepared.agentDir, prepared.workdir, "hc7 direct fork rewrites source");
    appendFileSync(src.file, HALF_LINE);
    const before = readFileSync(src.file);
    const run = launch(prepared, ["--fork", src.file]);
    try {
      await until(() => run.sessionsSeen.length > 0, 25_000, "HC7 session frame");
      const after = readFileSync(src.file);
      expect(after.length).toBe(before.length + 1); // exactly one extra byte…
      expect(after.at(-1)).toBe(0x0a); // …a newline (loadEntriesFromFile's repair append)
      expect(after.equals(Buffer.concat([before, Buffer.from("\n", "utf8")]))).toBe(true);
    } finally {
      run.cleanup();
    }
  }, 60_000);
});
