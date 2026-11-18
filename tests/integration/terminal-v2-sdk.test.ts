/** Real SDK 1.5 context → production agent wiring → real UDS → real startHub →
 * real HTTP auth/context RPC/PTY + durable prune. No LLM call or site paths. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request, type IncomingMessage } from "node:http";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import type { TerminalViewFrameV2 } from "../../src/web-hub/protocol/terminal-v2.js";
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
it("captures actual SDK cwd, fences held native resize across HTTP views, and durably prunes", async () => {
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
  let resizeCalls = 0,
    physicalSettled = false,
    releaseResize!: () => void;
  const resizeBarrier = new Promise<void>((resolve) => {
    releaseResize = resolve;
  });
  // Explicit injected method-result barrier, NOT a claim that the kernel ioctl hung.
  // Every released resize executes the original native backend; no fake resize/proof.
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
        backend: (options) => {
          const backend = createTerminalTestBackend(options, fixture.fixture);
          return new Proxy(backend, {
            get(target, key) {
              if (key === "resize")
                return async (...args: Parameters<typeof backend.resize>) => {
                  resizeCalls++;
                  if (resizeCalls === 1) await resizeBarrier;
                  await target.resize(...args);
                  physicalSettled = true;
                };
              const value = Reflect.get(target, key, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
        ready: (work) => {
          initialized = work;
        },
      },
    },
  );
  if (!("httpPort" in result)) throw new Error("private SDK hub startup failed");
  const hub: RunningHub = result;
  closers.push(() => hub.close("sdk-test"));
  closers.push(() => releaseResize());
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
  const term = { scope, hubInstance: list.body.hubInstance, termId: created.body.termId };
  const attach = async () => {
    const stream = await openView(hub.httpPort, cookie, term);
    const attached = await stream.next((frame) => frame.t === "attached");
    const replay = await stream.next((frame) => frame.t === "replay-end");
    if (attached.t !== "attached" || replay.t !== "replay-end") throw new Error("missing original view frames");
    const writer = { ...term, viewId: attached.viewId };
    expect((await call("ack", { ...writer, offset: replay.offset, replayComplete: true })).body.ok).toBe(true);
    await stream.next((frame) => frame.t === "ready");
    return { ...stream, writer };
  };
  const old = await attach();
  const startedAt = Date.now();
  const first = await call("resize", { ...old.writer, seq: 1, cols: 81, rows: 25 });
  expect(first.body).toMatchObject({ ok: false, effect: "unknown" });
  expect(Date.now() - startedAt).toBeLessThan(5000); // original 2s budget plus HTTP scheduling; no production widening.
  expect(resizeCalls).toBe(1);
  expect(physicalSettled).toBe(false);
  const next = await attach();
  const busyAt = Date.now();
  expect((await call("resize", { ...next.writer, seq: 1, cols: 101, rows: 33 })).body).toMatchObject({
    ok: false,
    code: "E_NOT_READY",
    effect: "none",
  });
  expect(Date.now() - busyAt).toBeLessThan(2000);
  expect(resizeCalls).toBe(1);
  let seq = 0;
  const size = async (rows: number, cols: number) => {
    const token = `SIZE${++seq}`;
    expect(
      (
        await call("input", {
          ...next.writer,
          seq,
          kind: "user",
          bytesB64: Buffer.from(`printf '${token}='; stty size\n`).toString("base64"),
        })
      ).body.ok,
    ).toBe(true);
    await next.until(() =>
      next.frames
        .filter((frame) => frame.t === "output")
        .map((frame) => Buffer.from(frame.bytesB64, "base64").toString())
        .join("")
        .includes(`${token}=${rows} ${cols}`),
    );
    const frame = next.frames.filter((frame) => frame.t === "output").at(-1)!;
    const offset = frame.offset + Buffer.from(frame.bytesB64, "base64").length;
    expect((await call("ack", { ...next.writer, offset })).body.ok).toBe(true);
  };
  console.info("native resize barrier", { first: first.body, calls: resizeCalls, physicalSettled });
  expect(physicalSettled).toBe(false);
  await size(24, 80); // actual old native dimensions, input is independent of held resize.
  releaseResize();
  await next.until(() => physicalSettled);
  expect((await call("resize", { ...next.writer, seq: 2, cols: 101, rows: 33 })).body).toEqual({
    ok: true,
    acceptedThrough: 2,
  });
  expect(resizeCalls).toBe(2);
  await size(33, 101); // original native backend really applied the accepted successor.
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

/** Real HTTP NDJSON; only the resize method barrier above is injected. */
async function openView(port: number, cookie: string, body: unknown) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/terminal/v2/view",
        method: "POST",
        agent: false,
        headers: {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${port}`,
          "x-pwh": "1",
          "content-type": "application/json",
        },
      },
      resolve,
    );
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
  closers.push(() => {
    response.destroy();
  });
  expect(response.statusCode).toBe(200);
  const frames: TerminalViewFrameV2[] = [];
  const decoder = new NdjsonDecoder({
    onFrame: (raw) => frames.push(raw as TerminalViewFrameV2),
    onError: () => {
      throw new Error("invalid native view");
    },
  });
  response.on("data", (chunk: Buffer) => decoder.push(chunk));
  const until = async (check: () => boolean) => {
    const at = Date.now() + 5000;
    while (!check()) {
      if (Date.now() >= at) throw new Error("native resize/view barrier deadline");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref();
      });
    }
  };
  return {
    frames,
    until,
    next: async (predicate: (frame: TerminalViewFrameV2) => boolean) => {
      await until(() => frames.some(predicate));
      return frames.find(predicate)!;
    },
  };
}
