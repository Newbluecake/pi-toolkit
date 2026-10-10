import { CONSULT_READONLY_TOOLS } from "../runtime/tool-scope.js";
import type {
  ConsultGuard,
  ConsultGuardCounters,
  ConsultGuardPreflight,
  ExpertRequestSnapshot,
  ToolDeclaration,
} from "../core/types.js";
import { preflight } from "./preserve-identity.js";

export const NESTED_TOOL_CALL_REASON = "Nested tool calls are disabled in this read-only consult.";

interface AgentToolLike {
  name: string;
  execute?: unknown;
}

interface ToolDefinitionLike {
  name: string;
  execute?: unknown;
  prepareArguments?: unknown;
  prepareLoadout?: unknown;
}

interface SessionLike {
  agent?: {
    beforeToolCall?: unknown;
    toolExecution?: unknown;
    state?: { tools?: unknown };
  };
  state?: { tools?: unknown };
  messages?: unknown;
  getAllTools?: () => unknown;
  getToolDefinition?: (name: string) => unknown;
  _beforeToolCall?: unknown;
}

interface PinnedTool {
  readonly agentTool: AgentToolLike;
  readonly definition: ToolDefinitionLike;
  readonly execute: unknown;
}

interface GuardState {
  readonly allowed: ReadonlyMap<string, PinnedTool>;
  readonly session: SessionLike;
  readonly originalBeforeToolCall: (...args: unknown[]) => unknown;
  batchKey: unknown;
  batchCalls: number;
  batchBlocked: boolean;
  batchAllBlocked: boolean;
  consecutiveAllBlocked: number;
  calls: number;
  batches: number;
  terminated: boolean;
  identity: number;
  nested: number;
  costAfterUsd: number;
}

function asSession(value: unknown): SessionLike {
  if (value === null || typeof value !== "object") throw new Error("session is not an object");
  return value as SessionLike;
}

function definitionOf(session: SessionLike, name: string): ToolDefinitionLike | undefined {
  if (typeof session.getToolDefinition !== "function") return undefined;
  const definition = session.getToolDefinition(name);
  return definition && typeof definition === "object" ? (definition as ToolDefinitionLike) : undefined;
}

function activeToolOf(session: SessionLike, name: string): AgentToolLike | undefined {
  const tools = session.state?.tools ?? session.agent?.state?.tools;
  if (!Array.isArray(tools)) return undefined;
  const tool = tools.find(
    (entry) => entry !== null && typeof entry === "object" && (entry as { name?: unknown }).name === name,
  );
  return tool && typeof tool === "object" ? (tool as AgentToolLike) : undefined;
}

function allowedTools(snapshot: ExpertRequestSnapshot): string[] {
  const snapshotNames = new Set(
    snapshot.tools
      .map((tool) => (typeof tool.name === "string" ? tool.name : undefined))
      .filter((name): name is string => name !== undefined),
  );
  return CONSULT_READONLY_TOOLS.filter((name) => snapshotNames.has(name));
}

export function blockedToolReason(name: string, allowed: readonly string[]): string {
  const names = allowed.length > 0 ? allowed.join(", ") : "none";
  return `Tool "${name}" is disabled in this read-only consult. Allowed tools: ${names}. Answer from your existing context${allowed.length > 0 ? " or use an allowed tool" : ""}.`;
}

function finishBatch(state: GuardState): void {
  if (state.batchCalls === 0) return;
  if (state.batchBlocked) state.batches += 1;
  if (state.batchBlocked && state.batchAllBlocked) {
    state.consecutiveAllBlocked += 1;
    if (state.consecutiveAllBlocked >= 2) state.terminated = true;
  } else {
    state.consecutiveAllBlocked = 0;
  }
  state.batchCalls = 0;
  state.batchBlocked = false;
  state.batchAllBlocked = true;
}

function beginBatch(state: GuardState, key: unknown): void {
  if (state.batchCalls > 0 && state.batchKey !== key) finishBatch(state);
  if (state.batchCalls === 0) {
    state.batchKey = key;
    state.batchBlocked = false;
    state.batchAllBlocked = true;
  }
}

export interface DecideContext {
  readonly toolName: string;
  readonly parentToolCallId?: string;
  readonly assistantMessage?: unknown;
  readonly tools?: readonly AgentToolLike[];
}

export interface DecideResult {
  readonly block: boolean;
  readonly reason?: string;
  readonly terminate?: boolean;
  readonly identity?: boolean;
  readonly nested?: boolean;
}

/** Decide one call. The guard factory is the only production caller that can create allowed pins. */
export function decide(state: GuardState, context: DecideContext): DecideResult {
  beginBatch(state, context.assistantMessage);
  state.batchCalls += 1;
  if (context.parentToolCallId !== undefined) {
    state.calls += 1;
    state.nested += 1;
    state.batchBlocked = true;
    state.batchAllBlocked = state.batchAllBlocked && true;
    const terminate = state.consecutiveAllBlocked >= 1;
    return { block: true, reason: NESTED_TOOL_CALL_REASON, terminate, nested: true };
  }

  const pinned = state.allowed.get(context.toolName);
  const current = context.tools?.find((tool) => tool.name === context.toolName);
  const definition = state.session.getToolDefinition?.(context.toolName) as ToolDefinitionLike | undefined;
  const identityOk =
    pinned !== undefined &&
    current === pinned.agentTool &&
    definition === pinned.definition &&
    definition.execute === pinned.execute;
  if (pinned !== undefined && identityOk) {
    state.batchAllBlocked = false;
    return { block: false };
  }

  state.calls += 1;
  state.batchBlocked = true;
  if (pinned !== undefined && !identityOk) state.identity += 1;
  const terminate = state.consecutiveAllBlocked >= 1;
  return {
    block: true,
    reason: blockedToolReason(context.toolName, [...state.allowed.keys()]),
    terminate,
    identity: pinned !== undefined && !identityOk,
  };
}

/** Install the nested-path block used by both production and conformance: nested calls block; the non-nested path delegates to pi's original hook after the outer guard decides. */
export function installNestedCallBlock(
  sessionValue: unknown,
  onNested?: (context: unknown, parentToolCallId: string) => unknown,
): void {
  const session = asSession(sessionValue);
  const original = session._beforeToolCall;
  if (typeof original !== "function") throw new Error("nested-hook");
  session._beforeToolCall = function (this: unknown, context: unknown, parentToolCallId?: string) {
    if (parentToolCallId !== undefined) {
      return Promise.resolve(onNested?.(context, parentToolCallId) ?? { block: true, reason: NESTED_TOOL_CALL_REASON });
    }
    return original.call(this, context, parentToolCallId);
  };
}

function pinTools(session: SessionLike, names: readonly string[]): ReadonlyMap<string, PinnedTool> {
  const pinned = new Map<string, PinnedTool>();
  for (const name of names) {
    const agentTool = activeToolOf(session, name);
    const definition = definitionOf(session, name);
    if (!agentTool || !definition || typeof definition.execute !== "function")
      throw new Error(`[consult-preserve:identity_mismatch:tool-not-registered:${name}]`);
    Object.freeze(definition);
    Object.freeze(agentTool);
    pinned.set(name, Object.freeze({ agentTool, definition, execute: definition.execute }));
  }
  return pinned;
}

function countersOf(state: GuardState): ConsultGuardCounters {
  // Counters are a read-only diagnostic snapshot. Include the pending batch without committing it.
  const pendingBlocked = state.batchCalls > 0 && state.batchBlocked;
  const pendingAllBlocked = pendingBlocked && state.batchAllBlocked;
  return Object.freeze({
    calls: state.calls,
    batches: state.batches + (pendingBlocked ? 1 : 0),
    terminated: state.terminated || (pendingAllBlocked && state.consecutiveAllBlocked >= 1),
    identity: state.identity,
    nested: state.nested,
    costAfterUsd: state.costAfterUsd,
  });
}

/** Production consult guard. Its only input is the frozen expert snapshot. */
export function createConsultGuard(snapshot: ExpertRequestSnapshot): ConsultGuard {
  const names = allowedTools(snapshot);
  let state: GuardState | undefined;
  let installed = false;
  return {
    preflight(sessionValue: unknown): ConsultGuardPreflight {
      try {
        return preflight(sessionValue, snapshot);
      } catch (error) {
        return {
          ok: false,
          code: "guard_unavailable:agent-hooks",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
    install(sessionValue: unknown): void {
      if (installed) return;
      const session = asSession(sessionValue);
      const original = session.agent?.beforeToolCall;
      if (typeof original !== "function") throw new Error("guard_unavailable:agent-hooks");
      const allowed = pinTools(session, names);
      const next: GuardState = {
        allowed,
        session,
        originalBeforeToolCall: original as (...args: unknown[]) => unknown,
        batchKey: undefined,
        batchCalls: 0,
        batchBlocked: false,
        batchAllBlocked: true,
        consecutiveAllBlocked: 0,
        calls: 0,
        batches: 0,
        terminated: false,
        identity: 0,
        nested: 0,
        costAfterUsd: 0,
      };
      state = next;
      installNestedCallBlock(session, (context, parentToolCallId) => {
        const input = context as {
          toolCall?: { name?: unknown };
          assistantMessage?: unknown;
          context?: { tools?: unknown };
        };
        return decide(next, {
          toolName: typeof input.toolCall?.name === "string" ? input.toolCall.name : "unknown",
          parentToolCallId,
          ...(input.assistantMessage === undefined ? {} : { assistantMessage: input.assistantMessage }),
          ...(Array.isArray(input.context?.tools) ? { tools: input.context.tools as AgentToolLike[] } : {}),
        });
      });
      session.agent!.toolExecution = "sequential";
      session.agent!.beforeToolCall = (context: unknown, signal?: unknown) => {
        const input = context as {
          toolCall?: { name?: unknown; id?: unknown };
          parentToolCallId?: unknown;
          args?: unknown;
          context?: { tools?: unknown };
          assistantMessage?: unknown;
        };
        const toolName = typeof input.toolCall?.name === "string" ? input.toolCall.name : "unknown";
        const decision = decide(next, {
          toolName,
          ...(typeof input.parentToolCallId === "string" ? { parentToolCallId: input.parentToolCallId } : {}),
          ...(input.assistantMessage === undefined ? {} : { assistantMessage: input.assistantMessage }),
          ...(Array.isArray(input.context?.tools) ? { tools: input.context.tools as AgentToolLike[] } : {}),
        });
        if (decision.block) return Promise.resolve(decision);
        return Promise.resolve(original.call(session.agent, context, signal));
      };
      installed = true;
    },
    counters(): ConsultGuardCounters {
      return state === undefined
        ? Object.freeze({ calls: 0, batches: 0, terminated: false, identity: 0, nested: 0, costAfterUsd: 0 })
        : countersOf(state);
    },
  };
}

export type { ToolDeclaration };
