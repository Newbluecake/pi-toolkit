/** Both listeners dispatch AFTER original Host/client/real-auth guards. No v1 assembly. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthIdentity } from "../../auth-identity.js";
import type { RequestContext } from "../../ports.js";
import type {
  TerminalAuthFenceV2,
  TerminalRoutesPortV2,
  TerminalServiceV2,
  TerminalViewPortV2,
} from "../../terminal-v2-ports.js";
import { TERMINAL_V2_HTTP_PATHS, type TerminalOpV2 } from "../../../protocol/terminal-v2-paths.js";
import {
  TERMINAL_V2_ERROR_STATUS,
  TERMINAL_V2_VIEW_HEADERS,
  terminalHttpRequestV2Ok,
  type TerminalFailureV2,
} from "../../../protocol/terminal-v2.js";
import { TERMINAL_V2_LIMITS as L } from "../../../protocol/terminal-v2-values.js";
import { asFailure, deadline, fail, requireLive, TerminalV2Fault } from "./local.js";
import { terminalNdjsonSinkV2 } from "./ndjson.js";
import type { TerminalAuthFailureV2 } from "./view.js";
import type { TerminalAuthNotificationsV2 } from "./revocation-fence.js";
import { terminalRouteAuditV2, type TerminalAuditV2 } from "./audit.js";
export type { TerminalRouteAuditV2, TerminalAuditV2 } from "./audit.js";

export function terminalPostV2Ok(req: IncomingMessage, origin: string): boolean {
  return (
    req.method === "POST" &&
    (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json" &&
    req.headers["x-pwh"] === "1" &&
    req.headers.origin === origin &&
    (req.headers["sec-fetch-site"] === undefined || req.headers["sec-fetch-site"] === "same-origin")
  );
}
function json(res: ServerResponse, result: unknown, status = 200): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(result);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
function errorJson(res: ServerResponse, failure: TerminalFailureV2): void {
  json(res, failure, TERMINAL_V2_ERROR_STATUS[failure.code]);
}
function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const clean = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      req.off("aborted", error);
      signal.removeEventListener("abort", abort);
    };
    const error = () => {
      clean();
      reject(new TerminalV2Fault(fail("E_BAD_REQUEST")));
    };
    const abort = () => {
      clean();
      reject(new TerminalV2Fault(fail("E_DEADLINE")));
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > L.frameBytes) {
        error();
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try {
        resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      } catch {
        reject(new TerminalV2Fault(fail("E_BAD_REQUEST")));
      }
    };
    if (signal.aborted) {
      abort();
      return;
    }
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    req.once("aborted", error);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Extra LOCAL typed assembly requirement: capture revision BEFORE invoking the original
 * authentication authority. handle-entry-only capture is insufficient (P6 regression gate).
 * Failure must be original auth facts, not terminal ledger health or a parsed cookie copy. */
export type TerminalAuthenticateV2 = (
  signal: AbortSignal,
) => Promise<{ ok: true; identity: AuthIdentity } | TerminalAuthFailureV2>;
export interface TerminalDispatchDepsV2 {
  routes: TerminalRoutesPortV2;
  auth: TerminalAuthFenceV2;
  authenticate: TerminalAuthenticateV2;
  now?: () => number;
}
export async function dispatchTerminalV2(
  deps: TerminalDispatchDepsV2,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  signal: AbortSignal,
): Promise<void> {
  if (!terminalPostV2Ok(req, ctx.externalOrigin)) {
    errorJson(res, fail("E_CSRF"));
    return;
  }
  const connection = new AbortController();
  const abort = () => connection.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  const wait = deadline(deps.now ?? Date.now, L.httpMs, [signal, connection.signal]);
  const revision = deps.auth.revision; // MUST precede authenticate's first invocation.
  try {
    requireLive(wait.signal);
    const result = await wait.wait(deps.authenticate(wait.signal));
    if (!result.ok) {
      errorJson(res, result);
      return;
    }
    deps.auth.check(result.identity, revision);
    requireLive(wait.signal);
    if (!(await wait.wait(deps.routes.handle(req, res, ctx, result.identity, wait.signal))))
      errorJson(res, fail("E_OFF"));
  } catch (error) {
    errorJson(res, asFailure(error));
  } finally {
    wait.dispose();
    req.off("aborted", abort);
    res.off("close", abort);
  }
}
export interface TerminalRoutesDepsV2 {
  service: TerminalServiceV2;
  views: TerminalViewPortV2 & { dispose(): void };
  auth: TerminalAuthFenceV2;
  notifications: Pick<TerminalAuthNotificationsV2, "subscribe">;
  hubInstance: string;
  now?: () => number;
  audit?: TerminalAuditV2;
}
export interface TerminalRoutesV2 extends TerminalRoutesPortV2 {
  auditHealth(): { failures: number };
}
export function createTerminalRoutesV2(deps: TerminalRoutesDepsV2): TerminalRoutesV2 {
  const now = deps.now ?? Date.now;
  const audit = terminalRouteAuditV2(now, deps.audit);
  let disposed = false;
  let flights = new AbortController();
  const off = deps.notifications.subscribe(() => {
    flights.abort();
    flights = new AbortController();
  });
  return {
    auditHealth: () => ({ failures: audit.failures() }),
    async handle(req, res, ctx, identity, signal) {
      const path = (req.url ?? "").split("?")[0];
      const op = (Object.keys(TERMINAL_V2_HTTP_PATHS) as TerminalOpV2[]).find(
        (candidate) => TERMINAL_V2_HTTP_PATHS[candidate] === path,
      );
      if (!op) return false;
      const startedAt = now();
      let auditCode: TerminalFailureV2["code"] | undefined;
      const revision = deps.auth.revision;
      const connection = new AbortController();
      const abort = () => connection.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      const wait = deadline(now, L.httpMs, [signal, flights.signal, connection.signal]);
      let accepted = false;
      const check = () => {
        deps.auth.check(identity, revision);
        requireLive(wait.signal);
      };
      try {
        if (disposed) throw new TerminalV2Fault(fail("E_OFF"));
        if (!terminalPostV2Ok(req, ctx.externalOrigin)) throw new TerminalV2Fault(fail("E_CSRF"));
        check();
        if (identity.listener !== ctx.kind) throw new TerminalV2Fault(fail("E_AUTH"));
        const raw = await wait.wait(body(req, wait.signal));
        check();
        if (!terminalHttpRequestV2Ok(op, raw)) throw new TerminalV2Fault(fail("E_BAD_REQUEST"));
        if ("hubInstance" in raw && raw.hubInstance !== deps.hubInstance)
          throw new TerminalV2Fault(fail("E_HUB_CHANGED"));
        // Branch-specific predicates preserve the P0 discriminated request types.
        const execute = async () => {
          switch (op) {
            case "list":
              if (terminalHttpRequestV2Ok("list", raw)) return deps.service.list(identity, raw.scope, wait.signal);
              break;
            case "create":
              if (terminalHttpRequestV2Ok("create", raw)) {
                accepted = true;
                const { scope, ...input } = raw;
                return deps.service.create(identity, scope, input, wait.signal);
              }
              break;
            case "creation":
              if (terminalHttpRequestV2Ok("creation", raw)) return deps.service.creation(identity, raw, wait.signal);
              break;
            case "rename":
              if (terminalHttpRequestV2Ok("rename", raw)) {
                accepted = true;
                return deps.service.rename(identity, raw, wait.signal);
              }
              break;
            case "close":
              if (terminalHttpRequestV2Ok("close", raw)) {
                accepted = true;
                return deps.service.close(identity, raw, wait.signal);
              }
              break;
            case "input":
              if (terminalHttpRequestV2Ok("input", raw)) {
                accepted = !("queryOnly" in raw);
                return deps.views.input(identity, raw, wait.signal);
              }
              break;
            case "resize":
              if (terminalHttpRequestV2Ok("resize", raw)) {
                accepted = true;
                return deps.views.resize(identity, raw, wait.signal);
              }
              break;
            case "ack":
              if (terminalHttpRequestV2Ok("ack", raw)) return deps.views.ack(identity, raw, wait.signal);
              break;
            case "view":
              if (terminalHttpRequestV2Ok("view", raw)) {
                const result = await deps.views.open(identity, raw, wait.signal);
                try {
                  check();
                } catch (error) {
                  if (result.ok) result.view.detach();
                  throw error;
                }
                if (!result.ok) return result;
                if (res.destroyed || res.writableEnded) {
                  result.view.detach();
                  return fail("E_VIEW_CHANGED");
                }
                try {
                  res.writeHead(200, TERMINAL_V2_VIEW_HEADERS);
                  res.flushHeaders();
                  const sink = terminalNdjsonSinkV2(req, res, () => result.view.detach());
                  result.view.start(sink);
                } catch (error) {
                  result.view.detach();
                  throw error;
                }
                return undefined;
              }
              break;
          }
          throw new TerminalV2Fault(fail("E_BAD_REQUEST"));
        };
        const result = await wait.wait(execute());
        check();
        if (result !== undefined) {
          if (result.ok) json(res, result);
          else {
            auditCode = result.code;
            errorJson(res, result);
          }
        }
      } catch (error) {
        let failure = asFailure(error);
        if (accepted && failure.code !== "E_INPUT_UNKNOWN") failure = fail(failure.code, "unknown");
        auditCode = failure.code;
        errorJson(res, failure);
      } finally {
        audit.record(op, identity.listener, startedAt, auditCode);
        wait.dispose();
        req.off("aborted", abort);
        res.off("close", abort);
      }
      return true;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      off();
      flights.abort();
      deps.views.dispose();
      audit.dispose();
      // Service/backend/ledger lifecycle belongs to P6, not routes.
    },
  };
}
