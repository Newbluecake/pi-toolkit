/** True child-process WebHub agent. Only the isolated UID/rc backend fixture is
 * substituted; production owner/local records/receipt writer/connection stay real. */
import { readFileSync } from "node:fs";
import net from "node:net";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TerminalOwner } from "../../../src/web-hub/agent/terminal/owner.js";
import type { TerminalTestFixture } from "../../../src/web-hub/agent/terminal/environment.js";
const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  home: string;
  fixture: TerminalTestFixture;
  pluginVersion?: string;
  componentRoot?: string;
  sessionId?: string;
  terminalOff?: boolean;
  limits?: object;
};
// Select a complete source snapshot, never a field-stripped imitation of an old peer.
const root = input.componentRoot ?? resolve(new URL("../../..", import.meta.url).pathname);
const load = (file: string) => import(pathToFileURL(join(root, file)).href);
const { wireWebHub } = await load("src/web-hub/agent/index.ts");
const { createTerminalOwner } = await load("src/web-hub/agent/terminal/owner.ts");
const { createTerminalTestBackend } = await load("src/web-hub/agent/terminal/backend.ts");
const { localPlainEnvironment } = await load("src/web-hub/protocol/terminal-local.ts");
const { resolveHubPaths } = await load("src/web-hub/protocol/paths.ts");
const { fakePi, fakeCtx, SETTINGS } = await load("tests/web-hub/agent/helpers.ts");
let allowed = true,
  guardThrows = false,
  backendCount = 0,
  validatedConstructor = false;
const backends: any[] = [];
const a = fakePi(),
  c = fakeCtx({ sessionId: input.sessionId ?? "child-terminal-session", mode: "rpc" });
Object.assign(c.ctx, { cwd: input.fixture.cwd });
let owner: TerminalOwner | undefined;
const control = wireWebHub(a.pi, {
  settings: {
    ...SETTINGS,
    terminal: {
      enabled: !input.terminalOff,
      maxPerSession: 2,
      maxPerPrincipal: 2,
      maxTotal: 8,
      inputIdleMs: 3600000,
      maxLifetimeMs: 28800000,
      ...input.limits,
    },
  },
  terminalGuard: () => {
    if (guardThrows) throw new Error("fixture-guard");
    return allowed && localPlainEnvironment();
  },
  fleet: () => [],
  env: { HOME: input.home },
  paths: resolveHubPaths({ home: input.home, uid: process.getuid!() }),
  argv1: "/nonexistent/pi",
  netConnect: (...args: any[]) => {
    const socket = (net.connect as any)(...args);
    const write = socket.write.bind(socket);
    let pending = "";
    socket.write = (chunk: any, ...rest: any[]) => {
      pending += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      let i: number;
      while ((i = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        try {
          const f = JSON.parse(line);
          if (f.t === "status") process.send?.({ event: "status-write", raw: line });
        } catch {}
      }
      return write(chunk, ...rest);
    };
    return socket;
  },
  buildInfo: async () => ({ pluginVersion: input.pluginVersion ?? "1.2.3", buildId: "child-terminal-integration" }),
  terminalOwnerFactory: async (options: any) => {
    owner = await createTerminalOwner({
      ...options,
      backend: (opts: any) => {
        backendCount++;
        // Only the audited uid/rc fixture changes. opts.cwd is the production
        // currentCwd capture, not a fixture override of it.
        // Negative cwd tests reuse the constructor from an already-created REAL
        // backend and its already-audited uid/rc fixture. This avoids having the
        // fixture's containment/mode check mask production cwd preflight. opts is
        // untouched; even a broken fallback could only exec the isolated fixture.
        const backend = validatedConstructor
          ? new backends[0].constructor(opts, input.fixture)
          : createTerminalTestBackend(opts, { ...input.fixture, cwd: opts.cwd });
        backends.push(backend);
        void backend.ready.catch(() =>
          process.stderr.write(`BACKEND_READY_FAILURE ${JSON.stringify(backend.diagnostic)}\n`),
        );
        void backend.done.then(() => {
          if (backend.diagnostic?.failure)
            process.stderr.write(`BACKEND_DONE_DIAGNOSTIC ${JSON.stringify(backend.diagnostic)}\n`);
        });
        return backend;
      },
    });
    return owner;
  },
});
a.fire("session_start", { type: "session_start" }, c.ctx);
const diagnostic = setTimeout(() => process.stderr.write(`CHILD_STATUS ${JSON.stringify(control.status())}\n`), 1000);
diagnostic.unref();
const tick = setInterval(() => {
  if (control.status().state === "live") {
    clearInterval(tick);
    process.stdout.write("READY\n");
  }
}, 20);
tick.unref();
process.on("message", async (raw: any) => {
  try {
    if (raw.op === "guard") {
      allowed = raw.allowed;
      guardThrows = raw.throws ?? false;
    }
    if (raw.op === "cwd") Object.assign(c.ctx, { cwd: raw.cwd });
    if (raw.op === "validated-constructor") {
      if (!backends.length) throw new Error("real-backend-required");
      validatedConstructor = true;
    }
    if (raw.op === "session") {
      c.state.sessionId = raw.sessionId;
      Object.assign(c.ctx, { cwd: raw.cwd });
      a.fire("session_start", { type: "session_start" }, c.ctx);
    }
    a.fire("turn_end", { type: "turn_end" }, c.ctx);
    process.send?.({
      id: raw.id,
      backendCount,
      backendSuccesses: backends.length,
      pid: process.pid,
      processCwd: process.cwd(),
      managed: backends.flatMap((b) => b.managed),
      diagnostics: backends.map((b) => b.diagnostic),
      resources: owner?.resourceEntries().length ?? 0,
    });
  } catch {
    process.send?.({ id: raw.id, error: "fixture-command-failed" });
  }
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text: string) => {
  if (!text.includes("STOP")) return;
  a.fire("session_shutdown", { reason: "quit" }, c.ctx);
  void (owner?.dispose() ?? Promise.resolve()).then(() => process.exit(0));
});
process.stdin.on("end", () => {
  a.fire("session_shutdown", { reason: "quit" }, c.ctx);
  void owner?.dispose().finally(() => process.exit(0));
});
