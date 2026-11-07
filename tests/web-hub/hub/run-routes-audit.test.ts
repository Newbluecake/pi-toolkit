/**
 * 2026-11 observability package: the run-route audit channel (`audit:"run"` lines written via
 * audit.ts's `auditRun`). subscribe/unsubscribe/history write ONE request line; the async
 * subscribe-time snapshot writes ONE more on settle (before the object-identity checks — a
 * discarded late snapshot is still the hang-triage evidence). Format assertions only:
 * identifiers + status/code + ms, never content, the raw runId never appears (sha256 tag).
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { HubError } from "../../../src/web-hub/hub/registry.js";
import { createRunRoutes, type RunRoutes } from "../../../src/web-hub/hub/run-routes.js";
import type { RegistryView, RunTranscriptService } from "../../../src/web-hub/hub/ports.js";
import type { SseClient, SseHub } from "../../../src/web-hub/hub/sse.js";
import type { RunHistoryPayload } from "../../../src/web-hub/protocol/run-transcript.js";
import { memLog, type MemLog } from "./helpers.js";

// --------------------------------------------------------------------- harness

const CLIENT = "c-client-1";
const AGENT = "agent-1";
const RUNID = "r_ABCDEFGH"; // RUN_ID_PATTERN-shaped; must NEVER appear in an audit line
const CANARY = "CANARY_CONTENT_NEVER_LOGGED";

const runTagOf = (runId: string): string => createHash("sha256").update(runId).digest("hex").slice(0, 12);

interface SentJson {
  status: number;
  body: unknown;
}

function fakeRes(): { res: ServerResponse; sent: SentJson[] } {
  const sent: SentJson[] = [];
  let status = 0;
  const res = {
    headersSent: false,
    destroyed: false,
    writeHead(s: number) {
      status = s;
      res.headersSent = true;
      return res;
    },
    end(body?: unknown) {
      sent.push({ status, body: typeof body === "string" ? JSON.parse(body) : body });
      return res;
    },
  } as unknown as ServerResponse;
  return { res, sent };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function historyPayload(over: Partial<RunHistoryPayload> = {}): RunHistoryPayload {
  return {
    agentKey: AGENT,
    runId: RUNID,
    entries: [],
    tailMessages: [],
    fromSeq: 1,
    hasMore: false,
    source: "live",
    terminal: false,
    status: "running",
    live: false,
    ...over,
  };
}

function harness(init: { snapshot?: () => Promise<RunHistoryPayload>; page?: () => Promise<RunHistoryPayload> } = {}) {
  const log = memLog();
  const pushes: Array<{ event: string; data: unknown }> = [];
  const client = {
    id: CLIENT,
    subscribed: new Set<string>(),
    send: (event: string, data: unknown) => {
      pushes.push({ event, data });
      return true;
    },
    close: () => undefined,
  } as unknown as SseClient;
  const sse = { get: (id: string) => (id === CLIENT ? client : undefined) } as unknown as SseHub;
  const registry = {
    get: (k: string) => (k === AGENT ? ({ agentKey: k } as never) : undefined),
  } as unknown as RegistryView;
  const watches: string[] = [];
  const runTx = {
    snapshot: () => (init.snapshot ?? (() => Promise.resolve(historyPayload())))(),
    page: () => (init.page ?? (() => Promise.resolve(historyPayload())))(),
    watch: (agentKey: string, runId: string, ref: string) => {
      watches.push(`${agentKey}|${runId}|${ref}`);
    },
    unwatch: () => undefined,
    onFrame: () => undefined,
    setSink: () => undefined,
    dispose: () => undefined,
  } as unknown as RunTranscriptService;
  let now = 1_000;
  const routes = createRunRoutes(sse, {
    listener: "loopback",
    registry,
    runTx,
    log,
    isClosed: () => false,
    now: () => now,
  });
  return {
    routes,
    log,
    pushes,
    watches,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const auditLines = (log: MemLog): Array<Record<string, unknown>> =>
  log.lines
    .filter((l) => (l.data as Record<string, unknown> | undefined)?.["audit"] === "run")
    .map((l) => l.data as Record<string, unknown>);

// --------------------------------------------------------------------- tests

describe('run-route audit channel (audit:"run")', () => {
  it("subscribe 202 writes a request line; the snapshot settle writes one more with the real ms", async () => {
    const snap = deferred<RunHistoryPayload>();
    const h = harness({ snapshot: () => snap.promise });
    const { res, sent } = fakeRes();
    h.routes.subscribe({ clientId: CLIENT, agentKey: AGENT, runId: RUNID }, res);
    expect(sent[0]).toMatchObject({ status: 202, body: { ok: true } });
    h.advance(123);
    snap.resolve(historyPayload());
    await flush();
    const lines = auditLines(h.log);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      audit: "run",
      op: "subscribe",
      listener: "loopback",
      agentKey: AGENT,
      runTag: runTagOf(RUNID),
      ok: true,
      status: 202,
    });
    expect(lines[1]).toMatchObject({ audit: "run", op: "snapshot", ok: true, ms: 123, runTag: runTagOf(RUNID) });
    expect(lines[1]).not.toHaveProperty("status"); // settle lines carry no HTTP status
    // the history was delivered to the SSE client, not the log
    expect(h.pushes.some((p) => p.event === "run_history")).toBe(true);
  });

  it("snapshot failure (E_DEADLINE) ⇒ settle line ok:false + code, the hang-triage discriminator", async () => {
    const snap = deferred<RunHistoryPayload>();
    const h = harness({ snapshot: () => snap.promise });
    const { res } = fakeRes();
    h.routes.subscribe({ clientId: CLIENT, agentKey: AGENT, runId: RUNID }, res);
    h.advance(5_001); // the RUN_TX.reqDeadlineMs-scale latency this channel exists to expose
    snap.reject(new HubError("E_DEADLINE"));
    await flush();
    const lines = auditLines(h.log);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      op: "snapshot",
      ok: false,
      code: "E_DEADLINE",
      ms: 5_001,
      runTag: runTagOf(RUNID),
    });
  });

  it("history page: success ⇒ ok line with status 200; failure ⇒ code + mapped status", async () => {
    const page = deferred<RunHistoryPayload>();
    const h = harness({ page: () => page.promise });
    const { res, sent } = fakeRes();
    const done = h.routes.historyPage(
      new URLSearchParams({ agent: AGENT, run: RUNID, before: "e1", limit: "50" }),
      res,
    );
    h.advance(42);
    page.resolve(historyPayload());
    await done;
    expect(sent[0]!.status).toBe(200);
    expect(auditLines(h.log)).toEqual([
      expect.objectContaining({ op: "history", ok: true, status: 200, ms: 42, runTag: runTagOf(RUNID) }),
    ]);

    const fail = harness({ page: () => Promise.reject(new HubError("E_NOT_FOUND", "unknown_run")) });
    const r2 = fakeRes();
    await fail.routes.historyPage(new URLSearchParams({ agent: AGENT, run: RUNID, before: "e1" }), r2.res);
    expect(auditLines(fail.log)).toEqual([
      expect.objectContaining({ op: "history", ok: false, code: "E_NOT_FOUND", status: 404, runTag: runTagOf(RUNID) }),
    ]);
  });

  it("unsubscribe is idempotent 200 and audited; validation 400s carry no identifiers", () => {
    const h = harness();
    const { res } = fakeRes();
    h.routes.unsubscribe({ clientId: CLIENT, agentKey: AGENT, runId: RUNID }, res);
    expect(auditLines(h.log)).toEqual([
      expect.objectContaining({ op: "unsubscribe", ok: true, status: 200, agentKey: AGENT, runTag: runTagOf(RUNID) }),
    ]);

    const bad = harness();
    const r2 = fakeRes();
    bad.routes.subscribe({ clientId: "x" }, r2.res); // missing/invalid fields
    const lines = auditLines(bad.log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ op: "subscribe", ok: false, status: 400, code: "E_BAD_REQUEST" });
    expect(lines[0]).not.toHaveProperty("runTag");
    expect(lines[0]).not.toHaveProperty("agentKey");
  });

  it("never logs the raw runId or any entry content (U7 discipline)", async () => {
    const h = harness({
      snapshot: () => Promise.resolve(historyPayload({ entries: [{ id: CANARY } as never] })),
      page: () => Promise.resolve(historyPayload({ entries: [{ id: CANARY } as never] })),
    });
    const r1 = fakeRes();
    h.routes.subscribe({ clientId: CLIENT, agentKey: AGENT, runId: RUNID }, r1.res);
    await flush();
    const r2 = fakeRes();
    await h.routes.historyPage(new URLSearchParams({ agent: AGENT, run: RUNID, before: CANARY }), r2.res);
    const blob = JSON.stringify(h.log.lines);
    expect(blob).not.toContain(RUNID);
    expect(blob).not.toContain(CANARY);
    expect(blob).toContain(runTagOf(RUNID)); // the tag IS there for correlation
  });
});
