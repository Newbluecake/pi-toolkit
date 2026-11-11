import { scopedFailure } from "../scopes/error-messages.js";
import { isFromRef, isHubTopic, readUntrustedValue, utf8Bytes } from "../scopes/limits.js";
import type { NormalizedMemoryCall, MemoryV4Params } from "./types.js";

const FIELDS = ["command", "scope", "path", "id", "text", "rev", "query", "topic", "from", "authority"];
/** The public entrance is closed; compatibility renames are opt-in, AFTER old alias validation. */
export function normalizeMemoryV4(
  input: unknown,
  options: { child?: boolean; alias?: boolean } = {},
): { ok: true; call: NormalizedMemoryCall } | ReturnType<typeof scopedFailure> {
  const parsed = readUntrustedValue(input);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value))
    return scopedFailure("E_META_INVALID");
  const p: Record<string, unknown> = { ...parsed.value };
  if (options.child && Object.hasOwn(p, "authority")) return scopedFailure("E_CHILD_AUTHORITY");
  if (
    (Object.hasOwn(p, "command") && Object.hasOwn(p, "op")) ||
    (Object.hasOwn(p, "scope") && Object.hasOwn(p, "storageScope"))
  )
    return scopedFailure("E_META_INVALID");
  if (options.alias && (Object.hasOwn(p, "op") || Object.hasOwn(p, "storageScope"))) {
    // Legacy aliases never acquire v4's default-project behavior. Their closed
    // schema and scope requirement are checked before the two renames.
    if (
      Object.keys(p).some(
        (key) => !["op", "storageScope", "id", "text", "rev", "topic", "from", "authority"].includes(key),
      )
    )
      return scopedFailure("E_META_INVALID");
    if (p.storageScope !== "session" && p.storageScope !== "hub") return scopedFailure("E_SCOPE_DISABLED");
    if (!["view", "create", "update", "delete"].includes(p.op as string)) return scopedFailure("E_META_INVALID");
    if (Object.hasOwn(p, "op")) {
      p.command = p.op;
      delete p.op;
    }
    if (Object.hasOwn(p, "storageScope")) {
      p.scope = p.storageScope;
      delete p.storageScope;
    }
  }
  if (Object.keys(p).some((key) => !FIELDS.includes(key))) return scopedFailure("E_META_INVALID");
  if (!["view", "create", "update", "delete", "search"].includes(p.command as string))
    return scopedFailure("E_META_INVALID");
  const scope = p.scope === undefined ? "project" : p.scope;
  if (!["project", "session", "hub", "all"].includes(scope as string)) return scopedFailure("E_SCOPE_DISABLED");
  if (scope === "all") {
    const allowed =
      p.command === "view" ? ["command", "scope"] : p.command === "search" ? ["command", "scope", "query"] : [];
    if (!allowed.length || Object.keys(p).some((k) => !allowed.includes(k))) return scopedFailure("E_META_INVALID");
  }
  for (const k of ["path", "id", "text", "rev", "query", "topic", "from"])
    if (Object.hasOwn(p, k) && typeof p[k] !== "string") return scopedFailure("E_META_INVALID");
  if (p.authority !== undefined && p.authority !== "agent" && p.authority !== "user")
    return scopedFailure("E_AUTHORITY");
  if (Object.hasOwn(p, "path") && Object.hasOwn(p, "id")) return scopedFailure("E_META_INVALID");
  if (p.command === "search" && (typeof p.query !== "string" || !p.query.trim()))
    return scopedFailure("E_META_INVALID");
  if (scope === "project" && ["id", "from", "authority"].some((k) => Object.hasOwn(p, k)))
    return scopedFailure("E_META_INVALID");
  if ((scope === "session" || scope === "hub") && Object.hasOwn(p, "path")) return scopedFailure("E_META_INVALID");
  if (scope === "session" && Object.hasOwn(p, "topic")) return scopedFailure("E_META_INVALID");
  if (p.command === "create" && (Object.hasOwn(p, "id") || Object.hasOwn(p, "rev")))
    return scopedFailure("E_META_INVALID");
  if ((p.command === "create" || p.command === "update") && typeof p.text !== "string")
    return scopedFailure("E_META_INVALID");
  if (p.command === "create" && scope === "project" && (typeof p.topic !== "string" || !p.topic))
    return scopedFailure("E_META_INVALID");
  if (
    scope === "project" &&
    (p.command === "update" || p.command === "delete") &&
    (typeof p.path !== "string" || !p.path)
  )
    return scopedFailure("E_META_INVALID");
  if (
    (p.command === "update" || p.command === "delete") &&
    (scope === "session" || scope === "hub") &&
    (typeof p.id !== "string" || !p.id)
  )
    return scopedFailure("E_META_INVALID");
  if (
    (p.command === "update" || (p.command === "delete" && scope !== "project")) &&
    (typeof p.rev !== "string" || !p.rev)
  )
    return scopedFailure("E_REV_REQUIRED");
  if (scope === "session" || scope === "hub") {
    if (typeof p.text === "string" && utf8Bytes(p.text) > 1024) return scopedFailure("E_TOO_LARGE");
    if (p.from !== undefined && !isFromRef(p.from)) return scopedFailure("E_FROM_INVALID");
    if (p.topic !== undefined && !isHubTopic(p.topic)) return scopedFailure("E_META_INVALID");
    if (scope === "hub" && p.command === "create" && !isHubTopic(p.topic)) return scopedFailure("E_META_INVALID");
  }
  return { ok: true, call: { ...(p as unknown as MemoryV4Params), scope: scope as NormalizedMemoryCall["scope"] } };
}
