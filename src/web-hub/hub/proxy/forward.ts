/** Bounded HTTP admission and pinned, streaming HTTP forwarding (§3.6). No redirect client. */
import { Agent, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Transform, pipeline } from "node:stream";
import {
  PROXY_ACTIVE_GLOBAL,
  PROXY_ACTIVE_PER_INSTANCE,
  PROXY_AGENT_OPTIONS,
  PROXY_QUEUE_GLOBAL,
  PROXY_QUEUE_PER_INSTANCE,
  PROXY_QUEUE_WAIT_MS,
  PROXY_RETRY_AFTER_S,
  PROXY_CONNECT_TIMEOUT_MS,
  PROXY_HEAD_TIMEOUT_MS,
  PROXY_UPSTREAM_IDLE_MS,
  PROXY_MAX_HEADER_BYTES,
  PROXY_REQUEST_BODY_MAX_BYTES,
  PROXY_STREAM_HWM_BYTES,
  PROXY_LISTENER_STATUS as STATUS,
} from "../../protocol/proxy.js";
import { filterRequestHeaders, filterResponseHeaders } from "./headers.js";
import { systemProxyTimer, type ProxyTimerPort, type PinnedProxyTarget } from "./dns-gate.js";
import type { ProxySession, ProxySessionStore } from "./sessions.js";

export interface ProxyTraffic {
  reqs: number;
  bytesUp: number;
  bytesDown: number;
  ws: number;
}
export type ProxyReply = (res: ServerResponse, status: number, headers?: Record<string, string>) => void;
export interface ProxyRequestGate {
  origin: string;
  browserHost: string;
  session: ProxySession;
  traffic: ProxyTraffic;
}
interface AdmissionJob {
  key: string;
  start(release: () => void): void;
  refuse(): void;
  cancelTimer(): void;
}
export interface ProxyAdmission {
  submit(key: string, start: AdmissionJob["start"], refuse: () => void): () => void;
  stats(): { active: number; queued: number };
}
/** One service-owned FIFO; a full instance does not head-of-line block other instances. */
export function createProxyAdmission(timer: ProxyTimerPort = systemProxyTimer): ProxyAdmission {
  const active = new Map<string, number>();
  const queue: AdmissionJob[] = [];
  let total = 0;
  const available = (key: string) => total < PROXY_ACTIVE_GLOBAL && (active.get(key) ?? 0) < PROXY_ACTIVE_PER_INSTANCE;
  const run = (job: AdmissionJob): void => {
    job.cancelTimer();
    total++;
    active.set(job.key, (active.get(job.key) ?? 0) + 1);
    let released = false;
    job.start(() => {
      if (released) return;
      released = true;
      total--;
      const n = (active.get(job.key) ?? 1) - 1;
      if (n === 0) active.delete(job.key);
      else active.set(job.key, n);
      drain();
    });
  };
  const drain = (): void => {
    for (let i = 0; i < queue.length;) {
      const job = queue[i]!;
      if (!available(job.key)) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      run(job);
    }
  };
  return {
    submit(key, start, refuse) {
      const job: AdmissionJob = { key, start, refuse, cancelTimer: () => {} };
      const cancel = () => {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        job.cancelTimer();
      };
      if (available(key)) run(job);
      else if (
        queue.length >= PROXY_QUEUE_GLOBAL ||
        queue.filter((j) => j.key === key).length >= PROXY_QUEUE_PER_INSTANCE
      )
        refuse();
      else {
        queue.push(job);
        job.cancelTimer = timer.after(PROXY_QUEUE_WAIT_MS, () => {
          cancel();
          refuse();
        });
      }
      return cancel;
    },
    stats: () => ({ active: total, queued: queue.length }),
  };
}
export interface ProxyForwardDeps {
  instanceId: string;
  pinned: PinnedProxyTarget;
  sessions: ProxySessionStore;
  sessionTraffic(session: ProxySession): ProxyTraffic;
  admission: ProxyAdmission;
  traffic: ProxyTraffic;
  reply: ProxyReply;
  now(): number;
  timer?: ProxyTimerPort;
}
export interface ProxyForwarder {
  handle(req: IncomingMessage, res: ServerResponse, gate: ProxyRequestGate): void;
  close(): void;
  /** Diagnostic seam: admission must never feed the Agent's otherwise-unbounded queue. */
  readonly agent: Agent;
}
export function createProxyForwarder(deps: ProxyForwardDeps): ProxyForwarder {
  const timer = deps.timer ?? systemProxyTimer;
  const agent = new Agent(PROXY_AGENT_OPTIONS);
  const cancels = new Set<() => void>();
  const bySocket = new Map<
    Socket,
    {
      jobs: Set<() => void>;
      incomplete: Set<() => void>;
      close(): void;
      end(): void;
    }
  >();
  let closing = false;
  return {
    agent,
    handle(req, res, gate) {
      if (closing) {
        deps.reply(res, STATUS.busy);
        return;
      }
      let ended = false;
      let cancelQueued = () => {};
      let destroyUp = () => {};
      let hardCancel = () => {};
      const detach = () => {
        hardCancel();
        cancels.delete(cancel);
        deps.sessions.detach(gate.session, revoker);
        res.off("close", cancel);
        res.off("finish", cancel);
        req.off("aborted", cancel);
        req.off("close", clientEnded);
        const rec = bySocket.get(req.socket);
        rec?.jobs.delete(cancel);
        rec?.incomplete.delete(clientEnded);
        if (rec?.jobs.size === 0) {
          req.socket.off("close", rec.close);
          req.socket.off("error", rec.close);
          req.socket.off("end", rec.end);
          bySocket.delete(req.socket);
        }
      };
      const cancel = () => {
        if (ended) return;
        ended = true;
        cancelQueued();
        destroyUp();
        detach();
      };
      const revoker = {
        destroy() {
          cancel();
          res.destroy();
        },
      };
      // IncomingMessage.close also fires after a normally completed request body.
      // A half-close/req close is cancellation only if that body is incomplete.
      const clientEnded = () => {
        if (!req.complete) cancel();
      };
      cancels.add(cancel);
      let socketRec = bySocket.get(req.socket);
      if (!socketRec) {
        const jobs = new Set<() => void>();
        const incomplete = new Set<() => void>();
        socketRec = {
          jobs,
          incomplete,
          close() {
            for (const job of [...jobs]) job();
          },
          end() {
            for (const job of [...incomplete]) job();
          },
        };
        bySocket.set(req.socket, socketRec);
        req.socket.once("close", socketRec.close);
        req.socket.once("error", socketRec.close);
        req.socket.once("end", socketRec.end);
      }
      socketRec.jobs.add(cancel);
      socketRec.incomplete.add(clientEnded);
      res.on("close", cancel);
      res.on("finish", cancel);
      req.on("aborted", cancel);
      req.on("close", clientEnded);
      // These are real client signals, not an inference from upstream backpressure.
      // If unread TCP bytes hide FIN while paused, the existing listener idle timeout
      // remains the fallback. Do not drain/discard bytes or time out a live slow upload.
      if (!deps.sessions.attach(gate.session, revoker)) {
        revoker.destroy();
        return;
      }
      hardCancel = timer.after(Math.max(1, gate.session.hardAt - deps.now()), () => revoker.destroy());
      const fail = (status: number) => {
        if (!res.headersSent && !res.destroyed)
          deps.reply(res, status, status === STATUS.busy ? { "Retry-After": String(PROXY_RETRY_AFTER_S) } : undefined);
        else res.destroy();
        cancel();
      };
      cancelQueued = deps.admission.submit(
        deps.instanceId,
        (release) => {
          if (ended) {
            release();
            return;
          }
          const ctx = {
            ...deps.pinned,
            ...gate,
            target: deps.pinned.target,
            peer: req.socket.remoteAddress ?? "",
            browserHost: gate.browserHost,
          };
          let up: ReturnType<typeof request>;
          let connectCancel = () => {};
          let headCancel = () => {};
          let released = false;
          const finishUp = () => {
            if (released) return;
            released = true;
            connectCancel();
            headCancel();
            // ClientRequest.close precedes socket.free; a surplus free socket is then
            // destroyed by Agent but still counts toward maxSockets until its real close.
            // Hand off only after THIS physical slot is reusable or actually removed.
            const socket = up?.socket;
            if (!socket || socket.closed || Object.values(agent.freeSockets).some((a) => a?.includes(socket))) {
              release();
              return;
            }
            const cleanup = () => {
              socket.off("free", free);
              socket.off("close", closed);
            };
            const closed = () => {
              cleanup();
              release();
            };
            const free = () => {
              if (socket.destroyed) return; // Agent's maxFreeSockets eviction: wait for close
              cleanup();
              release();
            };
            socket.once("free", free);
            socket.once("close", closed);
          };
          try {
            up = request({
              host: deps.pinned.pinnedIp,
              port: deps.pinned.target.port,
              method: req.method,
              path: req.url,
              headers: filterRequestHeaders(req.headers, ctx),
              setHost: false,
              agent,
              maxHeaderSize: PROXY_MAX_HEADER_BYTES,
              ...{ highWaterMark: PROXY_STREAM_HWM_BYTES },
            });
          } catch {
            finishUp();
            fail(STATUS.badGateway);
            return;
          }
          destroyUp = () => {
            connectCancel();
            headCancel();
            up.destroy();
          };
          // Release on the real ClientRequest close, not the caller's cancellation race.
          up.once("close", finishUp);
          up.on("error", () => {
            if (!ended) fail(STATUS.badGateway);
          });
          connectCancel = timer.after(PROXY_CONNECT_TIMEOUT_MS, () => fail(STATUS.badGateway));
          headCancel = timer.after(PROXY_HEAD_TIMEOUT_MS, () => fail(STATUS.gatewayTimeout));
          up.on("socket", (socket) => {
            socket.unref();
            if (!socket.connecting) connectCancel();
            else socket.once("connect", () => connectCancel());
          });
          up.setTimeout(PROXY_UPSTREAM_IDLE_MS, () => {
            if (!ended) fail(STATUS.gatewayTimeout);
          });
          up.on("response", (upstream) => {
            connectCancel();
            headCancel();
            if (ended) {
              upstream.destroy();
              return;
            }
            try {
              res.writeHead(upstream.statusCode ?? STATUS.badGateway, filterResponseHeaders(upstream.headers, ctx));
            } catch {
              upstream.destroy();
              fail(STATUS.badGateway);
              return;
            }
            const counter = new Transform({
              highWaterMark: PROXY_STREAM_HWM_BYTES,
              transform(chunk: Buffer, _enc, cb) {
                deps.traffic.bytesDown += chunk.length;
                gate.traffic.bytesDown += chunk.length;
                cb(null, chunk);
              },
            });
            pipeline(upstream, counter, res, (err) => {
              if (err) cancel();
            });
          });
          let bytes = 0;
          const counter = new Transform({
            highWaterMark: PROXY_STREAM_HWM_BYTES,
            transform(chunk: Buffer, _enc, cb) {
              bytes += chunk.length;
              if (bytes > PROXY_REQUEST_BODY_MAX_BYTES) {
                // Respond before pipeline tears down its source socket.
                fail(STATUS.bodyTooLarge);
                cb(new Error("proxy body cap"));
              } else {
                deps.traffic.bytesUp += chunk.length;
                gate.traffic.bytesUp += chunk.length;
                cb(null, chunk);
              }
            },
          });
          pipeline(req, counter, up, (err) => {
            if (err && !ended) fail(STATUS.badGateway);
          });
        },
        () => fail(STATUS.busy),
      );
      // submit may synchronously refuse/start; don't leave a stale queue cancellation behind.
      if (ended) cancelQueued();
    },
    close() {
      if (closing) return;
      closing = true;
      for (const cancel of [...cancels]) cancel();
      agent.destroy();
    },
  };
}
