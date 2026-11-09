/** session adapter: forward to the existing shared scoped view/approval/enqueue path. */
import { mutateScopedMemory, viewScopedItem, type ScopedMutationParams } from "../scopes/tool-operations.js";
import type { ScopedToolDeps } from "../scopes/tool-surface.js";

export const sessionMemoryAdapter = Object.freeze({
  view(deps: ScopedToolDeps, id: string | undefined) {
    return viewScopedItem(deps, "session", id);
  },
  mutate(deps: ScopedToolDeps, toolCallId: string, input: ScopedMutationParams, signal?: AbortSignal) {
    return mutateScopedMemory(deps, "session", toolCallId, input, signal);
  },
});
