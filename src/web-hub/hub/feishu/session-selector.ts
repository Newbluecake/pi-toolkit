/**
 * 飞书话题换绑方案 r3 §4.6 (P1) — the ONE resolution ladder for `thr_req{op:"rebind"}.to`.
 *
 * Deliberately standalone (NOT `sessions.select`): that one needs a chat context, a sender and
 * a `/list` generation (§2.2), none of which exist on the agent→hub thr channel. This ladder is
 * pure over the live session views + the hub-held alias store:
 *
 *   完整 sid → 唯一前缀（≥6）→ 精确别名 → 精确 name
 *
 * A rung with >1 DISTINCT session hits ⇒ `E_THR_TARGET_AMBIGUOUS` immediately — the ladder never
 * descends past an ambiguous rung. A single hit is then admission-checked the same way
 * `sessions.resolve` does: no live view ⇒ `E_THR_TARGET_OFFLINE`, >1 live ⇒
 * `E_THR_TARGET_AMBIGUOUS`, `state === "read-only"` ⇒ `E_THR_TARGET_READONLY`.
 *
 * `aliasOf` is the hub-held cross-session alias lookup (xs relay store, canonical form without
 * `@`); the selector is normalized with the SAME `normalizeAlias` as the alias store, so the
 * comparison is canonical-to-canonical. Pure: no I/O, no clock, no module-scope state (I4).
 */
import { basename } from "node:path";
import { normalizeAlias } from "../../protocol/xs-alias.js";
import type { FeishuSessionView } from "./sessions.js";

export type SessionSelectResult =
  | { ok: true; sessionId: string; agentKey: string; label: string }
  | {
      ok: false;
      code: "E_THR_TARGET_UNKNOWN" | "E_THR_TARGET_AMBIGUOUS" | "E_THR_TARGET_OFFLINE" | "E_THR_TARGET_READONLY";
    };

/** The rebind `to` prefix rung only accepts selectors of ≥6 UTF-16 units (§4.6). */
export const THREAD_REBIND_PREFIX_MIN = 6;

export function selectSession(
  q: string,
  views: readonly FeishuSessionView[],
  aliasOf: (sessionId: string) => string | undefined,
): SessionSelectResult {
  const bySid = new Map<string, FeishuSessionView[]>();
  for (const v of views) {
    const list = bySid.get(v.sessionId);
    if (list === undefined) bySid.set(v.sessionId, [v]);
    else list.push(v);
  }
  let hits: string[] = [];
  if (bySid.has(q)) {
    hits = [q];
  } else if (q.length >= THREAD_REBIND_PREFIX_MIN) {
    const prefixed = [...bySid.keys()].filter((sid) => sid.startsWith(q));
    if (prefixed.length > 0) hits = prefixed;
  }
  if (hits.length === 0) {
    const n = normalizeAlias(q, { stripAt: true });
    if (n.ok) {
      const aliased = [...bySid.keys()].filter((sid) => aliasOf(sid) === n.alias);
      if (aliased.length > 0) hits = aliased;
    }
  }
  if (hits.length === 0) {
    const named = [...new Set(views.filter((v) => v.name === q).map((v) => v.sessionId))];
    if (named.length > 0) hits = named;
  }
  if (hits.length === 0) return { ok: false, code: "E_THR_TARGET_UNKNOWN" };
  if (hits.length > 1) return { ok: false, code: "E_THR_TARGET_AMBIGUOUS" };
  const sessionId = hits[0]!;
  const live = bySid.get(sessionId)!.filter((v) => v.live);
  if (live.length === 0) return { ok: false, code: "E_THR_TARGET_OFFLINE" };
  if (live.length > 1) return { ok: false, code: "E_THR_TARGET_AMBIGUOUS" };
  const view = live[0]!;
  if (view.state === "read-only") return { ok: false, code: "E_THR_TARGET_READONLY" };
  return {
    ok: true,
    sessionId,
    agentKey: view.agentKey,
    label: view.name || basename(view.cwd) || sessionId.slice(0, 6),
  };
}
