import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  constructor(
    private readonly fence: TerminalRevocationFence,
    private readonly now: () => number,
  ) {
    this.off = fence.subscribe((s) => {
      for (const b of this.bindings.values()) if (matches(s, b.identity)) b.revoke();
    });
  }
  connect(
    req: IncomingMessage,
    res: ServerResponse,
    id: AuthIdentity,
    clientId: string,
    origin: string,
  ): LiveTerminalBinding | undefined {
    if (!terminalSseOriginOk(req, origin)) return undefined;
    let p;
    try {
      p = this.fence.proof(id);
    } catch {
      return undefined;
    }
    if (this.bindings.size >= 2048) return undefined;
    const k = `${id.listener}:${clientId}`;
    this.bindings.get(k)?.revoke();
    let active = false;
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
        // Terminal events bypass SseHub.publish AND its replay ring; only this original socket.
        if (res.writableLength > 65_536) {
          b.revoke();
          return false;
        }
        const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
        if (Buffer.byteLength(frame) > 24_576) {
          b.revoke();
          return false;
        }
        try {
          const ok = res.write(frame);
          if (!ok) b.revoke();
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
      },
    };
    const timer = clock.setTimer(clampSpanMs(meta.parentExpiresAt - this.now()), () => b.revoke());
    this.bindings.set(k, b);
    res.once("close", () => b.revoke());
    res.once("error", () => b.revoke());
    b.send("terminal_connection", {
      connectionInstance: meta.connectionInstance,
      connectionToken: meta.connectionToken,
      expiresAt: meta.parentExpiresAt,
    });
    return b;
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
  dispose() {
    this.off();
    for (const b of [...this.bindings.values()]) b.revoke();
    this.bindings.clear();
  }
}
