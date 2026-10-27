import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readBeforeAgentStartTrigger } from "../../adapters/pi-compat.js";
import type { AgentSettings } from "../../config/settings.js";
import type { StackHolder } from "../../holder.js";
import type { Stack } from "../../stack.js";
import type { WebHubControl, WebHubDeps } from "../../web-hub/agent/index.js";
import { currentConnection } from "../../web-hub/agent/connection.js";
import { XS_ALIAS_V2_HUB_CAP, XS_CHANNEL_HUB_CAP } from "../../web-hub/protocol/xs.js";
import type { XsHubLimitsWire } from "../../web-hub/protocol/xs.js";
import { createFabricXsCommand } from "../../commands/fabric-xs.js";
import { createListSessionsTool, listSessionsParamsFor } from "../../tools/list-sessions-tool.js";
import { createMessageChannelTool, MessageChannelParams } from "../../tools/message-channel-tool.js";
import { createMessageSessionTool, messageSessionParamsFor } from "../../tools/message-session-tool.js";
import { observeRootWakeTrigger } from "../root-wake.js";
import { aliasSuggestions } from "./alias-suggest.js";
import type { XsAliasMarkDecided } from "./alias-decided.js";
import { getXsHostCapability } from "./host-cap.js";
import { getXsReplyLedger } from "./reply-ledger.js";
import { createXsSender, detectXsToolCollisions, type XsSender } from "./sender.js";
import { stashXsMembershipHandoff, takeXsMembershipHandoff, type XsMembershipEntryData } from "./membership.js";
import {
  stashXsAliasHandoff,
  takeXsAliasHandoff,
  XS_ALIAS_HANDOFF_PENDING_MS,
  type XsAliasHandoffShot,
} from "./alias-handoff.js";
import type { StackXsInput } from "./stack.js";
import { xsOn } from "./switch.js";
import type { XsChannelView } from "./types-channel.js";
import { display as unreadDisplay, XS_INBOX_STATUS_KEY } from "./unread.js";
import { getXsWakeLedger } from "./wake-ledger.js";

export interface XsActivationDeps {
  settings: AgentSettings;
  holder: StackHolder;
  webHubRef: { current?: WebHubControl };
  /** index.ts's `xsFencePorts` (schedule / goal / topic-switch also write it). */
  fencePorts: { topicSwitch?: () => boolean; goal?: () => boolean };
  /** index.ts's `notifyCapabilityCtx` (alias suggestions, alias-lost notice, @session cwd). */
  notifyCtx: { current?: ExtensionContext };
  /** Late-bound: the scheduler is built after this activation (`/fabric fence reset` → `resetBlockers`). */
  scheduleMessage: () => { resetBlockers(): void } | undefined;
}

export interface XsActivation {
  readonly enabled: boolean;
  readonly replyEnabled: boolean;
  readonly channelsOn: boolean;
  readonly aliasOn: boolean;
  /** Live read of the attach state — never snapshot it. */
  attached(): boolean;
  hubChannelCap(): boolean;
  aliasUsable(): boolean;
  /** The sender, present only after `registerSurface` ran with xs on. */
  sender(): XsSender | undefined;
  capabilityState(): ReturnType<typeof getXsHostCapability>["state"];
  /** Phase a: B1 trigger guard + unread turn-event forwarders. */
  registerTriggerGuard(pi: ExtensionAPI): void;
  /** Phase b: fence hooks, agent_settled, session_shutdown (C1). */
  registerFenceHooks(pi: ExtensionAPI): void;
  /** Phase c: sender, list_sessions / message_session / message_channel, `/fabric`. */
  registerSurface(pi: ExtensionAPI): void;
  /** session_shutdown: on a `/new` boundary (reason "new") stash the outgoing stack's explicit
   *  membership for the successor session (new-session-channels-fix). No-op otherwise. */
  stashMembershipHandoff(reason: string): void;
  /** session_start: clears `attached`, returns the session id this start proves (undefined when xs is idle). */
  beginSessionStart(ctx: ExtensionContext, reason?: string): string | undefined;
  /** session_start with a live previous stack: a NEW session identity proves the old one ended. */
  defensiveTeardown(nextSessionId: string | undefined): void;
  /** `buildSessionStack`'s xs argument (undefined when xs is off). */
  stackInput(): StackXsInput | undefined;
  /** session_start after `holder.current = stack`: id, inbox re-render, attached flag, tool-collision scan. */
  attach(stack: Stack, ctx: ExtensionContext, pi: ExtensionAPI, nextSessionId: string | undefined): void;
  /** `{ xs }` slot of the wireWebHub deps (empty object when xs is off). */
  webHubDeps(): Pick<WebHubDeps, "xs">;
}

/**
 * Cross-session (xs) activation state and its staged registrations, moved verbatim out of `activate()`
 * (#56 batch 2 step 5-5). The three `register*` phases are called from `activate()` at the ORIGINAL positions —
 * their order relative to archive / memory / schedule / mention registrations is pinned by the activation
 * trace golden. All xs `let`s live inside this closure; readers go through the accessor methods.
 */
export function createXsActivation(deps: XsActivationDeps): XsActivation {
  const { settings, holder, webHubRef, fencePorts: xsFencePorts, notifyCtx: notifyCapabilityCtx } = deps;
  const xsEnabled = xsOn({
    fabric: settings.fabric,
    webHub: { enabled: settings.webHub.enabled, control: settings.webHub.control !== false },
  }); // frozen per activate: tools/caps/stack all share this gate
  const replyEnabled = xsEnabled && settings.fabric.crossSession.reply.enabled; // frozen per activate
  // Channel-plan §3.1/§6 (CHW): frozen per activate (non-live). Off ⇒ old-agent shape: no
  // `xs.channel.v1` cap, no `message_channel`, the legacy `list_sessions` instance, named channels suspended.
  const channelsOn = xsEnabled && settings.fabric.crossSession.channels.enabled;
  // Alias-plan §3.6/§6 (ALW): frozen per activate (non-live). Picks the alias tool descriptions, the agent cap
  // `xs.alias.v1` and the hub config key. Deliberately NOT the hub cap: a late/missing hub cap must never swap a
  // registered tool's description (provider cache prefix) — without it the runtime falls back to legacy addressing.
  const aliasOn = xsEnabled && settings.fabric.crossSession.alias.enabled;
  const xsLedger = getXsWakeLedger();
  const xsCapability = getXsHostCapability();
  const xsSessionOf = (ctx: { sessionManager?: { getSessionId(): string } }): string | undefined => {
    try {
      return ctx.sessionManager?.getSessionId();
    } catch {
      return undefined;
    }
  };
  let xsAttached = false;
  // Channel-plan §12.6 (IBW): TUI inbox badge + web status republish. The ctx is the latest session_start's.
  const xsInboxCtx: { current?: { ui?: { setStatus?: (key: string, text: string | undefined) => void } } } = {};
  let xsInboxShown: string | undefined;
  let xsInboxPublished = -1; // last count handed to the web publisher (-1 ⇒ force)
  const refreshXsInbox = () => {
    const n = holder.current?.xs?.unread?.() ?? 0;
    const text = n > 0 ? `inbox ${unreadDisplay(n)}` : undefined;
    if (text !== xsInboxShown) {
      xsInboxShown = text;
      try {
        xsInboxCtx.current?.ui?.setStatus?.(XS_INBOX_STATUS_KEY, text);
      } catch {
        /* stale ctx after a session switch: the next session_start re-renders */
      }
    }
    if (n === xsInboxPublished) return; // turn events fire often; only a changed count republishes
    xsInboxPublished = n;
    try {
      webHubRef.current?.xs?.notifyUnreadChanged();
    } catch {
      /* display hint only */
    }
  };
  let xsSessionId: string | undefined;
  let xsCollisions: string[] = [];
  let xsHubLimits: XsHubLimitsWire | undefined;
  // /new membership handoff (new-session-channels-fix): the snapshot taken at
  // `session_shutdown{new}`, consumed by the immediately following `stackInput()`.
  let pendingHandoff: XsMembershipEntryData | undefined;
  // Alias-force-default AF7 (§5.5): the `/new` alias snapshot of the previous session id. `aliasInherit` is the one-shot
  // "predecessor was decided" input of the NEXT stack build; `aliasPending` is the handoff still to be asked of the hub
  // (cleared when attempted, expired, or a human decides on the new session first).
  let aliasInherit = false;
  let aliasPending: { prevSessionId: string; alias: string; expiresAt: number } | undefined;

  // Reply-plan §9 (MW): the @session port reuses the SAME sender instance as the tools.
  let xsSender: XsSender | undefined;
  // Channel-plan §2.3 (CHW): live probe — local channels on ∧ live link ∧ the hub declared xs.channel.v1.
  const xsHubChannelCap = (): boolean => webHubRef.current?.xs?.hubPort().hubChannelCap?.() === true;
  // Alias-plan §3.6 (ALW): live probe — local alias on ∧ live link ∧ the hub declared xs.alias.v1 (AL3's state).
  const xsAliasUsable = (): boolean => aliasOn && webHubRef.current?.xs?.hubPort().aliasUsable?.() === true;
  // Alias-force-default §3.4 (AFW): live probe — the CURRENT hub link declared `xs.alias.v2` (not merely local support).
  const xsAliasHubV2 = (): boolean => {
    if (!aliasOn || webHubRef.current?.xs === undefined) return false;
    const conn = currentConnection();
    return conn !== undefined && conn.status().state === "live" && conn.caps.includes(XS_ALIAS_V2_HUB_CAP);
  };
  // Alias-force-default §5.1/§5.3 (AFW): the main session's decided marker, only while the xs stack is attached.
  const xsAliasDecided = () => (xsAttached ? holder.current?.xs?.aliasDecided : undefined);
  // Channel-plan §2.3/§10 (CHW): the sender's channel view delegates to the CURRENT stack's membership
  // (rebuilt per session_start); no attached stack ⇒ empty sets / not joined (fail closed).
  const xsChannelView: XsChannelView = {
    pref: () => (xsAttached ? (holder.current?.xs?.membership.pref() ?? []) : []),
    effective: () => (xsAttached ? (holder.current?.xs?.membership.effective() ?? []) : []),
    link: (hubCap) => (xsAttached ? (holder.current?.xs?.membership.link(hubCap) ?? []) : []),
    linkJoined: (hubCap) => (xsAttached ? holder.current?.xs?.membership.linkJoined(hubCap) === true : false),
  };
  function registerTriggerGuard(pi: ExtensionAPI): void {
    // B1 stays installed even after an xs-off reload: old queued marked triggers still need
    // authorization. Never return the library TriggerResult as a pi hook result.
    pi.on("before_agent_start", (event, ctx) => {
      const trigger = readBeforeAgentStartTrigger(event);
      const marked =
        trigger.kind === "custom" &&
        trigger.customType === "subagent:xs" &&
        (trigger.details as { xsWake?: unknown } | undefined)?.xsWake === true;
      // Off means zero new context reads, except B1's mandatory orphan/old-authorization guard.
      if (!xsEnabled && xsLedger.size === 0 && !marked) return;
      const xs = xsAttached ? holder.current?.xs : undefined;
      if (xs?.controller) xs.beforeAgentStart(event);
      else if (xsAttached && holder.current?.rootWakeRecovery) {
        xs?.beforeAgentStart(event);
        holder.current.rootWakeRecovery.beforeAgentStart(event);
      } else {
        xs?.beforeAgentStart(event);
        // No owner yet (including the pre-stack window): never authorize an unsupervised
        // delayed action. Preserve the record as a tombstone until execution/teardown proof.
        const sessionId = xsSessionOf(ctx);
        for (const record of xsLedger.entries()) {
          if (sessionId !== undefined && record.sessionId === sessionId && record.state === "live")
            xsLedger.tombstone(record.token);
        }
        observeRootWakeTrigger(event, {
          sessionId: sessionId ?? "",
          abort: () => ctx.abort(),
          ledger: xsLedger,
          capability: xsCapability,
          ...(holder.current?.wake ? { level: holder.current.wake.level } : {}),
          audit: (event) => console.warn(`[pi-subagent] fabric xs ${event}`),
        });
      }
    });
    if (xsEnabled) {
      // Channel-plan §12.3 (IBW): unread inbox clearing rides the extension turn events (message_end is
      // unusable: pi runs extension handlers BEFORE persisting). Forwarders only; counting lives in unread.ts.
      pi.on("turn_start", () => holder.current?.xs?.unreadTurnStart());
      pi.on("turn_end", () => holder.current?.xs?.unreadTurnEnd());
      pi.on("agent_end", () => holder.current?.xs?.unreadAgentEnd()); // fallback when turn_end never fired
    }
  }

  function registerFenceHooks(pi: ExtensionAPI): void {
    if (xsEnabled) {
      // Registered ahead of other async mutation hooks: the window closes BEFORE their awaits.
      pi.on("session_before_compact", () => {
        holder.current?.xs?.fence.onEvent({ type: "session_before_compact" });
      });
      pi.on("session_compact", () => {
        holder.current?.xs?.fence.onEvent({ type: "session_compact" });
        holder.current?.xs?.reply?.flush(); // §7.2: fence close evidence ⇒ retry owed notices
      });
      pi.on("session_compact_failed", () => {
        holder.current?.xs?.fence.onEvent({ type: "session_compact_failed" });
        holder.current?.xs?.reply?.flush(); // §7.2: fence close evidence ⇒ retry owed notices
      });
      pi.on("session_before_tree", () => {
        holder.current?.xs?.fence.onEvent({ type: "session_before_tree" });
      });
      pi.on("session_tree", () => {
        holder.current?.xs?.fence.onEvent({ type: "session_tree" });
        holder.current?.xs?.reply?.flush(); // §7.2: fence close evidence ⇒ retry owed notices
      });
      pi.on("session_before_switch", () => {
        holder.current?.xs?.fence.onEvent({ type: "session_before_switch" });
      });
      pi.on("session_before_fork", () => {
        holder.current?.xs?.fence.onEvent({ type: "session_before_fork" });
      });
    }
    pi.on("agent_settled", () => {
      holder.current?.xs?.settled();
      holder.current?.rootWakeRecovery?.settled();
    });
    // Same synchronous phase as session destruction, not the later (awaiting) fleet drain.
    // Fpi10: replacement first aborts the outgoing AgentSession; reload does NOT, so preserve
    // its authorizations/leases for explicit recovery. No time-based ledger cleanup.
    pi.on("session_shutdown", (event, ctx) => {
      xsAttached = false;
      holder.current?.disposeXsSync(); // fence session_shutdown event, xs.dispose, rootWakeRecovery.dispose (Stack-owned)
      if (event.reason !== "reload") {
        const sessionId = xsSessionId ?? (xsEnabled || xsLedger.size > 0 ? xsSessionOf(ctx) : undefined);
        if (sessionId !== undefined) xsLedger.teardown(sessionId);
      }
    });
  }

  function registerSurface(pi: ExtensionAPI): void {
    if (xsEnabled) {
      const sender = createXsSender({
        port: {
          list: (args) => webHubRef.current?.xs?.hubPort().list(args) ?? Promise.resolve({ kind: "off" }),
          resolve: (args) => webHubRef.current?.xs?.hubPort().resolve(args) ?? Promise.resolve({ kind: "off" }),
          send: (args) => webHubRef.current?.xs?.hubPort().send(args) ?? Promise.resolve({ kind: "off" }),
          ...(replyEnabled ? { replyCapable: () => webHubRef.current?.xs?.hubPort().replyCapable?.() === true } : {}),
          // Alias-plan §5.2 (ALW): alias mode ⇒ send pins the resolved full sessionId; off ⇒ key absent (legacy sender).
          ...(aliasOn ? { aliasUsable: xsAliasUsable } : {}),
          // Channel-plan §5.5/§4.1 (CHW): the channel ops ride the same late-bound bridge; absent bridge ⇒ off.
          ...(channelsOn
            ? {
                hubChannelCap: xsHubChannelCap,
                broadcast: (args) =>
                  webHubRef.current?.xs?.hubPort().broadcast?.(args) ?? Promise.resolve({ kind: "off" as const }),
                channels: (args) =>
                  webHubRef.current?.xs?.hubPort().channels?.(args) ?? Promise.resolve({ kind: "off" as const }),
              }
            : {}),
        },
        origin: {
          current: () => {
            const xs = xsAttached ? holder.current?.xs : undefined;
            return xs ? { sessionId: xs.sessionId(), epoch: xs.membership.epoch } : undefined;
          },
        },
        maxChars: settings.fabric.maxChars,
        ...(replyEnabled
          ? {
              reply: {
                ledger: getXsReplyLedger(),
                defaultTimeoutS: settings.fabric.crossSession.reply.defaultTimeoutS,
                maxTimeoutS: settings.fabric.crossSession.reply.maxTimeoutS,
                lateGraceS: settings.fabric.crossSession.reply.lateGraceS,
                maxPending: settings.fabric.crossSession.reply.maxPending,
                maxPendingPerTarget: settings.fabric.crossSession.reply.maxPendingPerTarget,
                receivable: (target: string) =>
                  (xsAttached ? holder.current?.xs?.reply?.receivable(target) : undefined) ?? "not_joined",
                inbound: (requestId: string) =>
                  xsAttached ? holder.current?.xs?.reply?.inbound(requestId) : undefined,
              },
            }
          : {}),
        ...(channelsOn ? { channels: xsChannelView } : {}),
        wakeOn: settings.fabric.wake.enabled,
        ...(settings.fabric.wake.enabled
          ? {
              level: {
                levelOfRoot: () => holder.current?.wake?.level.root ?? 0,
                hopAllowed: (level: number) => holder.current?.wake?.level.hopAllowed(level) ?? false,
              },
            }
          : {}),
      });
      xsSender = sender;
      // Alias-plan §6 (ALW): instances/descriptions frozen at activate by the LOCAL alias setting (see `aliasOn`).
      pi.registerTool(createListSessionsTool({ sender, channels: channelsOn, ...(aliasOn ? { alias: true } : {}) }));
      pi.registerTool(createMessageSessionTool({ sender, reply: replyEnabled, ...(aliasOn ? { alias: true } : {}) }));
      // Channel-plan §6.1 (CHW): main session only (this whole block is post-guard), xsOn ∧ channels.enabled.
      if (channelsOn) pi.registerTool(createMessageChannelTool({ sender }));
      const command = createFabricXsCommand({
        enabled: () => xsEnabled,
        sessionId: () => holder.current?.xs?.sessionId() ?? "",
        membership: () => holder.current?.xs?.membership,
        fence: () => holder.current?.xs?.fence,
        // Channel-plan §2.3 (CHW): not joined on THIS link ⇒ no resolve frame; the command falls back to
        // its offline full-id rule (an old hub would otherwise resolve for a non-member, C4).
        resolve: (query) =>
          channelsOn && !xsChannelView.linkJoined(xsHubChannelCap())
            ? Promise.resolve({ ok: false, kind: "offline" })
            : (webHubRef.current?.xs?.resolveBlock(query) ?? Promise.resolve({ ok: false, kind: "offline" })),
        replies: () => {
          const reply = holder.current?.xs?.reply;
          return reply ? { ledger: reply.ledger, maxPending: reply.maxPending } : undefined;
        },
        onPolicyChange: () => holder.current?.xs?.reply?.flush(),
        afterFenceReset: () => deps.scheduleMessage()?.resetBlockers(),
        // Alias-plan §7 (ALW, AL4 port): always wired while xs is on — `localEnabled:false` still renders the
        // `alias n/a (alias.enabled=false)` status line; bridge/cache are AL3's (absent web-hub wiring ⇒ local refusal).
        alias: () => {
          const xs = aliasOn ? webHubRef.current?.xs : undefined;
          return {
            localEnabled: aliasOn,
            ...(xs ? { bridge: xs.aliasBridge(), cache: xs.aliasCache() } : {}),
            leaseDays: Math.round((settings.fabric.crossSession.alias.offlineLeaseH / 24) * 10) / 10,
            coolMin: settings.fabric.crossSession.alias.coolMin,
            // Alias-force-default (AFW → AF4 port): v2 probe, frozen auto setting, the SAME decided instance the
            // auto engine reads, and the engine's cached skip reason. All live/guarded; absent while alias is off.
            ...(aliasOn
              ? {
                  hubAliasV2: xsAliasHubV2,
                  autoFromCwd: settings.fabric.crossSession.alias.autoFromCwd,
                  decided: () => xsAliasDecided()?.decided() === true,
                  markDecided: (via: Parameters<XsAliasMarkDecided>[0]) => xsAliasDecided()?.markDecided(via),
                  autoSkipReason: () => webHubRef.current?.xs?.aliasAutoSkip?.(),
                }
              : {}),
            suggestions: () =>
              aliasSuggestions({
                cwd: notifyCapabilityCtx.current?.cwd,
                sessionName: (() => {
                  try {
                    return notifyCapabilityCtx.current?.sessionManager.getSessionName();
                  } catch {
                    return undefined;
                  }
                })(),
              }),
          };
        },
        // Channel-plan §6.3 (CHW): the hub listing (also the completion cache's refresh source — the
        // command itself refreshes after status/channels/join/leave; the completer never does I/O).
        ...(channelsOn
          ? {
              channels: async () => {
                const out = await sender.channels();
                return out.status === "ok"
                  ? { ok: true as const, channels: out.channels ?? [] }
                  : { ok: false as const, reason: out.reason ?? out.status };
              },
              broadcast: () => ({
                outPerHour: settings.fabric.crossSession.channels.broadcast.outPerHour,
                wakeOutPerHour: settings.fabric.crossSession.channels.broadcast.wakeOutPerHour,
                wakeMaxRecipients: settings.fabric.crossSession.channels.broadcast.wakeMaxRecipients,
              }),
            }
          : {}),
        hubChannelCap: () => {
          // `undefined` ⇔ no live hub link (n/a); otherwise whether THIS hub declared xs.channel.v1.
          const conn = webHubRef.current?.xs !== undefined ? currentConnection() : undefined;
          return conn !== undefined && conn.status().state === "live"
            ? conn.caps.includes(XS_CHANNEL_HUB_CAP)
            : undefined;
        },
        directoryChannels: () => {
          const directory = xsAttached ? holder.current?.xs?.directory : undefined;
          return directory ? directory.rows().flatMap((row) => row.channels ?? []) : [];
        },
        autoJoinInvalid: () =>
          settings.fabric.crossSession.autoJoin && settings.fabric.crossSession.channels.autoJoinInvalid,
        statusView: () => {
          const xs = holder.current?.xs;
          const quota = xs?.receiver.wakeQuota();
          return {
            capability: xsCapability.state,
            lines: [
              ...(quota
                ? [`in ${quota.recvUsed}/${quota.recvCap} h · wakes ${quota.wakesUsed}/${quota.wakesCap} h`]
                : []),
              ...(xs
                ? [
                    `inbox unread ${xs.unread?.() ?? 0}`,
                    `controller ${xs.controller?.state ?? "off"} · inbox ${xs.inbox.occupied}/${xs.inbox.cap}`,
                    `counts ${JSON.stringify(xs.receiver.countersSnapshot())}`,
                    `audit ${JSON.stringify(xs.audit)}`,
                  ]
                : []),
              ...(xsHubLimits
                ? [
                    `hub sends ${xsHubLimits.hubSendsPerMin}/min · local ${settings.fabric.crossSession.limits.hubSendsPerMin}/min${xsHubLimits.hubSendsPerMin !== settings.fabric.crossSession.limits.hubSendsPerMin ? " · differs" : ""}`,
                  ]
                : ["hub limits unavailable"]),
              ...(xsCollisions.length ? [`tool collisions: ${xsCollisions.join(", ")}`] : []),
            ],
          };
        },
      });
      pi.registerCommand("fabric", {
        ...command,
        handler: async (args, ctx) => {
          if (args.trim() === "" || args.trim() === "status") xsHubLimits = await webHubRef.current?.xs?.hubInfo();
          await command.handler(args, ctx);
        },
      });
    }
  }

  function stashMembershipHandoff(reason: string): void {
    if (reason !== "new") return; // fork never inherits (P10); resume/quit have their own state
    try {
      const shot = holder.current?.xs?.membership.handoffSnapshot();
      if (shot !== undefined) stashXsMembershipHandoff(shot);
    } catch {
      /* handoff is best-effort: a failure just keeps today's behaviour */
    }
    if (aliasOn) stashAliasHandoff();
  }

  /** AF7: park the outgoing session's held alias + decided mark (display cache view; the hub re-verifies everything).
   *  Nothing to carry ⇒ nothing parked. Any read failure ⇒ no handoff (the auto path decides). */
  function stashAliasHandoff(): void {
    try {
      const xs = holder.current?.xs;
      if (xs === undefined) return;
      const fromSessionId = xs.sessionId();
      // by explicit sid: the fence hook already ran (`xsAttached=false`), so `current()` (which goes through the attached
      // stack) would read nothing here
      const alias = webHubRef.current?.xs?.aliasCache().heldFor?.(fromSessionId);
      const decided = xs.aliasDecided?.decided() === true;
      stashXsAliasHandoff({
        fromSessionId,
        ...(alias !== undefined ? { alias } : {}),
        decided,
        at: Date.now(),
      });
    } catch {
      /* best-effort */
    }
  }

  function beginSessionStart(ctx: ExtensionContext, reason?: string): string | undefined {
    xsAttached = false;
    // Consume-once (any reason clears the slot): only a `/new` start adopts the handoff.
    const shot = takeXsMembershipHandoff();
    pendingHandoff = reason === "new" ? shot : undefined;
    // AF7: same rules for the alias snapshot — any reason clears the slot, only `new` adopts it (fork/resume never),
    // and only for a genuinely NEW session id (a stash from the same id is a leftover, not a predecessor).
    const aliasShot: XsAliasHandoffShot | undefined = takeXsAliasHandoff(Date.now());
    const nextSid = xsSessionOf(ctx);
    aliasInherit = false;
    aliasPending = undefined;
    if (aliasOn && reason === "new" && aliasShot !== undefined && aliasShot.fromSessionId !== nextSid) {
      aliasInherit = aliasShot.decided;
      if (aliasShot.alias !== undefined) {
        aliasPending = {
          prevSessionId: aliasShot.fromSessionId,
          alias: aliasShot.alias,
          expiresAt: Date.now() + XS_ALIAS_HANDOFF_PENDING_MS,
        };
      }
    }
    return xsEnabled || xsLedger.size > 0 ? nextSid : undefined;
  }

  function defensiveTeardown(nextXsSessionId: string | undefined): void {
    if (xsSessionId && nextXsSessionId !== undefined && xsSessionId !== nextXsSessionId) xsLedger.teardown(xsSessionId);
  }

  function stackInput(): StackXsInput | undefined {
    const handoff = pendingHandoff;
    pendingHandoff = undefined;
    const inheritDecided = aliasInherit;
    aliasInherit = false;
    return xsEnabled
      ? {
          ...(handoff !== undefined ? { membershipHandoff: handoff } : {}),
          ports: {
            webExec: () => webHubRef.current?.webExecBusy?.() === true,
            topicSwitch: () => xsFencePorts.topicSwitch?.(),
            goal: () => xsFencePorts.goal?.(),
          },
          memberChanged: () => webHubRef.current?.xs?.publishMember(),
          unreadChanged: refreshXsInbox,
          ...(channelsOn ? { hubChannelCap: xsHubChannelCap } : {}),
          ...(aliasOn
            ? {
                aliasUsable: xsAliasUsable,
                aliasDecided: true,
                ...(inheritDecided ? { aliasDecidedInherit: true } : {}),
                // AF7: a human decision on the new session wins over a still-pending handoff.
                aliasHumanDecided: () => {
                  aliasPending = undefined;
                },
              }
            : {}),
          listRows: async (origin) => {
            const reply = await webHubRef.current?.xs?.hubPort().list({ origin });
            return reply?.kind === "res" && reply.res.ok ? (reply.res.rows ?? []) : undefined;
          },
        }
      : undefined;
  }

  function attach(stack: Stack, ctx: ExtensionContext, pi: ExtensionAPI, nextXsSessionId: string | undefined): void {
    xsSessionId = nextXsSessionId;
    if (xsEnabled) {
      xsInboxCtx.current = ctx;
      xsInboxPublished = -1;
      xsInboxShown = "\u0000"; // new session/reload: force one re-render of the (possibly retained) count
      refreshXsInbox();
    }
    xsAttached = xsSessionId !== undefined && (stack.xs !== undefined || stack.rootWakeRecovery !== undefined);
    if (xsEnabled) {
      // The toolkit's own two declarations are not collisions. Keep foreign declarations and
      // duplicates (when the host exposes them); C-X7 tests host-specific name arbitration.
      try {
        // Channel-plan §6 (CHW): compare against the instances THIS activation registered.
        const own = new Map<string, unknown>([
          ["list_sessions", listSessionsParamsFor(channelsOn)],
          ["message_session", messageSessionParamsFor(replyEnabled)],
          ...(channelsOn ? ([["message_channel", MessageChannelParams]] as const) : []),
        ]);
        xsCollisions = detectXsToolCollisions(
          pi
            .getAllTools()
            .filter(
              (tool) => !own.has(tool.name) || JSON.stringify(tool.parameters) !== JSON.stringify(own.get(tool.name)),
            )
            .map((tool) => tool.name),
          { channels: channelsOn },
        );
        if (xsCollisions.length) console.warn(`[pi-subagent] fabric xs tool collisions: ${xsCollisions.join(", ")}`);
      } catch {
        /* older host / unbound runtime: diagnostic only */
      }
    }
  }

  function webHubDeps(): Pick<WebHubDeps, "xs"> {
    return xsEnabled
      ? {
          xs: {
            stack: () => (xsAttached ? holder.current?.xs : undefined),
            // Channel-plan §3.2/§6.4 (CHW): the three broadcast keys ride along only when channels are on;
            // the bridge writes them only into a named-channel frame (default-only frames stay byte-identical).
            memberLimits: () =>
              channelsOn
                ? {
                    ...settings.fabric.crossSession.limits,
                    broadcastsOutPerHour: settings.fabric.crossSession.channels.broadcast.outPerHour,
                    broadcastMinIntervalMs: settings.fabric.crossSession.channels.broadcast.minIntervalS * 1000,
                    broadcastWakesOutPerHour: settings.fabric.crossSession.channels.broadcast.wakeOutPerHour,
                  }
                : settings.fabric.crossSession.limits,
            hubSendsPerMin: () => settings.fabric.crossSession.limits.hubSendsPerMin,
            // Reply-plan §5.1: frozen per activate (non-live, §8.1); unset ⇒ pre-reply byte shape.
            replyEnabled: () => replyEnabled,
            // Channel-plan §3.1 (CHW): agent cap `xs.channel.v1` + hub-global broadcast params.
            channelsEnabled: () => channelsOn,
            channelsHubConfig: () => ({
              maxRecipients: settings.fabric.crossSession.channels.broadcast.maxRecipients,
              wakeMaxRecipients: settings.fabric.crossSession.channels.broadcast.wakeMaxRecipients,
            }),
            // Alias-plan §3.6/§4 (ALW): agent cap `xs.alias.v1` + `HubConfig.crossSession.alias` (AL2 deviation 1:
            // alias off ⇒ the key is never written ⇒ the spawned hub builds no table). Keys absent while off.
            ...(aliasOn
              ? {
                  aliasEnabled: () => true,
                  aliasHubConfig: () => ({
                    offlineLeaseH: settings.fabric.crossSession.alias.offlineLeaseH,
                    coolMin: settings.fabric.crossSession.alias.coolMin,
                    takeMinOfflineMin: settings.fabric.crossSession.alias.takeMinOfflineMin,
                  }),
                  // Alias-force-default §5.1 (AFW): the cwd-basename auto-claim inputs. Wired ONLY while
                  // `autoFromCwd` is on (frozen per activate) — off ⇒ no hook ⇒ the engine is inert and the agent is
                  // byte-identical to the pre-auto wiring. Main session only by construction (this whole object
                  // exists only in the post-guard activate; secure D8 forces crossSession off ⇒ no xs at all).
                  ...(settings.fabric.crossSession.alias.autoFromCwd
                    ? {
                        aliasAuto: () => ({
                          enabled: true,
                          cwd: (() => {
                            try {
                              return notifyCapabilityCtx.current?.cwd;
                            } catch {
                              return undefined; // stale ctx after a session switch
                            }
                          })(),
                          home: homedir(),
                          tmpdir: tmpdir(),
                          // Fail closed: no attached stack, a foreign sid, or no decided port ⇒ "decided" ⇒ no auto.
                          decided: (sessionId: string) => {
                            const xs = xsAttached ? holder.current?.xs : undefined;
                            return (
                              xs === undefined || xs.sessionId() !== sessionId || xs.aliasDecided?.decided() !== false
                            );
                          },
                          // AF7: a pending `/new` handoff outranks the auto claim (the bridge also tracks one in flight)
                          handoffPending: () => aliasPending !== undefined && Date.now() <= aliasPending.expiresAt,
                        }),
                        notifyAliasAuto: (text: string) => {
                          try {
                            const ctx = notifyCapabilityCtx.current;
                            if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, "info");
                          } catch {
                            /* display hint only */
                          }
                        },
                      }
                    : {}),
                  // AF7 (§5.5): the `/new` handoff still owed to the hub for the CURRENT session. Wired whenever alias is on
                  // — independent of `autoFromCwd` (a handoff is a continuation, not an auto-claim). Expired ⇒ gone.
                  aliasHandoff: () => ({
                    pending: (sessionId: string) => {
                      const p = aliasPending;
                      if (p === undefined) return undefined;
                      if (Date.now() > p.expiresAt || p.prevSessionId === sessionId) {
                        aliasPending = undefined;
                        return undefined;
                      }
                      return { alias: p.alias, prevSessionId: p.prevSessionId };
                    },
                    settle: () => {
                      aliasPending = undefined;
                    },
                  }),
                  // Q3: display-only one-shot notice (the bridge de-duplicates by (sessionId, lost.at)).
                  notifyAliasLost: (text: string) => {
                    try {
                      const ctx = notifyCapabilityCtx.current;
                      if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, "info");
                    } catch {
                      /* display hint only */
                    }
                  },
                }
              : {}),
          },
        }
      : {};
  }

  return {
    enabled: xsEnabled,
    replyEnabled,
    channelsOn,
    aliasOn,
    attached: () => xsAttached,
    hubChannelCap: xsHubChannelCap,
    aliasUsable: xsAliasUsable,
    sender: () => xsSender,
    capabilityState: () => xsCapability.state,
    registerTriggerGuard,
    registerFenceHooks,
    registerSurface,
    stashMembershipHandoff,
    beginSessionStart,
    defensiveTeardown,
    stackInput,
    attach,
    webHubDeps,
  };
}
