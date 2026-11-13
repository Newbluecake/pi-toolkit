/** Dedicated preflight is metadata-only. No grant/ready/PTY before local authority.
 * Old peers receive only the existing offer/prepare sequence: no new query unless
 * their private challenge explicitly advertises support. No public cap is added. */
import { randomBytes } from "node:crypto";
import { createTerminalCommandIngress } from "../commands.js";
import type { TerminalAgentLink } from "../agent-server.js";
import type { TerminalIngressMeta, TerminalIngressPort } from "../ports.js";
import type { CmdFrame } from "../../protocol/messages.js";
import { terminalFrameOk, type TerminalLocalReference, type TermReq, type TermRes } from "../../protocol/terminal.js";
import { verifyLocalAuthority, type initializeTerminalStore } from "../../protocol/terminal-local.js";
import { bounded, clampSpanMs, sameTerminalMeta, TerminalFault } from "./limits.js";
import type { TerminalAgentTarget } from "./service.js";
const id = () => randomBytes(24).toString("base64url");
export function createTerminalLocalAuthority(deps: {
  store: Awaited<ReturnType<typeof initializeTerminalStore>>;
  link(key: string): TerminalAgentLink | undefined;
  now(): number;
}) {
  const known = new Map<
    string,
    { meta: TerminalIngressMeta; ownerInstance: string; reference: TerminalLocalReference }
  >();
  const inflight = new Map<string, Promise<void>>();
  const offers = new Map<string, { resolve(value: string): void; reject(error: unknown): void }>();
  const waits = new Map<
    string,
    { meta: TerminalIngressMeta; resolve(value: TermRes): void; reject(error: unknown): void }
  >();
  let disposed = false;
  const current = (meta: TerminalIngressMeta) =>
    !disposed && !!deps.link(meta.agentKey) && sameTerminalMeta(deps.link(meta.agentKey)!.meta, meta);
  const command = createTerminalCommandIngress({
    current,
    onOffer: (_meta, commandId, offer) => {
      const pending = offers.get(commandId);
      offers.delete(commandId);
      if (offer) pending?.resolve(offer.offerId);
      else pending?.reject(new TerminalFault("E_UNSUPPORTED"));
    },
    onDedicated: (meta, raw) => {
      if (!terminalFrameOk(raw)) return;
      const frame = raw as TermRes;
      if (frame.t !== "term_res" || frame.sessionId !== meta.sessionId || frame.epoch !== meta.epoch) return;
      const pending = waits.get(frame.rid);
      if (pending && sameTerminalMeta(pending.meta, meta)) {
        waits.delete(frame.rid);
        pending.resolve(frame);
      }
    },
  });
  function target(key: string): TerminalAgentTarget | undefined {
    const saved = known.get(key),
      link = deps.link(key);
    if (!saved || !link || disposed || !sameTerminalMeta(saved.meta, link.meta)) return undefined;
    try {
      const record = verifyLocalAuthority(deps.store, saved.reference, {
        pid: link.agentId.pid,
        agentNonce: link.agentId.nonce,
        sessionId: link.meta.sessionId,
        epoch: link.meta.epoch,
        ownerInstance: saved.ownerInstance,
      });
      return {
        meta: { ...link.meta },
        processIdentity: { ...record.process },
        ownerInstance: saved.ownerInstance,
        allowed: true,
      };
    } catch {
      return undefined;
    }
  }
  async function exchange(
    meta: TerminalIngressMeta,
    frame: TermReq,
    at: number,
    signal: AbortSignal,
  ): Promise<TermRes> {
    if (waits.size >= 64 || !current(meta)) throw new TerminalFault("E_UNAVAILABLE");
    let resolve!: (value: TermRes) => void, reject!: (error: unknown) => void;
    const work = new Promise<TermRes>((a, b) => {
      resolve = a;
      reject = b;
    });
    void work.catch(() => {});
    waits.set(frame.rid, { meta, resolve, reject });
    try {
      if (!deps.link(meta.agentKey)?.send(frame)) throw new TerminalFault("E_UNAVAILABLE");
      const result = await bounded(work, deps.now, at, signal);
      if (!current(meta)) throw new TerminalFault("E_SESSION_CHANGED");
      return result;
    } finally {
      waits.delete(frame.rid);
    }
  }
  async function discover(link: TerminalAgentLink, signal: AbortSignal) {
    const meta = { ...link.meta },
      at = deps.now() + clampSpanMs(2000);
    const commandId = id(),
      rid = id();
    if (!command.register(meta, { commandId, rid })) throw new TerminalFault("E_LIMIT");
    let resolve!: (value: string) => void, reject!: (error: unknown) => void;
    const offered = new Promise<string>((a, b) => {
      resolve = a;
      reject = b;
    });
    void offered.catch(() => {});
    offers.set(commandId, { resolve, reject });
    try {
      const frame: CmdFrame = {
        t: "cmd",
        rid,
        id: commandId,
        deadlineMs: clampSpanMs(at - deps.now()),
        origin: { listener: "loopback", ip: "terminal", reqId: rid },
        cmd: {
          op: "command",
          name: "webhub",
          expect: { sessionId: meta.sessionId },
          args: `__terminal ${JSON.stringify({ v: 1, action: "resource_inventory", requestNonce: id() })}`,
        },
      };
      if (!current(meta) || !link.send(frame)) throw new TerminalFault("E_UNAVAILABLE");
      const offerId = await bounded(offered, deps.now, at, signal),
        hubNonce = id();
      const challenge = await exchange(
        meta,
        {
          t: "term_req",
          v: 1,
          rid: id(),
          sessionId: meta.sessionId,
          epoch: meta.epoch,
          op: "prepare_protocol",
          offerId,
          hubNonce,
        },
        at,
        signal,
      );
      if (
        !challenge.ok ||
        challenge.op !== "protocol_challenge" ||
        challenge.offerId !== offerId ||
        challenge.hubNonce !== hubNonce ||
        challenge.authorityAvailable !== true ||
        !command.bindOwner(meta, commandId, challenge.ownerInstance)
      )
        throw new TerminalFault("E_UNSUPPORTED");
      const authority = await exchange(
        meta,
        { t: "term_req", v: 1, rid: id(), sessionId: meta.sessionId, epoch: meta.epoch, op: "authority" },
        at,
        signal,
      );
      if (!authority.ok || authority.op !== "authority" || authority.ownerInstance !== challenge.ownerInstance)
        throw new TerminalFault("E_UNAVAILABLE");
      verifyLocalAuthority(deps.store, authority.authority, {
        pid: link.agentId.pid,
        agentNonce: link.agentId.nonce,
        sessionId: meta.sessionId,
        epoch: meta.epoch,
        ownerInstance: challenge.ownerInstance,
      });
      if (!current(meta) || signal.aborted || deps.now() >= at) throw new TerminalFault("E_SESSION_CHANGED");
      if (!known.has(meta.agentKey) && known.size >= 64) throw new TerminalFault("E_LIMIT");
      known.set(meta.agentKey, { meta, ownerInstance: authority.ownerInstance, reference: authority.authority });
    } finally {
      offers.delete(commandId);
      command.expire(meta, commandId);
    }
  }
  const port: TerminalIngressPort = {
    ...command,
    retireLink(meta) {
      command.retireLink(meta);
      if (known.get(meta.agentKey)?.meta.linkGen === meta.linkGen) known.delete(meta.agentKey);
      for (const [rid, pending] of waits)
        if (pending.meta.agentKey === meta.agentKey && pending.meta.linkGen === meta.linkGen) {
          waits.delete(rid);
          pending.reject(new TerminalFault("E_SESSION_CHANGED"));
        }
    },
  };
  return {
    port,
    target,
    consumes(meta: TerminalIngressMeta, raw: unknown): boolean {
      if (command.ownsCommand(meta, raw)) {
        command.consumeAgentFrame(meta, raw);
        return true;
      }
      const frame = raw as { t?: unknown; rid?: unknown; op?: unknown };
      if (frame?.t === "term_res" && (frame.op === "authority" || waits.has(String(frame.rid)))) {
        command.consumeAgentFrame(meta, raw);
        return true;
      }
      return false;
    },
    async ensure(key: string, signal: AbortSignal) {
      if (target(key)) return;
      const saved = known.get(key),
        liveLink = deps.link(key);
      if (saved && liveLink && sameTerminalMeta(saved.meta, liveLink.meta)) throw new TerminalFault("E_UNAVAILABLE");
      known.delete(key); // a different real session/link is a new authority scope
      const link = deps.link(key);
      if (!link || disposed) throw new TerminalFault("E_UNAVAILABLE");
      const flightKey = JSON.stringify(link.meta);
      let work = inflight.get(flightKey);
      if (!work) {
        if (inflight.size >= 32) throw new TerminalFault("E_LIMIT");
        work = discover(link, signal).finally(() => inflight.delete(flightKey));
        inflight.set(flightKey, work);
      }
      try {
        await bounded(work, deps.now, deps.now() + clampSpanMs(2000), signal);
      } catch (error) {
        throw error instanceof TerminalFault ? error : new TerminalFault("E_UNAVAILABLE");
      }
      if (!target(key)) throw new TerminalFault("E_UNAVAILABLE");
    },
    dispose() {
      disposed = true;
      known.clear();
      for (const pending of waits.values()) pending.reject(new TerminalFault("E_DISABLED"));
      waits.clear();
      for (const pending of offers.values()) pending.reject(new TerminalFault("E_DISABLED"));
      offers.clear();
    },
  };
}
