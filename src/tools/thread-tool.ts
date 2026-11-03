/**
 * fabric-thread arch r3 §5.1 (P3): the MAIN-session `thread` tool — `list` / `subscribe` /
 * `unsubscribe`. Registered post-guard (right after the fabric tool group) by src/index.ts, ONLY
 * while `fabric.enabled ∧ fabric.threads.enabled` (G2a: off ⇒ the tool never exists and the tool
 * table stays byte-identical). Child sessions never see this form (their `thread` is the
 * customTools closure from thread-child-tool.ts).
 *
 * All logic lives on the stack surface (`ThreadStackSurface`, stack.ts) — this file is the
 * schema + result-text mapping only, so it stays unit-testable against a fake surface.
 *
 * rebind-plan r3 §4.8 (agent package): TWO frozen schema instances, picked once per activation
 * by `threadParamsFor(rebindOn)` (same precedent as message-session-tool's Legacy/Reply):
 *   - `ThreadToolParamsLegacy` — byte-identical to the pre-rebind schema (three actions, no
 *     `to`); `threads on ∧ rebind off` keeps using it, description unappended (A16);
 *   - `ThreadToolParamsRebind` — adds the `rebind`/`acquire` actions and the `to` parameter.
 * `fromRev` is NEVER a model parameter — the agent injects it internally (§4.7); the model
 * neither should nor could supply a binding generation for a declarative tool call.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { THREAD_HANDLE_RE } from "../web-hub/protocol/thread.js";
import type { ThreadAcquireResult, ThreadRebindResult } from "../fabric/thread/engine.js";

/** Frozen LEGACY instance (rebind off). Byte-identical to the pre-rebind schema — pinned by
 *  `tests/fixtures/thread-rebind-off-golden.json`; never edit. */
export const ThreadToolParamsLegacy = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("subscribe"), Type.Literal("unsubscribe")], {
    description:
      "list: current threads + subscriptions. subscribe: route a thread's further events to a run. unsubscribe: end one subscription.",
  }),
  run: Type.Optional(
    Type.String({
      description:
        "subscribe: target direct-dispatch run — the full run id, a unique run id prefix, or the run's @label.",
    }),
  ),
  h: Type.Optional(
    Type.String({
      description:
        "subscribe/unsubscribe: thread handle `fs:…` (15 chars, from a routed event's display line or `list`). " +
        'subscribe alternatively accepts the literal "origin" — the thread of the Feishu prompt(s) this turn ' +
        "started from.",
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description:
        "subscribe: the run's responsibility statement (≤200 chars) — quoted in every event wrapper so the " +
        'worker can judge "in scope or handback". Defaults to the run\'s label.',
    }),
  ),
  subId: Type.Optional(Type.String({ description: "unsubscribe: the subscription id from `list` (t1, t2, …)." })),
});
/** Back-compat name for the legacy instance. */
export const ThreadToolParams = ThreadToolParamsLegacy;
export type ThreadToolParams = Static<typeof ThreadToolParamsLegacy>;

/** rebind-plan r3 §4.8: the second frozen instance (rebind on) — the legacy properties verbatim
 *  except the extended `action` union, plus `to`. */
export const ThreadToolParamsRebind = Type.Object({
  ...ThreadToolParamsLegacy.properties,
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("subscribe"),
      Type.Literal("unsubscribe"),
      Type.Literal("rebind"),
      Type.Literal("acquire"),
    ],
    {
      description:
        "list: current threads + subscriptions. subscribe: route a thread's further events to a run. unsubscribe: end one subscription. " +
        "rebind: transfer the Feishu topic binding behind h to another session (you must be its current holder). " +
        "acquire: register/refresh YOUR ownership of a thread in the local directory (the only trusted re-entry; needed before subscribe when the directory doesn't know the thread).",
    },
  ),
  to: Type.Optional(
    Type.String({
      description:
        "rebind: target session selector — a full session id, a unique id prefix (≥6), an exact alias, or an exact session name (≤128 chars).",
    }),
  ),
});
export type ThreadToolParamsRebind = Static<typeof ThreadToolParamsRebind>;

/** The ONE instance-selection rule (rebind-plan r3 §4.8): `fabric.threads.rebind` (frozen at
 *  activate) ⇒ the rebind instance, otherwise the legacy one — threads-on × rebind-off stays
 *  byte-identical (A16). */
export function threadParamsFor(rebindOn: boolean): typeof ThreadToolParamsLegacy | typeof ThreadToolParamsRebind {
  return rebindOn ? ThreadToolParamsRebind : ThreadToolParamsLegacy;
}

/** What the main tool needs from the stack surface (§5.1 createdBy:"root"). */
export interface ThreadMainOps {
  list(): string;
  subscribe(input: {
    run: string;
    h: string;
    scope: string;
    origin: boolean;
  }):
    | { ok: true; subId: string; created: boolean; h: string; label: string }
    | { ok: false; reason: string; detail?: string };
  unsubscribe(subId: string): { ok: true } | { ok: false; reason: string };
  origins(): ReadonlyArray<{ h: string; label: string; at: number }>;
  /** rebind-plan r3 §3.2 (optional so rebind-off stubs stay valid — the rebind schema never
   *  reaches these actions without the dep). origin resolution happens on the surface. */
  acquire?(input: { h: string; origin: boolean; force?: boolean }): Promise<ThreadAcquireResult>;
  rebind?(input: { h: string; to: string; origin: boolean }): Promise<ThreadRebindResult>;
}

export interface ThreadToolDeps {
  /** The live stack surface — undefined (no stack / feature off) answers a fixed line. */
  current(): ThreadMainOps | undefined;
  /** rebind-plan r3 §4.8: `fabric.threads.rebind` frozen at activate — selects the schema
   *  instance and the description. Omitted/false ⇒ the legacy tool, byte-identical (A16). */
  rebind?: boolean;
}

const LEGACY_DESCRIPTION =
  "Manage Feishu thread subscriptions: while a run holds an ACTIVE subscription for a thread, that " +
  "thread's further events are steered DIRECTLY to the run (no main-session turn). subscribe requires a " +
  'direct-dispatch run in {queued, starting, running} and the thread handle; `h:"origin"` resolves the ' +
  "thread the current turn's Feishu prompt came from. Re-subscribing the same (run, thread) is idempotent " +
  "(updates the scope). Subscriptions end automatically when the run settles.";

/** rebind-plan r3 §4.8: the rebind-on description — legacy prose + the two new actions and the
 *  dispatch/acquire convention (worker acquires BEFORE subscribing; without it subscribe degrades
 *  safely to thread_unknown and events keep taking the main-session path). */
const REBIND_DESCRIPTION =
  LEGACY_DESCRIPTION +
  " rebind: transfer a Feishu topic you currently hold to another session — the result carries the resolved FULL " +
  "sessionId; dispatch to it with message_session(to: that sid) and put the thread handle in the dispatch text, " +
  'telling the worker to run thread(action:"acquire", h) BEFORE subscribing or replying (acquire is the only ' +
  "trusted directory entry; skipping it makes subscribe answer thread_unknown and the events keep going to the " +
  "main session — a safe degrade, not an error). acquire: register/refresh your own hold of a thread (use it when " +
  "you were told a handle is yours but list/subscribe don't know it). " +
  'Failures: E_THR_UNSUPPORTED means the hub lacks thr.rebind.v1 — do NOT retry. effect "none" means provably ' +
  'NOT applied — fix the cause and retry. effect "unknown" means it MAY have been applied — do NOT blind-retry: ' +
  'probe with thread(action:"acquire", h) first (owned ⇒ still yours, retry once is safe; not owner ⇒ already ' +
  "transferred, dispatch normally).";

/** §4.8 failure mapping — the three classes a model must distinguish. */
function failureText(code: string, effect: "none" | "unknown"): string {
  if (code === "E_THR_UNSUPPORTED")
    return "E_THR_UNSUPPORTED: the hub does not support thread rebind (thr.rebind.v1) — do NOT retry.";
  if (effect === "unknown")
    return (
      `${code} (effect unknown) — this MAY already have taken effect; do NOT blind-retry: probe with ` +
      'thread(action:"acquire", h) first — owned ⇒ still yours (one retry is safe); not owner ⇒ already transferred, ' +
      "dispatch normally."
    );
  switch (code) {
    case "E_THR_NO_OWNER":
      return "E_THR_NO_OWNER (effect none) — you are not the current holder of this thread; only its holder can transfer it. Nothing was applied.";
    case "E_THR_STALE":
      return "E_THR_STALE (effect none) — the binding changed underneath you; nothing was applied. Retry the action once (freshness is re-observed automatically).";
    case "E_THR_NOT_BOUND":
      return "E_THR_NOT_BOUND (effect none) — the binding behind this handle no longer exists; nothing was applied.";
    case "E_THR_TARGET_UNKNOWN":
    case "E_THR_TARGET_AMBIGUOUS":
    case "E_THR_TARGET_OFFLINE":
    case "E_THR_TARGET_READONLY":
      return `${code} (effect none) — the "to" selector did not resolve to exactly one live, writable session; nothing was applied. Fix "to" and retry.`;
    case "E_NO_ORIGIN":
      return "E_NO_ORIGIN (effect none) — no Feishu thread event reached this session recently; pass an explicit h.";
    case "E_AMBIGUOUS_ORIGIN":
      return "E_AMBIGUOUS_ORIGIN (effect none) — several threads delivered events recently; pass an explicit h.";
    default:
      return `${code} (effect none) — provably NOT applied; fix the cause and retry.`;
  }
}

export function createThreadTool(deps: ThreadToolDeps): ToolDefinition<typeof ThreadToolParamsLegacy> {
  const rebindOn = deps.rebind === true;
  const reply = (text: string): { content: Array<{ type: "text"; text: string }>; details: unknown } => ({
    content: [{ type: "text", text }],
    details: { source: "thread" },
  });
  return {
    name: "thread",
    label: "thread",
    description: rebindOn ? REBIND_DESCRIPTION : LEGACY_DESCRIPTION,
    parameters: (rebindOn ? ThreadToolParamsRebind : ThreadToolParamsLegacy) as typeof ThreadToolParamsLegacy,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ThreadToolParams & Partial<ThreadToolParamsRebind>;
      const ops = deps.current();
      if (ops === undefined)
        return reply("thread subscriptions are off (fabric.threads.enabled=false) or no live session stack.");
      // the union widens with the rebind instance; compare as string so both schemas type-check.
      switch ((params as { action: string }).action) {
        case "list":
          return reply(ops.list());
        case "subscribe": {
          if (params.run === undefined || params.run.trim() === "")
            return reply('E_BAD_REQUEST: subscribe needs "run" (run id, prefix or @label).');
          const h = (params.h ?? "").trim();
          if (h !== "origin" && !THREAD_HANDLE_RE.test(h))
            return reply('E_BAD_REQUEST: subscribe needs "h" — a `fs:…` handle or the literal "origin".');
          const result = ops.subscribe({
            run: params.run.trim(),
            h,
            scope: params.scope ?? "",
            origin: h === "origin",
          });
          if (!result.ok) {
            const hint =
              result.reason === "run_not_found"
                ? "unknown run — pass the full run id from the Agent result"
                : result.reason === "run_not_direct"
                  ? "that run is workflow-internal / external / nested — only direct-dispatch runs subscribe"
                  : result.reason === "run_status"
                    ? "the run is stopping or already terminal"
                    : result.reason === "thread_unknown"
                      ? "unknown handle — handles come from routed events or /thread status; wait for an event first"
                      : result.reason === "hub_unsupported"
                        ? "the hub link is offline or lacks thr.v1"
                        : result.reason === "ambiguous_origin"
                          ? "several threads delivered events recently — pass an explicit h: " + (result.detail ?? "")
                          : result.reason === "no_origin"
                            ? "no Feishu thread event reached this session recently — pass an explicit h"
                            : (result.detail ?? result.reason);
            return reply(`E_${result.reason.toUpperCase()}: ${hint}`);
          }
          return reply(
            `${result.created ? "subscribed" : "updated (idempotent)"}: ${result.subId} · thread ${result.h} ` +
              `「${result.label}」→ run events now steer directly; the run answers via its own thread tool.`,
          );
        }
        case "unsubscribe": {
          const subId = (params.subId ?? "").trim();
          if (subId === "") return reply('E_BAD_REQUEST: unsubscribe needs subId (from thread(action:"list")).');
          const result = ops.unsubscribe(subId);
          return reply(
            result.ok ? `ended ${subId}.` : `E_${result.reason.toUpperCase()}: unknown or already-ended subscription.`,
          );
        }
        // ------------------------------------------------ rebind-plan r3 §4.8 (rebind-on only)
        case "acquire": {
          if (ops.acquire === undefined)
            return reply("E_THR_UNSUPPORTED: thread acquire is off (fabric.threads.rebind=false).");
          const h = (params.h ?? "").trim();
          if (h !== "origin" && !THREAD_HANDLE_RE.test(h))
            return reply('E_BAD_REQUEST: acquire needs "h" — a `fs:…` handle or the literal "origin".');
          const result = await ops.acquire({ h, origin: h === "origin" });
          if (!result.ok) return reply(failureText(result.code, result.effect));
          if (result.already)
            return reply(
              `already open: thread ${h}「${result.label ?? ""}」is registered in the local directory ` +
                `(fast path — no hub round trip, rev NOT refreshed${result.rev !== undefined ? `; last known rev ${result.rev}` : ""}).`,
            );
          return reply(
            `acquired: thread ${h}「${result.label ?? ""}」registered (rev ${result.rev ?? "?"}) — the directory ` +
              "entry is OPEN; you may subscribe now.",
          );
        }
        case "rebind": {
          if (ops.rebind === undefined)
            return reply("E_THR_UNSUPPORTED: thread rebind is off (fabric.threads.rebind=false).");
          const h = (params.h ?? "").trim();
          if (h !== "origin" && !THREAD_HANDLE_RE.test(h))
            return reply('E_BAD_REQUEST: rebind needs "h" — a `fs:…` handle or the literal "origin".');
          const to = (params.to ?? "").trim();
          if (to === "")
            return reply('E_BAD_REQUEST: rebind needs "to" (a session id, unique prefix, alias or exact name).');
          if (to.length > 128) return reply('E_BAD_REQUEST: "to" is over 128 chars.');
          const result = await ops.rebind({ h, to, origin: h === "origin" });
          if (!result.ok) return reply(failureText(result.code, result.effect));
          if (!result.changed)
            return reply(
              `no-op: thread ${result.h} was ALREADY bound to session ${result.sessionId} (rev ${result.rev} ` +
                "unchanged) — nothing was transferred; you can dispatch to it directly.",
            );
          return reply(
            `rebound: thread ${result.h}「${result.label}」is now bound to session ${result.sessionId} (rev ${result.rev}). ` +
              `Dispatch with message_session(to:"${result.sessionId}") and put the handle ${result.h} in the dispatch text, ` +
              'telling the worker to run thread(action:"acquire", h:"' +
              result.h +
              '") BEFORE subscribing or replying.',
          );
        }
      }
      // unreachable under either frozen schema — a smuggled action string.
      return reply(`E_BAD_REQUEST: unknown action ${String((params as { action: unknown }).action)}.`);
    },
  };
}
