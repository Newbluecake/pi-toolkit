/** Real dual listener auth/HTTP/SSE, real socket/ingress + production ready gate.
 * The dedicated peer's terminal operations are bounded agent-port fixtures, NOT a PTY.
 * Actual forkpty/reaper/renderer are separate P1-A/P2/P3 gates. */
import net from "node:net";
import { auditTerminal } from "../../src/web-hub/hub/audit.js";
import { createAdminHandler } from "../../src/web-hub/hub/admin.js";
import type { Auth } from "../../src/web-hub/hub/auth.js";
import { request as httpRequest } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createRegistry } from "../../src/web-hub/hub/registry.js";
import { createAgentServer } from "../../src/web-hub/hub/agent-server.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createHostsPort } from "../../src/web-hub/hub/net-hosts.js";
import { createScope } from "../../src/web-hub/hub/lifecycle.js";
import { createLoginLimiter } from "../../src/web-hub/hub/ratelimit.js";
import { createKdfAdmission } from "../../src/web-hub/hub/kdf-admission.js";
import { createClientAllowGuard } from "../../src/web-hub/hub/client-allow.js";
import { createPrivacyStore } from "../../src/web-hub/hub/privacy/store.js";
import { createTerminalNegotiator } from "../../src/web-hub/agent/commands.js";
import { createTerminalService } from "../../src/web-hub/hub/terminal/service.js";
import { createTerminalRoutes } from "../../src/web-hub/hub/terminal/routes.js";
import { createTerminalResourceJournal } from "../../src/web-hub/hub/terminal/resource-fence-journal.js";
import {
  TerminalResourceFence,
  createLocalTerminalProofVerifier,
  inventoryDigest,
} from "../../src/web-hub/hub/terminal/resource-fence.js";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import type { CmdFrame } from "../../src/web-hub/protocol/messages.js";
import {
  terminalResolvedAckMatches,
  TERMINAL_LIMITS as L,
  type TerminalReapProof,
  type TerminalProtocolReadyProof,
  type TerminalResolvedAckAuthority,
  type TermReq,
  type TerminalNegotiation,
} from "../../src/web-hub/protocol/terminal.js";
import type { TerminalHttpRequests } from "../../src/web-hub/protocol/terminal.js";
import { fakeKdf, fakeLanStore } from "../web-hub/contract/fakes.js";
import { fakeDeps, makeTmp, login, openSse, postJson, rawRequest, type SseConn } from "../web-hub/http/helpers.js";
import { lanPostJson, seedLanUser, TEST_KDF_POLICY } from "../web-hub/http/lan-helpers.js";
import { hello, connectClient, waitFor, memLog } from "../web-hub/hub/helpers.js";
import { freePort } from "../helpers/free-port.js";
const live: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of live.splice(0)) await close();
});
const config = {
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  inputIdleMs: L.inputIdleMs,
  maxLifetimeMs: L.maxLifetimeMs,
};
async function harness(realClock = false) {
  const tmp = makeTmp("th-");
  let now = realClock ? Date.now() : 1_700_000_000_000;
  const clock = () => (realClock ? Date.now() : now),
    log = memLog(),
    registry = createRegistry({ now: clock, log, pidAlive: () => true });
  const deps = fakeDeps(tmp.dir);
  deps.now = clock;
  deps.registry = registry;
  deps.bus = registry.bus;
  await mkdir(deps.paths.stateDir, { mode: 0o700 });
  const privacyListeners = new Set<() => void>();
  const privacy = createPrivacyStore({
    stateDir: deps.paths.stateDir,
    onChange: () => {
      for (const fn of privacyListeners) fn();
    },
  });
  await privacy.load();
  let journalFailure = false;
  const receipts = new Set<string>();
  const journalBase = createTerminalResourceJournal({
    stateDir: deps.paths.stateDir,
    now: clock,
    trustedNew: async () => true,
  });
  const journal = {
    load: journalBase.load,
    commit: (...args: Parameters<typeof journalBase.commit>) =>
      journalFailure ? Promise.resolve("unavailable" as const) : journalBase.commit(...args),
  };
  const fence = new TerminalResourceFence({
    journal,
    now: clock,
    verifyProof: createLocalTerminalProofVerifier({ receipt: (p) => receipts.has(JSON.stringify(p)) }),
  });
  await fence.initialize(new AbortController().signal);
  let agentKey = "",
    allowed = true,
    opens = 0,
    inputs = 0,
    revision = 1,
    holdOpen = false,
    holdAttach = false,
    holdInput = false,
    holdClose = false,
    holdRenew = false,
    pendingBytes = 0;
  const held: Array<() => void> = [],
    frames: TermReq[] = [];
  const processIdentity = { bootId: "linux-test-boot", pid: 4242, starttime: "100", uid: process.getuid!() };
  const service = createTerminalService({
    config,
    audit: (record) => auditTerminal(log, record),
    now: clock,
    resourceFence: fence,
    target: (key) =>
      key === agentKey
        ? {
            meta: { agentKey, linkGen: registry.getLinkGen(agentKey)!, sessionId: "session", epoch: "epoch-1" },
            processIdentity,
            allowed,
          }
        : undefined,
    send: (meta, frame) => registry.send(meta.agentKey, frame),
    pendingBytes: () => pendingBytes,
    privacy: {
      denied: (s) => privacy.degraded || privacy.isLocked(s),
      onChange: (fn) => {
        privacyListeners.add(fn);
        return () => {
          privacyListeners.delete(fn);
        };
      },
    },
  });
  const routes = createTerminalRoutes({ service, now: clock, log });
  deps.terminal = routes;
  const scope = createScope({ now: clock, log }),
    store = fakeLanStore(),
    limiter = createLoginLimiter({ now: clock });
  deps.lan = {
    cfg: { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    store,
    kdf: fakeKdf(),
    limiter,
    admission: createKdfAdmission({ now: clock, isTightened: limiter.isTightened }),
    hosts: createHostsPort(),
    scope,
    onStatus: () => {},
    clientAllow: createClientAllowGuard({}),
    kdfPolicy: TEST_KDF_POLICY,
  };
  const fe = createHttpFrontend(deps),
    port = (await fe.listen()).port,
    status = await fe.lan!.start();
  if (status.state !== "on") throw Error("LAN did not start");
  const ports = [port, status.port];
  const cookies = [await login(port, deps.paths.tokenFile), ""];
  seedLanUser(store, { username: "alice", password: "terminal-owned-test-password" });
  async function loginLan() {
    const r = await lanPostJson(ports[1]!, "/api/login", {
      username: "alice",
      password: "terminal-owned-test-password",
    });
    expect(r.status).toBe(200);
    return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  }
  cookies[1] = await loginLan();
  const server = net.createServer();
  const sock = join(tmp.dir, "agent.sock");
  await new Promise<void>((r) => server.listen(sock, r));
  const as = createAgentServer(server, {
    registry,
    config: deps.config,
    log,
    now: clock,
    httpPort: () => port,
    terminal: service.ingress,
  });
  const client = await connectClient(sock);
  client.send(hello({ caps: ["cmd.v1", "command.v1"] }));
  const ack = await client.waitFrame((f) => f.t === "hello_ack");
  agentKey = String(ack.agentKey);
  client.send({ t: "session", sessionId: "session", cwd: "/tmp/work", reason: "startup", leafId: null, mode: "tui" });
  await waitFor(() => registry.get(agentKey)?.session?.sessionId === "session");
  const privateChannels = new Map<string, TerminalProtocolReadyProof>(),
    ackAuthorities = new Map<string, TerminalResolvedAckAuthority>(),
    forgotten: string[] = [];
  const negotiator = createTerminalNegotiator({
    now: clock,
    current: () => ({
      localConnectionInstance: "conn-1",
      sessionId: "session",
      epoch: "epoch-1",
      ownerInstance: "owner",
    }),
    allowed: () => allowed,
    limits: config,
    send: (f) => client.send(f),
    onBound: (channelId, proof) => privateChannels.set(channelId, proof),
  });
  const terms = new Map<
    string,
    {
      request: Extract<TermReq, { op: "open" }>;
      attachmentId: string;
      writerLease: string;
      nextInputSeq: number;
      closed?: boolean;
    }
  >();
  const decoder = new NdjsonDecoder({
    onFrame: (raw) => {
      const f = raw as CmdFrame | TermReq;
      if (f.t === "cmd" && f.cmd.op === "command") {
        const request = JSON.parse(f.cmd.args.slice("__terminal ".length)) as TerminalNegotiation;
        const offer = negotiator.offer(f, request);
        client.send({
          t: "cmd_result",
          rid: f.rid,
          id: f.id,
          ok: true,
          data: { op: "command", kind: "builtin", completion: "sync", history: "none", terminal: offer },
        });
        return;
      }
      if (f.t !== "term_req") return;
      frames.push(f);
      if (["prepare_protocol", "protocol_ready", "bind"].includes(f.op)) {
        negotiator.receive(f);
        return;
      }
      const send = (extra: object) =>
        client.send({
          t: "term_res",
          v: 1,
          rid: f.rid,
          sessionId: "session",
          epoch: "epoch-1",
          ownerInstance: "owner",
          ...("channelId" in f ? { channelId: f.channelId } : {}),
          op: f.op,
          ok: true,
          ...extra,
        });
      if (f.op === "resolved_ack") {
        const authority = ackAuthorities.get(f.channelId);
        if (authority && terminalResolvedAckMatches(f, { ...authority, now: clock() })) {
          for (const identity of f.resolved.identities) {
            forgotten.push(identity.reservationId);
          }
          ackAuthorities.set(f.channelId, {
            ...authority,
            receipts: authority.receipts.filter(
              (i) => !f.resolved.identities.some((j) => j.reservationId === i.reservationId),
            ),
            lastJournalRevision: f.resolved.journalRevision,
          });
        }
        return;
      }
      if (f.op === "inventory") {
        const channel = privateChannels.get(f.channelId);
        if (channel?.mode !== "resource-only") throw Error("inventory without ready resource-only channel");
        const entries = fence
          .records()
          .resources.filter((r) => r.status === "unresolved")
          .map((r) => r.entry);
        const evidence = {
          hubBootId: f.challenge.hubBootId,
          challengeId: f.challenge.challengeId,
          linkGen: f.challenge.linkGen,
          inventoryId: `inventory-${f.rid}`,
          revision: 7,
        };
        const proofs: TerminalReapProof[] = entries
          .filter((e) => terms.get(e.identity.termId)?.closed)
          .map((e) => ({
            ...evidence,
            identity: e.identity,
            agentProcessIdentity: e.agentProcessIdentity,
            proofId: `proof-${e.identity.termId}`,
            spawnSettled: true,
            ptyClosed: true,
            helperReaped: true,
            managedGroupsGone: true,
            identitiesChecked: e.managed,
            outcome: "reaped",
          }));
        for (const proof of proofs) receipts.add(JSON.stringify(proof));
        ackAuthorities.set(f.channelId, {
          live: true,
          current: {
            localConnectionInstance: "conn-1",
            sessionId: "session",
            epoch: "epoch-1",
            ownerInstance: "owner",
          },
          channel: { ...channel, channelId: f.channelId },
          challenge: f.challenge,
          inventoryId: evidence.inventoryId,
          revision: evidence.revision,
          lastJournalRevision: 0,
          receipts: proofs.map((p) => p.identity),
          now: clock(),
        });
        const digest = inventoryDigest(entries);
        send({
          page: {
            ...evidence,
            phase: "begin",
            sender: { agentSessionId: "session", epoch: "epoch-1", ownerInstance: "owner", processIdentity },
            totalCount: entries.length,
            chunkCount: 1,
            digest,
          },
        });
        send({ page: { ...evidence, phase: "chunk", chunkIndex: 0, entries, proofs } });
        send({
          page: { ...evidence, phase: "end", totalCount: entries.length, chunkCount: 1, digest, complete: true },
        });
        return;
      }
      const fact = (r: typeof terms extends Map<string, infer T> ? T : never) => ({
        termId: r.request.termId,
        reservationId: r.request.reservationId,
        revision,
        state: "live",
        nextInputSeq: r.nextInputSeq,
        baseOffset: 0,
        nextOffset: 0,
        deadlines: {
          inputIdleAt: now + L.inputIdleMs,
          lifetimeAt: now + L.maxLifetimeMs,
          parentExpiresAt: now + L.maxLifetimeMs,
        },
        attachmentId: r.attachmentId,
        writerLease: r.writerLease,
        replayMode: "cold",
        shellName: "bash",
        userLabel: "fixture-user",
        hostLabel: "fixture-host",
        cwd: "/owned/initial-cwd",
        sessionOrdinal: 999,
        createdAt: 1,
        writerPresent: false,
        ownerLabel: "forged-agent-owner",
      });
      if (f.op === "open") {
        opens++;
        const t = { request: f, attachmentId: f.attachmentId, writerLease: f.writerLease, nextInputSeq: 0 };
        terms.set(f.termId, t);
        const respond = () => {
          send(fact(t));
          client.send({
            t: "term_event",
            v: 1,
            sessionId: "session",
            epoch: "epoch-1",
            ownerInstance: "owner",
            channelId: f.channelId,
            termId: f.termId,
            revision,
            kind: "cutover",
            attemptId: "attempt",
            newLiveEpoch: "live-epoch",
            replayEnd: 0,
            liveFrom: 0,
            gap: { from: 0, to: 0 },
            resetParser: true,
          });
        };
        if (holdOpen) held.push(respond);
        else respond();
        return;
      }
      if (f.op === "attach") {
        const t = terms.get(f.termId)!;
        t.attachmentId = f.attachmentId;
        t.writerLease = f.writerLease;
        const respond = () => send(fact(t));
        if (holdAttach) held.push(respond);
        else respond();
        return;
      }
      if (f.op === "input") {
        inputs++;
        const t = terms.get(f.termId)!;
        t.nextInputSeq = f.inputSeq + 1;
        const respond = () => send({ acceptedThrough: f.inputSeq });
        if (holdInput) held.push(respond);
        else respond();
        return;
      }
      if (f.op === "close") {
        const term = terms.get(f.termId);
        if (term) term.closed = true;
        const respond = () => send({ state: "closing", revision: ++revision });
        if (holdClose) held.push(respond);
        else respond();
        return;
      }
      if (f.op === "renew" && holdRenew) {
        held.push(() => send({ revision: ++revision }));
        return;
      }
      send({ revision: ++revision });
    },
    onError: () => {},
  });
  client.sock.on("data", (c) => decoder.push(c));
  let barrierSeq = 0;
  const streams: SseConn[] = [];
  async function connection(i: number, cookie = cookies[i]!, lastEventId?: number) {
    const s = await openSse(ports[i]!, { cookie, ...(lastEventId === undefined ? {} : { lastEventId }) });
    streams.push(s);
    const h = await s.waitFor((e) => e.event === "hello"),
      c = await s.waitFor((e) => e.event === "terminal_connection");
    return {
      stream: s,
      identity: {
        clientId: String(h.data.clientId),
        connectionInstance: String(c.data.connectionInstance),
        connectionToken: String(c.data.connectionToken),
      },
    };
  }
  const post = async (i: number, op: keyof TerminalHttpRequests, fields: object, cookie = cookies[i]!) => {
    const r = await postJson(
      ports[i]!,
      `/api/terminal/${op}`,
      { agentKey, expect: { sessionId: "session", epoch: "epoch-1" }, ...fields },
      { Cookie: cookie, Origin: `http://127.0.0.1:${ports[i]}` },
    );
    return { ...r, json: JSON.parse(r.body) };
  };
  live.push(async () => {
    for (const s of streams) s.close();
    negotiator.dispose();
    client.sock.destroy();
    await as.close();
    await new Promise<void>((r) => server.close(() => r()));
    await fe.close();
    await scope.dispose();
    await privacy.close();
    tmp.cleanup();
  });
  return {
    service,
    routes,
    fence,
    privacy,
    store,
    ports,
    fe,
    tmp,
    setPending: (n: number) => {
      pendingBytes = n;
    },
    cookies,
    connection,
    post,
    frames,
    held,
    loginLan,
    log,
    client,
    agentKey,
    processIdentity,
    forgotten,
    setJournalFailure: (v: boolean) => {
      journalFailure = v;
    },
    setTime: (n: number) => {
      now = n;
    },
    getTime: clock,
    setAllowed: (v: boolean) => {
      allowed = v;
    },
    hold: (kind: "open" | "attach" | "input" | "close" | "renew", v: boolean) => {
      if (kind === "open") holdOpen = v;
      else if (kind === "attach") holdAttach = v;
      else if (kind === "input") holdInput = v;
      else if (kind === "close") holdClose = v;
      else holdRenew = v;
    },
    counts: () => ({ opens, inputs }),
    barrier: async () => {
      const ts = ++barrierSeq;
      client.send({ t: "ping", ts });
      await client.waitFrame((f) => f.t === "pong" && f.ts === ts);
    },
    async prepare(i: number, c: { identity: object }) {
      const r = await post(i, "prepare", { ...c.identity, cols: 80, rows: 24 });
      expect(r.status, r.body).toBe(200);
      return r.json;
    },
    async opened(i: number, c: { identity: object; stream: SseConn }) {
      const t = await this.prepare(i, c);
      const r = await post(i, "open", { ...c.identity, ...t, ok: undefined, tabId: "tab", cols: 80, rows: 24 });
      expect(r.status, r.body).toBe(200);
      await c.stream.waitFor((e) => e.event === "terminal" && e.data.event.kind === "cutover");
      return r.json;
    },
  };
}

describe("T-REV/T-SSE/T-ID/T-BIND dual listener terminal (§3/4)", () => {
  it.each([0, 1])(
    "listener %i real login + native SSE without Origin/metadata + dedicated ready/bind/open",
    async (i) => {
      const h = await harness(),
        c = await h.connection(i),
        opened = await h.opened(i, c);
      expect(h.frames.map((f) => f.op).slice(0, 4)).toEqual(["prepare_protocol", "protocol_ready", "bind", "open"]);
      expect(opened).toMatchObject({
        sessionOrdinal: 1,
        createdAt: h.getTime(),
        ownerLabel: "本登录",
        writerPresent: true,
        shellName: "bash",
        userLabel: "fixture-user",
        hostLabel: "fixture-host",
        cwd: "/owned/initial-cwd",
      });
      const list = await h.post(i, "list", c.identity);
      expect(list.status).toBe(200);
      expect(list.json.rows[0]).toMatchObject({
        sessionOrdinal: 1,
        createdAt: opened.createdAt,
        writerPresent: true,
        ownerLabel: "本登录",
      });
      for (const k of ["cwd", "shellName", "userLabel", "hostLabel", "writerLease"])
        expect(list.json.rows[0]).not.toHaveProperty(k);
      const state = await h.post(i, "state", { ...c.identity, target: { termId: opened.termId } });
      expect(state.json.fact).not.toHaveProperty("cwd");
      const input = await h.post(i, "input", {
        ...c.identity,
        termId: opened.termId,
        attachmentId: opened.attachmentId,
        writerLease: opened.writerLease,
        inputSeq: 0,
        bytesB64: Buffer.from("secret-input-marker").toString("base64"),
        inputKind: "user",
        streamEpoch: "live-epoch",
      });
      expect(input.json).toEqual({ ok: true, acceptedThrough: 0 });
      expect(h.counts()).toEqual({ opens: 1, inputs: 1 });
      const privateEvents = c.stream.events.filter((e) => e.event.startsWith("terminal"));
      expect(privateEvents.every((e) => e.id === undefined)).toBe(true);
      expect(JSON.stringify(h.log.lines)).not.toMatch(
        /secret-input-marker|forged-agent-owner|owned\/initial-cwd|writerLease|connectionToken/,
      );
    },
    15000,
  );
  it("strict missing/null/cross Origin, forged SSE token/instance/clientId and cross-listener identities never spawn", async () => {
    const h = await harness(),
      c = await h.connection(0);
    for (const origin of [undefined, "null", "http://evil.invalid"]) {
      const r = await rawRequest(h.ports[0]!, {
        method: "POST",
        path: "/api/terminal/prepare",
        headers: {
          Cookie: h.cookies[0]!,
          "Content-Type": "application/json",
          "X-PWH": "1",
          ...(origin === undefined ? {} : { Origin: origin }),
        },
        body: JSON.stringify({
          ...c.identity,
          agentKey: h.agentKey,
          expect: { sessionId: "session", epoch: "epoch-1" },
          cols: 80,
          rows: 24,
        }),
      });
      expect(r.status).toBe(403);
    }
    for (const changed of [
      { ...c.identity, connectionToken: "wrong" },
      { ...c.identity, connectionInstance: "wrong" },
      { ...c.identity, clientId: "wrong" },
    ])
      expect((await h.post(0, "prepare", { ...changed, cols: 80, rows: 24 })).json.code).toBe("E_AUTH");
    expect((await h.post(1, "prepare", { ...c.identity, cols: 80, rows: 24 })).json.code).toBe("E_AUTH");
    expect(h.counts().opens).toBe(0);
  });
  it("new same-user sid cannot borrow old SSE; reconnect invalidates original token; parent expiry never slides", async () => {
    const h = await harness(),
      c = await h.connection(1),
      newCookie = await h.loginLan();
    expect((await h.post(1, "list", c.identity, newCookie)).json.code).toBe("E_AUTH");
    c.stream.close();
    await h.barrier();
    const next = await h.connection(1);
    expect(next.identity.connectionInstance).not.toBe(c.identity.connectionInstance);
    expect((await h.post(1, "list", c.identity)).json.code).toBe("E_AUTH");
    expect((await h.post(1, "list", next.identity)).status).toBe(200);
    h.setTime(h.getTime() + 12 * 60 * 60 * 1000 + 1);
    expect((await h.post(1, "list", next.identity)).status).not.toBe(200);
  });
  it("concurrent same ticket opens once, hub writer CAS across two real sockets, refresh must attach not re-open", async () => {
    const h = await harness(),
      c = await h.connection(0),
      ticket = await h.prepare(0, c);
    h.hold("open", true);
    const fields = {
      ...c.identity,
      openId: ticket.openId,
      createTicket: ticket.createTicket,
      cols: 80,
      rows: 24,
      tabId: "tab",
    };
    const p = h.post(0, "open", fields),
      p2 = h.post(0, "open", fields);
    await waitFor(() => h.counts().opens === 1);
    h.held.splice(0).forEach((f) => f());
    const [a, b] = await Promise.all([p, p2]);
    expect(a.json.termId).toBe(b.json.termId);
    expect(h.counts().opens).toBe(1);
    const d = await h.connection(0);
    expect(
      (
        await h.post(0, "attach", {
          ...d.identity,
          termId: a.json.termId,
          attachId: "attach2",
          tabId: "tab2",
          cols: 80,
          rows: 24,
        })
      ).json.code,
    ).toBe("E_WRITER_BUSY");
    expect(
      (
        await h.post(0, "detach", {
          ...c.identity,
          termId: a.json.termId,
          attachmentId: a.json.attachmentId,
          writerLease: a.json.writerLease,
        })
      ).status,
    ).toBe(200);
    h.hold("attach", true);
    const attachFields = {
      ...d.identity,
      termId: a.json.termId,
      attachId: "attach3",
      tabId: "tab2",
      cols: 80,
      rows: 24,
    };
    const x = h.post(0, "attach", attachFields),
      y = h.post(0, "attach", attachFields);
    await waitFor(() => h.held.length === 1);
    h.held.splice(0).forEach((f) => f());
    const pair = await Promise.all([x, y]);
    expect(pair.filter((r) => r.status === 200)).toHaveLength(1);
    expect(pair.filter((r) => r.json.code === "E_WRITER_BUSY")).toHaveLength(1);
    expect(
      (
        await h.post(0, "input", {
          ...c.identity,
          termId: a.json.termId,
          attachmentId: a.json.attachmentId,
          writerLease: a.json.writerLease,
          inputSeq: 0,
          bytesB64: "YQ==",
          inputKind: "user",
          streamEpoch: "live-epoch",
        })
      ).json.code,
    ).toBe("E_LEASE_EXPIRED");
  });
  it("first logout emit denies concurrent open/input and delayed successful auth before paused DB delete resolves", async () => {
    const h = await harness(),
      c = await h.connection(1),
      opened = await h.opened(1, c),
      before = h.counts();
    const originalDelete = h.store.deleteSession.bind(h.store);
    let resume!: () => void;
    const entered = vi.fn();
    h.store.deleteSession = async (hash) => {
      entered();
      await new Promise<void>((r) => (resume = r));
      await originalDelete(hash);
    };
    const originalTouch = h.store.touchSession.bind(h.store);
    let releaseAuth!: () => void;
    const authEntered = vi.fn();
    let holdAuth = true;
    h.store.touchSession = async (...args) => {
      const result = await originalTouch(...args);
      if (holdAuth) {
        holdAuth = false;
        authEntered();
        await new Promise<void>((r) => (releaseAuth = r));
      }
      return result;
    };
    const delayedInput = h.post(1, "input", {
      ...c.identity,
      termId: opened.termId,
      attachmentId: opened.attachmentId,
      writerLease: opened.writerLease,
      inputSeq: 0,
      bytesB64: "YQ==",
      inputKind: "user",
      streamEpoch: "live-epoch",
    });
    await waitFor(() => authEntered.mock.calls.length === 1);
    const logout = lanPostJson(h.ports[1]!, "/api/logout", {}, { Cookie: h.cookies[1]! });
    await waitFor(() => entered.mock.calls.length === 1);
    releaseAuth();
    expect((await delayedInput).json.code).toBe("E_AUTH_REVOKING");
    const payload = {
      ...c.identity,
      termId: opened.termId,
      attachmentId: opened.attachmentId,
      writerLease: opened.writerLease,
      inputSeq: 0,
      bytesB64: "YQ==",
      inputKind: "user",
      streamEpoch: "live-epoch",
    };
    expect((await h.post(1, "input", payload)).json.code).toBe("E_AUTH_REVOKING");
    expect((await h.post(1, "prepare", { ...c.identity, cols: 80, rows: 24 })).json.code).toBe("E_AUTH_REVOKING");
    expect(h.counts()).toEqual(before);
    expect(h.frames.at(-1)?.op).toBe("close");
    resume();
    await logout;
  });
  it("privacy real store onChange and trusted secure guard suppress operations/output and erase panel metadata", async () => {
    const h = await harness(),
      c = await h.connection(0),
      opened = await h.opened(0, c);
    await h.privacy.setLocked("session", true);
    const no = await h.post(0, "list", c.identity);
    expect(no.json.code).toBe("E_PRIVACY_LOCKED");
    for (const k of [
      "sessionOrdinal",
      "createdAt",
      "writerPresent",
      "ownerLabel",
      "shellName",
      "userLabel",
      "hostLabel",
      "cwd",
    ])
      expect(no.json).not.toHaveProperty(k);
    await h.privacy.setLocked("session", false);
    const list = await h.post(0, "list", c.identity);
    expect(list.json.rows[0]).not.toHaveProperty("sessionOrdinal");
    expect(list.json.rows[0]).not.toHaveProperty("ownerLabel");
    h.setAllowed(false);
    expect((await h.post(0, "state", { ...c.identity, target: { termId: opened.termId } })).status).not.toBe(200);
  });
  it("output is private, no ring replay/forged channel output, first revoke is zero new enqueue", async () => {
    const h = await harness(),
      owner = await h.connection(0),
      opened = await h.opened(0, owner),
      other = await h.connection(0);
    await h.post(0, "list", other.identity);
    const f = h.frames.find((f) => f.op === "open") as Extract<TermReq, { op: "open" }>;
    const output = (offset: number, text: string, channelId = f.channelId) => ({
      t: "term_event",
      v: 1,
      sessionId: "session",
      epoch: "epoch-1",
      ownerInstance: "owner",
      channelId,
      termId: opened.termId,
      revision: 1,
      kind: "output",
      offset,
      bytesB64: Buffer.from(text).toString("base64"),
      streamEpoch: "live-epoch",
    });
    h.client.send(output(0, "forged-output-marker", "wrong-channel"));
    h.client.send(output(0, "private-output-marker"));
    await owner.stream.waitFor((e) => e.event === "terminal" && e.data.event.kind === "output");
    await h.barrier();
    expect(other.stream.events.filter((e) => e.event === "terminal")).toEqual([]);
    const replay = await h.connection(0, h.cookies[0], 0);
    expect(replay.stream.events.filter((e) => e.event === "terminal")).toEqual([]);
    expect(JSON.stringify(owner.stream.events)).not.toContain(Buffer.from("forged-output-marker").toString("base64"));
    const count = owner.stream.events.filter((e) => e.event === "terminal").length;
    h.service.auth.revoke("all");
    h.client.send(output(21, "after-revoke-marker"));
    await h.barrier();
    expect(owner.stream.events.filter((e) => e.event === "terminal")).toHaveLength(count);
    expect(h.service.limits.queuedBytes()).toBe(0);
  });
  it("noACK/slow viewer detaches at bounded window, control close still works; UDS pending denies input", async () => {
    const h = await harness(),
      c = await h.connection(0),
      opened = await h.opened(0, c),
      f = h.frames.find((f) => f.op === "open") as Extract<TermReq, { op: "open" }>;
    const input = {
      ...c.identity,
      termId: opened.termId,
      attachmentId: opened.attachmentId,
      writerLease: opened.writerLease,
      inputSeq: 0,
      bytesB64: "YQ==",
      inputKind: "user",
      streamEpoch: "live-epoch",
    };
    h.setPending(L.udsPendingBytes);
    expect((await h.post(0, "input", input)).json.code).toBe("E_RATE");
    expect(h.counts().inputs).toBe(0);
    h.setPending(0);
    const data = Buffer.alloc(8192, 0x61).toString("base64");
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 32; i++)
      h.client.send({
        t: "term_event",
        v: 1,
        sessionId: "session",
        epoch: "epoch-1",
        ownerInstance: "owner",
        channelId: f.channelId,
        termId: opened.termId,
        revision: 1,
        kind: "output",
        offset: i * 8192,
        bytesB64: data,
        streamEpoch: "live-epoch",
      });
    await h.barrier();
    expect(h.service.limits.queuedBytes()).toBeLessThanOrEqual(65536);
    expect(
      (
        await h.post(0, "renew", {
          ...c.identity,
          termId: opened.termId,
          attachmentId: opened.attachmentId,
          writerLease: opened.writerLease,
        })
      ).json.code,
    ).toBe("E_LEASE_EXPIRED");
    const close = await h.post(0, "close", {
      ...c.identity,
      termId: opened.termId,
      closeId: "close",
      expectedRevision: 1,
    });
    expect(close.status).toBe(200);
    expect(close.json.state).toBe("closing");
    expect(h.service.limits.physicalUsed).toBe(1);
    // Diagnostic actual H heap sample, not a claim about A/Python/xterm memory.
    console.info(
      "P1-H H-only memory sample",
      JSON.stringify({
        heapDeltaBytes: process.memoryUsage().heapUsed - before,
        queuedRawBytes: h.service.limits.queuedBytes(),
        physicalSlots: h.service.limits.physicalUsed,
      }),
    );
  });
  it("input duplicate ACK is not a second backend effect; renew never extends shell idle/hard deadline", async () => {
    const h = await harness(),
      c = await h.connection(0),
      o = await h.opened(0, c),
      lease = { ...c.identity, termId: o.termId, attachmentId: o.attachmentId, writerLease: o.writerLease };
    const body = { ...lease, inputSeq: 0, bytesB64: "YQ==", inputKind: "user", streamEpoch: "live-epoch" };
    expect((await h.post(0, "input", body)).json.acceptedThrough).toBe(0);
    expect((await h.post(0, "input", body)).json.acceptedThrough).toBe(0);
    expect(h.counts().inputs).toBe(1);
    expect((await h.post(0, "input", { ...body, bytesB64: "Yg==" })).json.code).toBe("E_INPUT_SEQUENCE");
    const before = await h.post(0, "state", { ...c.identity, target: { termId: o.termId } });
    h.setTime(h.getTime() + 14000);
    expect((await h.post(0, "renew", lease)).status).toBe(200);
    const after = await h.post(0, "state", { ...c.identity, target: { termId: o.termId } });
    expect(after.json.fact.deadlines).toEqual(before.json.fact.deadlines);
    h.setTime(before.json.fact.deadlines.inputIdleAt);
    expect((await h.post(0, "input", { ...body, inputSeq: 1 })).json.code).toBe("E_EXPIRED");
    expect(h.service.limits.physicalUsed).toBe(1);
  });
  it("open timeout keeps durable physical slot, no id-changing retry; late agent completion cannot resurrect", async () => {
    const h = await harness(),
      c = await h.connection(0),
      ticket = await h.prepare(0, c);
    h.hold("open", true);
    const body = {
      ...c.identity,
      openId: ticket.openId,
      createTicket: ticket.createTicket,
      cols: 80,
      rows: 24,
      tabId: "tab",
    };
    const request = h.post(0, "open", body);
    await waitFor(() => h.counts().opens === 1);
    h.setTime(h.getTime() + 4000);
    const response = await request;
    expect(response.json.code).toBe("E_DEADLINE");
    expect(h.service.limits.physicalUsed).toBe(1);
    expect(h.fence.physicalUsed()).toBe(1);
    expect(h.fence.records().resources[0]?.status).toBe("unresolved");
    h.held.splice(0).forEach((f) => f());
    await h.barrier();
    expect((await h.post(0, "open", body)).status).not.toBe(200);
    expect(h.counts().opens).toBe(1);
    expect(h.service.limits.physicalUsed).toBe(1);
  }, 12000);

  it("actual passwd commit/epoch + internal repair permit ONLY a subsequent real login", async () => {
    const h = await harness(),
      old = await h.connection(1);
    await h.opened(1, old);
    const admin = createAdminHandler({
      log: h.log,
      hasLan: () => true,
      store: () => h.store,
      kdf: () => fakeKdf(),
      limiter: () => undefined,
      lan: () => h.fe.lan,
      lanStatus: () => undefined,
      shutdown: () => {},
      now: h.getTime,
      terminalAuth: () => h.service.auth,
      auth: () => (h.fe as typeof h.fe & { auth: Auth }).auth,
      rotateIntentFile: join(h.tmp.dir, "rotate.json"),
      revokeLanSessions: () => undefined,
      revokeLoopbackSse: () => 0,
      revokeLanSse: () => 0,
      bumpLanRevokeGen: () => {},
    });
    const result = await admin.handleLanReq(
      { t: "lan_req", rid: "passwd", op: "passwd", username: "alice", password: "Vermilion!Quartz7New" },
      { agentKey: h.agentKey },
    );
    expect(result.ok).toBe(true);
    expect((await h.post(1, "list", old.identity)).status).toBe(401);
    const r = await lanPostJson(h.ports[1]!, "/api/login", { username: "alice", password: "Vermilion!Quartz7New" });
    expect(r.status).toBe(200);
    const cookie = (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    const fresh = await h.connection(1, cookie);
    expect((await h.post(1, "list", fresh.identity, cookie)).status).toBe(200);
    expect((await h.post(1, "list", old.identity, cookie)).json.code).toBe("E_AUTH");
  });
  it("actual token rotate commits both listener cutoffs; subsequent real login proves the new generation", async () => {
    const h = await harness(),
      old = await h.connection(0),
      lan = await h.connection(1),
      auth = (h.fe as typeof h.fe & { auth: Auth; revokeAllSse: () => number }).auth;
    const admin = createAdminHandler({
      log: h.log,
      hasLan: () => true,
      store: () => h.store,
      kdf: () => fakeKdf(),
      limiter: () => undefined,
      lan: () => h.fe.lan,
      lanStatus: () => undefined,
      shutdown: () => {},
      now: h.getTime,
      terminalAuth: () => h.service.auth,
      auth: () => auth,
      rotateIntentFile: join(h.tmp.dir, "rotate.json"),
      revokeLanSessions: async () => {
        const rows = await h.store.listUsers(h.getTime());
        for (const row of rows) {
          const u = await h.store.getUser(row.username);
          if (u) await h.store.deleteAllSessions(u.id);
        }
        return 1;
      },
      revokeLoopbackSse: () => (h.fe as typeof h.fe & { revokeAllSse: () => number }).revokeAllSse(),
      revokeLanSse: () => (h.fe.lan as typeof h.fe.lan & { revokeAll: () => number }).revokeAll(),
      bumpLanRevokeGen: () => {},
    });
    const rotated = await admin.handleRotateToken({ agentKey: h.agentKey });
    expect(rotated.revoked.loopback).toBe(1);
    expect((await h.post(0, "list", old.identity)).status).toBe(401);
    expect((await h.post(1, "list", lan.identity)).status).toBe(401);
    const r = await postJson(h.ports[0]!, "/api/login", { token: rotated.token });
    expect(r.status).toBe(200);
    const cookie = (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    const fresh = await h.connection(0, cookie);
    expect((await h.post(0, "list", fresh.identity, cookie)).status).toBe(200);
    const lc = await h.loginLan(),
      lf = await h.connection(1, lc);
    expect((await h.post(1, "list", lf.identity, lc)).status).toBe(200);
  });
  it("SSE explicit null/cross/same-site sources get no terminal candidate token on either listener", async () => {
    const h = await harness();
    for (const i of [0, 1])
      for (const headers of [
        { Origin: "null" },
        { Origin: "http://evil.invalid" },
        { "Sec-Fetch-Site": "same-site" },
      ]) {
        const text = await new Promise<string>((resolve, reject) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port: h.ports[i],
              path: "/api/events",
              headers: { Cookie: h.cookies[i]!, ...headers },
              agent: false,
            },
            (res) => {
              let text = "";
              res.on("data", (b) => {
                text += String(b);
                if (text.includes("event: agents")) {
                  setImmediate(() => {
                    clearTimeout(timer);
                    resolve(text);
                    req.destroy();
                  });
                }
              });
            },
          );
          const timer = setTimeout(() => {
            req.destroy();
            reject(Error("SSE capture timed out"));
          }, 2000);
          timer.unref();
          req.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          req.end();
        });
        expect(text).toContain("event: hello");
        expect(text).not.toContain("event: terminal_connection");
      }
  });

  it("preexisting valid LAN cookie has legacy access but cannot mint this-boot terminal binding", async () => {
    const h = await harness();
    // Persisted-row fixture: unlike HTTP login, generic authorize/touch has no login-complete provenance.
    const old = await h.store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: `http://127.0.0.1:${h.ports[1]}`,
      createdIp: "127.0.0.1",
      now: h.getTime(),
    });
    const cookie = `pwh_lan=${old.sid}`;
    expect((await rawRequest(h.ports[1]!, { path: "/api/session", headers: { Cookie: cookie } })).status).toBe(200);
    const text = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: h.ports[1], path: "/api/events", headers: { Cookie: cookie }, agent: false },
        (res) => {
          let text = "";
          res.on("data", (b) => {
            text += String(b);
            if (text.includes("event: agents"))
              setImmediate(() => {
                clearTimeout(timer);
                resolve(text);
                req.destroy();
              });
          });
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        reject(Error("SSE capture timeout"));
      }, 2000);
      timer.unref();
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.end();
    });
    expect(text).toContain("event: hello");
    expect(text).not.toContain("event: terminal_connection");
    expect(
      (await h.post(1, "list", { clientId: "forged", connectionInstance: "forged", connectionToken: "forged" }, cookie))
        .json,
    ).toEqual({ ok: false, code: "E_AUTH", effect: "none" });
    const freshCookie = await h.loginLan(),
      fresh = await h.connection(1, freshCookie);
    expect((await h.post(1, "list", fresh.identity, freshCookie)).status).toBe(200);
    expect(h.counts().opens).toBe(0);
  });
  it.each([0, 1])(
    "listener %i total 5s includes partial body; auth/body cannot hang or spawn",
    async (i) => {
      const h = await harness(true);
      const result = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: h.ports[i],
            method: "POST",
            path: "/api/terminal/prepare",
            headers: {
              Cookie: h.cookies[i]!,
              Origin: `http://127.0.0.1:${h.ports[i]}`,
              "Content-Type": "application/json",
              "X-PWH": "1",
              "Content-Length": "1000",
            },
            agent: false,
          },
          (res) => {
            let text = "";
            res.on("data", (b) => (text += String(b)));
            res.on("end", () => {
              resolve({ status: res.statusCode!, json: JSON.parse(text) });
              req.destroy();
            });
          },
        );
        req.on("error", reject);
        req.setTimeout(7000, () => {
          req.destroy();
          reject(Error("partial-body request hung"));
        });
        req.write("{");
      });
      expect(result).toEqual({ status: 504, json: { ok: false, code: "E_DEADLINE", effect: "none" } });
      expect(h.counts().opens).toBe(0);
    },
    10000,
  );
  it("latest resize sequence wins; close intent freezes writer before awaited backend ACK", async () => {
    const h = await harness(),
      c = await h.connection(0),
      o = await h.opened(0, c),
      lease = { ...c.identity, termId: o.termId, attachmentId: o.attachmentId, writerLease: o.writerLease };
    const first = await h.post(0, "resize", { ...lease, resizeSeq: 2, cols: 100, rows: 30 });
    expect(first.status).toBe(200);
    expect((await h.post(0, "resize", { ...lease, resizeSeq: 1, cols: 80, rows: 24 })).status).toBe(200);
    expect(h.frames.filter((f) => f.op === "resize")).toHaveLength(1);
    expect(
      (
        await h.post(0, "input", {
          ...lease,
          inputSeq: 0,
          bytesB64: "YQ==",
          inputKind: "user",
          streamEpoch: "old-live-epoch",
        })
      ).json.code,
    ).toBe("E_INPUT_SEQUENCE");
    expect(h.counts().inputs).toBe(0);
    h.hold("close", true);
    const closing = h.post(0, "close", {
      ...c.identity,
      termId: o.termId,
      closeId: "close-intent",
      expectedRevision: first.json.revision,
    });
    await waitFor(() => h.held.length === 1);
    expect(
      (
        await h.post(0, "input", {
          ...lease,
          inputSeq: 0,
          bytesB64: "YQ==",
          inputKind: "user",
          streamEpoch: "live-epoch",
        })
      ).json.code,
    ).toBe("E_LEASE_EXPIRED");
    expect(h.counts().inputs).toBe(0);
    expect(
      (
        await h.post(0, "close", {
          ...c.identity,
          termId: o.termId,
          closeId: "close-intent",
          expectedRevision: first.json.revision,
        })
      ).json.state,
    ).toBe("closing");
    h.held.splice(0).forEach((f) => f());
    expect((await closing).status).toBe(200);
    expect(h.service.limits.physicalUsed).toBe(1);
  });
  it("a renew ACK arriving after writer expiry cannot resurrect its lease", async () => {
    const h = await harness(),
      c = await h.connection(0),
      o = await h.opened(0, c),
      lease = { ...c.identity, termId: o.termId, attachmentId: o.attachmentId, writerLease: o.writerLease };
    h.setTime(h.getTime() + 14000);
    h.hold("renew", true);
    const pending = h.post(0, "renew", lease);
    await waitFor(() => h.held.length === 1);
    h.setTime(h.getTime() + 1001);
    h.held.splice(0).forEach((f) => f());
    expect((await pending).json.code).toBe("E_LEASE_EXPIRED");
    expect((await h.post(0, "renew", lease)).json.code).toBe("E_LEASE_EXPIRED");
  });
  it("real private resource-ready → inventory → durable journal CAS → resolved_ack forgets exact receipts once", async () => {
    const h = await harness(),
      c = await h.connection(0),
      o = await h.opened(0, c);
    expect(
      (
        await h.post(0, "close", {
          ...c.identity,
          termId: o.termId,
          closeId: "close-for-receipt",
          expectedRevision: o.revision,
        })
      ).status,
    ).toBe(200);
    h.fence.begin(
      { agentKey: h.agentKey, linkGen: 1, sessionId: "session", epoch: "epoch-1" },
      "owner",
      h.processIdentity,
    );
    expect((await h.post(0, "prepare", { ...c.identity, cols: 80, rows: 24 })).status).toBe(200);
    await h.barrier();
    const acks = h.frames.filter((f): f is Extract<TermReq, { op: "resolved_ack" }> => f.op === "resolved_ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]!.resolved).toMatchObject({
      hubBootId: h.fence.bootId,
      linkGen: 1,
      revision: 7,
      journalRevision: h.fence.records().revision,
      identities: [
        {
          agentSessionId: "session",
          termId: o.termId,
          epoch: "epoch-1",
          ownerInstance: "owner",
          reservationId: o.reservationId,
        },
      ],
    });
    expect(h.forgotten).toEqual([o.reservationId]);
    expect(h.service.limits.physicalUsed).toBe(0);
    expect(h.fence.physicalUsed()).toBe(0);
    const bytes = await readFile(join(h.tmp.dir, "state", "terminal-resource-fence-v1.json"), "utf8");
    expect(JSON.parse(bytes).resources[0].status).toBe("resolved");
    const ownEvents = JSON.stringify(c.stream.events);
    expect(ownEvents).not.toContain("resolved_ack");
    expect(ownEvents).not.toContain("journalRevision");
  });
  it("failed durable resolution never sends resolved_ack and never frees receipts or physical slot", async () => {
    const h = await harness(),
      c = await h.connection(0),
      o = await h.opened(0, c);
    await h.post(0, "close", { ...c.identity, termId: o.termId, closeId: "close-fail", expectedRevision: o.revision });
    h.fence.begin(
      { agentKey: h.agentKey, linkGen: 1, sessionId: "session", epoch: "epoch-1" },
      "owner",
      h.processIdentity,
    );
    h.setJournalFailure(true);
    expect((await h.post(0, "prepare", { ...c.identity, cols: 80, rows: 24 })).json.code).toBe(
      "E_RESOURCE_QUARANTINED",
    );
    await h.barrier();
    expect(h.frames.filter((f) => f.op === "resolved_ack")).toEqual([]);
    expect(h.forgotten).toEqual([]);
    expect(h.service.limits.physicalUsed).toBe(1);
    expect(h.fence.physicalUsed()).toBe(1);
  });
});
