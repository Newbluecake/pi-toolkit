import { scopedFailure } from "../scopes/error-messages.js";
import { scopedReadGate, type ScopedSurfaceDeps } from "../scopes/tool-surface.js";
import { scopedReadError } from "./errors.js";
import type {
  HubEntry,
  HubReadGroup,
  MemoryV4Params,
  ReadInspection,
  SessionEntry,
  SessionReadGroup,
} from "./types.js";

/** Both reads and search are pure projections of the current authorized snapshot. */
export function selectScopedEntries<T extends { id: string; item: { text: string } }>(
  entries: readonly T[],
  call: MemoryV4Params,
): T[] {
  const query = call.query?.toLowerCase();
  return entries
    .filter(
      (entry) =>
        (call.id === undefined || entry.id === call.id) &&
        (call.command !== "search" || (query !== undefined && entry.item.text.toLowerCase().includes(query))),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 50);
}
export function inspectScopedMemory(
  deps: ScopedSurfaceDeps,
  scope: "session",
  call: MemoryV4Params,
): ReadInspection<SessionReadGroup>;
export function inspectScopedMemory(
  deps: ScopedSurfaceDeps,
  scope: "hub",
  call: MemoryV4Params,
): ReadInspection<HubReadGroup>;
export function inspectScopedMemory(
  deps: ScopedSurfaceDeps,
  scope: "session" | "hub",
  call: MemoryV4Params,
): ReadInspection<SessionReadGroup | HubReadGroup> {
  try {
    const gate = scopedReadGate(deps, scope);
    if (gate) return { status: { state: "disabled", ...errorFields(scopedFailure(gate)) } };
    if (scope === "session") {
      // view.poisoned is an observed persistence failure; a throwing getter is NOT poison.
      const view = deps.session!.view();
      if (view.poisoned) return { status: { state: "poisoned", ...errorFields(scopedFailure("E_PERSIST_UNKNOWN")) } };
      const entries: SessionEntry[] = view.items.map((entry) => ({ id: entry.item.id, ...entry }));
      const items = selectScopedEntries(entries, call);
      return {
        status: { state: items.length ? "ok" : "empty" },
        group: call.command === "search" ? { kind: "hits", hits: items } : { kind: "items", items },
      };
    }
    const view = deps.hub!.management.status();
    if (view.state === "disabled")
      return { status: { state: "disabled", ...errorFields(scopedFailure("E_SCOPE_DISABLED")) } };
    if (view.state === "inert") return { status: { state: "inert", ...errorFields(scopedFailure("E_NAMESPACE")) } };
    if (view.state === "absent")
      return {
        status: { state: "absent" },
        group: call.command === "search" ? { kind: "hits", hits: [] } : { kind: "items", items: [] },
      };
    const entries: HubEntry[] = [];
    // Read only selected visible ids. Each inspection rechecks the existing Hub read gates.
    for (const visible of selectScopedEntries(
      view.items.map((item) => ({ id: item.id, item })),
      call,
    )) {
      const gate = scopedReadGate(deps, "hub");
      if (gate) return { status: { state: "disabled", ...errorFields(scopedFailure(gate)) } };
      const read = deps.hub!.management.inspect(visible.id);
      if (!read.ok)
        return {
          status: {
            state: read.code === "E_NAMESPACE" ? "inert" : read.code === "E_SCOPE_DISABLED" ? "disabled" : "error",
            ...errorFields(scopedFailure(read.code)),
          },
        };
      entries.push({ id: read.item.id, rev: read.rev, item: read.item });
    }
    // Match against the inspected current body, not a stale status body.
    const items = selectScopedEntries(entries, call);
    return {
      status: { state: items.length ? "ok" : "empty" },
      group: call.command === "search" ? { kind: "hits", hits: items } : { kind: "items", items },
    };
  } catch (error) {
    return { status: { state: "error", ...scopedReadError(scope, error) } };
  }
}
function errorFields(error: { code: string; message: string }) {
  return { code: error.code, message: error.message };
}
