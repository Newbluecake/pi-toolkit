/** Activation-local routing and optional v4 facade. No owners, caps, paths or approval creation. */
import type { TSchema } from "@sinclair/typebox";
import { createMemoryToolV4, type MemoryToolV4Deps } from "./tool.js";
import { appendV4Replacement, type V4Registration } from "./replacement.js";
import { scopedFailure } from "../scopes/error-messages.js";
import { isFromRef, isHubTopic, readUntrustedValue, utf8Bytes } from "../scopes/limits.js";
import { scopedReadGate, type ScopedToolDeps } from "../scopes/tool-surface.js";
import type { ScopedMutationParams } from "../scopes/tool-operations.js";
import { createProjectAdapter } from "./project-adapter.js";
import { sessionMemoryAdapter } from "./session-adapter.js";
import { hubMemoryAdapter } from "./hub-adapter.js";

export interface ScopedMemoryCallPort {
  run(
    toolCallId: string,
    input: unknown,
    signal?: AbortSignal,
    options?: { v4Registration: () => V4Registration },
  ): Promise<unknown>;
}
export interface ScopedMemoryDispatcher {
  scoped(toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Created once by wireMemory; currentScoped is resolved anew on every execute. */
export function createMemoryDispatcher<Args extends unknown[], Result, Context = unknown>(ports: {
  project: (...args: Args) => Promise<Result>;
  currentScoped: () => ScopedMemoryCallPort | undefined;
  unified?: MemoryToolV4Deps<Context>;
  v4Registration?: () => V4Registration;
}) {
  const project = createProjectAdapter(ports.project);
  return {
    project: project.execute,
    v4: ports.unified ? createMemoryToolV4(ports.unified) : undefined,
    async scoped(toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
      const current = ports.currentScoped();
      return current
        ? current.run(
            toolCallId,
            input,
            signal,
            ports.v4Registration ? { v4Registration: ports.v4Registration } : undefined,
          )
        : scopedFailure("E_STALE_SESSION");
    },
  };
}

/** The old alias normalizer. Do NOT map/route before its child/field/scope/gate checks.
 * Factory-only callers and the activation dispatcher use this exact same path. */
export async function dispatchScopedMemory(
  deps: ScopedToolDeps,
  toolCallId: string,
  input: unknown,
  signal?: AbortSignal,
  options?: { v4Registration: () => V4Registration; parameters: TSchema },
): Promise<unknown> {
  const result = await dispatchScopedMemoryInner(deps, toolCallId, input, signal);
  return options ? appendV4Replacement(result, input, options.parameters, options.v4Registration()) : result;
}
async function dispatchScopedMemoryInner(
  deps: ScopedToolDeps,
  toolCallId: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const parsed = readUntrustedValue(input);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value))
    return scopedFailure("E_META_INVALID");
  const p = parsed.value;
  if (deps.child && Object.hasOwn(p, "authority")) return scopedFailure("E_CHILD_AUTHORITY");
  if (
    Object.keys(p).some((k) => !["op", "storageScope", "id", "text", "rev", "topic", "from", "authority"].includes(k))
  )
    return scopedFailure("E_META_INVALID");
  if (p.storageScope !== "session" && p.storageScope !== "hub") return scopedFailure("E_SCOPE_DISABLED");
  const scope = p.storageScope;
  const gate = scopedReadGate(deps, scope);
  if (gate) return scopedFailure(gate);
  for (const k of ["id", "text", "rev", "topic", "from", "authority"])
    if (p[k] !== undefined && typeof p[k] !== "string") return scopedFailure("E_META_INVALID");
  if (p.authority !== undefined && p.authority !== "agent" && p.authority !== "user")
    return scopedFailure("E_AUTHORITY");
  if (typeof p.text === "string" && utf8Bytes(p.text) > 1024) return scopedFailure("E_TOO_LARGE");
  if (p.from !== undefined && !isFromRef(p.from)) return scopedFailure("E_FROM_INVALID");
  if (p.topic !== undefined && !isHubTopic(p.topic)) return scopedFailure("E_META_INVALID");
  const adapter = scope === "session" ? sessionMemoryAdapter : hubMemoryAdapter;
  if (p.op === "view") return adapter.view(deps, p.id as string | undefined);
  if (p.op !== "create" && p.op !== "update" && p.op !== "delete") return scopedFailure("E_META_INVALID");
  if (scope === "hub") {
    const status = deps.hub!.management.status();
    if (status.state === "inert") return scopedFailure("E_NAMESPACE");
    if (status.state === "disabled") return scopedFailure("E_SCOPE_DISABLED");
  }
  if (p.op !== "create" && (typeof p.rev !== "string" || !p.rev)) return scopedFailure("E_REV_REQUIRED");
  if (p.op === "create" && (p.id !== undefined || p.rev !== undefined)) return scopedFailure("E_META_INVALID");
  if (p.op !== "delete" && typeof p.text !== "string") return scopedFailure("E_META_INVALID");
  if (scope === "session" && p.topic !== undefined) return scopedFailure("E_META_INVALID");
  return adapter.mutate(deps, toolCallId, p as unknown as ScopedMutationParams, signal);
}
