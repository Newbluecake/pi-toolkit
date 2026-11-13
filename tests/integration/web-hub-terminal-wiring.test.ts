/** Production assembly contract gates. No browser, no fake physical-release proof. */
import { afterEach, describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { TERMINAL_HTTP_PATHS } from "../../src/web-hub/protocol/terminal-paths.js";
import { TERMINAL_UI_CAP } from "../../src/web-hub/protocol/version.js";
import { config } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, rawRequest, type SseConn } from "../web-hub/http/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function offHub() {
  const sandbox = sandboxHome();
  cleanups.push(sandbox.restore);
  const result = await startHub(config({ home: sandbox.home }), createHttpFrontend);
  if ("exists" in result) throw new Error("unexpected singleton");
  const hub: RunningHub = result;
  cleanups.push(() => hub.close("test"));
  const cookie = await login(hub.httpPort, hub.paths.tokenFile);
  const sse: SseConn = await openSse(hub.httpPort, { cookie });
  cleanups.push(() => sse.close());
  await sse.waitFor((e) => e.event === "agents");
  return { hub, cookie, sse };
}
describe("terminal production assembly — default off", () => {
  it("every terminal route stays 404, capability/connection invisible and no journal directory/file", async () => {
    const { hub, cookie, sse } = await offHub();
    const before = (await readdir(hub.paths.stateDir)).sort();
    for (const path of Object.values(TERMINAL_HTTP_PATHS)) {
      const get = await rawRequest(hub.httpPort, { path, headers: { Cookie: cookie } });
      const post = await postJson(
        hub.httpPort,
        path,
        {},
        { Cookie: cookie, Origin: `http://127.0.0.1:${hub.httpPort}` },
      );
      expect(get.status, path).toBe(404);
      expect(post.status, path).toBe(404);
    }
    expect(hub.info.caps).not.toContain(TERMINAL_UI_CAP);
    expect(sse.events.filter((e) => e.event === "terminal_connection" || e.event === "terminal")).toEqual([]);
    expect(sse.events.find((e) => e.event === "hub")!.data.caps).not.toContain(TERMINAL_UI_CAP);
    expect((await readdir(hub.paths.stateDir)).sort()).toEqual(before);
    expect(before.filter((name) => /terminal/.test(name))).toEqual([]);
  });
});

// A trusted in-process producer port is used here to exercise the real production
// composition before cross-process authority is decided. It calls the REAL owner's
// physical receipt method; no wire boolean or constant verifier establishes reaping.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { wireWebHub } from "../../src/web-hub/agent/index.js";
import {
  createTerminalOwner,
  type TerminalOwner,
  type TerminalOwnerOptions,
} from "../../src/web-hub/agent/terminal/owner.js";
import { createTerminalTestBackend, type TerminalBackend } from "../../src/web-hub/agent/terminal/backend.js";
import { readTerminalIdentity, terminalIdentitiesGone } from "../../src/web-hub/agent/terminal/reaper.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import {
  TERMINAL_JOURNAL_FILE,
  terminalIdentityKey,
  type TerminalJournal,
  type TerminalHttpRequests,
  type TerminalHttpResults,
  type TerminalSseEvent,
} from "../../src/web-hub/protocol/terminal.js";
import type { FrontendDeps } from "../../src/web-hub/hub/ports.js";
import { fakePi, fakeCtx, resetGlobals, SETTINGS, waitUntil } from "../web-hub/agent/helpers.js";
import { makeTerminalFixture } from "./web-hub-terminal-fixture.js";
const terminalConfig = {
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  inputIdleMs: 3600000,
  maxLifetimeMs: 28800000,
};
async function physicalHub(degraded = false, initialized = true) {
  const sandbox = sandboxHome();
  cleanups.push(sandbox.restore);
  const fixture = makeTerminalFixture();
  cleanups.push(fixture.cleanup);
  const identity = await readTerminalIdentity(process.pid);
  if (identity === undefined) throw new Error("real Linux identity required");
  const paths = resolveHubPaths({ home: sandbox.home, uid: process.getuid!() });
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  // An explicit new fixture store before exposure, NOT ENOENT/trustedNew inference.
  if (initialized)
    await writeFile(join(paths.stateDir, TERMINAL_JOURNAL_FILE), JSON.stringify({ v: 1, revision: 0, resources: [] }), {
      flag: "wx",
      mode: 0o600,
    });
  if (degraded) await writeFile(join(paths.stateDir, "privacy.json"), "corrupt fixture", { mode: 0o600 });
  let owner: TerminalOwner | undefined, ownerOptions: TerminalOwnerOptions | undefined;
  let frontend: FrontendDeps | undefined;
  const backends: TerminalBackend[] = [];
  let receiptChecks = 0,
    resolvedAcks = 0;
  const result = await startHub(
    config({ home: sandbox.home, privacy: true, terminal: terminalConfig }),
    (deps) => {
      frontend = deps;
      return createHttpFrontend(deps);
    },
    {
      terminalAuthority: {
        target: (link) => {
          if (
            link.agentId.pid !== process.pid ||
            !owner ||
            !ownerOptions?.allowed() ||
            link.meta.sessionId !== ownerOptions.sessionId ||
            link.meta.epoch !== ownerOptions.epoch
          )
            return undefined;
          return {
            meta: link.meta,
            processIdentity: {
              bootId: identity.bootId,
              pid: identity.pid,
              starttime: identity.starttime,
              uid: identity.uid,
            },
            allowed: true,
          };
        },
        receipt: (proof, entry) => {
          const actual = owner?.reapProof(entry.identity, proof);
          if (
            !actual ||
            terminalIdentityKey(actual.identity) !== terminalIdentityKey(proof.identity) ||
            JSON.stringify(actual.agentProcessIdentity) !== JSON.stringify(proof.agentProcessIdentity) ||
            JSON.stringify(actual.identitiesChecked) !== JSON.stringify(proof.identitiesChecked)
          )
            return false;
          receiptChecks++;
          return true;
        },
      },
    },
  );
  if ("exists" in result) throw new Error("unexpected singleton");
  const hub = result;
  cleanups.push(() => hub.close("test"));
  resetGlobals();
  const a = fakePi(),
    c = fakeCtx({ sessionId: "terminal-session" });
  Object.assign(c.ctx, { cwd: fixture.fixture.cwd });
  wireWebHub(a.pi, {
    settings: { ...SETTINGS, terminal: { enabled: true, ...terminalConfig } },
    terminalGuard: () => true,
    fleet: () => [],
    env: { HOME: sandbox.home },
    paths,
    argv1: "/nonexistent/pi",
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "terminal-wiring" }),
    terminalOwnerFactory: async (options) => {
      ownerOptions = options;
      owner = await createTerminalOwner({
        ...options,
        backend: (opts) => {
          const b = createTerminalTestBackend(opts, fixture.fixture);
          backends.push(b);
          return b;
        },
      });
      const forget = owner.forgetResolvedReceipts.bind(owner);
      vi.spyOn(owner, "forgetResolvedReceipts").mockImplementation((ids) => {
        const count = forget(ids);
        resolvedAcks += count;
        return count;
      });
      return owner;
    },
  });
  a.fire("session_start", { type: "session_start" }, c.ctx);
  await waitUntil(() => frontend!.registry.list().some((v) => v.session?.sessionId === "terminal-session"), 5000);
  cleanups.push(async () => {
    a.fire("session_shutdown", { reason: "quit" }, c.ctx);
    await owner?.dispose();
    resetGlobals();
    vi.restoreAllMocks();
  });
  const view = frontend!.registry.list().find((v) => v.session?.sessionId === "terminal-session")!;
  const cookie = await login(hub.httpPort, hub.paths.tokenFile);
  const sse = await openSse(hub.httpPort, { cookie });
  cleanups.push(() => sse.close());
  if (degraded) {
    await sse.waitEnd();
    expect(sse.events.some((e) => e.event === "hub" && e.data.caps.includes(TERMINAL_UI_CAP))).toBe(true);
    expect(sse.events.some((e) => e.event === "terminal_connection")).toBe(false);
    expect(backends).toEqual([]);
    return undefined;
  }
  const connection = await sse.waitFor((e) => e.event === "terminal_connection");
  const client = await sse.waitFor((e) => e.event === "hello");
  expect(sse.events.findIndex((e) => e.event === "hub")).toBeLessThan(sse.events.indexOf(connection));
  expect(connection.id).toBeUndefined();
  const scope = {
    agentKey: view.agentKey,
    expect: { sessionId: "terminal-session", epoch: view.epoch },
    clientId: client.data.clientId,
    connectionInstance: connection.data.connectionInstance,
    connectionToken: connection.data.connectionToken,
  };
  const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${hub.httpPort}` };
  async function post<K extends keyof TerminalHttpRequests>(op: K, extra: object = {}) {
    const response = await postJson(hub.httpPort, TERMINAL_HTTP_PATHS[op], { ...scope, ...extra }, headers);
    return { status: response.status, body: JSON.parse(response.body) as TerminalHttpResults[K] & { code?: string } };
  }
  const output = (termId: string) =>
    sse.events
      .filter((e) => e.event === "terminal")
      .map((e) => (e.data as TerminalSseEvent).event)
      .filter((e) => e.termId === termId && e.kind === "output")
      .map((e) => Buffer.from((e as { bytesB64: string }).bytesB64, "base64").toString())
      .join("");
  async function writable(attachment: TerminalHttpResults["open"]) {
    const begin = await sse.waitFor(
      (e) =>
        e.event === "terminal" &&
        e.data.attachmentId === attachment.attachmentId &&
        e.data.event.kind === "replay_begin",
    );
    const ack = await post("ack", {
      ...writer(attachment),
      ack: {
        phase: "replay_ready",
        attemptId: begin.data.event.attemptId,
        replayEpoch: begin.data.event.replayEpoch,
        renderedThrough: begin.data.event.N0,
      },
    });
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    const cutover = await sse.waitFor(
      (e) =>
        e.event === "terminal" && e.data.attachmentId === attachment.attachmentId && e.data.event.kind === "cutover",
    );
    return cutover.data.event.newLiveEpoch as string;
  }
  return {
    hub,
    cookie,
    sse,
    post,
    output,
    writable,
    owner: () => owner!,
    backends,
    scope,
    headers,
    receipts: () => ({ receiptChecks, resolvedAcks }),
    journal: async () =>
      JSON.parse(await readFile(join(paths.stateDir, TERMINAL_JOURNAL_FILE), "utf8")) as TerminalJournal,
  };
}
const writer = (a: TerminalHttpResults["open"]) => ({
  termId: a.termId,
  attachmentId: a.attachmentId,
  writerLease: a.writerLease,
});
async function openPhysical(h: NonNullable<Awaited<ReturnType<typeof physicalHub>>>) {
  const prepare = await h.post("prepare", { cols: 80, rows: 24 });
  expect(prepare.status, JSON.stringify(prepare.body)).toBe(200);
  const opened = await h.post("open", { ...prepare.body, ok: undefined, cols: 80, rows: 24, tabId: "tab" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const streamEpoch = await h.writable(opened.body);
  return { attachment: opened.body, streamEpoch };
}
describe("terminal real hub + real connection + physical PTY with trusted local producer port", () => {
  it("HTTP prepare/open → directed output/input echo → detach/attach same PID → close/reap/durable ACK → quota reusable", async () => {
    const h = (await physicalHub())!;
    const observerCookie = await login(h.hub.httpPort, h.hub.paths.tokenFile);
    const observer = await openSse(h.hub.httpPort, { cookie: observerCookie });
    cleanups.push(() => observer.close());
    await observer.waitFor((e) => e.event === "agents");
    const { attachment, streamEpoch } = await openPhysical(h);
    const shell = h.backends[0]!.managed.find((id) => id.role === "shell")!;
    expect(shell.pid).toBeGreaterThan(0);
    const command = 'printf "TERM_PID=%s\\n" "$$"\n';
    const input = await h.post("input", {
      ...writer(attachment),
      inputSeq: attachment.nextInputSeq,
      inputKind: "user",
      streamEpoch,
      bytesB64: Buffer.from(command).toString("base64"),
    });
    expect(input.status, JSON.stringify(input.body)).toBe(200);
    await waitUntil(() => h.output(attachment.termId).includes(`TERM_PID=${shell.pid}`), 5000);
    expect(observer.events.filter((e) => e.event === "terminal")).toEqual([]);
    expect(h.sse.events.filter((e) => e.event === "terminal").every((e) => e.id === undefined)).toBe(true);
    expect((await h.post("detach", writer(attachment))).status).toBe(200);
    expect(h.backends[0]!.managed.find((id) => id.role === "shell")!.pid).toBe(shell.pid);
    const attach = await h.post("attach", {
      termId: attachment.termId,
      attachId: "again",
      tabId: "tab",
      cols: 80,
      rows: 24,
    });
    expect(attach.status, JSON.stringify(attach.body)).toBe(200);
    const epoch2 = await h.writable(attach.body);
    expect(h.backends).toHaveLength(1);
    const echo = await h.post("input", {
      ...writer(attach.body),
      inputSeq: attach.body.nextInputSeq,
      inputKind: "user",
      streamEpoch: epoch2,
      bytesB64: Buffer.from('printf "ATTACHED=%s\\n" "$$"\n').toString("base64"),
    });
    expect(echo.status).toBe(200);
    await waitUntil(() => h.output(attachment.termId).includes(`ATTACHED=${shell.pid}`), 5000);
    for (let index = 0; index < 3; index++) {
      const a = index === 0 ? attach.body : (await openPhysical(h)).attachment;
      const closed = await h.post("close", {
        termId: a.termId,
        closeId: `close-${index}`,
        expectedRevision: a.revision,
      });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      await waitUntil(() => h.receipts().resolvedAcks === index + 1, 8000, "exact durable receipt ACK");
      expect(h.owner().resourceEntries()).toEqual([]);
      expect((await h.journal()).resources.every((r) => r.status === "resolved")).toBe(true);
      expect(await terminalIdentitiesGone(h.backends[index]!.managed)).toBe(true);
    }
    expect(h.receipts().receiptChecks).toBeGreaterThanOrEqual(3);
    expect(h.backends).toHaveLength(3); // exceeds quota 2 without any manual fence mutation
    expect(observer.events.filter((e) => e.event === "terminal")).toEqual([]);
  }, 30000);
});

describe("terminal authority loss is observable before another request can act", () => {
  it("privacy onChange fences before original SSE closes; first new request denies and real shell is reaped", async () => {
    const h = (await physicalHub())!;
    await openPhysical(h);
    const marked = await postJson(
      h.hub.httpPort,
      "/api/privacy/lock",
      { agentKey: h.scope.agentKey, sessionId: h.scope.expect.sessionId, locked: true },
      h.headers,
    );
    expect(marked.status).toBe(200);
    await h.sse.waitEnd();
    const denied = await h.post("prepare", { cols: 80, rows: 24 });
    expect(denied.status).not.toBe(200);
    expect(h.backends).toHaveLength(1);
    const fresh = await openSse(h.hub.httpPort, { cookie: h.cookie });
    cleanups.push(() => fresh.close());
    const connection = await fresh.waitFor((e) => e.event === "terminal_connection");
    const hello = await fresh.waitFor((e) => e.event === "hello");
    const privacy = fresh.events.find((e) => e.event === "privacy")!;
    expect(privacy.data.locked).toContain(h.scope.expect.sessionId);
    expect(fresh.events.indexOf(privacy)).toBeLessThan(fresh.events.indexOf(connection));
    const request = await postJson(
      h.hub.httpPort,
      TERMINAL_HTTP_PATHS.prepare,
      {
        ...h.scope,
        cols: 80,
        rows: 24,
        clientId: hello.data.clientId,
        connectionInstance: connection.data.connectionInstance,
        connectionToken: connection.data.connectionToken,
      },
      h.headers,
    );
    expect(JSON.parse(request.body)).toMatchObject({ ok: false, code: "E_PRIVACY_LOCKED", effect: "none" });
    expect(h.backends).toHaveLength(1);
    await waitUntil(() => h.receipts().resolvedAcks === 1, 8000);
  }, 20000);
  it("auth revoke closes original SSE; first request rejects and cleanup still collects exact physical receipt", async () => {
    const h = (await physicalHub())!;
    await openPhysical(h);
    const logout = await postJson(h.hub.httpPort, "/api/logout", {}, h.headers);
    expect(logout.status).toBe(200);
    await h.sse.waitEnd();
    const rejected = await h.post("prepare", { cols: 80, rows: 24 });
    expect(rejected.status).toBe(401);
    expect(h.backends).toHaveLength(1);
    await waitUntil(() => h.receipts().resolvedAcks === 1, 8000);
  }, 20000);
  it("degraded privacy emits hub capability then closes SSE without any binding token or backend", async () => {
    expect(await physicalHub(true)).toBeUndefined();
  });
});

describe("production missing-authority refusal", () => {
  it("does not treat first enabled boot/ENOENT as new-store authority or mint a private connection", async () => {
    const sandbox = sandboxHome();
    cleanups.push(sandbox.restore);
    const result = await startHub(config({ home: sandbox.home, terminal: terminalConfig }), createHttpFrontend);
    if ("exists" in result) throw new Error("unexpected singleton");
    cleanups.push(() => result.close("test"));
    const cookie = await login(result.httpPort, result.paths.tokenFile);
    const sse = await openSse(result.httpPort, { cookie });
    cleanups.push(() => sse.close());
    await sse.waitEnd();
    expect(sse.events.some((e) => e.event === "terminal_connection")).toBe(false);
    const response = await postJson(
      result.httpPort,
      TERMINAL_HTTP_PATHS.prepare,
      {},
      { Cookie: cookie, Origin: `http://127.0.0.1:${result.httpPort}` },
    );
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ ok: false, code: "E_UNAVAILABLE", effect: "none" });
    expect((await readdir(result.paths.stateDir)).filter((name) => /terminal/.test(name))).toEqual([]);
  });
});

describe("production journal prerequisite", () => {
  it("even a valid local producer cannot turn a missing journal into an empty new store", async () => {
    const h = (await physicalHub(false, false))!;
    const rejected = await h.post("prepare", { cols: 80, rows: 24 });
    expect(rejected.body).toMatchObject({ ok: false, code: "E_RESOURCE_QUARANTINED", effect: "unknown" });
    expect(h.backends).toEqual([]);
    expect((await readdir(h.hub.paths.stateDir)).filter((name) => /terminal/.test(name))).toEqual([]);
  });
});

describe("detached physical lifecycle", () => {
  it("natural exit after detach still supplies a dedicated lifecycle fact and exact receipt ACK", async () => {
    const h = (await physicalHub())!;
    const { attachment, streamEpoch } = await openPhysical(h);
    const sent = await h.post("input", {
      ...writer(attachment),
      inputSeq: attachment.nextInputSeq,
      inputKind: "user",
      streamEpoch,
      bytesB64: Buffer.from("sleep 0.1; exit\n").toString("base64"),
    });
    expect(sent.status).toBe(200);
    expect((await h.post("detach", writer(attachment))).status).toBe(200);
    const count = h.sse.events.filter((e) => e.event === "terminal").length;
    await waitUntil(() => h.receipts().resolvedAcks === 1, 8000, "detached physical completion ACK");
    expect(h.owner().resourceEntries()).toEqual([]);
    expect(h.sse.events.filter((e) => e.event === "terminal")).toHaveLength(count);
    expect(await terminalIdentitiesGone(h.backends[0]!.managed)).toBe(true);
  }, 20000);
});
