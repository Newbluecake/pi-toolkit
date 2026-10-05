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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTO } from "../../src/web-hub/protocol/version.js";
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
