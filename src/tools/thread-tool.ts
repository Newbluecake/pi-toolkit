/**
 * fabric-thread arch r3 §5.1 (P3): the MAIN-session `thread` tool — `list` / `subscribe` /
 * `unsubscribe`. Registered post-guard (right after the fabric tool group) by src/index.ts, ONLY
 * while `fabric.enabled ∧ fabric.threads.enabled` (G2a: off ⇒ the tool never exists and the tool
 * table stays byte-identical). Child sessions never see this form (their `thread` is the
 * customTools closure from thread-child-tool.ts).
 *
 * All logic lives on the stack surface (`ThreadStackSurface`, stack.ts) — this file is the
 * schema + result-text mapping only, so it stays unit-testable against a fake surface.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { THREAD_HANDLE_RE } from "../web-hub/protocol/thread.js";

export const ThreadToolParams = Type.Object({
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
export type ThreadToolParams = Static<typeof ThreadToolParams>;

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
}

export interface ThreadToolDeps {
  /** The live stack surface — undefined (no stack / feature off) answers a fixed line. */
  current(): ThreadMainOps | undefined;
}

export function createThreadTool(deps: ThreadToolDeps): ToolDefinition<typeof ThreadToolParams> {
  const reply = (text: string): { content: Array<{ type: "text"; text: string }>; details: unknown } => ({
    content: [{ type: "text", text }],
    details: { source: "thread" },
  });
  return {
    name: "thread",
    label: "thread",
    description:
      "Manage Feishu thread subscriptions: while a run holds an ACTIVE subscription for a thread, that " +
      "thread's further events are steered DIRECTLY to the run (no main-session turn). subscribe requires a " +
      'direct-dispatch run in {queued, starting, running} and the thread handle; `h:"origin"` resolves the ' +
      "thread the current turn's Feishu prompt came from. Re-subscribing the same (run, thread) is idempotent " +
      "(updates the scope). Subscriptions end automatically when the run settles.",
    parameters: ThreadToolParams,
    async execute(_toolCallId, params) {
      const ops = deps.current();
      if (ops === undefined)
        return reply("thread subscriptions are off (fabric.threads.enabled=false) or no live session stack.");
      switch (params.action) {
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
      }
    },
  };
}
