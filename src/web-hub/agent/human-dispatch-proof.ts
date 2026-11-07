/** #39 host-only source bridge. P4 owns ONE instance and wires its handlers immediately
 * after secure guards, before reentrant input interceptors, even with WebHub off.
 * No wire/text lookup, XS budget, timer, provider-message identity or queued replay.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { HumanTurnTracker } from "../../memory/scopes/op-cap.js";
import { createOpApprovalPort, type OpApprovalDeps } from "../../memory/scopes/authorize.js";
import type {
  HumanDispatchProofPort,
  HumanDispatchTicket,
  HumanDispatchIngress,
  HumanIngressCandidate,
  MemoryOwner,
  HumanTurn,
} from "../../memory/scopes/types.js";
import { isFeishuCmdOrigin, type CmdOrigin } from "../protocol/messages.js";

export interface HumanDispatchDeps {
  owner(): MemoryOwner | undefined;
  context(): Pick<ExtensionContext, "mode" | "isIdle" | "hasPendingMessages"> | undefined;
  tracker: HumanTurnTracker;
  /** Main-session only, secure guard passed. Unknown/child/locked must return false. */
  enabled(): boolean;
}
type Candidate = {
  owner: MemoryOwner;
  generation: number;
  channel: "tui" | "web";
  ticket?: HumanDispatchTicket;
  token: HumanIngressCandidate;
};
type Scope = {
  ticket?: HumanDispatchTicket;
  admitted: boolean;
  claimed: boolean;
  candidate?: Candidate;
  turn?: HumanTurn;
};
const sameOwner = (a: MemoryOwner | undefined, b: MemoryOwner): boolean =>
  a !== undefined &&
  a.incarnation === b.incarnation &&
  a.sid === b.sid &&
  a.sessionEpoch === b.sessionEpoch &&
  a.branchGen === b.branchGen &&
  a.sessionFile === b.sessionFile;

export interface HumanDispatchBridge extends HumanDispatchProofPort {
  /** Only immediate browser prompt dispatch; never call from held/topic/replay release. */
  dispatchWeb<T>(cmdId: string, origin: CmdOrigin, send: () => T): T;
  onInput(ingress: HumanDispatchIngress): void;
  onBeforeAgentStart(event: Pick<BeforeAgentStartEvent, "messageType">): void;
  onAgentStart(): void;
  onSettled(): void;
}

export function createHumanDispatchProof(deps: HumanDispatchDeps): HumanDispatchBridge {
  const scope = new AsyncLocalStorage<Scope>();
  const used = new WeakSet<HumanDispatchTicket>();
  let active: Candidate | undefined;
  let generation = 0,
    dispatchGeneration = 0;
  let running = false,
    disposed = false;
  const allowed = (): boolean => {
    try {
      return !disposed && deps.enabled() === true;
    } catch {
      return false;
    }
  };
  const idle = (): boolean => {
    try {
      const ctx = deps.context();
      return allowed() && !running && ctx?.isIdle() === true && ctx.hasPendingMessages() === false;
    } catch {
      return false;
    }
  };
  const ownerNow = (): MemoryOwner | undefined => {
    try {
      return deps.owner();
    } catch {
      return undefined;
    }
  };
  const revoke: HumanDispatchProofPort["revoke"] = (reason) => {
    generation++;
    active = undefined;
    deps.tracker.invalidate(reason);
    if (reason === "session" || reason === "tree") running = false;
  };
  const port: HumanDispatchBridge = {
    runDispatch(ticket, send) {
      const admitted =
        idle() &&
        active === undefined &&
        sameOwner(ownerNow(), ticket.owner) &&
        !used.has(ticket) &&
        Number.isSafeInteger(ticket.dispatchGeneration) &&
        ticket.dispatchGeneration > dispatchGeneration &&
        (ticket.originKind === "loopback" || ticket.originKind === "lan");
      revoke("input");
      used.add(ticket);
      if (Number.isSafeInteger(ticket.dispatchGeneration))
        dispatchGeneration = Math.max(dispatchGeneration, ticket.dispatchGeneration);
      const state: Scope = { ticket, admitted, claimed: false };
      const failed = (): void => {
        state.admitted = false;
        if (active?.ticket === ticket || (state.turn !== undefined && deps.tracker.current() === state.turn))
          revoke("dispatch-error");
      };
      try {
        const result = scope.run(state, send);
        // Observe a returned rejection without changing the caller's return contract. The SDK
        // extension bridge returns void; ALS still reaches input and start in that case.
        if (result instanceof Promise) void result.catch(failed);
        return result;
      } catch (error) {
        failed();
        throw error;
      }
    },
    dispatchWeb(cmdId, origin, send) {
      const owner = ownerNow();
      if (!owner || isFeishuCmdOrigin(origin) || (origin.listener !== "loopback" && origin.listener !== "lan")) {
        // Explicitly mask inherited scopes, including reentrant machine/Feishu sends.
        return scope.run({ admitted: false, claimed: false }, send);
      }
      const ticket: HumanDispatchTicket = Object.freeze({
        cmdId,
        owner,
        nonce: Object.freeze({}),
        dispatchGeneration: dispatchGeneration + 1,
        originKind: origin.listener,
      });
      return port.runDispatch(ticket, send);
    },
    claim(owner, ingress) {
      const parent = scope.getStore();
      const admitted = idle() && active === undefined; // competing/nested pending input is ambiguous
      revoke("input");
      if (!allowed() || !sameOwner(ownerNow(), owner) || ingress.streamingBehavior !== undefined) return undefined;
      let state = parent;
      let channel: "tui" | "web";
      if (ingress.source === "interactive" && deps.context()?.mode === "tui" && admitted) {
        // enterWith binds the native SDK input -> prepareRun chain, not a global "next user".
        // A nested input invalidates generation; a custom start cannot claim a pending user.
        state = { admitted: true, claimed: true };
        scope.enterWith(state);
        channel = "tui";
      } else if (
        ingress.source === "extension" &&
        state?.ticket &&
        admitted &&
        state.admitted &&
        state.ticket.dispatchGeneration === dispatchGeneration &&
        !state.claimed &&
        sameOwner(state.ticket.owner, owner)
      ) {
        state.claimed = true;
        channel = "web";
      } else {
        if (state) state.claimed = true;
        return undefined;
      }
      const candidate: Candidate = {
        owner,
        generation,
        channel,
        token: Object.freeze({}) as HumanIngressCandidate,
        ...(state?.ticket ? { ticket: state.ticket } : {}),
      };
      active = candidate;
      state!.candidate = candidate;
      return candidate.token;
    },
    confirmStart(token, owner) {
      const candidate = active;
      active = undefined;
      if (
        !allowed() ||
        running ||
        !candidate ||
        candidate.token !== token ||
        candidate.generation !== generation ||
        !sameOwner(candidate.owner, owner) ||
        !sameOwner(ownerNow(), owner) ||
        scope.getStore()?.candidate !== candidate ||
        (candidate.ticket !== undefined && candidate.ticket.dispatchGeneration !== dispatchGeneration)
      )
        return undefined;
      const turn = candidate.channel === "tui" ? deps.tracker.noteInteractive(owner) : deps.tracker.noteWebTurn(owner);
      scope.getStore()!.turn = turn;
      return turn;
    },
    onInput(ingress) {
      const owner = ownerNow();
      if (owner) port.claim(owner, ingress);
      else revoke("input");
    },
    onBeforeAgentStart(event) {
      const candidate = active;
      const owner = ownerNow();
      if (event.messageType === "user" && candidate && owner) {
        if (!port.confirmStart(candidate.token, owner)) revoke("handled");
      } else revoke("handled");
      running = true;
    },
    onAgentStart() {
      // before_agent_start is the only mint point. An unobserved/foreign run revokes.
      if (!running) revoke("handled");
      running = true;
    },
    settled() {
      revoke("abort");
      running = false;
    },
    onSettled() {
      revoke("abort");
      running = false;
    },
    revoke,
    dispose() {
      revoke("shutdown");
      disposed = true;
      scope.disable();
    },
  };
  return port;
}

/** Idempotence belongs to the instance, not a module/global registry. P4 calls this once
 * after secure guards in both TUI-only and Web deployments. WebHub itself registers NO
 * auxiliary hooks. owner() must change on session/tree boundaries, NOT ordinary leaf append.
 */
export function createHumanDispatchHookOwner(bridge: HumanDispatchBridge): (pi: ExtensionAPI) => void {
  const wired = new WeakSet<ExtensionAPI>();
  return (pi) => {
    if (wired.has(pi)) return;
    wired.add(pi);
    pi.on("input", (event) => {
      bridge.onInput(event);
      return { action: "continue" };
    });
    pi.on("before_agent_start", (event) => {
      bridge.onBeforeAgentStart(event);
    });
    pi.on("agent_start", () => {
      bridge.onAgentStart();
    });
    pi.on("agent_end", () => {
      bridge.revoke("abort");
    });
    pi.on("agent_settled", () => {
      bridge.onSettled();
    });
    pi.on("session_start", () => {
      bridge.revoke("session");
    });
    pi.on("session_tree", () => {
      bridge.revoke("tree");
    });
    pi.on("session_shutdown", () => {
      bridge.revoke("shutdown");
    });
  };
}

/** Production local-select adapter: hasUI alone (notably RPC proxy UI) grants nothing.
 * P4 supplies the SAME tracker/registry used by this bridge and a live remote port.
 */
export function createHumanOpApproval(
  deps: Omit<OpApprovalDeps, "select" | "localSelectForbidden" | "remote"> & {
    readonly remote?: import("../../ask-user/remote.js").AskUserRemotePort | undefined;
    context(): Pick<ExtensionContext, "mode" | "ui"> | undefined;
  },
) {
  const { remote: _initialRemote, ...rest } = deps;
  const approvalDeps: OpApprovalDeps = {
    ...rest,
    select: async (title, options, opts) => {
      const ctx = deps.context();
      if (ctx?.mode !== "tui" || typeof ctx.ui?.select !== "function") return undefined;
      return ctx.ui.select(title, [...options], opts);
    },
    get localSelectForbidden() {
      const ctx = deps.context();
      return ctx?.mode !== "tui" || typeof ctx.ui?.select !== "function";
    },
  };
  Object.defineProperty(approvalDeps, "remote", { get: () => deps.remote });
  return createOpApprovalPort(approvalDeps);
}
