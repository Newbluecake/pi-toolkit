/** T51 v2 agent-only metadata producer. Not wired until P6 replaces v1 assembly.
 * No IO, timers, registration, PTY/authority/receipt or hub implementation imports.
 * P6 supplies trusted live facts and the post-HOST_KEY guard, never wire/browser facts.
 * The hub owns resolve/rid deadlines, link correlation and same-create-request capture. */
import type { StatusInfo } from "../../protocol/messages.js";
import {
  parseTerminalSessionV2,
  terminalContextFrameV2Ok,
  type TerminalContextReply,
  type TerminalSessionV2,
  type TerminalTargetLimitsV2,
} from "../../protocol/terminal-v2.js";
import { terminalCwdV2Ok } from "../../protocol/terminal-v2-values.js";

/** Structural subset of pi's current event context; no SDK runtime dependency. */
export interface TerminalAgentContextV2 {
  readonly cwd: string;
  readonly mode: string;
  readonly sessionManager: { getSessionId(): string | undefined };
}
export interface TerminalContextFactsV2<C extends TerminalAgentContextV2> {
  readonly ctx: C;
  readonly epoch: string;
  /** Exact live connection binding object; do not reconstruct it from an id. */
  readonly linkInstance: object;
  readonly domain: "plain" | "secure" | "locked" | "unknown";
  readonly privateNamespace: "not-ns" | "in-ns" | "unknown";
  readonly isChild: boolean;
  readonly enabled: boolean;
  readonly control: boolean;
  readonly webCommands: boolean;
  readonly limits: TerminalTargetLimitsV2;
}
export interface TerminalContextProducerDepsV2<C extends TerminalAgentContextV2> {
  /** undefined while detached/offline/shutting down. Read afresh on every projection/request. */
  current(): TerminalContextFactsV2<C> | undefined;
  /** Missing/throwing/withdrawn guard is denial, never a plain-domain fallback. */
  guard?: (ctx: C) => boolean;
}
type Denial = Extract<TerminalContextReply, { ok: false }>["code"];
type Live<C extends TerminalAgentContextV2> = {
  facts: TerminalContextFactsV2<C>;
  declaration: TerminalSessionV2;
};

export function createTerminalContextProducer<C extends TerminalAgentContextV2>(
  deps: TerminalContextProducerDepsV2<C>,
) {
  let generation = 0;
  let disposed = false;
  let revision: object = {};
  // Only correlation identity is retained. Never retain cwd, a positive guard or a status frame.
  let active: { sessionId: string; epoch: string; linkInstance: object; generation: number } | undefined;
  const withdraw = (): void => {
    revision = {};
    active = undefined;
  };
  const deny = (code: Denial): Denial => {
    withdraw(); // Observing withdrawal is sticky; restoring old values cannot revive this generation.
    return code;
  };
  const inspect = (): Live<C> | Denial => {
    try {
      const facts = deps.current();
      if (!facts) return deny("E_SESSION_CHANGED");
      if (facts.domain !== "plain" || facts.privateNamespace !== "not-ns") return deny("E_SECURE");
      if (
        facts.isChild !== false ||
        facts.enabled !== true ||
        facts.control !== true ||
        facts.webCommands !== true ||
        (facts.ctx.mode !== "tui" && facts.ctx.mode !== "rpc") ||
        !deps.guard ||
        typeof facts.linkInstance !== "object" ||
        facts.linkInstance === null
      )
        return deny("E_UNSUPPORTED");
      // Guard may synchronously reenter/withdraw. Its result alone is never stored as authority.
      const before = revision;
      let guarded = false;
      try {
        guarded = deps.guard(facts.ctx) === true;
      } catch {
        return deny("E_SECURE");
      }
      if (!guarded) return deny("E_SECURE");
      if (before !== revision) return "E_SESSION_CHANGED";
      const fresh = deps.current();
      if (
        !fresh ||
        fresh.ctx !== facts.ctx ||
        fresh.epoch !== facts.epoch ||
        fresh.linkInstance !== facts.linkInstance ||
        fresh.domain !== facts.domain ||
        fresh.privateNamespace !== facts.privateNamespace ||
        fresh.isChild !== facts.isChild ||
        fresh.enabled !== facts.enabled ||
        fresh.control !== facts.control ||
        fresh.webCommands !== facts.webCommands ||
        fresh.limits.maxPerSession !== facts.limits.maxPerSession ||
        fresh.limits.inputIdleMs !== facts.limits.inputIdleMs ||
        fresh.limits.maxLifetimeMs !== facts.limits.maxLifetimeMs
      )
        return deny("E_SESSION_CHANGED");
      const declaration = parseTerminalSessionV2({
        v: 2,
        enabled: true,
        sessionId: facts.ctx.sessionManager.getSessionId(),
        epoch: facts.epoch,
        contextGeneration: generation,
        limits: { ...facts.limits },
      });
      if (!declaration) return deny("E_UNSUPPORTED");
      return { facts, declaration };
    } catch {
      return deny("E_UNSUPPORTED");
    }
  };
  const live = (): Live<C> | Denial => {
    if (disposed) return "E_UNSUPPORTED";
    const before = active;
    const value = inspect();
    if (typeof value === "string") return value;
    if (
      !before ||
      before !== active ||
      before.generation !== generation ||
      before.sessionId !== value.declaration.sessionId ||
      before.epoch !== value.declaration.epoch ||
      before.linkInstance !== value.facts.linkInstance
    )
      return deny("E_SESSION_CHANGED");
    return value;
  };
  const declaration = (): TerminalSessionV2 | undefined => {
    const value = live();
    if (typeof value === "string") return undefined;
    return Object.freeze({ ...value.declaration, limits: Object.freeze({ ...value.declaration.limits }) });
  };

  return {
    /** Explicit session/link boundary only, never a tick/request/eligibility-recovery retry.
     * Retire the old generation BEFORE capturing a successor, even for identical session ids. */
    start(): boolean {
      withdraw();
      if (disposed || generation === Number.MAX_SAFE_INTEGER) {
        disposed = true;
        return false;
      }
      generation++;
      const before = revision;
      const value = inspect();
      if (typeof value === "string" || before !== revision || disposed) return false;
      active = {
        sessionId: value.declaration.sessionId,
        epoch: value.declaration.epoch,
        linkInstance: value.facts.linkInstance,
        generation,
      };
      return true;
    },
    withdraw,
    /** Permanent activation teardown. A stale callback cannot start it again. */
    dispose(): void {
      withdraw();
      disposed = true;
    },
    declaration,
    /** Write-time projection AFTER any other status transforms. Strip stored positives even
     * when current eligibility is absent. Store only the raw status, never this projection. */
    projectStatus<T extends StatusInfo>(
      frame: T,
    ): Omit<T, "terminalSessionV2"> & Pick<StatusInfo, "terminalSessionV2"> {
      const { terminalSessionV2: _discarded, ...raw } = frame;
      const current = declaration();
      return current ? { ...raw, terminalSessionV2: current } : raw;
    },
    /** Synchronous dedicated private ingress only. Malformed/non-request frames are consumed
     * by the caller without replying; never pass either request or reply to cmd/history/bus.
     * Pass the ORIGINAL receiving binding, and send immediately on that exact binding only. */
    reply(raw: unknown, linkInstance: object): TerminalContextReply | undefined {
      if (!terminalContextFrameV2Ok(raw) || raw.t !== "terminal_context_req") return undefined;
      const fail = (code: Denial): TerminalContextReply => ({
        t: "terminal_context_res",
        v: 2,
        rid: raw.rid,
        ok: false,
        code,
      });
      const value = live();
      if (typeof value === "string") return fail(value);
      const d = value.declaration;
      if (
        linkInstance !== value.facts.linkInstance ||
        raw.sessionId !== d.sessionId ||
        raw.epoch !== d.epoch ||
        raw.contextGeneration !== d.contextGeneration
      )
        return fail("E_SESSION_CHANGED"); // An obsolete request does not retire the valid current scope.
      try {
        const before = active;
        const cwd = value.facts.ctx.cwd; // Exactly once per RPC. No HOME/process/hub fallback or filesystem probe.
        if (!terminalCwdV2Ok(cwd)) return fail("E_CWD");
        // Cwd/guard access can reenter trusted lifecycle code. Never upgrade the original request
        // to a successor generation/context, even if the session id does an ABA in that callback.
        const after = live();
        if (typeof after === "string") return fail(after);
        if (
          !before ||
          before !== active ||
          after.facts.ctx !== value.facts.ctx ||
          after.facts.linkInstance !== linkInstance ||
          after.declaration.contextGeneration !== raw.contextGeneration
        )
          return fail("E_SESSION_CHANGED");
        return Object.freeze({
          t: "terminal_context_res",
          v: 2,
          rid: raw.rid,
          ok: true,
          sessionId: d.sessionId,
          epoch: d.epoch,
          contextGeneration: d.contextGeneration,
          cwd,
        });
      } catch {
        return fail("E_CWD");
      }
    },
  };
}
