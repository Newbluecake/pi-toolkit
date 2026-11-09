/** Early, scopes-only assembly. Child receiver does not invent SDK resume facts or human hooks. */
import type { ScopedMemoryDispatcher } from "../unified/dispatcher.js";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../../config/settings.js";
import type { AskUserRemotePort } from "../../ask-user/remote.js";
import { isWebInvocation } from "../../commands/capture.js";
import { createHumanDispatchHookOwner, type HumanDispatchBridge } from "../../web-hub/agent/human-dispatch-proof.js";
import { scopedFailure } from "./error-messages.js";
import { resolveHubSlot } from "./hub-slot.js";
import { receiveMemoryChildBinding, type MemoryBindRequest } from "./child-bind.js";
import { createMemoryOwner, hasMemoryManagerCapabilities, type MemoryOwnerRuntime } from "./owner.js";
import type { EffectiveHubSlot, SessionWriteGate } from "./types.js";

export interface MemoryScopesGroup {
  readonly childBinding: import("./child-bind.js").MemoryChildBindingPort;
  readonly gate: SessionWriteGate;
  runtime(): MemoryOwnerRuntime | undefined;
  dispose(): void;
}
export interface MemoryScopesWiring {
  current(): MemoryOwnerRuntime | undefined;
  group(): MemoryScopesGroup | undefined;
  proof: HumanDispatchBridge;
  context(ctx: ExtensionContext): void;
  /** wireMemory supplies the sole per-activation dispatcher after both surfaces are built. */
  attachDispatcher(dispatcher: ScopedMemoryDispatcher): void;
  command(args: string, ctx: ExtensionCommandContext): Promise<{ handled: boolean; result?: unknown }>;
  dispose(): void;
}
export function wireMemoryScopes(
  pi: ExtensionAPI,
  opts: {
    settings: MemorySettings;
    child: boolean;
    domain: "plain" | "secure" | "locked";
    gate: SessionWriteGate;
    locked(): boolean;
    remote(): AskUserRemotePort | undefined;
    hubPaths(): { readonly stateDir: string } | undefined;
  },
): MemoryScopesWiring | undefined {
  if (!opts.settings.enabled || opts.domain !== "plain" || (!opts.settings.scopes.session && !opts.settings.scopes.hub))
    return undefined;
  let dispatcher: ScopedMemoryDispatcher | undefined;
  let closed = false;
  let ctx: ExtensionContext | undefined;
  let commandCtx: ExtensionCommandContext | undefined;
  let group: MemoryScopesGroup | undefined;
  let runtime: MemoryOwnerRuntime | undefined;
  let epoch = 0,
    tree = 0;
  let childRequest: MemoryBindRequest | undefined;
  let receiverOff: (() => void) | undefined;
  const current = () => (runtime?.current() ? runtime : undefined);
  const proof: HumanDispatchBridge = {
    runDispatch: (ticket, send) => {
      const r = current();
      return r ? r.proof.runDispatch(ticket, send) : send();
    },
    dispatchWeb: (id, origin, send) => {
      const r = current();
      return r ? r.proof.dispatchWeb(id, origin, send) : send();
    },
    claim: (owner, ingress) => current()?.proof.claim(owner, ingress),
    confirmStart: (candidate, owner) => current()?.proof.confirmStart(candidate, owner),
    settled: (owner) => {
      current()?.proof.settled(owner);
    },
    onInput: (ingress) => {
      current()?.proof.onInput(ingress);
    },
    onBeforeAgentStart: (event) => {
      current()?.proof.onBeforeAgentStart(event);
    },
    onAgentStart: () => {
      current()?.proof.onAgentStart();
    },
    onSettled: () => {
      current()?.proof.onSettled();
    },
    revoke: (reason) => {
      current()?.proof.revoke(reason);
    },
    dispose: () => {
      group?.dispose();
    },
  };
  function open(manager: unknown, reason: string, inherited?: EffectiveHubSlot) {
    if (closed) return undefined;
    group?.dispose();
    group = undefined;
    runtime = undefined;
    activeTree = undefined;
    // Capability absence is effective-off, before paths/poison/authority are constructed.
    // Do not catch real manager failures here or turn them into an empty inheritance seed.
    if (!hasMemoryManagerCapabilities(manager)) return undefined;
    epoch++;
    tree = 0;
    const paths = !inherited && opts.settings.scopes.hub ? opts.hubPaths() : undefined;
    const slot = opts.settings.scopes.hub
      ? (inherited ?? Object.freeze(resolveHubSlot({ ...(paths ? { paths } : {}), env: process.env })))
      : undefined;
    let live = true;
    let owned: MemoryOwnerRuntime | undefined;
    const build = (why: string) =>
      createMemoryOwner({
        manager,
        append: (type, data) => {
          if (opts.child) {
            if (!manager.appendCustomEntry) throw Error("E_WRITE_GATE");
            manager.appendCustomEntry(type, data);
          } else pi.appendEntry(type, data);
        },
        enabled: opts.settings.scopes,
        child: opts.child,
        sessionEpoch: epoch,
        branchGen: tree,
        reason: why,
        ...(slot ? { slot } : {}),
        context: () => ctx,
        isCurrent: () => {
          if (!live || owned !== runtime) return false;
          try {
            return ctx === undefined || ctx.sessionManager === manager;
          } catch {
            return false;
          }
        },
        locked: opts.locked,
        gate: opts.gate,
        remote: opts.remote,
        commandContext: () => ({
          mode: commandCtx?.mode ?? "unknown",
          hasUI: commandCtx?.hasUI ?? false,
          isWeb: commandCtx ? isWebInvocation(commandCtx) : false,
        }),
      });
    // Factory reads owner before publication only for recovery. isCurrent is exact group-local live identity.
    owned = build(reason);
    runtime = owned;
    const thisGroup: MemoryScopesGroup = {
      childBinding: Object.freeze(slot ? { frozenParentHubSlot: slot } : {}),
      gate: opts.gate,
      runtime: () => (live ? owned : undefined),
      dispose() {
        if (!live) return;
        live = false;
        owned?.dispose();
        if (runtime === owned) runtime = undefined;
      },
    };
    group = thisGroup;
    return {
      group: thisGroup,
      tree() {
        if (!live) return;
        owned?.dispose();
        tree++;
        owned = build("tree");
        runtime = owned;
      },
    };
  }
  let activeTree: (() => void) | undefined;
  function context(next: ExtensionContext) {
    if (closed) return;
    try {
      const manager = next.sessionManager;
      if (!hasMemoryManagerCapabilities(manager)) {
        group?.dispose();
        group = undefined;
        activeTree = undefined;
        ctx = next;
        return;
      }
      if (
        !runtime ||
        manager !== runtime.manager ||
        manager.getSessionId() !== runtime.owner.sid ||
        manager.getSessionFile() !== runtime.owner.sessionFile
      ) {
        if (opts.child) {
          group?.dispose();
          return;
        }
        ctx = next;
        const opened = open(manager, "context");
        activeTree = opened?.tree;
      }
      ctx = next;
    } catch {
      group?.dispose();
      ctx = undefined;
    }
  }
  if (opts.child) {
    receiverOff = receiveMemoryChildBinding(pi.events, (request) => {
      childRequest = request;
      const opened = open(request.manager, request.reason, request.frozenParentHubSlot);
      activeTree = opened?.tree;
      return () => {
        opened?.group.dispose();
        if (childRequest === request) {
          ctx = undefined;
          childRequest = undefined;
        }
      };
    });
  } else {
    // These precede the bridge hooks (and every downstream handled/reentrant interceptor).
    pi.on("session_start", (event, next) => {
      closed = false;
      ctx = next;
      const opened = open(next.sessionManager, event.reason);
      activeTree = opened?.tree;
    });
    pi.on("input", (_event, next) => {
      context(next);
    });
    pi.on("before_agent_start", (_event, next) => {
      context(next);
    });
    pi.on("agent_start", (_event, next) => {
      context(next);
    });
    createHumanDispatchHookOwner(proof)(pi);
    pi.on("session_shutdown", () => {
      closed = true;
      group?.dispose();
      ctx = undefined;
    });
  }
  pi.on("session_tree", (_event, next) => {
    context(next);
    activeTree?.();
  });
  // Scope-only tool. Old memory/mem descriptions and schemas remain unchanged.
  if (!opts.child || opts.settings.scopes.session) pi.registerTool(createMemoryOwnerTool());
  function createMemoryOwnerTool() {
    // Schema factory needs only declared flags, not a live manager/global store.
    const { name, label, description, parameters } = createScopedToolSchema();
    const schema = { name, label, description, parameters };
    return {
      ...schema,
      async execute(id: string, input: unknown, signal?: AbortSignal, _update?: unknown, next?: ExtensionContext) {
        if (next) context(next);
        if (dispatcher) {
          const result = await dispatcher.scoped(id, input, signal);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
        }
        const r = current();
        return r
          ? r.tool.execute(id, input, signal)
          : {
              content: [{ type: "text" as const, text: JSON.stringify(scopedFailure("E_STALE_SESSION")) }],
              details: undefined,
            };
      },
    };
  }
  function createScopedToolSchema() {
    return createScopedMemoryTool({
      enabled: opts.settings.scopes,
      child: opts.child,
      capability: () => "unknown",
      currentOwner: () => {
        throw Error("E_STALE_SESSION");
      },
      signal: () => new AbortController().signal,
      sharedApproval: {
        request: async () => ({ approved: false, code: "E_STALE_SESSION" }),
        revoke() {},
        dispose() {},
      },
      caps: { revoke() {} },
      humanTurn: () => undefined,
      projectLabel: () => "project",
    });
  }
  return {
    current,
    group: () => group,
    proof,
    context,
    attachDispatcher(next) {
      dispatcher = next;
    },
    async command(args, next) {
      context(next);
      commandCtx = next;
      try {
        return (
          (await current()?.command.route(args)) ?? {
            handled: /^(session|hub)(?: |$)/.test(args),
            result: scopedFailure("E_STALE_SESSION"),
          }
        );
      } finally {
        if (commandCtx === next) commandCtx = undefined;
      }
    },
    dispose() {
      closed = true;
      receiverOff?.();
      group?.dispose();
      // Routing is stateless and follows this wiring's lifetime/GC. Retain the injected
      // instance so a real session_start can resume through it, never a second route.
      ctx = undefined;
    },
  };
}
import { createScopedMemoryTool } from "./tool.js";

/** Real owning parent read, not a shadow child registry. Missing/changed reads reject admission. */
export function captureMemorySeed(
  group: MemoryScopesGroup | undefined,
  runner: Pick<import("../../service/ports.js").Runner, "getRunState" | "peekBranch">,
  parentRunId?: string,
): import("./types.js").MemorySeedCapture {
  const r = group?.runtime();
  if (!r?.session || !r.current() || r.capability() !== "ok") throw Error("memory parent unavailable");
  let capture: import("./types.js").MemorySeedCapture;
  if (parentRunId === undefined) capture = r.session.snapshot();
  else {
    const before = runner.getRunState?.(parentRunId);
    if (!before?.sessionId || before.status === "stopping" || isTerminalStatus(before.status) || !runner.peekBranch)
      throw Error("memory nested parent unavailable");
    const branch = runner.peekBranch(parentRunId);
    const after = runner.getRunState?.(parentRunId);
    if (
      !branch ||
      !after ||
      before.generation !== after.generation ||
      before.sessionId !== after.sessionId ||
      before.status !== after.status ||
      isTerminalStatus(after.status)
    )
      throw Error("memory nested parent changed");
    const folded = foldSessionMemory(branch, before.sessionId);
    capture = folded.items.length
      ? {
          v: 1,
          state: "captured",
          seed: {
            v: 1,
            fromSid: before.sessionId,
            frozenAt: new Date().toISOString(),
            items: folded.items.map((i) => i.item),
            nextN: folded.nextN,
          },
        }
      : { v: 1, state: "empty" };
  }
  if (group?.runtime() !== r || !r.current() || r.capability() !== "ok") throw Error("memory parent changed");
  const checked = validateSeedCapture(capture);
  if (!checked.ok) throw Error(`memory seed capture failed: ${checked.reason}`);
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(checked.capture);
}
import { foldSessionMemory } from "./session-fold.js";
import { validateSeedCapture } from "./limits.js";
import { isTerminalStatus } from "../../core/status.js";
