/** Production assembly contract gates. No browser, no fake physical-release proof. */
import { afterEach, describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { TERMINAL_HTTP_PATHS } from "../../src/web-hub/protocol/terminal-paths.js";
import { TERMINAL_UI_CAP } from "../../src/web-hub/protocol/version.js";
import { config } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, rawRequest, type SseConn } from "../web-hub/http/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const ioGate = vi.hoisted(() => ({
  onHandle: undefined as ((path: unknown, handle: { sync(): Promise<void> }) => void) | undefined,
  afterIngress: undefined as ((raw: unknown) => void) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      ioGate.onHandle?.(args[0], handle);
      return handle;
    },
  };
});
vi.mock("../../src/web-hub/hub/agent-server.js", async (original) => {
  const actual = await original<typeof import("../../src/web-hub/hub/agent-server.js")>();
  return {
    ...actual,
    createAgentServer: (...args: Parameters<typeof actual.createAgentServer>) => {
      const [server, deps] = args,
        terminal = deps.terminal;
      return actual.createAgentServer(server, {
        ...deps,
        ...(terminal
          ? {
              terminal: {
                ...terminal,
                consumeAgentFrame: (meta, raw) => {
                  terminal.consumeAgentFrame(meta, raw);
                  ioGate.afterIngress?.(raw);
                },
              },
            }
          : {}),
      });
    },
  };
});
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  ioGate.onHandle = undefined;
  ioGate.afterIngress = undefined;
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

// Real production local authority/receipt filesystem ports; only the physical
// UID/rc fixture is injected, with no authority or proof-verifier replacement.
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
import { TERMINAL_LOCAL_DIR } from "../../src/web-hub/protocol/terminal-local.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import {
  TERMINAL_JOURNAL_FILE,
  TERMINAL_LIMITS,
  terminalIdentityKey,
  type TerminalJournal,
  type TerminalHttpRequests,
  type TerminalHttpResults,
  type TerminalSseEvent,
  type TermRes,
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
async function physicalHub(degraded = false) {
  let localAllowed = true;
  let mapAuthority:
    | ((
        ref: import("../../src/web-hub/protocol/terminal.js").TerminalLocalReference,
      ) => import("../../src/web-hub/protocol/terminal.js").TerminalLocalReference)
    | undefined;
  let mapProof:
    | ((
        proof: import("../../src/web-hub/protocol/terminal.js").TerminalReapProof,
      ) => import("../../src/web-hub/protocol/terminal.js").TerminalReapProof)
    | undefined;
  const provedInventories = new Set<string>();
  let provedEnd: Extract<TermRes, { op: "inventory"; ok: true }> | undefined;
  let beforeReceiptPublish: (() => Promise<void>) | undefined;
  let legacyChallenge = false;
  const sandbox = sandboxHome();
  cleanups.push(sandbox.restore);
  const fixture = makeTerminalFixture();
  cleanups.push(fixture.cleanup);
  const identity = await readTerminalIdentity(process.pid);
  if (identity === undefined) throw new Error("real Linux identity required");
  const paths = resolveHubPaths({ home: sandbox.home, uid: process.getuid!() });
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  if (degraded) await writeFile(join(paths.stateDir, "privacy.json"), "corrupt fixture", { mode: 0o600 });
  let owner: TerminalOwner | undefined;
  let frontend: FrontendDeps | undefined;
  const backends: TerminalBackend[] = [];
  let resolvedAcks = 0;
  const launch = async () => {
    const result = await startHub(config({ home: sandbox.home, privacy: true, terminal: terminalConfig }), (deps) => {
      frontend = deps;
      return createHttpFrontend(deps);
    });
    if ("exists" in result) throw new Error("unexpected singleton");
    return result;
  };
  let hub = await launch();
  cleanups.push(() => hub.close("test"));
  resetGlobals();
  const a = fakePi(),
    c = fakeCtx({ sessionId: "terminal-session" });
  Object.assign(c.ctx, { cwd: fixture.fixture.cwd });
  wireWebHub(a.pi, {
    settings: { ...SETTINGS, terminal: { enabled: true, ...terminalConfig } },
    terminalGuard: () => localAllowed,
    fleet: () => [],
    env: { HOME: sandbox.home },
    paths,
    argv1: "/nonexistent/pi",
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "terminal-wiring" }),
    terminalOwnerFactory: async (options) => {
      owner = await createTerminalOwner({
        ...options,
        send: (frame) => {
          // Observe the real producer snapshot before any hostile wire-only projection.
          if (frame.t === "term_res" && frame.ok && frame.op === "inventory") {
            if (frame.page.phase === "chunk" && frame.page.proofs.length) provedInventories.add(frame.page.inventoryId);
            if (frame.page.phase === "end" && provedInventories.has(frame.page.inventoryId))
              provedEnd = structuredClone(frame);
          }
          if (legacyChallenge && frame.t === "term_res" && frame.ok && frame.op === "protocol_challenge") {
            const { authorityAvailable: _authority, ...old } = frame;
            return options.send(old);
          }
          if (frame.t === "term_res" && frame.ok && frame.op === "authority" && mapAuthority)
            return options.send({ ...frame, authority: mapAuthority({ ...frame.authority }) });
          if (
            frame.t === "term_res" &&
            frame.ok &&
            frame.op === "inventory" &&
            frame.page.phase === "chunk" &&
            mapProof
          )
            return options.send({
              ...frame,
              page: { ...frame.page, proofs: frame.page.proofs.map((p) => mapProof!(structuredClone(p))) },
            });
          return options.send(frame);
        },
        backend: (opts) => {
          const b = createTerminalTestBackend(
            {
              ...opts,
              ...(opts.receiptContext
                ? { receiptContext: { ...opts.receiptContext, beforePublish: async () => beforeReceiptPublish?.() } }
                : {}),
            },
            fixture.fixture,
          );
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
    // Teardown only: failed negative cases intentionally retain H quota/journal; their
    // isolated scratch is about to be removed, so remove only this test owner's proven receipts.
    if (owner) {
      const own = owner.resourceEntries().filter(
        (r) =>
          r.identity.ownerInstance === owner!.ownerInstance &&
          owner!.reapProof(r.identity, {
            hubBootId: "cleanup",
            challengeId: "cleanup",
            linkGen: 1,
            inventoryId: "cleanup",
            revision: 1,
          }),
      );
      if (own.length) owner.forgetResolvedReceipts(own.map((r) => r.identity));
    }
    resetGlobals();
    vi.restoreAllMocks();
  });
  const view = frontend!.registry.list().find((v) => v.session?.sessionId === "terminal-session")!;
  let cookie = await login(hub.httpPort, hub.paths.tokenFile);
  let sse = await openSse(hub.httpPort, { cookie });
  const initialStream = sse;
  cleanups.push(() => initialStream.close());
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
  let scope = {
    agentKey: view.agentKey,
    expect: { sessionId: "terminal-session", epoch: view.epoch },
    clientId: client.data.clientId,
    connectionInstance: connection.data.connectionInstance,
    connectionToken: connection.data.connectionToken,
  };
  let headers = { Cookie: cookie, Origin: `http://127.0.0.1:${hub.httpPort}` };
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
    get hub() {
      return hub;
    },
    get cookie() {
      return cookie;
    },
    get sse() {
      return sse;
    },
    async refreshStream() {
      sse.close();
      sse = await openSse(hub.httpPort, { cookie }); // Deliberately NO login call or cookie replacement.
      const stream = sse;
      cleanups.push(() => stream.close());
      const connection = await sse.waitFor((e) => e.event === "terminal_connection"),
        hello = await sse.waitFor((e) => e.event === "hello");
      scope = {
        ...scope,
        clientId: hello.data.clientId,
        connectionInstance: connection.data.connectionInstance,
        connectionToken: connection.data.connectionToken,
      };
    },
    async restart() {
      await hub.close("terminal-cold-restart-test");
      hub = await launch();
      await waitUntil(
        () => frontend!.registry.list().some((v) => v.session?.sessionId === "terminal-session"),
        8000,
        "real agent reconnect after cold hub restart",
      );
      const view = frontend!.registry.list().find((v) => v.session?.sessionId === "terminal-session")!;
      cookie = await login(hub.httpPort, hub.paths.tokenFile);
      sse = await openSse(hub.httpPort, { cookie });
      const stream = sse;
      cleanups.push(() => stream.close());
      const connection = await sse.waitFor((e) => e.event === "terminal_connection"),
        hello = await sse.waitFor((e) => e.event === "hello");
      scope = {
        agentKey: view.agentKey,
        expect: { sessionId: "terminal-session", epoch: view.epoch },
        clientId: hello.data.clientId,
        connectionInstance: connection.data.connectionInstance,
        connectionToken: connection.data.connectionToken,
      };
      headers = { Cookie: cookie, Origin: `http://127.0.0.1:${hub.httpPort}` };
    },
    post,
    output,
    writable,
    owner: () => owner!,
    backends,
    get scope() {
      return scope;
    },
    get headers() {
      return headers;
    },
    revokeLocalGuard: () => {
      localAllowed = false;
      a.fire("turn_end", { type: "turn_end" }, c.ctx);
    },
    legacyChallenge: () => {
      legacyChallenge = true;
    },
    mapAuthority: (fn: typeof mapAuthority) => {
      mapAuthority = fn;
    },
    mapProof: (fn: typeof mapProof) => {
      mapProof = fn;
    },
    beforeReceiptPublish: (fn: typeof beforeReceiptPublish) => {
      beforeReceiptPublish = fn;
    },
    provedEnd: () => provedEnd,
    receipts: () => ({ resolvedAcks }),
    journal: async () =>
      JSON.parse(
        await readFile(join(paths.stateDir, TERMINAL_LOCAL_DIR, TERMINAL_JOURNAL_FILE), "utf8"),
      ) as TerminalJournal,
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
describe("terminal real hub + real connection + physical PTY with production local filesystem authority", () => {
  it("same login cookie survives three real SSE replacements and lists/reattaches the same physical shell", async () => {
    const h = (await physicalHub())!;
    let { attachment } = await openPhysical(h);
    const originalCookie = h.cookie;
    const pid = h.backends[0]!.managed.find((id) => id.role === "shell")!.pid;
    for (let round = 0; round < 3; round++) {
      expect((await h.post("detach", writer(attachment))).status).toBe(200);
      const oldConnection = h.scope.connectionInstance;
      await h.refreshStream();
      expect(h.cookie).toBe(originalCookie);
      expect(h.scope.connectionInstance).not.toBe(oldConnection);
      const listed = await h.post("list");
      expect(listed.status).toBe(200);
      expect(listed.body.rows.map((r) => r.termId)).toEqual([attachment.termId]);
      const attached = await h.post("attach", {
        termId: attachment.termId,
        attachId: `refresh-${round}`,
        tabId: "refresh-tab",
        cols: 80,
        rows: 24,
      });
      expect(attached.status).toBe(200);
      attachment = attached.body;
      const streamEpoch = await h.writable(attachment);
      expect(
        (
          await h.post("input", {
            ...writer(attachment),
            inputSeq: attachment.nextInputSeq,
            inputKind: "user",
            streamEpoch,
            bytesB64: Buffer.from('printf "REFRESH_PID=%s\\n" "$$"\n').toString("base64"),
          })
        ).status,
      ).toBe(200);
      await waitUntil(() => h.output(attachment.termId).includes(`REFRESH_PID=${pid}`), 5000);
      expect(h.backends).toHaveLength(1);
    }
    expect(
      (
        await h.post("close", {
          termId: attachment.termId,
          closeId: "refresh-close",
          expectedRevision: attachment.revision,
        })
      ).status,
    ).toBe(200);
    await waitUntil(() => h.receipts().resolvedAcks === 1, TERMINAL_LIMITS.reapRetryMs);
  }, 90000);
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
      expect((await h.journal()).resources).toEqual([]);
      expect(await terminalIdentitiesGone(h.backends[index]!.managed)).toBe(true);
    }
    expect(
      (await h.journal()).resources.every((row) => row.proof !== undefined && row.proof.receipt === undefined),
    ).toBe(true);
    for (const backend of h.backends) {
      const physical = await backend.done;
      expect(physical.receipt).toBeDefined();
      expect(JSON.stringify(await h.journal())).not.toContain(physical.receipt!.nonce);
    }
    expect(await readdir(join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, "receipts"))).toEqual([]);
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

describe("production existing-store refusal", () => {
  it.each(["empty", "leftover-authority", "leftover-receipt"])(
    "never resets an existing %s directory with missing journal",
    async (kind) => {
      const sandbox = sandboxHome();
      cleanups.push(sandbox.restore);
      const paths = resolveHubPaths({ home: sandbox.home, uid: process.getuid!() });
      await mkdir(join(paths.stateDir, TERMINAL_LOCAL_DIR), { recursive: true, mode: 0o700 });
      if (kind !== "empty")
        await writeFile(join(paths.stateDir, TERMINAL_LOCAL_DIR, kind), "untrusted leftover", { mode: 0o600 });
      const before = await readdir(join(paths.stateDir, TERMINAL_LOCAL_DIR));
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
      expect(await readdir(join(paths.stateDir, TERMINAL_LOCAL_DIR))).toEqual(before);
      expect(JSON.parse(readFileSync(result.paths.hubJson, "utf8")).terminal).toEqual({
        state: "unavailable",
        reason: "journal-missing",
      });
    },
  );
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

import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
describe("separate-process production authority and physical receipt release chain", () => {
  it("crosses real agent/hub process boundary and repeatedly frees quota only after receipt/journal/ACK", async () => {
    const sandbox = sandboxHome();
    cleanups.push(sandbox.restore);
    const fixture = makeTerminalFixture();
    cleanups.push(fixture.cleanup);
    let frontend: FrontendDeps | undefined;
    const result = await startHub(config({ home: sandbox.home, privacy: true, terminal: terminalConfig }), (deps) => {
      frontend = deps;
      return createHttpFrontend(deps);
    });
    if ("exists" in result) throw new Error("unexpected singleton");
    const hub = result;
    cleanups.push(() => hub.close("test"));
    const configFile = join(fixture.fixture.root, "agent.json");
    await writeFile(configFile, JSON.stringify({ home: sandbox.home, fixture: fixture.fixture }), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("tests/integration/fixtures/terminal-agent.ts"), configFile],
      { stdio: "pipe", env: { ...process.env, HOME: sandbox.home } },
    );
    let ready = false,
      errors = "";
    child.stdout.on("data", (data: Buffer) => {
      ready ||= data.toString().includes("READY");
    });
    child.stderr.on("data", (data: Buffer) => {
      errors = (errors + data.toString()).slice(-4096);
    });
    const exited = once(child, "exit");
    cleanups.push(async () => {
      child.stdin.end("STOP\n");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
      deadline.unref();
      await exited;
      clearTimeout(deadline);
    });
    try {
      await waitUntil(() => ready || child.exitCode !== null, 10000, "real child agent ready");
    } catch (error) {
      throw new Error(`${String(error)}; ${errors}; cards=${frontend!.registry.list().length}`);
    }
    expect(child.exitCode, errors).toBeNull();
    expect(ready, errors).toBe(true);
    const view = frontend!.registry.list().find((v) => v.session?.sessionId === "child-terminal-session")!;
    expect(view.agentId.pid).toBe(child.pid);
    expect(child.pid).not.toBe(process.pid);
    const cookie = await login(hub.httpPort, hub.paths.tokenFile);
    const sse = await openSse(hub.httpPort, { cookie });
    cleanups.push(() => sse.close());
    const connection = await sse.waitFor((e) => e.event === "terminal_connection"),
      hello = await sse.waitFor((e) => e.event === "hello");
    const scope = {
      agentKey: view.agentKey,
      expect: { sessionId: view.session!.sessionId, epoch: view.epoch },
      clientId: hello.data.clientId,
      connectionInstance: connection.data.connectionInstance,
      connectionToken: connection.data.connectionToken,
    };
    const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${hub.httpPort}` };
    const post = async (op: keyof TerminalHttpRequests, extra: object) => {
      const response = await postJson(hub.httpPort, TERMINAL_HTTP_PATHS[op], { ...scope, ...extra }, headers);
      expect(response.status, `${response.body}; op=${op}; agent=${errors}`).toBe(200);
      return JSON.parse(response.body);
    };
    const root = join(hub.paths.stateDir, TERMINAL_LOCAL_DIR),
      journalPath = join(root, TERMINAL_JOURNAL_FILE);
    for (let round = 0; round < 4; round++) {
      const prepared = await post("prepare", { cols: 80, rows: 24 });
      const a = await post("open", {
        openId: prepared.openId,
        createTicket: prepared.createTicket,
        tabId: "child-tab",
        cols: 80,
        rows: 24,
      });
      const attachWritable = async (attachment: TerminalHttpResults["open"]) => {
        const begin = await sse.waitFor(
          (e) =>
            e.event === "terminal" &&
            e.data.attachmentId === attachment.attachmentId &&
            e.data.event.kind === "replay_begin",
        );
        await post("ack", {
          ...writer(attachment),
          ack: {
            phase: "replay_ready",
            attemptId: begin.data.event.attemptId,
            replayEpoch: begin.data.event.replayEpoch,
            renderedThrough: begin.data.event.N0,
          },
        });
        return (
          await sse.waitFor(
            (e) =>
              e.event === "terminal" &&
              e.data.attachmentId === attachment.attachmentId &&
              e.data.event.kind === "cutover",
          )
        ).data.event.newLiveEpoch;
      };
      let epoch = await attachWritable(a);
      const output = () =>
        sse.events
          .filter((e) => e.event === "terminal" && e.data.event.termId === a.termId && e.data.event.kind === "output")
          .map((e) => Buffer.from(e.data.event.bytesB64, "base64").toString())
          .join("");
      await post("input", {
        ...writer(a),
        inputSeq: a.nextInputSeq,
        inputKind: "user",
        streamEpoch: epoch,
        bytesB64: Buffer.from('printf "CHILD_PID=%s\\n" "$$"\n').toString("base64"),
      });
      await waitUntil(() => /CHILD_PID=\d+/.test(output()), 5000, "real cross-process shell echo");
      const pid = Number(/CHILD_PID=(\d+)/.exec(output())![1]);
      expect(pid).toBeGreaterThan(0);
      await post("detach", writer(a));
      const attached = await post("attach", {
        termId: a.termId,
        attachId: `child-attach-${round}`,
        tabId: "child-tab",
        cols: 80,
        rows: 24,
      });
      epoch = await attachWritable(attached);
      await post("input", {
        ...writer(attached),
        inputSeq: attached.nextInputSeq,
        inputKind: "user",
        streamEpoch: epoch,
        bytesB64: Buffer.from('printf "REATTACHED=%s\\n" "$$"\n').toString("base64"),
      });
      await waitUntil(() => output().includes(`REATTACHED=${pid}`), 5000, "same PID after attach");
      const beforeClose = JSON.parse(readFileSync(journalPath, "utf8")) as TerminalJournal;
      expect(beforeClose.resources.some((row) => row.entry.identity.termId === a.termId)).toBe(true);
      await post("close", { termId: a.termId, closeId: `child-close-${round}`, expectedRevision: attached.revision });
      let stage = "durable resolve/prune";
      try {
        // Physical completion can take the production escalating-reaper budget (60s).
        // A close/exit event is NOT a durable-release barrier: retain both journal
        // assertions and the separate exact-receipt ACK assertion below.
        await waitUntil(
          () => {
            const j = JSON.parse(readFileSync(journalPath, "utf8")) as TerminalJournal;
            return j.revision >= beforeClose.revision + 2 && j.resources.length === 0;
          },
          TERMINAL_LIMITS.reapRetryMs,
          "real cross-process durable resolution",
        );
        stage = "receipt ACK/delete";
        await waitUntil(
          () => readdirSync(join(root, "receipts")).length === 0,
          5000,
          "ACK deletes exact persisted receipt",
        );
      } catch (error) {
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as TerminalJournal;
        const receipts = readdirSync(join(root, "receipts")).map((file) => {
          const receipt = JSON.parse(readFileSync(join(root, "receipts", file), "utf8"));
          // Body-free physical diagnostics only; never print capabilities/nonces.
          return { identity: receipt.identity, physical: receipt.physical };
        });
        const processState = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8") : "gone";
        throw new Error(
          `${String(error)}; ${JSON.stringify({
            stage,
            round,
            pid,
            reaper: {
              budgetMs: TERMINAL_LIMITS.reapRetryMs,
              shell: processState,
              managed: journal.resources
                .flatMap((row) => row.entry.managed)
                .map((identity) => {
                  try {
                    return { identity, stat: readFileSync(`/proc/${identity.pid}/stat`, "utf8") };
                  } catch {
                    return { identity, stat: "gone-or-unreadable" };
                  }
                }),
            },
            journal: { revision: journal.revision, resources: journal.resources },
            receipts,
            agentExit: child.exitCode,
            agentDiagnostics: errors,
            lifecycle: sse.events
              .filter((e) => e.event === "terminal" && e.data.event.kind === "exit")
              .map((e) => ({ kind: e.data.event.kind, reap: e.data.event.reap, reason: e.data.event.reason })),
          })}`,
        );
      }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(sse.events.filter((e) => e.event === "terminal").every((e) => e.id === undefined)).toBe(true);
    }
    expect(await readdir(join(root, "authority"))).toHaveLength(1);
  }, 300000);
});

import { chmodSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import type { TerminalAuthorityRecord, TerminalPhysicalReceipt } from "../../src/web-hub/protocol/terminal-local.js";
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
describe("authority falsification — real production preflight, zero backend opens", () => {
  it.each([
    "missing",
    "malformed",
    "tampered-hash",
    "pid",
    "starttime",
    "uid",
    "boot",
    "agent-nonce",
    "capability",
    "namespace",
    "secure-domain",
    "not-main",
    "inactive",
    "symlink",
    "permissions",
  ])(
    "rejects %s authority before the very first prepare",
    async (fault) => {
      const h = (await physicalHub())!;
      const dir = join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, "authority");
      const path = join(dir, (await readdir(dir))[0]!);
      const source = readFileSync(path, "utf8"),
        original = JSON.parse(source) as TerminalAuthorityRecord;
      let record = structuredClone(original);
      if (fault === "missing") unlinkSync(path);
      else if (fault === "malformed") writeFileSync(path, "{}", { mode: 0o600 });
      else if (fault === "tampered-hash") {
        record.createdAt++;
        writeFileSync(path, JSON.stringify(record));
      } else if (fault === "symlink") {
        const target = join(h.hub.paths.stateDir, "authority-symlink-target");
        writeFileSync(target, source, { mode: 0o600 });
        unlinkSync(path);
        symlinkSync(target, path);
      } else if (fault === "permissions") chmodSync(path, 0o644);
      else {
        if (fault === "pid") record.process.pid++;
        if (fault === "starttime") record.process.starttime = String(BigInt(record.process.starttime) + 1n);
        if (fault === "uid") record.process.uid++;
        if (fault === "boot") record.process.bootId = "wrong-current-boot";
        if (fault === "agent-nonce") record.agentNonce = "wrong-agent-nonce";
        if (fault === "namespace") record.namespaces.mnt = "mnt:[wrong]";
        if (fault === "secure-domain") record.domain = "secure";
        if (fault === "not-main") record.main = false;
        if (fault === "inactive") record.active = false;
        const bytes = JSON.stringify(record);
        writeFileSync(path, bytes);
        // Rehash the hostile file on its dedicated response: isolate OS/scope/policy
        // checks, so a digest mismatch cannot mask a missing independent guard.
        h.mapAuthority((ref) => ({
          ...ref,
          sha256: hash(bytes),
          ...(fault === "capability" ? { nonce: "x".repeat(32) } : {}),
        }));
      }
      const rejected = await h.post("prepare", { cols: 80, rows: 24 });
      if (rejected.status === 200)
        await h.post("open", {
          openId: rejected.body.openId,
          createTicket: rejected.body.createTicket,
          cols: 80,
          rows: 24,
          tabId: "hostile-authority",
        });
      expect(rejected.status).not.toBe(200);
      expect(h.backends).toEqual([]);
      expect((await h.journal()).resources).toEqual([]);
      expect(h.receipts().resolvedAcks).toBe(0);
      // Restore only test fixture bytes/mode to let bounded teardown read its own root.
      if (fault === "symlink") unlinkSync(path);
      writeFileSync(path, source, { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    10000,
  );
  it("rechecks a previously accepted authority before open, not just during bootstrap", async () => {
    const h = (await physicalHub())!;
    const prepared = await h.post("prepare", { cols: 80, rows: 24 });
    expect(prepared.status).toBe(200);
    const dir = join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, "authority"),
      path = join(dir, (await readdir(dir))[0]!);
    const source = readFileSync(path, "utf8");
    chmodSync(path, 0o644);
    const rejected = await h.post("open", {
      openId: prepared.body.openId,
      createTicket: prepared.body.createTicket,
      cols: 80,
      rows: 24,
      tabId: "bad-cache",
    });
    expect(rejected.status).not.toBe(200);
    expect(h.backends).toEqual([]);
    expect((await h.journal()).resources).toEqual([]);
    writeFileSync(path, source);
    chmodSync(path, 0o600);
  });
});
describe("receipt falsification — real PTYs gone still cannot release without the exact local witness", () => {
  it.each([
    "missing-reference",
    "missing-file",
    "malformed",
    "tampered-hash",
    "tuple",
    "pid",
    "starttime",
    "uid",
    "capability",
    "symlink",
    "permissions",
  ])(
    "retains both physical reservations and refuses N+1 open after %s",
    async (fault) => {
      const h = (await physicalHub())!;
      const a = (await openPhysical(h)).attachment,
        b = (await openPhysical(h)).attachment;
      const prepared = await h.post("prepare", { cols: 80, rows: 24 });
      expect(prepared.status).toBe(200);
      const touched = new Set<string>();
      h.mapProof((proof) => {
        if (fault === "missing-reference") {
          delete proof.receipt;
          return proof;
        }
        const ref = proof.receipt!;
        const path = join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, "receipts", `${ref.recordId}.json`);
        if (fault === "missing-file") {
          try {
            unlinkSync(path);
          } catch {}
          return proof;
        }
        if (!touched.has(path)) {
          touched.add(path);
          const source = readFileSync(path, "utf8");
          if (fault === "symlink") {
            const target = join(h.hub.paths.stateDir, `receipt-target-${ref.recordId}`);
            writeFileSync(target, source, { mode: 0o600 });
            unlinkSync(path);
            symlinkSync(target, path);
          } else if (fault === "permissions") chmodSync(path, 0o644);
          else if (fault === "malformed") writeFileSync(path, "{}");
          else {
            const record = JSON.parse(source) as TerminalPhysicalReceipt;
            if (fault === "tuple") record.identity.reservationId = "wrong-reservation";
            if (fault === "pid") record.agentProcessIdentity.pid++;
            if (fault === "starttime")
              record.agentProcessIdentity.starttime = String(BigInt(record.agentProcessIdentity.starttime) + 1n);
            if (fault === "uid") record.agentProcessIdentity.uid++;
            if (fault === "tampered-hash") record.physical.waited.push(process.pid);
            writeFileSync(path, JSON.stringify(record));
          }
        }
        if (!["tampered-hash", "symlink", "permissions", "malformed"].includes(fault))
          proof.receipt = {
            ...ref,
            sha256: hash(readFileSync(path, "utf8")),
            ...(fault === "capability" ? { nonce: "x".repeat(32) } : {}),
          };
        return proof;
      });
      expect(
        (await h.post("close", { termId: a.termId, closeId: "bad-receipt-a", expectedRevision: a.revision })).status,
      ).toBe(200);
      expect(
        (await h.post("close", { termId: b.termId, closeId: "bad-receipt-b", expectedRevision: b.revision })).status,
      ).toBe(200);
      await Promise.all(h.backends.map((backend) => backend.done));
      const rejected = await h.post("open", {
        openId: prepared.body.openId,
        createTicket: prepared.body.createTicket,
        cols: 80,
        rows: 24,
        tabId: "third",
      });
      expect(rejected.status).not.toBe(200);
      expect(h.backends).toHaveLength(2);
      expect(h.receipts().resolvedAcks).toBe(0);
      const journal = await h.journal();
      expect(journal.resources).toHaveLength(2);
      expect(journal.resources.every((row) => row.status === "unresolved")).toBe(true);
    },
    20000,
  );
});

describe("causal physical completion during an older inventory commit", () => {
  it("drains a real newer exit revision without extending the original collection budget", async () => {
    const h = (await physicalHub())!;
    const { attachment } = await openPhysical(h);
    let receiptRelease!: () => void,
      receiptEntered = false;
    const receiptGate = new Promise<void>((resolve) => {
      receiptRelease = resolve;
    });
    h.beforeReceiptPublish(() => {
      receiptEntered = true;
      return receiptGate;
    });
    let journalRelease!: () => void,
      journalEntered = false;
    const journalGate = new Promise<void>((resolve) => {
      journalRelease = resolve;
    });
    const root = join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR);
    ioGate.onHandle = (path, handle) => {
      if (path === root && !journalEntered) {
        const realSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await realSync();
          journalEntered = true;
          await journalGate;
        };
      }
    };
    let exitObserved = false;
    ioGate.afterIngress = (raw) => {
      const frame = raw as { t?: string; kind?: string };
      if (frame.t === "term_event" && frame.kind === "exit") exitObserved = true;
    };
    const closing = h.post("close", {
      termId: attachment.termId,
      closeId: "causal-close",
      expectedRevision: attachment.revision,
    });
    try {
      await waitUntil(() => receiptEntered && journalEntered, 1500, "real prior inventory fsync barrier");
      expect(h.receipts().resolvedAcks).toBe(0);
      receiptRelease();
      await h.backends[0]!.done;
      await waitUntil(() => exitObserved, 1000, "verified exit consumed before old fsync finishes");
      journalRelease();
      expect((await closing).status).toBe(200);
      await waitUntil(() => h.receipts().resolvedAcks === 1, 4000, "new revision drains after stale inventory");
      expect((await h.journal()).resources).toEqual([]);
    } finally {
      receiptRelease();
      journalRelease();
      ioGate.onHandle = undefined;
      ioGate.afterIngress = undefined;
    }
  }, 10000);
});

describe("authority compatibility and loaded-journal loss", () => {
  it("old private challenge has no new query/grant/open and leaves legacy challenge bytes unchanged", async () => {
    const h = (await physicalHub())!;
    h.legacyChallenge();
    const receive = vi.spyOn(h.owner(), "receive");
    const rejected = await h.post("prepare", { cols: 80, rows: 24 });
    expect(rejected.status).not.toBe(200);
    expect(h.backends).toEqual([]);
    expect(receive.mock.calls.some(([frame]) => (frame as { op?: string }).op === "authority")).toBe(false);
    expect(
      receive.mock.calls.some(([frame]) =>
        ["protocol_ready", "bind", "open"].includes(String((frame as { op?: string }).op)),
      ),
    ).toBe(false);
  });
  it("loss of an already-loaded revision-zero journal cannot silently recreate it before open", async () => {
    const h = (await physicalHub())!;
    const prepared = await h.post("prepare", { cols: 80, rows: 24 });
    expect(prepared.status).toBe(200);
    const path = join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, TERMINAL_JOURNAL_FILE);
    unlinkSync(path);
    const rejected = await h.post("open", {
      openId: prepared.body.openId,
      createTicket: prepared.body.createTicket,
      cols: 80,
      rows: 24,
      tabId: "missing-loaded",
    });
    expect(rejected.status).not.toBe(200);
    expect(h.backends).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
});

describe("local guarded-owner revocation", () => {
  it("revokes its record synchronously, rejects the first request and clears the original UI connection", async () => {
    const h = (await physicalHub())!;
    await openPhysical(h);
    const directory = join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, "authority");
    expect(await readdir(directory)).toHaveLength(1);
    h.revokeLocalGuard();
    expect(readdirSync(directory)).toEqual([]);
    const rejected = await h.post("prepare", { cols: 80, rows: 24 });
    expect(rejected.status).not.toBe(200);
    expect(h.backends).toHaveLength(1);
    await h.sse.waitEnd();
    expect((await h.backends[0]!.done).outcome).toBe("reaped");
    expect(h.receipts().resolvedAcks).toBe(0); // no valid current owner to authorize collection
    expect((await h.journal()).resources.every((r) => r.status === "unresolved")).toBe(true);
  });
});

describe("durable consumption and cold hub restart", () => {
  it("normal last close is pruned before ACK, so three cold restarts do not permanently occupy quota", async () => {
    const h = (await physicalHub())!;
    for (let round = 0; round < 3; round++) {
      const { attachment } = await openPhysical(h);
      expect(
        (
          await h.post("close", {
            termId: attachment.termId,
            closeId: `normal-cold-${round}`,
            expectedRevision: attachment.revision,
          })
        ).status,
      ).toBe(200);
      await waitUntil(() => h.receipts().resolvedAcks === round + 1, 5000, "consumed receipt ACK");
      expect((await h.journal()).resources).toEqual([]);
      expect(await readdir(join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, "receipts"))).toEqual([]);
      const revision = (await h.journal()).revision;
      await h.restart();
      expect((await h.journal()).resources).toEqual([]);
      expect((await h.journal()).revision).toBe(revision); // cold load did not re-quarantine consumed rows
      expect((await h.post("prepare", { cols: 80, rows: 24 })).status).toBe(200);
    }
  }, 30000);
  it.each(["resolved-before-prune", "pruned-before-ack"])(
    "recovers real durable %s crash window only through fresh proof and prune",
    async (window) => {
      const h = (await physicalHub())!;
      const { attachment } = await openPhysical(h);
      const root = join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR),
        journal = join(root, TERMINAL_JOURNAL_FILE);
      let resume!: () => void,
        entered = false;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      ioGate.onHandle = (path, handle) => {
        if (path !== root || entered) return;
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync(); // REAL file/parent fsync has completed; only its return is held
          const disk = JSON.parse(readFileSync(journal, "utf8")) as TerminalJournal;
          const match =
            window === "resolved-before-prune"
              ? disk.resources.some(
                  (row) => row.status === "resolved" && row.entry.identity.termId === attachment.termId,
                )
              : disk.resources.length === 0;
          if (!entered && match) {
            entered = true;
            await gate;
          }
        };
      };
      const pending = h
        .post("close", { termId: attachment.termId, closeId: `crash-${window}`, expectedRevision: attachment.revision })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      try {
        await waitUntil(() => entered, 1500, "real durable crash boundary");
        expect(h.receipts().resolvedAcks).toBe(0);
        expect(await readdir(join(root, "receipts"))).toHaveLength(1);
        if (window === "resolved-before-prune") expect((await h.journal()).resources[0]?.status).toBe("resolved");
        else expect((await h.journal()).resources).toEqual([]);
        ioGate.onHandle = undefined;
        await h.restart(); // drops old pending/controller/channel state; same REAL store is cold-loaded
        await pending;
        const recovered = await h.journal();
        expect(recovered.resources).toHaveLength(1);
        expect(recovered.resources[0]?.status).toBe("unresolved");
        expect(recovered.resources[0]?.entry.identity.termId).toBe(attachment.termId);
        expect(h.receipts().resolvedAcks).toBe(0);
        expect((await h.post("prepare", { cols: 80, rows: 24 })).status).toBe(200);
        await waitUntil(() => h.receipts().resolvedAcks === 1, 5000, "fresh challenge consumes old receipt");
        expect((await h.journal()).resources).toEqual([]);
        expect(await readdir(join(root, "receipts"))).toEqual([]);
        expect(h.owner().resourceEntries()).toEqual([]);
        // More than the quota count remains possible after either crash boundary.
        for (let round = 0; round < 3; round++) {
          const { attachment: a } = await openPhysical(h);
          expect(
            (await h.post("close", { termId: a.termId, closeId: `after-crash-${round}`, expectedRevision: a.revision }))
              .status,
          ).toBe(200);
          await waitUntil(() => h.receipts().resolvedAcks === round + 2, 5000);
        }
      } finally {
        resume();
        ioGate.onHandle = undefined;
      }
    },
    30000,
  );
  it("forged consumed declarations/ACK without the current proved snapshot never delete a retained receipt", async () => {
    const h = (await physicalHub())!;
    const { attachment } = await openPhysical(h);
    h.mapProof((proof) => {
      delete proof.receipt;
      return proof;
    }); // physical witness retained, H cannot resolve/prune
    await h.post("close", {
      termId: attachment.termId,
      closeId: "keep-for-forgery",
      expectedRevision: attachment.revision,
    });
    await h.backends[0]!.done;
    const before = h.owner().resourceEntries();
    expect(before).toHaveLength(1);
    const files = await readdir(join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, "receipts"));
    expect(files).toHaveLength(1);
    await waitUntil(() => h.provedEnd() !== undefined, 1000, "real proof-bearing snapshot");
    const end = h.provedEnd()!;
    const scope = {
      t: "term_req",
      v: 1,
      rid: "forged-consumed",
      sessionId: end.sessionId,
      epoch: end.epoch,
      ownerInstance: end.ownerInstance,
      channelId: end.channelId,
    };
    expect(h.owner().receive({ ...scope, op: "consumed", identities: before.map((r) => r.identity) })).toBe(false);
    // The REAL live channel, inventory id/revision/boot/link and identities all match.
    // Only the challenge is forged: this must reach and fail terminalResolvedAckMatches.
    expect(
      h.owner().receive({
        ...scope,
        op: "resolved_ack",
        resolved: {
          hubBootId: end.page.hubBootId,
          challengeId: "forged-challenge",
          linkGen: end.page.linkGen,
          inventoryId: end.page.inventoryId,
          revision: end.page.revision,
          journalRevision: 99999,
          identities: before.map((r) => r.identity),
        },
      }),
    ).toBe(false);
    expect(h.owner().resourceEntries()).toEqual(before);
    expect(await readdir(join(h.hub.paths.stateDir, TERMINAL_LOCAL_DIR, "receipts"))).toEqual(files);
    expect(h.receipts().resolvedAcks).toBe(0);
    expect((await h.journal()).resources[0]?.status).toBe("unresolved");
    h.mapProof(undefined);
    const retry = await h.post("prepare", { cols: 80, rows: 24 });
    expect(retry.status).toBe(200);
    await waitUntil(() => h.receipts().resolvedAcks === 1, 5000);
  }, 15000);
});
