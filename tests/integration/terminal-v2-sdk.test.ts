/** Real SDK 1.5 context → production agent wiring → real UDS → real startHub →
 * real HTTP auth/context RPC/PTY + durable prune. No LLM call or site paths. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalSdkAgent } from "./helpers/terminal-v2-sdk.js";
import { makeTerminalFixture } from "./terminal-v2-backend-fixture.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createTerminalTestBackend } from "../../src/web-hub/hub/terminal/v2/backend.js";
import { webHubStateDir } from "../../src/web-hub/protocol/paths.js";
import type { FrontendDeps } from "../../src/web-hub/hub/ports.js";
import { login, postJson } from "../web-hub/http/helpers.js";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
it("captures actual current pi ExtensionContext cwd at create time and never routes it through command/public status", async () => {
  const fixture = makeTerminalFixture();
  closers.push(fixture.cleanup);
  const home = fixture.fixture.home,
    state = webHubStateDir(home),
    socketDir = join(fixture.fixture.root, "s");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDir, { mode: 0o700 });
  const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  put(join(home, ".pi/agent/pi-toolkit.json"), { webHub: { terminal: { enabled: true } } });
  const marker = { v: 2, storeId: "s".repeat(24), initialization: "fresh", checkpointId: "c".repeat(24) };
  mkdirSync(join(state, "terminal-v2"), { mode: 0o700 });
  put(join(state, ".terminal-initialized-v2"), marker);
  put(join(state, "terminal-v2/marker.json"), marker);
  put(join(state, "terminal-v2/ledger.json"), { v: 2, storeId: marker.storeId, revision: 0, allocations: [] });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi/agent"));
  vi.stubEnv("PI_WEBHUB_TERMINAL_SOURCE", "plain");
  let deps!: FrontendDeps, initialized: Promise<void> | undefined, status!: () => void;
  const declared = new Promise<void>((resolve) => {
    status = resolve;
  });
  const publicEvents: unknown[] = [];
  const result = await startHub(
    { v: 1, home, port: 0, idleExitMinutes: 10, pluginVersion: "1.2.3", buildId: "sdk-test" },
    (d) => {
      deps = d;
      d.bus.subscribe((event) => {
        publicEvents.push(event);
        if (event.type === "status" && "terminalSessionV2" in event.status) status();
      });
      return createHttpFrontend(d);
    },
    {
      xdgRuntimeDir: socketDir,
      terminalV2Test: {
        backend: (options) => createTerminalTestBackend(options, fixture.fixture),
        ready: (work) => {
          initialized = work;
        },
      },
    },
  );
  if (!("httpPort" in result)) throw new Error("private SDK hub startup failed");
  const hub: RunningHub = result;
  closers.push(() => hub.close("sdk-test"));
  await initialized;
  const sdk = await createTerminalSdkAgent({ home, cwd: fixture.fixture.cwd, socketDir, version: "1.2.3" });
  closers.push(sdk.close);
  // Own bounded barrier, not an arbitrary sleep or a model response dependency.
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      declared,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("actual SDK declaration deadline")), 8000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const target = deps.registry.list().find((agent) => agent.session?.sessionId === sdk.manager.getSessionId());
  expect(target).toBeDefined();
  expect(sdk.context.cwd).toBe(fixture.fixture.cwd);
  expect(sdk.context.mode).toBe("rpc");
  expect(target?.status?.terminalSessionV2).toMatchObject({ v: 2, sessionId: sdk.manager.getSessionId() });
  const scope = { agentKey: target!.agentKey, sessionId: sdk.manager.getSessionId(), epoch: target!.epoch };
  const cookie = await login(hub.httpPort, hub.paths.tokenFile);
  const call = async (op: string, body: unknown) => {
    const response = await postJson(hub.httpPort, `/api/terminal/v2/${op}`, body, {
      Cookie: cookie,
      Origin: `http://127.0.0.1:${hub.httpPort}`,
    });
    return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const list = await call("list", { scope });
  expect(list.status).toBe(200);
  const created = await call("create", {
    scope,
    hubInstance: list.body.hubInstance,
    requestId: "r".repeat(24),
    mode: "ensure-empty",
    cols: 80,
    rows: 24,
  });
  expect(created.status).toBe(200);
  expect(created.body.ok).toBe(true);
  const closed = await call("close", { scope, hubInstance: list.body.hubInstance, termId: created.body.termId });
  expect(closed.body).toMatchObject({ ok: true, state: "closed" });
  const disk = JSON.parse(readFileSync(join(state, "terminal-v2/ledger.json"), "utf8"));
  expect(disk.revision).toBe(2);
  expect(disk.allocations).toEqual([]);
  expect(publicEvents.some((event) => JSON.stringify(event).includes("terminal_context_"))).toBe(false);
  expect(
    publicEvents.some(
      (event) =>
        JSON.stringify(event).includes('"cwd":"' + fixture.fixture.cwd + '"') &&
        (event as { type?: string }).type === "status",
    ),
  ).toBe(false);
}, 30000);
