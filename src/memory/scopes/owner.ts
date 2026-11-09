/** One actual-manager owner. All authority/closures are activation-local; poison alone is shared. */
import { createCommandConfirmKernel, type CommandConfirmKernel } from "../command-confirm.js";
import { executeConfirmedMemoryWrite } from "../command.js";
import type { MemoryWebDispatchRequest, MemoryWriteTask, WriteOutcome } from "./web-write-port.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskUserRemotePort } from "../../ask-user/remote.js";
import { createHumanDispatchProof, createHumanOpApproval } from "../../web-hub/agent/human-dispatch-proof.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "./op-cap.js";
import { createSessionCommandRegistry } from "./session-command.js";
import { createSessionMemoryStore, sessionPoisonIdentity } from "./session-store.js";
import { sharedSessionPoisonRegistry } from "./session-poison.js";
import { createHubMemoryProvider } from "./hub-store.js";
import { createScopedMemoryCommand, trustedNativeMemoryCommand, type NativeMemoryCommandContext } from "./command.js";
import { inspectScopedMemory } from "../unified/read.js";
import type { ScopedV4Port } from "../unified/types.js";
import { createScopedMemoryTool } from "./tool.js";
import { createScopedMemoryDoctor } from "./doctor.js";
import { hubMemoryRoot } from "./hub-slot.js";
import { isMemorySid, sha256Hex } from "./limits.js";
import type { MemoryChildManager } from "./child-bind.js";
import type { EffectiveHubSlot, MemoryOwner, SessionWriteGate } from "./types.js";

export interface MemoryOwnerDeps {
  readonly manager: MemoryChildManager;
  readonly append: (type: string, data: unknown) => void;
  readonly enabled: { readonly session: boolean; readonly hub: boolean };
  readonly child: boolean;
  readonly sessionEpoch: number;
  readonly branchGen: number;
  readonly reason: string;
  readonly slot?: EffectiveHubSlot;
  readonly context: () => ExtensionContext | undefined;
  readonly isCurrent: () => boolean;
  readonly locked: () => boolean;
  readonly commandContext: () => NativeMemoryCommandContext;
  readonly remote: () => AskUserRemotePort | undefined;
  readonly gate: SessionWriteGate;
}
/** Missing capabilities are not an empty session. Do not construct authority or read storage.
 * A present method that throws (including an accessor) is a host failure, not feature-off.
 */
export function hasMemoryManagerCapabilities(manager: unknown): manager is MemoryChildManager {
  if (typeof manager !== "object" || manager === null) return false;
  const candidate = manager as Partial<MemoryChildManager>;
  return (
    typeof candidate.getSessionId === "function" &&
    typeof candidate.getSessionFile === "function" &&
    typeof candidate.getBranch === "function"
  );
}
export function createMemoryOwner(deps: MemoryOwnerDeps) {
  const manager = deps.manager;
  if (!hasMemoryManagerCapabilities(manager)) return undefined;
  const sid = manager.getSessionId(),
    file = manager.getSessionFile();
  if (!isMemorySid(sid) || (file !== undefined && typeof file !== "string"))
    throw Error("invalid memory session identity");
  const owner: MemoryOwner = Object.freeze({
    incarnation: Object.freeze({}),
    sid,
    ...(file === undefined ? {} : { sessionFile: file }),
    sessionEpoch: deps.sessionEpoch,
    branchGen: deps.branchGen,
  });
  const abort = new AbortController();
  let disposed = false;
  const current = () => {
    if (disposed || !deps.isCurrent()) return false;
    try {
      return manager.getSessionId() === sid && manager.getSessionFile() === file;
    } catch {
      return false;
    }
  };
  const requireOwner = () => {
    if (!current()) throw Error("E_STALE_SESSION");
    return owner;
  };
  const capability = () => (current() && !deps.locked() ? ("ok" as const) : ("locked" as const));
  const tracker = createHumanTurnTracker(() => caps.revoke());
  const caps = createMemoryOpCapRegistry(() => tracker.current());
  const commandEnvironment = () =>
    current() &&
    capability() === "ok" &&
    trustedNativeMemoryCommand({ child: deps.child, commandContext: deps.commandContext });
  const commands = createSessionCommandRegistry(commandEnvironment);
  const proof = createHumanDispatchProof({
    owner: () => (current() ? owner : undefined),
    context: deps.context,
    tracker,
    enabled: () => !deps.child && capability() === "ok",
  });
  const approval = createHumanOpApproval({
    tracker,
    registry: caps,
    context: deps.context,
    get remote() {
      return deps.remote();
    },
  });
  let webKernel: CommandConfirmKernel | undefined;
  let webTasks: Set<MemoryWriteTask> | undefined;
  const poison = deps.enabled.session ? sharedSessionPoisonRegistry() : undefined;
  const recovery = poison?.recoveryAuthority();
  const session = deps.enabled.session
    ? createSessionMemoryStore({
        webConfirm: () => webKernel,
        currentOwner: requireOwner,
        isLocked: () => capability() !== "ok",
        getBranch: () => manager.getBranch(),
        // Leaf identity is only a fold-cache hint. Reduced host managers may omit it;
        // without the hint the store reads/folds the real branch on every capture.
        getLeafId: () => manager.getLeafId?.() ?? undefined,
        getSessionId: () => manager.getSessionId(),
        getSessionFile: () => manager.getSessionFile(),
        getManager: () => (current() ? manager : undefined),
        appendCustomEntry: deps.append,
        sessionWriteGate: deps.gate,
        caps,
        now: () => new Date().toISOString(),
        isChildSession: deps.child,
        stableSessionIdentity: () => `${sid}\u0000${file ?? "memory-only"}`,
        ...(poison && recovery ? { poisonRegistry: poison, recovery, commandGrants: commands } : {}),
      })
    : undefined;
  // Only the SDK's completed open fact qualifies. Shared weak metadata rejects repeat/same-manager attempts.
  if (session && recovery && deps.reason === "resume") {
    const receipt = recovery.recordReopen(
      sessionPoisonIdentity(`${sid}\u0000${file ?? "memory-only"}`),
      "resume",
      manager,
    );
    if (receipt) session.verifyRecovery(receipt);
  }
  const project = () => sha256Hex(deps.context()?.cwd ?? "").slice(0, 16);
  const hub =
    deps.enabled.hub && deps.slot
      ? createHubMemoryProvider({
          capability,
          registry: caps,
          owner: requireOwner,
          slot: () => deps.slot!,
          gate: deps.gate,
          isChildSession: () => deps.child,
          currentProjectSlug: project,
          trustedCommand: commandEnvironment,
          commandSource: () => ({ project: project(), label: "project", sid8: sid.slice(0, 8) }),
        })
      : undefined;
  const common = {
    enabled: deps.enabled,
    child: deps.child,
    capability,
    currentOwner: requireOwner,
    ...(session ? { session } : {}),
    ...(hub ? { hub } : {}),
    signal: () => abort.signal,
  };
  const tool = createScopedMemoryTool({
    ...common,
    sharedApproval: approval,
    caps,
    humanTurn: () => tracker.current(),
    projectLabel: () => "project",
  });
  const command = createScopedMemoryCommand({
    ...common,
    commandContext: deps.commandContext,
    sessionCommands: commands,
    sessionCommandTarget: session ?? {
      enqueueCommand: async () => ({ ok: false as const, code: "E_SCOPE_DISABLED" as const }),
    },
    sessionPath: () => file,
    hubPath: () => (deps.slot ? hubMemoryRoot(deps.slot) : "unavailable"),
    select: async (title, choices, opts) => {
      const ctx = deps.context();
      return ctx?.mode === "tui" ? ctx.ui.select(title, [...choices], opts) : undefined;
    },
  });
  const doctor = createScopedMemoryDoctor(common);
  // Lazy: native/model use and Web-off sessions never construct a Web kernel.
  function startWebWrite(request: MemoryWebDispatchRequest, actualCtx: ExtensionContext) {
    const failure = (code: "E_MEM_CONFIRM_STALE" | "E_MEM_BUSY" | "E_MEM_CONFIRM_UNAVAILABLE"): WriteOutcome => ({
      ok: false,
      effect: "none",
      code,
      retryable: false,
      message: `${code}: 本步未执行。`,
    });
    const live = () => {
      try {
        return (
          !deps.child &&
          !!session &&
          current() &&
          capability() === "ok" &&
          actualCtx.sessionManager === manager &&
          deps.context()?.sessionManager === manager &&
          !abort.signal.aborted &&
          !request.signal.aborted &&
          request.current()
        );
      } catch {
        return false;
      }
    };
    if (!live() || !session) return { accepted: false as const, outcome: failure("E_MEM_CONFIRM_STALE") };
    if (webTasks?.size) return { accepted: false as const, outcome: failure("E_MEM_BUSY") };
    const remote = deps.remote();
    if (!remote) return { accepted: false as const, outcome: failure("E_MEM_CONFIRM_UNAVAILABLE") };
    webKernel ??= createCommandConfirmKernel({
      channel: { kind: "web", remote: { open: (req) => deps.remote()?.open(req) } },
      isOwnerCurrent: () => !deps.child && current() && capability() === "ok",
    });
    const kernel = webKernel;
    const call = kernel.start(request.write.rawArgs, {
      cmdId: request.cmdId,
      commandOwner: request.commandOwner,
      operationGeneration: request.operationGeneration,
      deadline: request.deadline,
      signal: request.signal,
      current: live,
      owner,
      manager,
    });
    if (!call) return { accepted: false as const, outcome: failure("E_MEM_CONFIRM_STALE") };
    let cached: WriteOutcome | undefined;
    let released = false;
    let resolve!: (outcome: WriteOutcome) => void;
    const done = new Promise<WriteOutcome>((r) => {
      resolve = r;
    });
    const remember = (outcome: WriteOutcome) => {
      cached ??= { ...outcome };
      resolve(cached);
      return { ...cached };
    };
    const task: MemoryWriteTask = {
      done,
      cancel(reason) {
        kernel.close(call);
        return cached ? { ...cached } : remember(session.cancelWeb(call, reason));
      },
      release() {
        if (released) return;
        task.cancel("dispose"); // Copy the final observation BEFORE dropping the registered plan.
        released = true;
        session.releaseWeb(call);
        webTasks?.delete(task);
      },
    };
    (webTasks ??= new Set()).add(task);
    // The bridge must attach cancel/release before any prepare or dialog work.
    void Promise.resolve().then(async () => {
      try {
        if (cached || released) return;
        const prepared = await session.prepareWebAdd(call, request.write);
        if (cached || released) return;
        if (!prepared.ok) {
          remember(prepared);
          return;
        }
        const answer = await kernel.confirm(call, prepared.plan.commandPlan);
        if (cached || released) return;
        if (!answer.approved) {
          remember({ ok: false, effect: "none", code: answer.code, message: answer.message, retryable: false });
          return;
        }
        if (!kernel.reserve(call, answer.receipt, prepared.plan.commandPlan)) {
          remember(failure("E_MEM_CONFIRM_STALE"));
          return;
        }
        remember(
          await executeConfirmedMemoryWrite(call, request.write, prepared.plan, answer.receipt, {
            kernel,
            store: session,
            currentOwnerMatches: (binding) =>
              binding.owner.incarnation === owner.incarnation &&
              binding.owner.sid === owner.sid &&
              binding.owner.sessionFile === owner.sessionFile &&
              binding.owner.sessionEpoch === owner.sessionEpoch &&
              binding.owner.branchGen === owner.branchGen &&
              binding.manager === manager &&
              live(),
          }),
        );
      } catch {
        // Store observation wins even if a host callback failed after the synchronous append.
        remember(session.cancelWeb(call, "dispose"));
      } finally {
        kernel.close(call); // NOT releaseWeb: commands owns observe → ledger → release.
      }
    });
    return { accepted: true as const, task };
  }

  return {
    owner,
    manager,
    session,
    startWebWrite,
    hub,
    proof,
    approval,
    caps,
    tracker,
    tool,
    // Diagnostic-only capability: do not collapse identity getter exceptions into locked/disabled.
    inspect: ((scope, call) => {
      const diagnostic = {
        ...common,
        capability: () => {
          if (disposed || !deps.isCurrent() || deps.locked()) return "locked" as const;
          return manager.getSessionId() === sid && manager.getSessionFile() === file
            ? ("ok" as const)
            : ("locked" as const);
        },
      };
      return scope === "session"
        ? inspectScopedMemory(diagnostic, "session", call)
        : inspectScopedMemory(diagnostic, "hub", call);
    }) as ScopedV4Port["inspect"],
    command,
    doctor,
    signal: abort.signal as AbortSignal,
    capability,
    current,
    dispose() {
      if (disposed) return;
      // Abort popups before revoking authority/stores. Never touches another incarnation/global poison.
      disposed = true;
      // Each exact-owner cleanup is independent (including a throwing UI close callback).
      for (const cleanup of [
        () => {
          for (const task of webTasks ?? []) task.cancel("dispose");
        },
        () => webKernel?.dispose(),
        () => abort.abort(),
        () => proof.dispose(),
        () => caps.revoke(),
        () => approval.dispose(),
        () => session?.dispose(),
        () => hub?.dispose(),
        () => recovery?.dispose(),
      ]) {
        try {
          cleanup();
        } catch {
          /* teardown must continue through every owner-local authority */
        }
      }
    },
  };
}
export type MemoryOwnerRuntime = NonNullable<ReturnType<typeof createMemoryOwner>>;
