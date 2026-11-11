/** Factory-only scoped surface. Host owns all ports, lifecycle and human provenance. */
import { inspectScopedMemory } from "../unified/read.js";
import type { V4Registration } from "../unified/replacement.js";
import type { ScopedV4Port } from "../unified/types.js";
import { withScopedMessage } from "./error-messages.js";
import { Type } from "@sinclair/typebox";
import { dispatchScopedMemory } from "../unified/dispatcher.js";
import type { ScopedToolDeps } from "./tool-surface.js";

export type { ScopedSurfaceDeps, ScopedToolDeps } from "./tool-surface.js";
export { scopedReadGate, scopedView } from "./tool-surface.js";
export { scopedFailure } from "./error-messages.js";
export const SCOPED_MEMORY_DESCRIPTION =
  "Session and Hub memory: op=view|create|update|delete. update/delete require the actual rev returned by view (for Hub, supply id); delete confirms the full current body. Session defaults to agent; user authority and changes to user items require exact-content human approval. Child sessions accept no explicit authority, including agent. Hub is shared by ALL projects of this Hub; a write needs the user to approve it in a dialog (terminal or web). scope=global inside memory text is NOT cross-project. No human proof/remote channel means refusal, not queueing or resending. Never store secrets.";
export function createScopedMemoryTool(deps: ScopedToolDeps, options?: { v4Registration: () => V4Registration }) {
  const scopes = deps.child
    ? deps.enabled.session
      ? ["session"]
      : []
    : ["session", "hub"].filter((s) => deps.enabled[s as "session" | "hub"]);
  const parameters = Type.Object(
    {
      op: Type.Union([Type.Literal("view"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]),
      storageScope: scopes.length ? Type.Union(scopes.map((s) => Type.Literal(s))) : Type.Never(),
      id: Type.Optional(
        Type.String({
          description: "Exact target id. Required for update/delete; Hub view with id returns actual rev.",
        }),
      ),
      text: Type.Optional(
        Type.String({
          description:
            "Full body for create/update. Delete always freezes the actual current body, never supplied substitute text.",
        }),
      ),
      rev: Type.Optional(
        Type.String({ description: "Actual current revision from view, required for update/delete CAS." }),
      ),
      topic: Type.Optional(
        Type.String({
          description: "Hub create topic (lowercase letters, digits, hyphens). Not accepted for session.",
        }),
      ),
      from: Type.Optional(
        Type.String({
          description:
            "Optional provenance link session:nN or project:<reference>; does not grant authority or move the source.",
        }),
      ),
      authority: Type.Optional(
        Type.Union([Type.Literal("agent"), Type.Literal("user")], {
          description:
            "Only used for session scope; ignored for hub scope, where writes and deletes always require exact-content confirmation.",
        }),
      ),
    },
    { additionalProperties: false },
  );
  async function dispatch(toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    return withScopedMessage(await dispatchScopedMemory(deps, toolCallId, input, signal));
  }
  async function run(
    toolCallId: string,
    input: unknown,
    signal?: AbortSignal,
    registration = options,
  ): Promise<unknown> {
    return withScopedMessage(
      await dispatchScopedMemory(
        deps,
        toolCallId,
        input,
        signal,
        registration ? { ...registration, parameters } : undefined,
      ),
    );
  }
  return {
    name: "scoped_memory",
    label: "Scoped Memory",
    description: SCOPED_MEMORY_DESCRIPTION,
    parameters,
    run,
    dispatch,
    inspect: ((scope, call) =>
      scope === "session"
        ? inspectScopedMemory(deps, "session", call)
        : inspectScopedMemory(deps, "hub", call)) as ScopedV4Port["inspect"],
    async execute(id: string, params: unknown, signal?: AbortSignal) {
      const result = await run(id, params, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
    },
  };
}
