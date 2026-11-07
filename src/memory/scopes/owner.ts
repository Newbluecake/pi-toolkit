/** One actual-manager owner. All authority/closures are activation-local; poison alone is shared. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskUserRemotePort } from "../../ask-user/remote.js";
import { createHumanDispatchProof, createHumanOpApproval } from "../../web-hub/agent/human-dispatch-proof.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "./op-cap.js";
import { createSessionCommandRegistry } from "./session-command.js";
import { createSessionMemoryStore, sessionPoisonIdentity } from "./session-store.js";
import { sharedSessionPoisonRegistry } from "./session-poison.js";
import { createHubMemoryProvider } from "./hub-store.js";
import { createScopedMemoryCommand, trustedNativeMemoryCommand, type NativeMemoryCommandContext } from "./command.js";
import { createScopedMemoryTool } from "./tool.js";
import { createScopedMemoryDoctor } from "./doctor.js";
import { hubMemoryRoot } from "./hub-slot.js";
import { sha256Hex } from "./limits.js";
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
export function createMemoryOwner(deps: MemoryOwnerDeps) {
  const manager = deps.manager;
  const sid = manager.getSessionId(),
    file = manager.getSessionFile();
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
  const poison = deps.enabled.session ? sharedSessionPoisonRegistry() : undefined;
  const recovery = poison?.recoveryAuthority();
  const session = deps.enabled.session
    ? createSessionMemoryStore({
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
  return {
    owner,
    manager,
    session,
    hub,
    proof,
    approval,
    caps,
    tracker,
    tool,
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
export type MemoryOwnerRuntime = ReturnType<typeof createMemoryOwner>;
