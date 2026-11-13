/** Both listeners call this one handler AFTER existing Host/client guards. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthIdentity } from "../auth-identity.js";
import type { HubLog, RequestContext, TerminalRoutesPort } from "../ports.js";
import {
  TERMINAL_HTTP_PATHS,
  TERMINAL_LIMITS as L,
  terminalHttpRequestOk,
  type TerminalHttpRequests,
} from "../../protocol/terminal.js";
import { auditTerminal } from "../audit.js";
import { TerminalFault, bounded, clampSpanMs, failure, terminalClock } from "./limits.js";
import type { TerminalService } from "./service.js";
import type { TerminalRevocationFence } from "./revocation-fence.js";
export interface TerminalFrontendPort extends TerminalRoutesPort {
  terminalAuth: TerminalRevocationFence;
  auditHealth(): { failures: number };
  openSse(req: IncomingMessage, res: ServerResponse, id: AuthIdentity, clientId: string, origin: string): void;
}
export const terminalFrontend = (port: TerminalRoutesPort | undefined): TerminalFrontendPort | undefined =>
  port && "terminalAuth" in port && "openSse" in port ? (port as TerminalFrontendPort) : undefined;
export const isTerminalPath = (url: string) => url.split("?")[0]!.startsWith("/api/terminal/");
export function terminalPostOk(req: IncomingMessage, origin: string): boolean {
  return (
    req.method === "POST" &&
    (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json" &&
    req.headers["x-pwh"] === "1" &&
    req.headers.origin === origin &&
    (req.headers["sec-fetch-site"] === undefined || req.headers["sec-fetch-site"] === "same-origin")
  );
}
function json(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const b = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(b),
  });
  res.end(b);
}
function status(code: string) {
  return code === "E_AUTH"
    ? 401
    : code === "E_CSRF"
      ? 403
      : code === "E_RATE" || code === "E_LIMIT"
        ? 429
        : code === "E_DEADLINE"
          ? 504
          : code === "E_BAD_REQUEST" || code === "E_STALE_CREATION"
            ? 400
            : 409;
}
async function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const clean = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      signal.removeEventListener("abort", abort);
    };
    const error = () => {
      clean();
      reject(new TerminalFault("E_BAD_REQUEST"));
    };
    const abort = () => {
      clean();
      reject(new TerminalFault("E_DEADLINE"));
    };
    const data = (b: Buffer) => {
      bytes += b.length;
      if (bytes > L.frameBytes) {
        error();
        req.resume();
      } else chunks.push(b);
    };
    const end = () => {
      clean();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new TerminalFault("E_BAD_REQUEST"));
      }
    };
    if (signal.aborted) {
      abort();
      return;
    }
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Total timer starts BEFORE auth IPC/body. Late authorize success cannot admit work. */
export async function dispatchTerminal(
  port: TerminalRoutesPort,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  now: () => number,
  authorize: (remaining: number) => Promise<AuthIdentity | undefined>,
): Promise<void> {
  if (!terminalPostOk(req, ctx.externalOrigin)) {
    json(res, 403, failure(new TerminalFault("E_CSRF")));
    return;
  }
  const ctl = new AbortController(),
    clock = terminalClock(now),
    at = now() + L.httpMs;
  const abort = () => ctl.abort();
  const timer = clock.setTimer(clampSpanMs(at - now()), abort);
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const id = await bounded(authorize(clampSpanMs(at - now())), now, at, ctl.signal);
    if (res.writableEnded) return;
    if (!id) {
      json(res, 401, failure(new TerminalFault("E_AUTH")));
      return;
    }
    if (ctl.signal.aborted) throw new TerminalFault("E_DEADLINE");
    const handled = await bounded(port.handle(req, res, ctx, id, ctl.signal), now, at, ctl.signal);
    if (!handled) json(res, 404, failure(new TerminalFault("E_UNSUPPORTED")));
  } catch (e) {
    const f = failure(e);
    // No complete HTTP body means handle() cannot have admitted an operation. The
    // total timer and body-abort rejection may settle in either microtask order.
    if (f.code === "E_DEADLINE" && !req.complete) f.effect = "none";
    json(res, status(f.code), f);
  } finally {
    clock.clearTimer(timer);
    req.off("aborted", abort);
    res.off("close", abort);
    ctl.abort();
  }
}
export function createTerminalRoutes(deps: {
  service: TerminalService;
  now: () => number;
  log: Pick<HubLog, "info">;
}): TerminalFrontendPort {
  let disposed = false,
    auditFailures = 0;
  const writeAudit = (r: Parameters<typeof auditTerminal>[1]) => {
    if (!auditTerminal(deps.log, r)) auditFailures = Math.min(Number.MAX_SAFE_INTEGER, auditFailures + 1);
  };
  const counts = new Map<string, { at: number; n: number; bytesIn: number }>();
  function audit(op: string, id: AuthIdentity, ok: boolean, code?: string, bytesIn = 0) {
    const high = ["input", "resize", "ack", "renew"].includes(op),
      k = `${id.listener}:${id.principal}:${ok ? "ok" : code}`;
    if (high) {
      const old = counts.get(k);
      if (old && deps.now() - old.at < 60_000) {
        old.n++;
        old.bytesIn += bytesIn;
        return;
      }
      if (old) writeAudit({ op: "aggregate", listener: id.listener, ok, n: old.n, bytesIn: old.bytesIn });
      if (counts.size >= 2048 && !old) return;
      counts.set(k, { at: deps.now(), n: 1, bytesIn });
      if (!ok) writeAudit({ op, listener: id.listener, ok, ...(code === undefined ? {} : { code }) });
      return;
    }
    writeAudit({ op, listener: id.listener, ok, ...(code === undefined ? {} : { code }) });
  }
  return {
    terminalAuth: deps.service.auth,
    auditHealth: () => ({
      failures: Math.min(Number.MAX_SAFE_INTEGER, auditFailures + deps.service.auditHealth().failures),
    }),
    openSse(req, res, id, clientId, origin) {
      deps.service.bindings.connect(req, res, id, clientId, origin);
    },
    async handle(req, res, ctx, id, signal) {
      const path = (req.url ?? "").split("?")[0],
        op = (Object.keys(TERMINAL_HTTP_PATHS) as Array<keyof TerminalHttpRequests>).find(
          (k) => TERMINAL_HTTP_PATHS[k] === path,
        );
      if (!op) return false;
      try {
        if (disposed) throw new TerminalFault("E_DISABLED");
        if (!terminalPostOk(req, ctx.externalOrigin)) throw new TerminalFault("E_CSRF");
        deps.service.auth.proof(id);
        const raw = await body(req, signal);
        if (!terminalHttpRequestOk(op, raw)) throw new TerminalFault("E_BAD_REQUEST");
        const binding = deps.service.bindings.resolve(id, raw);
        const result = await deps.service.request(op, raw, id, binding, signal);
        // Recheck AFTER every awaited operation, even if authorize succeeded before first emit.
        try {
          deps.service.auth.proof(id);
        } catch (e) {
          if (e instanceof TerminalFault && (op === "input" || op === "open"))
            throw new TerminalFault(e.code, "unknown");
          throw e;
        }
        if (signal.aborted || !binding.metadata.live)
          throw new TerminalFault("E_AUTH_REVOKING", op === "open" || op === "input" ? "unknown" : "none");
        audit(
          op,
          id,
          true,
          undefined,
          op === "input" && "bytesB64" in raw ? Buffer.from(raw.bytesB64, "base64").length : 0,
        );
        json(res, 200, result);
      } catch (e) {
        const f = failure(e);
        audit(op, id, false, f.code);
        json(res, status(f.code), f);
      }
      return true;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const r of counts.values()) writeAudit({ op: "aggregate", ok: true, n: r.n, bytesIn: r.bytesIn });
      counts.clear();
      await deps.service.dispose();
    },
  };
}
