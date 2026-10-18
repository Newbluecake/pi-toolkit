import { getCurrentTools, getToolStateChanges, toToolDeclaration } from "@earendil-works/pi-ai";
import type { ConsultGuardPreflight, ExpertRequestSnapshot, ToolDeclaration } from "../core/types.js";
import {
  anchorIdentityMatches,
  compareMessageBreakpoints,
  messageBreakpointShape,
  withoutCacheControl,
  type AnchorObservation,
} from "./anchor.js";
import { CONSULT_READONLY_TOOLS } from "../runtime/tool-scope.js";

/** Provider-visible fields frozen by consult-preserve v3.1. */
export const PROVIDER_PREFIX_FIELDS = Object.freeze([
  "model",
  "messages",
  "max_tokens",
  "stream",
  "betas",
  "system",
  "temperature",
  "tools",
  "thinking",
  "output_config",
  "metadata",
  "tool_choice",
  "fallbacks",
] as const);

export type ProviderPrefixField = (typeof PROVIDER_PREFIX_FIELDS)[number];

export interface ToolStateChangeResult {
  toolsAdded: ToolDeclaration[];
  toolsRemoved: Array<{ name: string }>;
}

/** Apply pi's own transcript tool-state comparison without reimplementing its semantics. */
export function toolStateChanges(
  previous: readonly ToolDeclaration[],
  current: readonly ToolDeclaration[],
): ToolStateChangeResult {
  const changes = getToolStateChanges(previous as never, current as never);
  return {
    toolsAdded: changes.toolsAdded as unknown as ToolDeclaration[],
    toolsRemoved: changes.toolsRemoved,
  };
}

/** The exact declaration check used by agent-loop.js:231, expressed for a session-like object. */
export function sessionToolStateChanges(session: unknown): ToolStateChangeResult {
  const value = session as {
    messages?: unknown;
    state?: { tools?: unknown };
    agent?: { state?: { tools?: unknown } };
  };
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const previous = getCurrentTools(messages as never);
  const stateTools = value.state?.tools ?? value.agent?.state?.tools;
  const current = Array.isArray(stateTools) ? stateTools.map((tool) => toToolDeclaration(tool as never)) : [];
  return toolStateChanges(previous as unknown as ToolDeclaration[], current as unknown as ToolDeclaration[]);
}

interface PreflightToolInfo {
  name: string;
  exposure?: unknown;
  sourceInfo?: { source?: unknown };
}

interface PreflightDefinition {
  prepareArguments?: unknown;
  prepareLoadout?: unknown;
}

interface PreflightSession {
  agent?: { beforeToolCall?: unknown; state?: { tools?: unknown } };
  state?: { tools?: unknown };
  _beforeToolCall?: unknown;
  getAllTools?: () => unknown;
  getToolDefinition?: (name: string) => unknown;
}

function preflightDefinition(session: PreflightSession, name: string): PreflightDefinition | undefined {
  if (typeof session.getToolDefinition !== "function") return undefined;
  const definition = session.getToolDefinition(name);
  return definition !== null && typeof definition === "object" ? (definition as PreflightDefinition) : undefined;
}

/**
 * Match AgentSession._getCallableTools() in pi 1.0.2 (agent-session.js:1106-1113):
 * active direct tools plus every registered codemode/deferred tool.
 */
function callableTools(session: PreflightSession, registered: readonly PreflightToolInfo[]): PreflightToolInfo[] {
  const activeTools = session.state?.tools ?? session.agent?.state?.tools;
  const active = new Set(
    Array.isArray(activeTools)
      ? activeTools
          .map((tool) => (tool !== null && typeof tool === "object" ? (tool as { name?: unknown }).name : undefined))
          .filter((name): name is string => typeof name === "string")
      : [],
  );
  return registered.filter(
    (tool) =>
      tool.exposure === "codemode" ||
      tool.exposure === "deferred" ||
      (tool.exposure === "direct" && active.has(tool.name)),
  );
}

/** Pure G-preflight checks. It performs no session mutation and no provider I/O. */
export function preflight(sessionValue: unknown, snapshot: ExpertRequestSnapshot): ConsultGuardPreflight {
  if (sessionValue === null || typeof sessionValue !== "object")
    return { ok: false, code: "guard_unavailable:agent-hooks" };
  const session = sessionValue as PreflightSession;
  if (typeof session.agent?.beforeToolCall !== "function") return { ok: false, code: "guard_unavailable:agent-hooks" };
  if (typeof session._beforeToolCall !== "function") return { ok: false, code: "guard_unavailable:nested-hook" };

  const allTools = typeof session.getAllTools === "function" ? session.getAllTools() : [];
  const registered = Array.isArray(allTools) ? (allTools as PreflightToolInfo[]) : [];
  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  const callable = callableTools(session, registered);
  const callableByName = new Map(callable.map((tool) => [tool.name, tool]));
  for (const declaration of snapshot.tools) {
    const name = typeof declaration.name === "string" ? declaration.name : undefined;
    if (!name || !byName.has(name)) {
      return { ok: false, code: `identity_mismatch:tool-not-registered:${name ?? "unknown"}` };
    }
    if (byName.get(name)?.exposure !== "direct") return { ok: false, code: `identity_mismatch:tool-exposure:${name}` };
  }

  for (const tool of callable) {
    if (preflightDefinition(session, tool.name)?.prepareLoadout !== undefined)
      return { ok: false, code: `identity_mismatch:prepare-loadout:${tool.name}` };
  }

  const allowedNames = new Set(
    snapshot.tools
      .map((tool) => (typeof tool.name === "string" ? tool.name : undefined))
      .filter(
        (name): name is string => name !== undefined && (CONSULT_READONLY_TOOLS as readonly string[]).includes(name),
      ),
  );
  for (const name of allowedNames) {
    if (byName.get(name)?.sourceInfo?.source !== "builtin")
      return { ok: false, code: `identity_mismatch:readonly-not-builtin:${name}` };
  }

  const editInfo = callableByName.get("edit");
  const editPrepare =
    editInfo?.sourceInfo?.source === "builtin" ? preflightDefinition(session, "edit")?.prepareArguments : undefined;
  for (const tool of callable) {
    if (allowedNames.has(tool.name)) continue;
    const prepare = preflightDefinition(session, tool.name)?.prepareArguments;
    if (prepare !== undefined && prepare !== editPrepare)
      return { ok: false, code: `identity_mismatch:unaudited-prepare-arguments:${tool.name}` };
  }

  const changes = sessionToolStateChanges(session);
  if (changes.toolsAdded.length > 0 || changes.toolsRemoved.length > 0) {
    const names = [
      ...new Set([
        ...changes.toolsAdded.map((tool) => String(tool.name ?? "unknown")),
        ...changes.toolsRemoved.map((tool) => tool.name),
      ]),
    ];
    return { ok: false, code: `identity_mismatch:tool-definition:${names.join(",")}` };
  }
  return { ok: true };
}

function stableValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function equal(left: unknown, right: unknown): boolean {
  return stableValue(left) === stableValue(right);
}

function messagePrefix(expert: unknown, consult: unknown, anchor?: AnchorObservation): boolean {
  if (!Array.isArray(expert) || !Array.isArray(consult) || consult.length < expert.length) return false;
  return (
    compareMessageBreakpoints(messageBreakpointShape(expert), messageBreakpointShape(consult), anchor) &&
    expert.every((message, index) => equal(withoutCacheControl(message), withoutCacheControl(consult[index])))
  );
}

export interface PayloadPrefixComparison {
  model: boolean;
  messages: boolean;
  tools: boolean;
  system: boolean;
  thinking: boolean;
  output_config: boolean;
  tool_choice: boolean;
  betas: boolean;
  temperature: boolean;
  metadata: boolean;
  fallbacks: boolean;
  max_tokens: boolean;
  stream: boolean;
}

/**
 * Compare the provider-visible prefix. This is deliberately a pure, JSON-only helper: it never
 * retains payload references and never inspects credentials or request identifiers.
 */
export function comparePayloadPrefix(
  expert: Record<string, unknown>,
  consult: Record<string, unknown>,
  anchor?: AnchorObservation,
): PayloadPrefixComparison {
  const optionalEqual = (name: string) => {
    const left = expert[name];
    const right = consult[name];
    return left === undefined && right === undefined ? true : equal(left, right);
  };
  return {
    model: equal(expert.model, consult.model),
    messages:
      messagePrefix(expert.messages, consult.messages, anchor) &&
      ((anchor?.state !== "added" && anchor?.state !== "relocated") || anchorIdentityMatches(consult, anchor.identity)),
    tools: equal(expert.tools, consult.tools),
    system: equal(expert.system, consult.system),
    thinking: optionalEqual("thinking"),
    output_config: optionalEqual("output_config"),
    tool_choice: optionalEqual("tool_choice"),
    betas: optionalEqual("betas"),
    temperature: optionalEqual("temperature"),
    metadata: optionalEqual("metadata"),
    fallbacks: optionalEqual("fallbacks"),
    max_tokens: optionalEqual("max_tokens"),
    stream: optionalEqual("stream"),
  };
}

/** Keep this import-level assertion useful to conformance without exposing mutable snapshot data. */
export function snapshotToolDeclarations(snapshot: ExpertRequestSnapshot): readonly ToolDeclaration[] {
  return snapshot.tools;
}
