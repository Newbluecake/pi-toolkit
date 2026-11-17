import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { acceptsGzip } from "../gzip.js";
import type { TerminalAuditRecord } from "../audit.js";
import type { SseClient } from "../sse.js";
import type { AuthIdentity } from "../auth-identity.js";
import type { TerminalSseBinding } from "../ports.js";
import type { TerminalSseIdentity } from "../../protocol/terminal.js";
import { TerminalRevocationFence, matches } from "./revocation-fence.js";
import { TerminalFault, terminalClock, clampSpanMs } from "./limits.js";
export type LiveTerminalBinding = TerminalSseBinding & {
  readonly identity: AuthIdentity;
  readonly active: boolean;
  activate(): void;
  onRevoke(fn: () => void): () => void;
};
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function terminalSseOriginOk(req: IncomingMessage, origin: string): boolean {
  const o = req.headers.origin;
  if (o !== undefined && o !== origin) return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}
export class TerminalSseBindings {
  private bindings = new Map<string, LiveTerminalBinding>();
  private off: () => void;
  private admissions = new Map<string, { identity: AuthIdentity; cancel(): void }>();
  private diagnosticAt = -Infinity;
  private diagnosticCount = 0;
  constructor(
    private readonly fence: TerminalRevocationFence,
    private readonly now: () => number,
    private readonly audit: (record: TerminalAuditRecord) => void = () => {},
  ) {
    this.off = fence.subscribe((s) => {
      for (const a of this.admissions.values()) if (matches(s, a.identity)) a.cancel();
      for (const b of this.bindings.values()) if (matches(s, b.identity)) b.revoke();
    });
  }
  connect(
    req: IncomingMessage,
    res: ServerResponse,
    id: AuthIdentity,
    clientId: string,
    origin: string,
    output: SseClient["output"],
    unavailable: (reason?: string) => void = () => {},
  ): LiveTerminalBinding | undefined {
    if (!terminalSseOriginOk(req, origin)) return undefined;
    let p;
    try {
      p = this.fence.proof(id);
    } catch {
      return undefined;
    }
    const k = `${id.listener}:${clientId}`;
    const encoding = acceptsGzip(
      typeof req.headers["accept-encoding"] === "string" ? req.headers["accept-encoding"] : undefined,
    )
      ? "gzip"
      : "identity";
    const note = (code: string, phase: "admission" | "bound") => {
      if (this.now() - this.diagnosticAt >= 1000) {
        this.diagnosticAt = this.now();
        this.diagnosticCount = 0;
      }
      if (this.diagnosticCount++ >= 8) return;
      try {
        this.audit({
          op: "sse",
          listener: id.listener,
          ok: false,
          code,
          phase,
          encoding,
          pending: output.pendingBytes(),
        });
      } catch {
        /* fail-soft, no content */
      }
    };
    this.admissions.get(k)?.cancel();
    this.bindings.get(k)?.revoke();
    if (this.bindings.size + this.admissions.size >= 2048) {
      unavailable();
      return undefined;
    }
    const establish = (): LiveTerminalBinding | undefined => {
      let active = false;
      let published = false;
      const source = {}; // unique to this exact binding, never shared with public frames
      let publicPressure = false;
      const listeners = new Set<() => void>();
      const clock = terminalClock(this.now);
      const meta = {
        listener: id.listener,
        principal: id.principal,
        sidTag: id.sidTag,
        ...(id.userId === undefined ? {} : { userId: id.userId }),
        parentExpiresAt: Math.min(id.parentExpiresAt, p.hardExpiry),
        fenceRevision: this.fence.revision,
        authEpoch: p.authEpoch,
        connectionInstance: randomBytes(24).toString("base64url"),
        connectionToken: randomBytes(32).toString("base64url"),
        clientId,
        live: true,
      };
      const check = () => {
        if (!meta.live || res.destroyed || res.writableEnded || this.now() >= meta.parentExpiresAt) return false;
        try {
          return this.fence.proof(id) === p;
        } catch {
          return false;
        }
      };
      const b: LiveTerminalBinding = {
        metadata: meta,
        identity: { ...id },
        get active() {
          return active;
        },
        activate: () => {
          if (!check()) throw new TerminalFault("E_AUTH");
          active = true;
        },
        onRevoke: (fn) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        send: (event, payload) => {
          if (!check() || (event === "terminal" && !active)) {
            b.revoke();
            return false;
          }
          // Bypass publish/replay, never the original connection's encoder/FIFO.
          if (output.pendingBytes() > 65_536) {
            note("E_SSE_PRESSURE", published ? "bound" : "admission");
            // A public-only backlog must not kill chat/history/fleet. No new private
            // frame is accepted. If our source still owns queued/encoded/socket bytes,
            // revoke MUST synchronously abort the shared stream instead.
            publicPressure = output.pendingBytes(source) === 0;
            b.revoke();
            return false;
          }
          const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
          if (Buffer.byteLength(frame) > 24_576) {
            b.revoke();
            return false;
          }
          try {
            const ok = output.send(frame, source);
            if (!ok) b.revoke();
            else published = true;
            return ok;
          } catch {
            b.revoke();
            return false;
          }
        },
        revoke: () => {
          if (!meta.live) return;
          meta.live = false;
          active = false;
          clock.clearTimer(timer);
          if (this.bindings.get(k) === b) this.bindings.delete(k);
          for (const fn of listeners) {
            try {
              fn();
            } catch {
              this.fence.revoke("all");
            }
          }
          listeners.clear();
          // A local capability erasure must be observable by P2 immediately. Closing the
          // original SSE also prevents a stale browser from retaining rendered private data.
          // No token-bearing invalidation frame enters the legacy event ring.
          note("E_SSE_REVOKED", published ? "bound" : "admission");
          res.off("close", b.revoke);
          res.off("error", b.revoke);
          if (published && !publicPressure) output.abort();
          else unavailable(publicPressure ? "sse-public-pressure" : undefined);
        },
      };
      const timer = clock.setTimer(clampSpanMs(meta.parentExpiresAt - this.now()), () => b.revoke());
      this.bindings.set(k, b);
      res.once("close", b.revoke);
      res.once("error", b.revoke);
      b.send("terminal_connection", {
        connectionInstance: meta.connectionInstance,
        connectionToken: meta.connectionToken,
        expiresAt: meta.parentExpiresAt,
      });
      return published ? b : undefined;
    };
    // No capability has been published. A public bootstrap is NOT private pressure.
    // Wait only for an actual encoder/drain notification, never a polling/sleep loop.
    if (output.pendingBytes() > 0) {
      if (output.pendingBytes() > 65_536) note("E_SSE_BOOTSTRAP", "admission");
      const clock = terminalClock(this.now);
      const deadline = this.now() + 2000;
      let offIdle = () => {};
      let timer: ReturnType<typeof clock.setTimer> | undefined;
      let waiting = true;
      const cancel = () => {
        waiting = false;
        offIdle();
        if (timer !== undefined) clock.clearTimer(timer);
        res.off("close", cancel);
        res.off("error", cancel);
        if (this.admissions.get(k)?.cancel === cancel) this.admissions.delete(k);
      };
      const abandon = () => {
        if (!waiting) return;
        cancel();
        note("E_SSE_ADMISSION", "admission");
        unavailable("sse-admission-timeout");
      };
      this.admissions.set(k, { identity: id, cancel });
      res.once("close", cancel);
      res.once("error", cancel);
      timer = clock.setTimer(clampSpanMs(deadline - this.now()), abandon);
      offIdle =
        output.onIdle?.(() => {
          if (!waiting) return;
          if (this.now() >= deadline || res.destroyed || res.writableEnded || output.pendingBytes() > 65_536) {
            abandon();
            return;
          }
          try {
            if (this.fence.proof(id) !== p) {
              abandon();
              return;
            }
          } catch {
            abandon();
            return;
          }
          cancel();
          establish();
        }) ?? (() => {});
      return undefined;
    }
    return establish();
  }
  resolve(id: AuthIdentity, s: TerminalSseIdentity): LiveTerminalBinding {
    const p = this.fence.proof(id),
      b = this.bindings.get(`${id.listener}:${s.clientId}`),
      m = b?.metadata;
    if (
      !b ||
      !m ||
      !m.live ||
      m.principal !== id.principal ||
      m.sidTag !== id.sidTag ||
      m.authEpoch !== p.authEpoch ||
      m.userId !== id.userId ||
      m.connectionInstance !== s.connectionInstance ||
      !equal(m.connectionToken, s.connectionToken) ||
      this.now() >= m.parentExpiresAt
    )
      throw new TerminalFault("E_AUTH");
    b.activate();
    return b;
  }
  revokeAll() {
    for (const a of [...this.admissions.values()]) a.cancel();
    for (const b of [...this.bindings.values()]) b.revoke();
  }
  dispose() {
    this.off();
    this.revokeAll();
    this.bindings.clear();
  }
}
