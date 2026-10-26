import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../config/settings.js";
import type { XsActivation } from "../fabric/xs/activate.js";
import type { XsSender } from "../fabric/xs/sender.js";
import { forwardQuery, forwardSpawn, type StackHolder } from "../holder.js";
import type { WebHubControl } from "../web-hub/agent/index.js";
import { createMentionAutocompleteProvider, type MentionAutocompleteEntry } from "./autocomplete.js";
import { createMentionRouteDeps, installMentionInput } from "./mention.js";
import {
  SESSION_MENTION_ERROR_SOURCE,
  SESSION_MENTION_SENT_CUSTOM_TYPE,
  createMentionSessionPort,
  sessionCompletionAlias,
  sessionCompletionBare,
  type MentionSessionPort,
  type MentionSessionSendOutcome,
  type SessionMentionNotice,
} from "./session.js";

export interface MentionWiringDeps {
  settings: AgentSettings;
  holder: StackHolder;
  xs: XsActivation;
  webHubRef: { current?: WebHubControl };
  /** index.ts's `notifyCapabilityCtx` (latest live session_start ctx). */
  notifyCtx: { current?: ExtensionContext };
}

export interface MentionWiring {
  /** The `@run` / `@session` routing deps (web-hub's mention dep spreads them too). */
  readonly routeDeps: ReturnType<typeof createMentionRouteDeps>;
  sessionNoticeMessage(notice: SessionMentionNotice): {
    customType: string;
    content: string;
    display: boolean;
    details: { source: string };
  };
  /** `installMentionInput(pi, routeDeps)`; call it right after the two wake `input` hooks. */
  install(pi: ExtensionAPI): void;
  /** session_start: `@` autocomplete provider (gated on `ctx.hasUI` ∧ `addAutocompleteProvider`). */
  attachAutocomplete(ctx: ExtensionContext): void;
}

/**
 * `@handle` / `@session` mention wiring moved verbatim out of `activate()` (#56 batch 2 step 5-6).
 * Depends on the xs activation (sender / attached / directory); never imports index.ts.
 */
export function createMentionWiring(deps: MentionWiringDeps): MentionWiring {
  const { settings, holder, xs, webHubRef, notifyCtx: notifyCapabilityCtx } = deps;
  // X6: @handle mentions. Registered once; resolves through the current
  // session's stack like the tools above. Conservative by contract: unknown
  // labels and @file/paths fall through to pi untouched.
  // Reply-plan §9.1 static facts shared by routing and completion (all LIVE reads).
  const sessionParseDeps = () => ({
    isLabel: (name: string) => holder.current?.mention.resolve(name) !== undefined,
    cwd: () => notifyCapabilityCtx.current?.cwd ?? process.cwd(),
    lookupExact: (name: string) => {
      const directory = xs.attached() ? holder.current?.xs?.directory : undefined;
      const row = directory?.lookupExact(name);
      // A miss on a shape-valid bare name warms the (throttled, single-flight) cache so the NEXT
      // attempt can match; this attempt still passes through to pi (RR8).
      if (row === undefined) void directory?.refresh("lookup");
      return row;
    },
    // Alias-plan §5.4 (ALW, AL5b): LIVE alias mode + the directory's unique alias lookup. Absent while alias is off
    // ⇒ the parse path is byte-identical to the pre-alias one.
    ...(xs.aliasOn
      ? {
          aliasMode: xs.aliasUsable,
          lookupAlias: (alias: string) => {
            const directory = xs.attached() ? holder.current?.xs?.directory : undefined;
            const row = directory?.lookupAlias(alias);
            // §5.4 step 6: a miss on an alias-shaped token (only reached after normalizeAlias ∧ label/file checks)
            // warms the throttled single-flight cache; this attempt still falls through.
            if (row === undefined) void directory?.refresh("mention");
            return row;
          },
        }
      : {}),
  });
  // Reply-plan §9.4/§9.6: human-origin @session notices are display-only (never triggerTurn).
  const sessionNoticeMessage = (notice: SessionMentionNotice) =>
    notice.kind === "error"
      ? {
          customType: "subagent:mention-error",
          content: notice.message,
          display: true,
          details: { source: SESSION_MENTION_ERROR_SOURCE },
        }
      : {
          customType: SESSION_MENTION_SENT_CUSTOM_TYPE,
          content: notice.message,
          display: true,
          details: { source: SESSION_MENTION_ERROR_SOURCE },
        };
  // Reply-plan §9.3: present iff xs is on. `joined` is a LIVE read (join/leave/connect are
  // call-time facts, §9.3/§9.7) — xs off / not joined / left ⇒ parse() undefined ⇒ `@` passes through.
  const mentionSessions: MentionSessionPort | undefined = xs.sender()
    ? createMentionSessionPort({
        ...sessionParseDeps(),
        // Channel-plan §2.3 (CHW): the LINK set — a named-channel-only session on an old hub passes `@` through.
        joined: () =>
          xs.attached() &&
          holder.current?.xs?.membership.linkJoined(xs.channelsOn && xs.hubChannelCap()) === true &&
          webHubRef.current?.xs !== undefined,
        send: async (target, message, options) => {
          const out = await xs.sender()!.message({
            to: target,
            text: message,
            wake: true,
            ...(options?.expectReply === false ? {} : { expectReply: {} }),
            origin: "human",
            levelOverride: 0,
          });
          return mapMentionSendOutcome(out, settings.fabric.crossSession.reply.maxPending);
        },
      })
    : undefined;
  const mentionRouteDeps = createMentionRouteDeps({
    ...(mentionSessions ? { sessions: mentionSessions } : {}),
    registry: {
      register: () => false, // registrations flow from spawn labels inside the stack
      resolve: (label) => holder.current?.mention.resolve(label),
      labels: () => holder.current?.mention.labels() ?? [],
      reassign: () => undefined, // label re-pointing is driven by the stack's onLabel wiring
    },
    query: forwardQuery(holder),
    spawn: forwardSpawn(holder),
    // message_agent reply hint only when fabric is on (subagents own the tool then)
    fabricEnabled: () => holder.current?.fabric != null,
    // X6b: surface the user's raw @ message in the fleet widget under the target run
    noteMention: (runId, message, pendingSince) => holder.current?.mentionNotes.set(runId, message, pendingSince),
  });
  return {
    routeDeps: mentionRouteDeps,
    sessionNoticeMessage,
    install: (pi) => installMentionInput(pi, mentionRouteDeps),
    attachAutocomplete(ctx) {
      if (ctx.hasUI && typeof ctx.ui.addAutocompleteProvider === "function") {
        ctx.ui.addAutocompleteProvider((current) =>
          createMentionAutocompleteProvider(current, {
            entries: () => mentionAutocompleteEntries(holder),
            ...(mentionSessions
              ? {
                  sessions: () => {
                    const directory = xs.attached() ? holder.current?.xs?.directory : undefined;
                    if (!directory) return [];
                    void directory.refresh("complete"); // never awaited (§9.5)
                    return directory.rows().map((row) => ({
                      ref: row.ref,
                      ...(row.name !== undefined ? { name: row.name } : {}),
                      cwdLabel: row.cwdLabel,
                      receive: row.receive,
                      busy: row.busy,
                      ...(row.channels !== undefined && row.channels.length > 0 ? { channels: row.channels } : {}),
                      ...(xs.aliasOn && row.alias !== undefined ? { alias: row.alias } : {}),
                    }));
                  },
                  sessionBareName: (name: string) => sessionCompletionBare(sessionParseDeps(), name),
                  ...(xs.aliasOn
                    ? { sessionBareAlias: (alias: string) => sessionCompletionAlias(sessionParseDeps(), alias) }
                    : {}),
                }
              : {}),
          }),
        );
      }
    },
  };
}

/** D-M7: live root-child mention view shared by the @ autocomplete wrapper
 *  and `/agent status`. Reads through the holder at call time, so wrappers
 *  registered on an earlier session_start keep seeing the rebuilt stack. */
export function mentionAutocompleteEntries(holder: StackHolder): readonly MentionAutocompleteEntry[] {
  const stack = holder.current;
  if (!stack) return [];
  const terminal = new Set(["completed", "failed", "timed_out", "aborted"]);
  return stack.mention.labels().flatMap((label) => {
    const target = stack.mention.resolve(label);
    // v2 hard constraint: only root-direct runs are mentionable (D-M7).
    if (!target || target.parent !== "root") return [];
    const status = stack.query.get(target.runId)?.status;
    return [
      {
        label,
        type: target.type,
        runId: target.runId,
        status: status === "running" ? "running" : status && terminal.has(status) ? "settled" : "other",
      } satisfies MentionAutocompleteEntry,
    ];
  });
}

/** Reply-plan §9.3/§9.6 (MW): project the fabric sender's outcome onto the mention layer's port
 *  shape. Anything the notices do not name (stale/changed origin, unreceivable, bad args, …) is an
 *  `error` carrying the sender's reason, with the sender's own effect (none ⇒ safe to retry). */
function mapMentionSendOutcome(
  out: Awaited<ReturnType<XsSender["message"]>>,
  maxPending: number,
): MentionSessionSendOutcome {
  const base = { effect: out.effect, ...(out.to !== undefined ? { to: out.to } : {}) };
  switch (out.status) {
    case "sent": {
      const dueAt = out.reply ? Date.parse(out.reply.dueAt) : Number.NaN;
      return {
        status: "sent",
        ...base,
        ...(out.reason !== undefined ? { reason: out.reason } : {}),
        ...(out.reply ? { requestId: out.reply.requestId } : {}),
        ...(Number.isFinite(dueAt) ? { replyDueAt: dueAt } : {}),
      };
    }
    case "no_target":
    case "ambiguous":
    case "reply_unsupported":
      return { status: out.status, ...base, ...(out.reason !== undefined ? { reason: out.reason } : {}) };
    case "reply_quota":
      return { status: "reply_quota", ...base, pendingReplies: maxPending };
    case "reply_unreceivable":
      return { status: "error", ...base, reason: `reply_unreceivable:${out.unreceivable ?? "unknown"}` };
    default:
      return { status: "error", ...base, reason: out.reason ?? out.code ?? out.status };
  }
}
