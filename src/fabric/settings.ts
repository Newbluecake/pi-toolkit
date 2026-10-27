/**
 * fabric · settings (#56 batch 2 ⑧): the `fabric` block's types, parse-time bounds, frozen defaults and
 * never-throws parsers. `src/config/settings.ts` imports ONLY this module for the block (aggregation,
 * `DEFAULT_FABRIC_SETTINGS`, `parseSettingsSource`) and re-exports the types (`export type {…} from`).
 * Pi-free: its value imports are pinned by `tests/web-hub/boundary.test.ts` (SYSLOAD_FILE_CLOSURE).
 */
import { XS_DEFAULT_CHANNEL, XS_MAX_CHANNELS, checkChannelName, channelSet } from "./xs/channel.js";
import { isValidXsSessionId } from "./xs/receive.js";

export interface FabricSettings {
  enabled: boolean;
  minIntervalMs: number;
  maxPerRun: number;
  findingQuota: number;
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
  /** Channel-plan §6.4 (CH0): channels + broadcast settings (present in every parsed block). */
  channels: FabricXsChannelSettings;
  /** Alias-plan §3.6 (AL0b): session alias settings (present in every parsed block). */
  alias: FabricXsAliasSettings;
}

export function parseFabricSettings(input: unknown): FabricSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ...defaults, wake: { ...defaults.wake }, crossSession: cloneFabricCrossSession(defaults.crossSession) };
  const value = input as Record<string, unknown>;
  const count = (key: keyof FabricSettings): number => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : (defaults[key] as number);
  };
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    minIntervalMs: count("minIntervalMs"),
    maxPerRun: count("maxPerRun"),
    findingQuota: count("findingQuota"),
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
  };
}

/** Deep-enough clone so a parsed result never aliases `DEFAULT_FABRIC_SETTINGS.crossSession`. */
function cloneFabricCrossSession(cs: FabricCrossSessionSettings): FabricCrossSessionSettings {
  return {
    ...cs,
    allowFrom: [...cs.allowFrom],
    limits: { ...cs.limits },
    reply: { ...cs.reply },
    channels: { ...cs.channels, autoJoin: [...cs.channels.autoJoin], broadcast: { ...cs.channels.broadcast } },
    alias: { ...cs.alias },
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

/** `fabric.wake.*` (plan v3 §4.8 + phase2 §4.1): field-by-field tolerant, never throws; unknown keys are ignored. */
export function parseFabricWakeSettings(input: unknown): FabricWakeSettings {
  const defaults = DEFAULT_FABRIC_SETTINGS.wake;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const count = (key: Exclude<keyof FabricWakeSettings, "enabled" | "resumeBudgetS" | "rootRunMaxS">): number => {
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
  };
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
    channels: parseFabricXsChannelSettings(value.channels),
    alias: parseFabricXsAliasSettings(value.alias),
  };
}

export const DEFAULT_FABRIC_SETTINGS: FabricSettings = {
  enabled: false,
  minIntervalMs: 30_000,
  maxPerRun: 20,
  findingQuota: 10,
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
    alias: { enabled: true, offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10 },
  },
};
