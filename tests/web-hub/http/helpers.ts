/** Shared helpers for package C (hub HTTP) tests: fake FrontendDeps, raw HTTP + SSE clients. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCard, HistoryPayload } from "../../../src/web-hub/protocol/http-contract.js";
import type { HubPaths } from "../../../src/web-hub/protocol/paths.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import type { AgentView, FrontendDeps, HistoryService, HubEvent, HubLog } from "../../../src/web-hub/hub/ports.js";
import { testHubPaths } from "../helpers/paths.js";

export function makeTmp(prefix = "pwh-http-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface LogLine {
  level: "info" | "warn" | "error";
  msg: string;
  data?: object;
}

export function captureLog(): HubLog & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push =
    (level: LogLine["level"]) =>
    (msg: string, data?: object): void => {
      lines.push(data === undefined ? { level, msg } : { level, msg, data });
    };
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

export function makeAgent(agentKey: string, extra: Partial<AgentView> = {}): AgentView {
  return {
    agentKey,
    kind: "tui",
    pid: 4242,
    cwd: "/tmp/wa",
    state: "live",
    pluginVersion: "0.0.0-test",
    outdated: false,
    prompts: [],
    agentId: { pid: 4242, nonce: "abcdefghijklmnop" },
    connectedAt: 1,
    lastFrameAt: 1,
    seq: 0,
    ...extra,
  };
}

export function emptyHistory(agentKey: string, fromSeq = 1): HistoryPayload {
  return { agentKey, entries: [], tailMessages: [], fromSeq, hasMore: false, source: "file" };
}

export interface FakeDeps extends FrontendDeps {
  agents: Map<string, AgentView>;
  emit(e: HubEvent): void;
  listeners(): number;
  logLines: LogLine[];
  historyCalls: { snapshot: string[]; page: Array<[string, string, number]> };
  setSnapshot(fn: (agentKey: string) => Promise<HistoryPayload>): void;
  setPage(fn: (agentKey: string, before: string, limit: number) => Promise<HistoryPayload>): void;
}

export function fakeDeps(dir: string, opts: { port?: number } = {}): FakeDeps {
  const agents = new Map<string, AgentView>();
  const subs = new Set<(e: HubEvent) => void>();
  const log = captureLog();
  const historyCalls: FakeDeps["historyCalls"] = { snapshot: [], page: [] };
  let snapshotFn: (agentKey: string) => Promise<HistoryPayload> = async (k) => emptyHistory(k);
  let pageFn: (agentKey: string, before: string, limit: number) => Promise<HistoryPayload> = async (k) =>
    emptyHistory(k);
  const history: HistoryService = {
    snapshot: (k) => {
      historyCalls.snapshot.push(k);
      return snapshotFn(k);
    },
    page: (k, b, l) => {
      historyCalls.page.push([k, b, l]);
      return pageFn(k, b, l);
    },
    onLeafChanged: () => {},
  };
  const stateDir = join(dir, "state");
  const paths: HubPaths = testHubPaths(stateDir);
  return {
    config: { v: 1, home: dir, port: opts.port ?? 0, idleExitMinutes: 10, pluginVersion: "0.0.0-test", buildId: "b1" },
    paths,
    registry: { list: () => [...agents.values()], get: (k) => agents.get(k) },
    bus: {
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    },
    history,
    log,
    info: () => ({ version: "9.9.9", buildId: "b1", pid: process.pid, startedAt: 1, proto: PROTO }),
    now: () => Date.now(),
    agents,
    emit: (e) => {
      for (const fn of [...subs]) fn(e);
    },
    listeners: () => subs.size,
    logLines: log.lines,
    historyCalls,
    setSnapshot: (fn) => {
      snapshotFn = fn;
    },
    setPage: (fn) => {
      pageFn = fn;
    },
  };
}

export interface RawResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

export function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(opts.timeoutMs ?? 5_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export const JSON_HEADERS = { "Content-Type": "application/json", "X-PWH": "1" } as const;

export function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return rawRequest(port, {
    method: "POST",
    path,
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

export async function login(port: number, tokenFile: string): Promise<string> {
  const token = readFileSync(tokenFile, "utf8").trim();
  const res = await postJson(port, "/api/login", { token });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.body}`);
  const setCookie = res.headers["set-cookie"]?.[0] ?? "";
  return setCookie.split(";")[0]!;
}

export interface SseEvent {
  id?: number;
  event: string;
  data: any;
}

export interface SseConn {
  status: number;
  events: SseEvent[];
  ended: boolean;
  waitFor(pred: (e: SseEvent, all: SseEvent[]) => boolean, ms?: number): Promise<SseEvent>;
  waitEnd(ms?: number): Promise<void>;
  pause(): void;
  close(): void;
}

export function parseSseBlock(block: string): SseEvent | undefined {
  let id: number | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) id = Number(line.slice(4));
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (data.length === 0) return undefined;
  const parsed = JSON.parse(data.join("\n")) as unknown;
  return id === undefined ? { event, data: parsed } : { id, event, data: parsed };
}

export function openSse(
  port: number,
  opts: {
    cookie?: string;
    lastEventId?: number | string;
    path?: string;
    host?: string;
    /** TCP dial target, defaults to `127.0.0.1` — see `lan-helpers.ts`'s `lanRequest.destHost` for
     * why this must be separate from the (possibly spoofed) `Host` header. */
    destHost?: string;
  } = {},
): Promise<SseConn> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}`, Accept: "text/event-stream" };
    if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
    if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = String(opts.lastEventId);
    const req = httpRequest({
      host: opts.destHost ?? "127.0.0.1",
      port,
      path: opts.path ?? "/api/events",
      headers,
      agent: false,
    });
    req.on("error", reject);
    req.on("response", (res) => {
      const events: SseEvent[] = [];
      const waiters: Array<() => void> = [];
      let buf = "";
      const notify = (): void => {
        for (const w of [...waiters]) w();
      };
      const conn: SseConn = {
        status: res.statusCode ?? 0,
        events,
        ended: false,
        waitFor(pred, ms = 3_000) {
          return new Promise((res2, rej2) => {
            const check = (): boolean => {
              const hit = events.find((e) => pred(e, events));
              if (hit !== undefined) {
                cleanup();
                res2(hit);
                return true;
              }
              if (conn.ended) {
                cleanup();
                rej2(new Error(`stream ended; got ${events.map((e) => e.event).join(",")}`));
                return true;
              }
              return false;
            };
            const timer = setTimeout(() => {
              cleanup();
              rej2(new Error(`waitFor timeout; got ${events.map((e) => e.event).join(",")}`));
            }, ms);
            const cleanup = (): void => {
              clearTimeout(timer);
              const i = waiters.indexOf(onEv);
              if (i >= 0) waiters.splice(i, 1);
            };
            const onEv = (): void => {
              check();
            };
            if (!check()) waiters.push(onEv);
          });
        },
        waitEnd(ms = 3_000) {
          return new Promise((res2, rej2) => {
            if (conn.ended) return res2();
            const timer = setTimeout(() => rej2(new Error("waitEnd timeout")), ms);
            const onEv = (): void => {
              if (conn.ended) {
                clearTimeout(timer);
                res2();
              }
            };
            waiters.push(onEv);
          });
        },
        pause: () => res.pause(),
        close: () => req.destroy(),
      };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = parseSseBlock(block);
          if (ev !== undefined) events.push(ev);
        }
        notify();
      });
      const end = (): void => {
        conn.ended = true;
        notify();
      };
      res.on("end", end);
      res.on("close", end);
      res.on("error", end);
      resolve(conn);
    });
    req.end();
  });
}

export type { AgentCard };
