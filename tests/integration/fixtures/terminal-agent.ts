/** True child-process WebHub agent. Only the isolated UID/rc backend fixture is
 * substituted; production owner/local records/receipt writer/connection stay real. */
import { readFileSync } from "node:fs";
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { createTerminalOwner, type TerminalOwner } from "../../../src/web-hub/agent/terminal/owner.js";
import { createTerminalTestBackend } from "../../../src/web-hub/agent/terminal/backend.js";
import { localPlainEnvironment } from "../../../src/web-hub/protocol/terminal-local.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { fakePi, fakeCtx, SETTINGS } from "../../web-hub/agent/helpers.js";
import type { TerminalTestFixture } from "../../../src/web-hub/agent/terminal/environment.js";
const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { home: string; fixture: TerminalTestFixture };
const a = fakePi(),
  c = fakeCtx({ sessionId: "child-terminal-session", mode: "rpc" });
Object.assign(c.ctx, { cwd: input.fixture.cwd });
let owner: TerminalOwner | undefined;
const control = wireWebHub(a.pi, {
  settings: {
    ...SETTINGS,
    terminal: {
      enabled: true,
      maxPerSession: 2,
      maxPerPrincipal: 2,
      maxTotal: 8,
      inputIdleMs: 3600000,
      maxLifetimeMs: 28800000,
    },
  },
  terminalGuard: () => localPlainEnvironment(),
  fleet: () => [],
  env: { HOME: input.home },
  paths: resolveHubPaths({ home: input.home, uid: process.getuid!() }),
  argv1: "/nonexistent/pi",
  buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "child-terminal-integration" }),
  terminalOwnerFactory: async (options) => {
    owner = await createTerminalOwner({
      ...options,
      backend: (opts) => createTerminalTestBackend(opts, input.fixture),
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
