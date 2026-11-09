/**
 * fabric · settings (#56 batch 2 ⑧): the `fabric` block's types, parse-time bounds, frozen defaults and
 * never-throws parsers. `src/config/settings.ts` imports ONLY this module for the block (aggregation,
 * `DEFAULT_FABRIC_SETTINGS`, `parseSettingsSource`) and re-exports the types (`export type {…} from`).
 * Pi-free: its value imports are pinned by `tests/web-hub/boundary.test.ts` (SYSLOAD_FILE_CLOSURE).
 */
import { XS_DEFAULT_CHANNEL, XS_MAX_CHANNELS, checkChannelName, channelSet } from "./xs/channel.js";
import { isValidXsSessionId } from "./xs/receive.js";
import { clampThreadWindowParams } from "../web-hub/protocol/thread.js";

export interface FabricSettings {
  enabled: boolean;
  minIntervalMs: number;
  maxPerRun: number;
  reportQuota: number;
  directiveQuota: number;
  deadLetterQuota: number;
  maxChars: number;
  progressTtlMs: number;
  progressChannel: "context" | "display";
  rootMinIntervalMs: number;
  rootInboxCap: number;
  /** Sender-controlled wake / revive of finished sub-agents (fabric-cross-session plan v3 §4.8); phase-1 (in-tree) leaves only. */
  wake: FabricWakeSettings;
  /** fabric phase-2 (phase2-plan §4.1): cross-session root↔root messaging; `xsOn` additionally
   * requires `fabric.enabled` ∧ `webHub.enabled` ∧ `webHub.control !== false` (frozen at activate). */
  crossSession: FabricCrossSessionSettings;
  /** fabric-thread (arch r3 §8.2/§11.1 P0): Thread 订阅直通. Only effective while `fabric.enabled`
   * is also on; read once at stack build (non-live, like `wake`). Window fields (H/S/R) go through
   * the agent/hub SHARED clamp (protocol/thread.ts `clampThreadWindowParams`). */
  threads: FabricThreadSettings;
}

/** Parse-time bounds for the non-window `fabric.threads.*` leaves (§11.1 P0 defaults; the three
 *  window leaves own-range in protocol/thread.ts). Config-accident containment, same posture as
 *  every other clamped leaf. */
export const FABRIC_THREADS_SUBS_PER_RUN_BOUNDS = [1, 8] as const;
export const FABRIC_THREADS_SUBS_PER_THREAD_BOUNDS = [1, 8] as const;
export const FABRIC_THREADS_SUBS_BOUNDS = [1, 64] as const;
/** 0 = every thread event takes the slow path (R4 always). */
export const FABRIC_THREADS_ROUTED_PER_HOUR_BOUNDS = [0, 600] as const;
export const FABRIC_THREADS_LANE_WAIT_BOUNDS = [0, 64] as const;
/** R6 (§6.3): a steer budget under 500 ms is unusable, so the floor matches it. */
export const FABRIC_THREADS_STEER_TIMEOUT_MS_BOUNDS = [500, 60_000] as const;
export const FABRIC_THREADS_REPLY_PER_MIN_BOUNDS = [0, 60] as const;
export const FABRIC_THREADS_REPLY_PER_HOUR_BOUNDS = [0, 600] as const;

/** `fabric.threads.receipt` (§8.1): phase-1 vocabulary is exactly `"first"` — the first event per
 *  subscription gets a text receipt (「已转交 @label（run_id: …)」), later ones only a reaction. */
export type FabricThreadReceiptMode = "first";
export const FABRIC_THREADS_RECEIPT_MODES = ["first"] as const;

/**
 * `fabric.threads.*` (fabric-thread arch r3 §8.2/§11.1 P0): field-by-field tolerant, never throws.
 * The three WINDOW leaves (handbackWindowMin H / startTimeoutMin S / retainMin R) parse through the
 * shared `clampThreadWindowParams` (own bounds + R ≥ max(H,S)+2) and every recorded change WARNs
 * one line — clamp-and-warn, never reject startup. Non-live: read once at stack build, only
 * effective while `fabric.enabled` is on; secure domains force `enabled:false` (I11, D8).
 */
export interface FabricThreadSettings {
  /** Default off — G2a: off ⇒ tools, prompts, hooks, hello caps, hub config, frames, persistent
   *  state all byte-identical (A-tier golden tests/fixtures/thread-off-golden.json). */
  enabled: boolean;
  /** §5.1 admission: per-run subscription ceiling (default 4). */
  maxSubsPerRun: number;
  /** §5.1 admission: per-thread subscriber ceiling (default 4). */
  maxSubsPerThread: number;
  /** §5.1 admission: per-session (main-session stack) subscription ceiling (default 32). */
  maxSubs: number;
  /** §6.3 R4: per-thread direct-routing events per hour before falling back to the slow path. */
  routedPerThreadPerHour: number;
  /** §6.5: per-thread lane wait-queue length (in-flight is always 1). */
  laneWait: number;
  /** §6.5: single-steer budget source — effective span is `min(steerTimeoutMs, frameDeadlineMs −
   *  1500)` through `clampSpanMs`; stored as `fabric.threads.steerTimeoutS` in the file. */
  steerTimeoutMs: number;
  /** §6.5 buffer TTL (S): minutes from a buffered event's own `deliveredAt` before the
   *  subscription ends `start_timeout`. Range 1–30. */
  startTimeoutMin: number;
  /** §8.2 payload retention (R): minutes an `accepted{thr:routed}` request keeps its payload at
   *  the hub (handback window). Range 5–60, ≥ max(H,S)+2. */
  retainMin: number;
  /** §5.5 handback window (H): minutes from `deliveredAt` within which a Worker may hand an event
   *  back. Range 1–30. */
  handbackWindowMin: number;
  /** §6.8: Worker replies per thread per minute. */
  replyPerThreadPerMin: number;
  /** §6.8: Worker replies per thread per hour. */
  replyPerThreadPerHour: number;
  /** §8.1 receipt policy — phase-1 vocabulary: "first". */
  receipt: FabricThreadReceiptMode;
  /** rebind-plan r3 §4.1 (P0b): Feishu topic REBIND (`thr.rebind.v1` — the rebind/acquire ops,
   *  the dual-end cap, the hub config leaf). Default false. OPTIONAL + omitted from the frozen
   *  defaults on purpose: an absent key IS off, and `DEFAULT_SETTINGS` must stay byte-identical
   *  under rebind=false (the settings corpus pins it; §4.1). Read as `rebind === true`.
   *  Secure/locked domains force it false (I11/D8, A17). */
  rebind?: boolean;
  /** P4 §8.2 ③ (parse artifact, NOT a settings key): true ⇔ the shared window clamp changed at
   *  least one leaf — `stack.ts`'s `statusLine()` appends the ` · cfg clamped` suffix for
   *  `/agent status`. Never serialized (setting-specs knows nothing of it). */
  windowClamped: boolean;
}

/**
 * `fabric.threads.*` parser: never throws; every change the shared window clamp records becomes
 * exactly one `[pi-subagent] fabric.threads.<key> <from> → <to> (<reason>)` WARN (§8.2 ③). A
 * non-object block falls back to the defaults (silent — an absent block IS the default state).
 */
export function parseFabricThreadSettings(input: unknown): FabricThreadSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.threads;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  const window = clampThreadWindowParams({
    handbackWindowMin: value.handbackWindowMin,
    startTimeoutMin: value.startTimeoutMin,
    retainMin: value.retainMin,
  });
  for (const change of window.changes) {
    console.warn(`[pi-subagent] fabric.threads.${change.key} ${change.from} → ${change.to} (${change.reason})`);
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    maxSubsPerRun: clamp(value.maxSubsPerRun, defaults.maxSubsPerRun, ...FABRIC_THREADS_SUBS_PER_RUN_BOUNDS),
    maxSubsPerThread: clamp(
      value.maxSubsPerThread,
      defaults.maxSubsPerThread,
      ...FABRIC_THREADS_SUBS_PER_THREAD_BOUNDS,
    ),
    maxSubs: clamp(value.maxSubs, defaults.maxSubs, ...FABRIC_THREADS_SUBS_BOUNDS),
    routedPerThreadPerHour: clamp(
      value.routedPerThreadPerHour,
      defaults.routedPerThreadPerHour,
      ...FABRIC_THREADS_ROUTED_PER_HOUR_BOUNDS,
    ),
    laneWait: clamp(value.laneWait, defaults.laneWait, ...FABRIC_THREADS_LANE_WAIT_BOUNDS),
    steerTimeoutMs: clamp(value.steerTimeoutMs, defaults.steerTimeoutMs, ...FABRIC_THREADS_STEER_TIMEOUT_MS_BOUNDS),
    ...window.value,
    replyPerThreadPerMin: clamp(
      value.replyPerThreadPerMin,
      defaults.replyPerThreadPerMin,
      ...FABRIC_THREADS_REPLY_PER_MIN_BOUNDS,
    ),
    replyPerThreadPerHour: clamp(
      value.replyPerThreadPerHour,
      defaults.replyPerThreadPerHour,
      ...FABRIC_THREADS_REPLY_PER_HOUR_BOUNDS,
    ),
    receipt: value.receipt === "first" ? "first" : defaults.receipt,
    // rebind-plan r3 §4.1 (P0b): omitted unless the user wrote a real boolean — absent = off,
    // keeping every parsed rebind-off block byte-identical to the pre-feature shape (corpus).
    ...(typeof value.rebind === "boolean" ? { rebind: value.rebind } : {}),
    windowClamped: window.changes.length > 0,
  };
}

/**
 * `fabric.wake.*` (plan v3 §4.8, Q2): only effective while `fabric.enabled` is also on; read once at stack build
 * (non-live). `rootRunMaxS` (phase2 §4.1) bounds ONLY the cross-session RootWakeController — the phase-1
 * tree-internal wake path never goes through the Controller (ruling P7) and is unaffected by the key.
 */
export interface FabricWakeSettings {
  /** Default on (Q2) — gated behind `fabric.enabled`, which defaults off, so a default install is unchanged. */
  enabled: boolean;
  /** Causal wake-chain ceiling (Q9): a wake with `level+1 > maxLevel` degrades to deliver-only. */
  maxLevel: number;
  /** Per sender run: how many `wake:true` sends may be effective. */
  perRunQuota: number;
  /** Fixed budget (seconds) of a revived run; parse-time clamped to 60..3600. */
  resumeBudgetS: number;
  resumesPerHour: number;
  resumesPerTargetPerHour: number;
  /** Max parked messages per finished target. */
  parkCapPerTarget: number;
  /** Cross-session Controller watchdog, measured from DISPATCH (phase2 §4.1/§6.2); parse-time
   * clamped to 60..3600, `0` = Controller off ⇒ cross-session `wake:true` degrades to deliver-only. */
  rootRunMaxS: number;
  /** #61 decision-wake (plan §2.1): explicit blocking decision requests from direct children —
   * default TRUE (user ruling 2026-11-07); `false` = explicit opt-out back to the legacy path.
   * Effective = fabric.enabled ∧ wake.enabled ∧ this leaf; non-live (read once at stack build).
   * Default-on grants NO budget by itself: a window opens only on a host-proven human input
   * (fabric/decision-input.ts); without proof every request is deliver-only. */
  decisionRequests: boolean;
}

/** Parse-time bounds for `fabric.wake.resumeBudgetS` (plan §4.8). */
export const FABRIC_WAKE_RESUME_BUDGET_MIN_S = 60;

export const FABRIC_WAKE_RESUME_BUDGET_MAX_S = 3600;

/** Parse-time bounds for `fabric.wake.rootRunMaxS` (phase2 §4.1: 60..3600, 0 = off). */
export const FABRIC_WAKE_ROOT_RUN_MIN_S = 60;

export const FABRIC_WAKE_ROOT_RUN_MAX_S = 3600;

/** `fabric.crossSession.receive` (phase2 §4.1, P2: joined sessions default to `wake`).
 *  Reply-plan §8.1/R1 (RX0): `"replies"` = accept ONLY replies bound to this session's own
 *  pending requests. This union is the PREFERENCE — every consumer reads the EFFECTIVE value
 *  from `effectiveReceive` (`replies` unavailable ⇒ `off`; it NEVER falls back to `wake`). */
export type FabricXsReceiveMode = "off" | "deliver" | "wake" | "replies";

/** Parse-time bounds for `fabric.crossSession.reply.*` (reply-plan §8.1). */
export const FABRIC_XS_REPLY_MIN_TIMEOUT_S = 60;

export const FABRIC_XS_REPLY_MAX_TIMEOUT_S = 86_400;

export const FABRIC_XS_REPLY_MAX_PENDING_MIN = 1;

export const FABRIC_XS_REPLY_MAX_PENDING_MAX = 32;

export const FABRIC_XS_REPLY_MAX_PENDING_PER_TARGET_MIN = 1;

export const FABRIC_XS_REPLY_MAX_PENDING_PER_TARGET_MAX = 8;

export const FABRIC_XS_REPLY_LATE_GRACE_MIN_S = 0;

export const FABRIC_XS_REPLY_LATE_GRACE_MAX_S = 3_600;

/**
 * `fabric.crossSession.reply.*` (reply-plan §8.1/§3.4, RX0): request-reply association tuning.
 * Field-by-field tolerant, never throws; every numeric leaf parse-time clamped to its bounds.
 * Non-live (read once at stack build, like the rest of `fabric.crossSession.*`).
 */
export interface FabricXsReplySettings {
  /** Default on — the feature rides the four xs switches (`xsOn`) on top of this leaf. */
  enabled: boolean;
  /** Default `expectReply.timeoutS` when the caller passes no timeout (seconds). */
  defaultTimeoutS: number;
  /** Ceiling for an explicit `expectReply.timeoutS` (seconds). */
  maxTimeoutS: number;
  /** Per-session cap: receivable-or-consuming tickets + replyInbox occupancy (§3.4). */
  maxPending: number;
  /** Per-target cap: receivable-or-consuming tickets issued towards one session (§3.4). */
  maxPendingPerTarget: number;
  /** Late-grace window after the timeout within which a reply is still delivered (§7.3). */
  lateGraceS: number;
}

/** Parse-time bounds for `fabric.crossSession.askRedirect.*` (#21 plan §1 D9). */
export const FABRIC_XS_ASK_REDIRECT_TIMEOUT_MIN_S = 60;

export const FABRIC_XS_ASK_REDIRECT_TIMEOUT_MAX_S = 3_600;

/** r3 root ruling: 1..2 — the hard ceiling 2 cannot be loosened by settings. */
export const FABRIC_XS_ASK_REDIRECT_MAX_PER_RUN_MIN = 1;

export const FABRIC_XS_ASK_REDIRECT_MAX_PER_RUN_MAX = 2;

/**
 * `fabric.crossSession.askRedirect.*` (#21 plan §1 D9): host-side redirection of ask_user to the
 * delegation requester inside a trusted delegated run. Field-by-field tolerant, never throws;
 * `timeoutS` clamps to 60..3600 and `maxPerRun` to 1..2 (`createXsAskRedirect` additionally takes
 * min(·, 2) — no injection path can loosen the ceiling). Non-live (frozen at activate/stack
 * build); effective = `xsOn ∧ reply.enabled ∧ wake.enabled ∧ askRedirect.enabled` (secure keeps
 * xsOn false ⇒ automatically off, I11/D8). Agent-side only — NEVER written into HubConfig.
 * Default ON per the user ruling (2026-11-05).
 */
export interface FabricXsAskRedirectSettings {
  /** Default true; off ⇒ the O class everywhere, surfaces byte-identical (I9). */
  enabled: boolean;
  /** Host-side wait budget per question (seconds), also clamped by the run and origin windows. */
  timeoutS: number;
  /** Billed redirects per run (parse-clamped 1..2; the module hard-caps at 2). */
  maxPerRun: number;
}

/** Parse-time bounds for `fabric.crossSession.channels.broadcast.*` (channel-plan §6.4). The two
 *  wake leaves' maxima are HARD ceilings (Q5): settings can only tighten them. */
export const FABRIC_XS_BROADCAST_OUT_PER_HOUR_MAX = 60;

export const FABRIC_XS_BROADCAST_MIN_INTERVAL_MIN_S = 10;

export const FABRIC_XS_BROADCAST_MIN_INTERVAL_MAX_S = 3_600;

export const FABRIC_XS_BROADCAST_WAKE_OUT_PER_HOUR_MAX = 2;

export const FABRIC_XS_BROADCAST_MAX_RECIPIENTS_MIN = 2;

export const FABRIC_XS_BROADCAST_MAX_RECIPIENTS_MAX = 32;

export const FABRIC_XS_BROADCAST_WAKE_MAX_RECIPIENTS_MAX = 4;

/** `fabric.crossSession.channels.broadcast.*` (channel-plan §6.4). */
export interface FabricXsBroadcastSettings {
  /** Per-session broadcasts per hour (rides `xs_member.limits`); 0 = broadcasting forbidden. */
  outPerHour: number;
  /** Minimum seconds between two broadcasts of one session. */
  minIntervalS: number;
  /** Broadcast wakes per hour per session — HARD max 2 (Q5). */
  wakeOutPerHour: number;
  /** Hub-global recipient ceiling (rides `HubConfig`). */
  maxRecipients: number;
  /** Hub-global wake recipient ceiling — HARD max 4 (Q5). */
  wakeMaxRecipients: number;
}

/** `fabric.crossSession.channels.*` (channel-plan §6.4, non-live). */
export interface FabricXsChannelSettings {
  /** Q6: default true. false ≡ an old agent: no cap, no channel tools, named channels suspended. */
  enabled: boolean;
  /** Canonical, de-duplicated, ≤4 names that `autoJoin` joins (default `["default"]`). */
  autoJoin: string[];
  /** §2.4: the configured `autoJoin` was a non-empty array whose entries were ALL invalid ⇒ join nothing and say so in status. */
  autoJoinInvalid: boolean;
  broadcast: FabricXsBroadcastSettings;
}

/** Parse-time bounds for `fabric.crossSession.alias.*` (alias-plan §3.6). `takeMinOfflineMin`'s floor IS NQ1
 *  (take needs the holder offline ≥10 min — it can never be tuned down to 0). */
export const FABRIC_XS_ALIAS_OFFLINE_LEASE_H_MIN = 1;

export const FABRIC_XS_ALIAS_OFFLINE_LEASE_H_MAX = 720;

export const FABRIC_XS_ALIAS_COOL_MIN_MIN = 1;

export const FABRIC_XS_ALIAS_COOL_MIN_MAX = 1_440;

export const FABRIC_XS_ALIAS_TAKE_MIN_OFFLINE_MIN_MIN = 10;

export const FABRIC_XS_ALIAS_TAKE_MIN_OFFLINE_MIN_MAX = 1_440;

/** `fabric.crossSession.alias.*` (alias-plan §3.6, non-live). */
export interface FabricXsAliasSettings {
  /** Q9: default true. false ≡ an old agent: no cap, no alias resolution, `/fabric alias` refused locally. */
  enabled: boolean;
  /** Q2: hours an offline holder keeps its alias (default 168 = 7 d). Rides `HubConfig.crossSession.alias`. */
  offlineLeaseH: number;
  /** Q4: minutes a cleared/renamed alias stays reserved for its former holder (default 10). */
  coolMin: number;
  /** NQ1: minutes a holder must be offline before `--take` (default 10, floor 10). */
  takeMinOfflineMin: number;
  /** Alias-force-default plan §6 (AF0): default true. Auto-claim the normalised cwd basename when the session has no alias
   *  and the name is free. Agent-side only: frozen at stack build (non-live, `/reload`), NEVER written into `HubConfig`
   *  (the hub does not know it, so hub bytes are unchanged). */
  autoFromCwd: boolean;
}

/**
 * `fabric.crossSession.activation.*` (fabric-xs-activation plan §3 P0, arch §3.2, non-live): the
 * ONE engineering rollback switch for the whole request-progress + idempotent-activation group
 * (`xs.state.v1`/`xs.activate.v1`, xs_state/xs_activate/xs_activate_ack frames, the new xs_req
 * ops, StatusInfo.xsRequests). Default TRUE; effective = `xsOn ∧ activation.enabled` (secure
 * domains stay fail-closed through xsOn's existing D8 override — no separate D8 branch). The
 * agent freezes it at stack build and writes `HubConfig.crossSession.activation` ONLY while
 * effective; hub-side key-absence-is-off (limits.ts normalize keeps exactly `true`). off ⇒ every
 * surface byte-identical (off goldens; the corpus append is P5's declared refresh).
 */
export interface FabricXsActivationSettings {
  /** Default true. false ≡ the pre-feature agent: no state/activate caps, no new ops/frames. */
  enabled: boolean;
}

/** `fabric.crossSession.limits.*` (phase2 §5.2, P8 defaults; every leaf parse-time clamped to its bounds). */
export interface FabricCrossSessionLimitsSettings {
  /** Per-session outbound sends per minute (sender + hub). */
  sendsOutPerMin: number;
  /** Per-session outbound sends per hour (sender + hub). */
  sendsOutPerHour: number;
  /** Per-session outbound wakes per hour (sender + hub); 0 = deliver-only. */
  wakesOutPerHour: number;
  /** Per-session inbound messages per hour (receiver only). */
  recvPerHour: number;
  /** Per-session inbound wakes per hour (receiver only); 0 = deliver-only. */
  wakesInPerHour: number;
  /** Cross-session inbox cap — independent of the tree-internal `rootInboxCap` (review #7). */
  inboxCap: number;
  /** Minimum interval between one session pair (sender + hub). */
  pairMinIntervalMs: number;
  /** Wakes per hour between one session pair (sender + hub). */
  pairWakesPerHour: number;
  /** Concurrent in-flight sends per session (sender + hub). */
  inFlightPerSession: number;
  /** Global hub-side sends per minute (HubConfig, frozen at hub start). */
  hubSendsPerMin: number;
  /** list + resolve calls per minute (sender + hub). */
  listPerMin: number;
}

/**
 * `fabric.crossSession.*` (phase2 §4.1): non-live, field-by-field tolerant, never throws.
 * `allowFrom` keeps only FULL session ids (pi `assertValidSessionId`'s rule); invalid entries are
 * dropped with one console.warn, and a non-empty-but-all-invalid list sets `allowFromDenyAll`
 * (review #14: fail closed — reject every sender, mirroring `webHub.lan.allowClients`).
 */
export interface FabricCrossSessionSettings {
  enabled: boolean;
  /** P1: sessions never join implicitly; `true` joins every new main session at startup. */
  autoJoin: boolean;
  /** P2: joined sessions default to wake (overridable per session via `/fabric receive`). */
  receive: FabricXsReceiveMode;
  /** Empty + `allowFromDenyAll === false` ⇒ any joined session may send here. */
  allowFrom: string[];
  /** #14 fail-closed marker: the configured allowFrom was non-empty but every entry was invalid. */
  allowFromDenyAll: boolean;
  limits: FabricCrossSessionLimitsSettings;
  /** Reply-plan §8.1 (RX0): request-reply association settings (present in every parsed
   *  block — `receive:"replies"` availability is judged against `reply.enabled` only through
   *  `effectiveReceive`, never by rewriting the stored preference). */
  reply: FabricXsReplySettings;
  /** #21 plan §1 D9: ask_user host-redirect settings (present in every parsed block; agent-side
   *  only — never rides HubConfig). */
  askRedirect: FabricXsAskRedirectSettings;
  /** Channel-plan §6.4 (CH0): channels + broadcast settings (present in every parsed block). */
  channels: FabricXsChannelSettings;
  /** Alias-plan §3.6 (AL0b): session alias settings (present in every parsed block). */
  alias: FabricXsAliasSettings;
  /** fabric-xs-activation plan §3 P0: the activation group switch (present in every parsed block). */
  activation: FabricXsActivationSettings;
}

export function parseFabricSettings(input: unknown): FabricSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      ...defaults,
      wake: { ...defaults.wake },
      crossSession: cloneFabricCrossSession(defaults.crossSession),
      threads: { ...defaults.threads },
    };
  const value = input as Record<string, unknown>;
  const count = (key: keyof FabricSettings): number => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : (defaults[key] as number);
  };
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    minIntervalMs: count("minIntervalMs"),
    maxPerRun: count("maxPerRun"),
    reportQuota: count("reportQuota"),
    directiveQuota: count("directiveQuota"),
    deadLetterQuota: count("deadLetterQuota"),
    maxChars: count("maxChars"),
    progressTtlMs: count("progressTtlMs"),
    progressChannel:
      value.progressChannel === "context" || value.progressChannel === "display"
        ? value.progressChannel
        : defaults.progressChannel,
    rootMinIntervalMs: count("rootMinIntervalMs") === 0 ? 0 : Math.max(1_000, count("rootMinIntervalMs")),
    rootInboxCap: count("rootInboxCap"),
    wake: parseFabricWakeSettings(value.wake),
    crossSession: parseFabricCrossSessionSettings(value.crossSession),
    threads: parseFabricThreadSettings(value.threads),
  };
}

/** Deep-enough clone so a parsed result never aliases `DEFAULT_FABRIC_SETTINGS.crossSession`. */
function cloneFabricCrossSession(cs: FabricCrossSessionSettings): FabricCrossSessionSettings {
  return {
    ...cs,
    allowFrom: [...cs.allowFrom],
    limits: { ...cs.limits },
    reply: { ...cs.reply },
    askRedirect: { ...cs.askRedirect },
    channels: { ...cs.channels, autoJoin: [...cs.channels.autoJoin], broadcast: { ...cs.channels.broadcast } },
    alias: { ...cs.alias },
    activation: { ...cs.activation },
  };
}

/**
 * `fabric.crossSession.alias.*` (alias-plan §3.6, AL0b): field-by-field tolerant, never throws; every numeric
 * leaf clamps into its bounds (`takeMinOfflineMin` can never go below the NQ1 floor of 10).
 */
export function parseFabricXsAliasSettings(input: unknown): FabricXsAliasSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.crossSession.alias;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    offlineLeaseH: clamp(
      value.offlineLeaseH,
      defaults.offlineLeaseH,
      FABRIC_XS_ALIAS_OFFLINE_LEASE_H_MIN,
      FABRIC_XS_ALIAS_OFFLINE_LEASE_H_MAX,
    ),
    coolMin: clamp(value.coolMin, defaults.coolMin, FABRIC_XS_ALIAS_COOL_MIN_MIN, FABRIC_XS_ALIAS_COOL_MIN_MAX),
    takeMinOfflineMin: clamp(
      value.takeMinOfflineMin,
      defaults.takeMinOfflineMin,
      FABRIC_XS_ALIAS_TAKE_MIN_OFFLINE_MIN_MIN,
      FABRIC_XS_ALIAS_TAKE_MIN_OFFLINE_MIN_MAX,
    ),
    autoFromCwd: typeof value.autoFromCwd === "boolean" ? value.autoFromCwd : defaults.autoFromCwd,
  };
}

/**
 * `fabric.crossSession.channels.*` (channel-plan §6.4, CH0): field-by-field tolerant, never throws;
 * every numeric leaf clamps into its bounds (the two wake leaves can only be tightened, Q5).
 * `autoJoin` entries go through `checkChannelName` (reserved/invalid dropped, de-duplicated, capped at
 * 4); a non-empty array with zero valid entries sets `autoJoinInvalid` and joins nothing.
 */
export function parseFabricXsChannelSettings(input: unknown): FabricXsChannelSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.crossSession.channels;
  const clone = (): FabricXsChannelSettings => ({
    ...defaults,
    autoJoin: [...defaults.autoJoin],
    broadcast: { ...defaults.broadcast },
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) return clone();
  const value = input as Record<string, unknown>;
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  let autoJoin = [...defaults.autoJoin];
  let autoJoinInvalid = false;
  if (Array.isArray(value.autoJoin)) {
    const names: string[] = [];
    for (const entry of value.autoJoin) {
      const checked = checkChannelName(entry);
      if (checked.ok) names.push(checked.name);
    }
    autoJoin = channelSet(names).slice(0, XS_MAX_CHANNELS);
    autoJoinInvalid = value.autoJoin.length > 0 && autoJoin.length === 0;
    if (autoJoinInvalid) {
      console.warn(
        "[pi-subagent] fabric.crossSession.channels.autoJoin: every entry is invalid or reserved — autoJoin joins nothing",
      );
    }
  }
  const b =
    value.broadcast && typeof value.broadcast === "object" && !Array.isArray(value.broadcast)
      ? (value.broadcast as Record<string, unknown>)
      : {};
  const d = defaults.broadcast;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    autoJoin,
    autoJoinInvalid,
    broadcast: {
      outPerHour: clamp(b.outPerHour, d.outPerHour, 0, FABRIC_XS_BROADCAST_OUT_PER_HOUR_MAX),
      minIntervalS: clamp(
        b.minIntervalS,
        d.minIntervalS,
        FABRIC_XS_BROADCAST_MIN_INTERVAL_MIN_S,
        FABRIC_XS_BROADCAST_MIN_INTERVAL_MAX_S,
      ),
      wakeOutPerHour: clamp(b.wakeOutPerHour, d.wakeOutPerHour, 0, FABRIC_XS_BROADCAST_WAKE_OUT_PER_HOUR_MAX),
      maxRecipients: clamp(
        b.maxRecipients,
        d.maxRecipients,
        FABRIC_XS_BROADCAST_MAX_RECIPIENTS_MIN,
        FABRIC_XS_BROADCAST_MAX_RECIPIENTS_MAX,
      ),
      wakeMaxRecipients: clamp(
        b.wakeMaxRecipients,
        d.wakeMaxRecipients,
        1,
        FABRIC_XS_BROADCAST_WAKE_MAX_RECIPIENTS_MAX,
      ),
    },
  };
}

/**
 * `fabric.crossSession.reply.*` (reply-plan §8.1, RX0): field-by-field tolerant, never throws;
 * every numeric leaf clamps to its bounds (config-accident containment, same posture as the
 * limits block). A non-object block falls back to the defaults.
 */
export function parseFabricXsReplySettings(input: unknown): FabricXsReplySettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.crossSession.reply;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    defaultTimeoutS: clamp(
      value.defaultTimeoutS,
      defaults.defaultTimeoutS,
      FABRIC_XS_REPLY_MIN_TIMEOUT_S,
      FABRIC_XS_REPLY_MAX_TIMEOUT_S,
    ),
    maxTimeoutS: clamp(
      value.maxTimeoutS,
      defaults.maxTimeoutS,
      FABRIC_XS_REPLY_MIN_TIMEOUT_S,
      FABRIC_XS_REPLY_MAX_TIMEOUT_S,
    ),
    maxPending: clamp(
      value.maxPending,
      defaults.maxPending,
      FABRIC_XS_REPLY_MAX_PENDING_MIN,
      FABRIC_XS_REPLY_MAX_PENDING_MAX,
    ),
    maxPendingPerTarget: clamp(
      value.maxPendingPerTarget,
      defaults.maxPendingPerTarget,
      FABRIC_XS_REPLY_MAX_PENDING_PER_TARGET_MIN,
      FABRIC_XS_REPLY_MAX_PENDING_PER_TARGET_MAX,
    ),
    lateGraceS: clamp(
      value.lateGraceS,
      defaults.lateGraceS,
      FABRIC_XS_REPLY_LATE_GRACE_MIN_S,
      FABRIC_XS_REPLY_LATE_GRACE_MAX_S,
    ),
  };
}

/** `fabric.crossSession.askRedirect.*` (#21 plan §1 D9): field-by-field tolerant, never throws. */
export function parseFabricXsAskRedirectSettings(input: unknown): FabricXsAskRedirectSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.crossSession.askRedirect;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    timeoutS: clamp(
      value.timeoutS,
      defaults.timeoutS,
      FABRIC_XS_ASK_REDIRECT_TIMEOUT_MIN_S,
      FABRIC_XS_ASK_REDIRECT_TIMEOUT_MAX_S,
    ),
    maxPerRun: clamp(
      value.maxPerRun,
      defaults.maxPerRun,
      FABRIC_XS_ASK_REDIRECT_MAX_PER_RUN_MIN,
      FABRIC_XS_ASK_REDIRECT_MAX_PER_RUN_MAX,
    ),
  };
}

/** `fabric.wake.*` (plan v3 §4.8 + phase2 §4.1): field-by-field tolerant, never throws; unknown keys are ignored. */
export function parseFabricWakeSettings(input: unknown): FabricWakeSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.wake;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const count = (
    key: Exclude<keyof FabricWakeSettings, "enabled" | "resumeBudgetS" | "rootRunMaxS" | "decisionRequests">,
  ): number => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : defaults[key];
  };
  const budgetRaw = value.resumeBudgetS;
  const rootRunRaw = value.rootRunMaxS;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    maxLevel: count("maxLevel"),
    perRunQuota: count("perRunQuota"),
    resumeBudgetS:
      typeof budgetRaw === "number" && Number.isFinite(budgetRaw)
        ? Math.min(FABRIC_WAKE_RESUME_BUDGET_MAX_S, Math.max(FABRIC_WAKE_RESUME_BUDGET_MIN_S, Math.floor(budgetRaw)))
        : defaults.resumeBudgetS,
    resumesPerHour: count("resumesPerHour"),
    resumesPerTargetPerHour: count("resumesPerTargetPerHour"),
    parkCapPerTarget: count("parkCapPerTarget"),
    // 0 = Controller off (phase2 §4.5 truth-table row); a positive finite value clamps to 60..3600;
    // anything else (wrong type, NaN, negative) falls back to the default.
    rootRunMaxS:
      rootRunRaw === 0
        ? 0
        : typeof rootRunRaw === "number" && Number.isFinite(rootRunRaw) && rootRunRaw > 0
          ? Math.min(FABRIC_WAKE_ROOT_RUN_MAX_S, Math.max(FABRIC_WAKE_ROOT_RUN_MIN_S, Math.floor(rootRunRaw)))
          : defaults.rootRunMaxS,
    // #61: default TRUE; only an explicit boolean false opts out (invalid types fall back to
    // the default — “缺省/非法类型回落 true”，plan §2.1).
    decisionRequests: typeof value.decisionRequests === "boolean" ? value.decisionRequests : defaults.decisionRequests,
  };
}

/**
 * `fabric.crossSession.activation.*` (fabric-xs-activation plan §3 P0): field-by-field tolerant,
 * never throws. A non-object block falls back to the default (ON — key absence IS on here, the
 * off-isolation tests write it explicitly false).
 */
export function parseFabricXsActivationSettings(input: unknown): FabricXsActivationSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.crossSession.activation;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  return { enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled };
}

/**
 * `fabric.crossSession.*` (phase2 §4.1): field-by-field tolerant, never throws. Limits clamp to
 * their §5.2 bounds (config-accident containment, same posture as every other clamped leaf);
 * `allowFrom` entries must be FULL session ids (#14) — invalid ones are dropped with one warn,
 * and a non-empty list with zero valid entries marks `allowFromDenyAll` (deny everything).
 */
export function parseFabricCrossSessionSettings(input: unknown): FabricCrossSessionSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.crossSession;
  if (!input || typeof input !== "object" || Array.isArray(input)) return cloneFabricCrossSession(defaults);
  const value = input as Record<string, unknown>;
  // min/max per §5.2; 0 is a legal value exactly where the table says so (wakesOutPerHour,
  // wakesInPerHour, pairWakesPerHour — "0 = deliver-only").
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  const rawAllow = value.allowFrom;
  const entries = Array.isArray(rawAllow) ? rawAllow : [];
  const valid: string[] = [];
  let invalid = 0;
  for (const entry of entries) {
    if (typeof entry === "string" && isValidXsSessionId(entry)) valid.push(entry);
    else invalid += 1;
  }
  if (invalid > 0) {
    console.warn(
      `[pi-subagent] fabric.crossSession.allowFrom: dropped ${invalid} invalid ${invalid === 1 ? "entry" : "entries"} (full session ids only)`,
    );
  }
  const reply = parseFabricXsReplySettings(value.reply);
  // reply-plan §8.1 (review #4): `receive:"replies"` is ALWAYS accepted as the stored
  // preference — with the reply feature off its EFFECTIVE value is `off` (effectiveReceive,
  // never a fall-back to the default `wake`). One warn at parse time so the operator sees why.
  const receive: FabricXsReceiveMode =
    value.receive === "off" || value.receive === "deliver" || value.receive === "wake" || value.receive === "replies"
      ? value.receive
      : defaults.receive;
  if (receive === "replies" && !reply.enabled) {
    console.warn(
      '[pi-subagent] fabric.crossSession.receive is "replies" but fabric.crossSession.reply.enabled is false — effective receive is off (not wake)',
    );
  }
  const limitsRaw =
    value.limits && typeof value.limits === "object" && !Array.isArray(value.limits)
      ? (value.limits as Record<string, unknown>)
      : {};
  const limit = (key: keyof FabricCrossSessionLimitsSettings, min: number, max: number): number =>
    clamp(limitsRaw[key], defaults.limits[key], min, max);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    autoJoin: typeof value.autoJoin === "boolean" ? value.autoJoin : defaults.autoJoin,
    receive,
    allowFrom: valid,
    allowFromDenyAll: !Array.isArray(rawAllow) ? false : entries.length > 0 && valid.length === 0,
    limits: {
      sendsOutPerMin: limit("sendsOutPerMin", 1, 60),
      sendsOutPerHour: limit("sendsOutPerHour", 1, 600),
      wakesOutPerHour: limit("wakesOutPerHour", 0, 60),
      recvPerHour: limit("recvPerHour", 1, 600),
      wakesInPerHour: limit("wakesInPerHour", 0, 60),
      inboxCap: limit("inboxCap", 1, 64),
      pairMinIntervalMs: limit("pairMinIntervalMs", 5_000, 600_000),
      pairWakesPerHour: limit("pairWakesPerHour", 0, 20),
      inFlightPerSession: limit("inFlightPerSession", 1, 16),
      hubSendsPerMin: limit("hubSendsPerMin", 1, 600),
      listPerMin: limit("listPerMin", 1, 60),
    },
    reply,
    askRedirect: parseFabricXsAskRedirectSettings(value.askRedirect),
    channels: parseFabricXsChannelSettings(value.channels),
    alias: parseFabricXsAliasSettings(value.alias),
    activation: parseFabricXsActivationSettings(value.activation),
  };
}

export const DEFAULT_FABRIC_SETTINGS: FabricSettings = {
  enabled: false,
  minIntervalMs: 30_000,
  maxPerRun: 20,
  reportQuota: 3,
  directiveQuota: 5,
  deadLetterQuota: 5,
  maxChars: 2_000,
  progressTtlMs: 900_000,
  progressChannel: "display",
  rootMinIntervalMs: 10_000,
  rootInboxCap: 12,
  wake: {
    enabled: true,
    maxLevel: 2,
    perRunQuota: 3,
    resumeBudgetS: 600,
    resumesPerHour: 6,
    resumesPerTargetPerHour: 2,
    parkCapPerTarget: 8,
    rootRunMaxS: 900,
    // #61 decision-wake plan §2.1: default ON (explicit false opts out; no budget without a
    // host-proven human input — fabric/decision-input.ts).
    decisionRequests: true,
  },
  // fabric phase-2 (phase2-plan §4.1/§5.2, rulings P1/P2/P8 + review #7): OFF by default —
  // `crossSession` exists in every parsed FabricSettings, but `xsOn` stays false until the
  // operator enables fabric + crossSession + webHub.
  crossSession: {
    enabled: false,
    autoJoin: false,
    receive: "wake",
    allowFrom: [],
    allowFromDenyAll: false,
    limits: {
      sendsOutPerMin: 10,
      sendsOutPerHour: 60,
      wakesOutPerHour: 6,
      recvPerHour: 30,
      wakesInPerHour: 12,
      inboxCap: 12,
      pairMinIntervalMs: 30_000,
      pairWakesPerHour: 2,
      inFlightPerSession: 4,
      hubSendsPerMin: 60,
      listPerMin: 6,
    },
    // reply-plan §8.1 (RX0): defaults — feature on, 30min default timeout, 24h ceiling,
    // 8 pending / 3 per target, 10min late grace.
    reply: {
      enabled: true,
      defaultTimeoutS: 1_800,
      maxTimeoutS: 86_400,
      maxPending: 8,
      maxPendingPerTarget: 3,
      lateGraceS: 600,
    },
    // #21 plan §1 D9 (user ruling 2026-11-05): default ON — effective only while
    // xs ∧ reply ∧ wake are all on; secure keeps xs off ⇒ automatically off (I11/D8).
    askRedirect: { enabled: true, timeoutS: 600, maxPerRun: 2 },
    // channel-plan §6.4 (CH0): Q6 channels on by default; broadcast wake ceilings are the Q5 hard maxima.
    channels: {
      enabled: true,
      autoJoin: [XS_DEFAULT_CHANNEL],
      autoJoinInvalid: false,
      broadcast: {
        outPerHour: 6,
        minIntervalS: 60,
        wakeOutPerHour: 2,
        maxRecipients: 16,
        wakeMaxRecipients: 4,
      },
    },
    // alias-plan §3.6 (AL0b): Q9 on by default, Q2 7 d lease, Q4 10 min cooling, NQ1 10 min take floor.
    alias: { enabled: true, offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10, autoFromCwd: true },
    // fabric-xs-activation plan §3 P0 (arch §3.2): default ON — effective = xsOn ∧ this flag;
    // off ⇒ every surface byte-identical. (The settings-corpus append this causes is P5's
    // declared refresh; do not regenerate it from a dev package.)
    activation: { enabled: true },
  },
  // fabric-thread arch r3 §11.1 P0 (threads default OFF — G2a): frozen defaults in the arch's
  // listing order; the window trio (startTimeoutMin S=8, retainMin R=15, handbackWindowMin H=10)
  // mirrors protocol/thread.ts's THREAD_WINDOW_DEFAULTS (15 ≥ max(10,8)+2 ✓). Parity is pinned by
  // tests/fabric/threads-settings.test.ts.
  threads: {
    enabled: false,
    maxSubsPerRun: 4,
    maxSubsPerThread: 4,
    maxSubs: 32,
    routedPerThreadPerHour: 60,
    laneWait: 8,
    steerTimeoutMs: 4_000,
    startTimeoutMin: 8,
    retainMin: 15,
    handbackWindowMin: 10,
    replyPerThreadPerMin: 6,
    replyPerThreadPerHour: 60,
    receipt: "first",
    windowClamped: false,
  },
};
