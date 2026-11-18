/** Private metadata RPC. No cwd may enter registry/bus/public SSE or command history. */
import { randomBytes } from "node:crypto";
import type { TerminalContextPort, TerminalContextSnapshotV2 } from "../../terminal-v2-ports.js";
import type { TerminalContextRequest, TerminalScopeV2, TerminalSessionV2 } from "../../../protocol/terminal-v2.js";
import { terminalContextFrameV2Ok } from "../../../protocol/terminal-v2.js";
import { TERMINAL_V2_LIMITS as L } from "../../../protocol/terminal-v2-values.js";
import { deadline, fail, TerminalV2Fault } from "./local.js";

export interface TerminalContextLinkV2 {
  readonly instance: object;
  readonly scope: TerminalScopeV2;
  readonly declaration: TerminalSessionV2;
  readonly pendingBytes: number;
  send(frame: TerminalContextRequest): boolean;
}
export function createHubTerminalContextV2(deps: {
  link(agentKey: string): TerminalContextLinkV2 | undefined;
  permitted(scope: TerminalScopeV2): boolean;
  now?: () => number;
}) {
  const pending = new Map<string, { link: TerminalContextLinkV2; resolve(raw: unknown): void }>();
  const snapshots = new WeakMap<TerminalContextSnapshotV2, TerminalContextLinkV2>();
  let stopped = false;
  const target = (scope: TerminalScopeV2): TerminalContextLinkV2 | undefined => {
    const link = deps.link(scope.agentKey);
    if (
      stopped ||
      !deps.permitted(scope) ||
      !link ||
      link.scope.sessionId !== scope.sessionId ||
      link.scope.epoch !== scope.epoch ||
      link.declaration.sessionId !== scope.sessionId ||
      link.declaration.epoch !== scope.epoch
    )
      return undefined;
    return link;
  };
  const same = (captured: TerminalContextLinkV2): boolean => {
    const live = target(captured.scope);
    return (
      live?.instance === captured.instance &&
      live.declaration.contextGeneration === captured.declaration.contextGeneration &&
      JSON.stringify(live.declaration.limits) === JSON.stringify(captured.declaration.limits)
    );
  };
  const port: TerminalContextPort = {
    current(snapshot) {
      const link = snapshots.get(snapshot);
      return link !== undefined && same(link);
    },
    async resolve(scope, signal) {
      const link = target(scope);
      if (!link) throw new TerminalV2Fault(fail("E_UNSUPPORTED"));
      if (pending.size >= 32 || link.pendingBytes > L.frameBytes) throw new TerminalV2Fault(fail("E_RATE"));
      const wait = deadline(deps.now ?? Date.now, L.contextMs, [signal]);
      const rid = randomBytes(24).toString("base64url");
      try {
        const reply = new Promise<unknown>((resolve) => pending.set(rid, { link, resolve }));
        if (
          !link.send({
            t: "terminal_context_req",
            v: 2,
            rid,
            sessionId: scope.sessionId,
            epoch: scope.epoch,
            contextGeneration: link.declaration.contextGeneration,
          })
        )
          throw new TerminalV2Fault(fail("E_SESSION_CHANGED"));
        const raw = await wait.wait(reply);
        if (!same(link) || signal.aborted) throw new TerminalV2Fault(fail("E_SESSION_CHANGED"));
        if (!terminalContextFrameV2Ok(raw) || raw.t !== "terminal_context_res")
          throw new TerminalV2Fault(fail("E_UNSUPPORTED"));
        if (!raw.ok) throw new TerminalV2Fault(fail(raw.code === "E_SECURE" ? "E_UNSUPPORTED" : raw.code));
        if (
          raw.sessionId !== scope.sessionId ||
          raw.epoch !== scope.epoch ||
          raw.contextGeneration !== link.declaration.contextGeneration
        )
          throw new TerminalV2Fault(fail("E_SESSION_CHANGED"));
        const snapshot = Object.freeze({
          scope: Object.freeze({ ...scope }),
          cwd: raw.cwd,
          contextGeneration: raw.contextGeneration,
          linkInstance: link.instance,
          limits: Object.freeze({ ...link.declaration.limits }),
        });
        snapshots.set(snapshot, link);
        return snapshot;
      } finally {
        pending.delete(rid);
        wait.dispose();
      }
    },
  };
  return {
    port,
    target,
    consume(instance: object, raw: unknown): void {
      if (!terminalContextFrameV2Ok(raw) || raw.t !== "terminal_context_res") return;
      const flight = pending.get(raw.rid);
      if (flight?.link.instance === instance && same(flight.link)) flight.resolve(raw);
    },
    retire(instance: object): void {
      for (const flight of pending.values()) if (flight.link.instance === instance) flight.resolve(undefined);
    },
    dispose(): void {
      stopped = true;
      for (const flight of pending.values()) flight.resolve(undefined);
      pending.clear();
    },
  };
}
