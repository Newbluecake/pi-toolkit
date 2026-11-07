/** F6: transport-neutral session directory. Durable identity is sessionId, NEVER agentKey. */
import { basename } from "node:path";
import { FEISHU_CAPS } from "../../protocol/feishu.js";
import { normalizeAlias } from "../../protocol/xs-alias.js";
import type { FeishuBinding } from "./state.js";

/** FA/F8 projects registry.list() into this small port (offline cards are not live views). */
export interface FeishuSessionView {
  sessionId: string;
  agentKey: string;
  cwd: string;
  name?: string;
  live: boolean;
  mode: "tui" | "rpc";
  state: "busy" | "idle" | "waiting" | "read-only";
}
export interface FeishuManagedSession {
  sessionId: string;
  cwd: string;
  name?: string;
}
export interface FeishuSessionSource {
  views(): readonly FeishuSessionView[];
  managed(): readonly FeishuManagedSession[];
  bindings(): readonly FeishuBinding[];
  /** Hub-held cross-session alias of a session (canonical, no `@`); absent when xs/alias is off. */
  alias?(sessionId: string): string | undefined;
}
export interface FeishuSessionRow {
  sessionId: string;
  name: string;
  /** `名称 · sid6` — disambiguating label for notifications/schedules (NOT shown on the /list card). */
  label: string;
  /** hub-held alias (canonical, without `@`); key absent when the session has none. */
  alias?: string;
  cwd: string;
  mode: "tui" | "rpc" | "managed";
  state: FeishuSessionView["state"] | "offline" | "ambiguous";
}
export type SessionResolution =
  { ok: true; agentKey: string; view: FeishuSessionView } | { ok: false; code: "offline" | "ambiguous" | "read-only" };
export interface SessionListGeneration {
  id: number;
  at: number;
  senderOpenId: string;
  rows: FeishuSessionRow[];
}
export type SessionSelection =
  { ok: true; row: FeishuSessionRow } | { ok: false; code: "not-found" | "ambiguous" | "list-expired" };

export function createFeishuSessions(source: FeishuSessionSource, now: () => number = Date.now) {
  const generations = new Map<string, SessionListGeneration[]>();
  let seq = 0;
  function resolve(sessionId: string): SessionResolution {
    const views = source.views().filter((v) => v.live && v.sessionId === sessionId);
    if (views.length === 0) return { ok: false, code: "offline" };
    if (views.length !== 1) return { ok: false, code: "ambiguous" };
    const view = views[0]!;
    if (view.state === "read-only") return { ok: false, code: "read-only" };
    return { ok: true, agentKey: view.agentKey, view: { ...view } };
  }
  function rows(): FeishuSessionRow[] {
    const views = source.views();
    const managed = source.managed();
    const bound = source.bindings();
    const ids = new Set(views.filter((v) => v.live).map((v) => v.sessionId));
    for (const b of bound) if (b.sessionId !== undefined) ids.add(b.sessionId);
    return [...ids]
      .map((sessionId): FeishuSessionRow => {
        const live = views.filter((v) => v.live && v.sessionId === sessionId);
        const view = live[0] ?? views.find((v) => v.sessionId === sessionId);
        const record = managed.find((r) => r.sessionId === sessionId);
        const binding = bound.find((b) => b.sessionId === sessionId);
        const cwd = view?.cwd ?? record?.cwd ?? "";
        const name = view?.name || record?.name || binding?.label || basename(cwd) || sessionId.slice(0, 6);
        const alias = source.alias?.(sessionId);
        return {
          sessionId,
          name,
          ...(alias === undefined || alias === "" ? {} : { alias }),
          label: `${name} · ${sessionId.slice(0, 6)}`,
          cwd,
          mode: record !== undefined ? "managed" : (view?.mode ?? "rpc"),
          state: live.length > 1 ? "ambiguous" : live.length === 0 ? "offline" : live[0]!.state,
        };
      })
      .sort(
        (a, b) =>
          Number(a.state === "offline") - Number(b.state === "offline") ||
          a.label.localeCompare(b.label) ||
          a.sessionId.localeCompare(b.sessionId),
      );
  }
  function sweep(): void {
    for (const [chatId, list] of generations) {
      const keep = list.filter((g) => now() - g.at < FEISHU_CAPS.listGenerationTtlMs);
      if (keep.length === 0) generations.delete(chatId);
      else generations.set(chatId, keep);
    }
  }
  return {
    resolve,
    rows,
    list(
      chatId: string,
      senderOpenId: string,
    ): { ok: true; generation: SessionListGeneration } | { ok: false; code: "cap" } {
      sweep();
      const list = generations.get(chatId) ?? [];
      // No silent eviction of generations which a user may still be selecting from.
      if (
        list.length >= FEISHU_CAPS.listGenerationsPerChat ||
        (!generations.has(chatId) && generations.size >= FEISHU_CAPS.bindings)
      )
        return { ok: false, code: "cap" };
      const generation = { id: ++seq, at: now(), senderOpenId, rows: rows() };
      generations.set(chatId, [...list, generation]);
      return { ok: true, generation: structuredClone(generation) };
    },
    select(chatId: string, senderOpenId: string, selector: string): SessionSelection {
      sweep();
      let candidates: FeishuSessionRow[];
      if (/^[1-9][0-9]*$/.test(selector)) {
        const generation = generations
          .get(chatId)
          ?.filter((g) => g.senderOpenId === senderOpenId)
          .at(-1);
        if (generation === undefined) return { ok: false, code: "list-expired" };
        const row = generation.rows[Number(selector) - 1];
        candidates = row === undefined ? [] : [row];
      } else {
        const all = rows();
        const exact = all.filter((r) => r.sessionId === selector);
        // `@alias` or bare alias: same normalisation as the alias store (NFKC + ASCII lowercase).
        const n = normalizeAlias(selector, { stripAt: true });
        const byAlias = exact.length > 0 || !n.ok ? [] : all.filter((r) => r.alias === n.alias);
        candidates =
          exact.length > 0
            ? exact
            : byAlias.length > 0
              ? byAlias
              : selector.startsWith("@")
                ? []
                : all.filter((r) => r.sessionId.startsWith(selector) || r.name === selector);
      }
      if (candidates.length !== 1) return { ok: false, code: candidates.length > 1 ? "ambiguous" : "not-found" };
      const row = candidates[0]!;
      if (row.state === "ambiguous" || source.views().filter((v) => v.live && v.sessionId === row.sessionId).length > 1)
        return { ok: false, code: "ambiguous" };
      return { ok: true, row: { ...row } };
    },
    clear() {
      generations.clear();
    },
  };
}
export type FeishuSessions = ReturnType<typeof createFeishuSessions>;

export function feishuBindingKey(chatType: "p2p" | "group", chatId: string, threadId?: string): string | undefined {
  return chatType === "p2p" ? `p2p:${chatId}` : threadId ? `grp:${chatId}:${threadId}` : undefined;
}
