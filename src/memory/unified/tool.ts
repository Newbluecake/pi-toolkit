import { MemoryError } from "../paths.js";
import { scopedFailure, withScopedMessage } from "../scopes/error-messages.js";
import { normalizeMemoryV4 } from "./normalize.js";
import { projectError, scopedReadError } from "./errors.js";
import { memoryV4Surface } from "./surface.js";
import type {
  AggregateRead,
  MemoryV4Params,
  ProjectV4Port,
  ScopedV4Port,
  ReadInspection,
  SessionReadGroup,
  HubReadGroup,
} from "./types.js";

export interface MemoryToolV4Deps<Context> {
  project: ProjectV4Port<Context>;
  /** Resolve at each call, never hold an owner across calls or approvals. */
  currentScoped: () => ScopedV4Port | undefined;
  child: boolean;
  scopesOn: boolean;
  jev?: boolean;
}

/** Independent v4 surface: production registration remains an assembly decision. */
export function createMemoryToolV4<Context = unknown>(deps: MemoryToolV4Deps<Context>) {
  async function inspectScoped(
    scope: "session" | "hub",
    call: MemoryV4Params,
  ): Promise<ReadInspection<SessionReadGroup | HubReadGroup>> {
    // Child Hub is inert without even resolving the scoped owner/provider.
    if ((deps.child && scope === "hub") || !deps.scopesOn)
      return {
        status: { state: "disabled", code: "E_SCOPE_DISABLED", message: scopedFailure("E_SCOPE_DISABLED").message },
      };
    try {
      const current = deps.currentScoped();
      if (!current)
        return {
          status: { state: "disabled", code: "E_SCOPE_DISABLED", message: scopedFailure("E_SCOPE_DISABLED").message },
        };
      return scope === "session" ? current.inspect("session", call) : current.inspect("hub", call);
    } catch (error) {
      return { status: { state: "error", ...scopedReadError(scope, error) } };
    }
  }
  async function run(id: string, input: unknown, signal: AbortSignal | undefined, context: Context): Promise<unknown> {
    const normalized = normalizeMemoryV4(input, { child: deps.child });
    // This entire preflight runs before resolving ANY port (including all writes/forbidden fields).
    if (!normalized.ok) return normalized;
    const call = normalized.call;
    if (call.scope === "all") {
      const result: AggregateRead = {
        ok: true,
        partial: false,
        scopeStatus: { project: { state: "empty" }, session: { state: "empty" }, hub: { state: "empty" } },
        groups: {},
      };
      try {
        const project = await deps.project.inspect(call, context);
        result.scopeStatus.project = project.status;
        if (project.group) result.groups.project = project.group;
      } catch (error) {
        result.scopeStatus.project = { state: "error", ...projectError(error) };
      }
      for (const scope of ["session", "hub"] as const) {
        const read = await inspectScoped(scope, call);
        result.scopeStatus[scope] = read.status;
        if (read.group) {
          // Overloads ensure each production port returns only its own group's DTO.
          if (scope === "session") result.groups.session = read.group as SessionReadGroup;
          else result.groups.hub = read.group as HubReadGroup;
        }
      }
      result.partial = Object.values(result.scopeStatus).some((s) => !["ok", "empty", "absent"].includes(s.state));
      return result;
    }
    if (call.scope === "project") {
      if (deps.child && deps.scopesOn && call.command !== "view" && call.command !== "search")
        return {
          ok: false,
          ...projectError(new MemoryError("E_READONLY: child project memory is read-only while scopes are enabled")),
        };
      try {
        const { scope: _scope, ...params } = call;
        return await deps.project.run(id, params, signal, context);
      } catch (error) {
        return { ok: false, ...projectError(error) };
      }
    }
    if (call.command === "view" || call.command === "search") {
      const read = await inspectScoped(call.scope, call);
      if (!read.group) {
        const { state: _state, ...error } = read.status;
        return { ok: false, ...error };
      }
      if (call.command === "view" && call.id !== undefined) {
        const entry = read.group.kind === "items" ? read.group.items[0] : undefined;
        return entry ? { ok: true, ...entry } : scopedFailure("E_NOT_FOUND");
      }
      return { ok: true, ...read.group };
    }
    if ((deps.child && call.scope === "hub") || !deps.scopesOn) return scopedFailure("E_SCOPE_DISABLED");
    const current = deps.currentScoped();
    if (!current) return scopedFailure("E_SCOPE_DISABLED");
    const { command, scope, ...params } = call;
    // Reuse the only existing approval/enqueue implementation and error guidance.
    return withScopedMessage(await current.dispatch(id, { op: command, storageScope: scope, ...params }, signal));
  }
  return {
    name: "memory",
    label: "Memory",
    ...memoryV4Surface({ child: deps.child, jev: deps.jev ?? false }),
    run,
    async execute(
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: Context,
    ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
      const result = await run(id, params, signal, context);
      // Preserve successful project tool text/usage; all new DTOs serialize as JSON.
      if (result && typeof result === "object" && "content" in result)
        return result as { content: { type: "text"; text: string }[]; details: unknown };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
    },
  };
}
