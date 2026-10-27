/**
 * web-hub · agent-side settings (#56 batch 2 ⑧): the `webHub` / `feishuBot` blocks' types, frozen defaults and
 * never-throws parsers (lan / spawn / proxy / feishu-bot sub-blocks return their own warnings).
 * `src/config/settings.ts` imports ONLY this module for these blocks (it is value-imported before the HOST_KEY
 * guard, so the closure stays pi-free: protocol/lan + protocol/client-allow only — pinned by
 * `tests/web-hub/boundary.test.ts` SYSLOAD_FILE_CLOSURE; the agent-owned `WebHubSettings` shape is a type import).
 */
import { canonicalOrigin, classifyHostToken, parseOrigin, type InvalidHostToken } from "../protocol/lan.js";
import { parseClientCidr, CLIENT_ALLOW_MAX, type InvalidClientCidr } from "../protocol/client-allow.js";
import type { WebHubLanSettings, WebHubSettings, WebHubSpawnSettings } from "./index.js";

/**
 * web-hub-proxy plan v2 §5 (X0): `webHub.proxy` — at most three leaves, non-live (captured at
 * activate; change → `/reload` then `/webhub restart`). Off by default; LAN reach follows
 * `webHub.lan` (Q2), there is no proxy LAN switch. `portRange` is stored as the canonical
 * `"<lo>-<hi>"` text (`protocol/proxy.ts` grammar); TTLs are fixed constants there, not settings.
 */
export interface WebHubProxySettings {
  enabled: boolean;
  portRange: string;
  maxProxies: number;
}

/**
 * feishu-bot plan v2 §9 (F0): the TOP-LEVEL `feishuBot` block (not under `webHub`) — non-live, captured
 * at activate (change → `/reload` then `/webhub restart`). Off by default ⇒ `buildHubConfig` never writes
 * `HubConfig.feishuBot` and the hub/agent stay byte-identical. The block only takes effect when
 * `webHub.enabled` ∧ `webHub.control !== false` too (FA's gate). `staleMessageS` is stored in SECONDS
 * (file key = internal key; deliberately NOT a `TIME_SETTING_MS_PATHS` entry), `debounceMs` in ms —
 * the plan's names verbatim. Keepalive is not a leaf (Q1 fixed it).
 */
export interface FeishuBotSettings {
  securityAlerts?: boolean;
  /** Mirror non-waking cross-session messages to bound p2p chats (default on; hub-start frozen). */
  xsMirror?: boolean;
  enabled: boolean;
  allowGroups: boolean;
  /** V8-confirmed: a group @-bot outside a topic opens + binds a topic */
  groupRootTopics: boolean;
  notify: "bound" | "off";
  spawnScope: "known" | "roots";
  debounceMs: number;
  staleMessageS: number;
  files: {
    outbound: "auto" | "buttons" | "off";
    inbound: boolean;
    maxInboundMiB: number;
  };
}

/**
 * `webHub.lan.*` defaults (lan-plan.md sec 9.1 / sec 11 W3-LI): all five keys are non-live
 * (captured at activate; change -> /reload). `extraHosts`/`trustProxyFrom`/`externalOrigins` are
 * comma-separated strings on disk (sec 9.1's table) and are validated into this `string[]` shape
 * (LE's frozen `WebHubLanSettings`, fed straight into `HubLanConfig`) by `parseWebHubLanBlock`.
 */
export const DEFAULT_WEBHUB_LAN_SETTINGS: WebHubLanSettings = {
  enabled: false,
  port: 7879,
  extraHosts: [],
  trustProxyFrom: [],
  externalOrigins: [],
  allowClients: [],
  sessionIdleMinutes: 720,
};

/**
 * `webHub.proxy.*` defaults (web-hub-proxy plan v2 §0/§5): off by default ⇒ `HubConfig.proxy` is
 * never constructed and the hub is byte-identical. The literals mirror `protocol/proxy.ts`
 * (`PROXY_DEFAULT_PORT_RANGE_TEXT` / `PROXY_DEFAULT_MAX_PROXIES`) — this module may not
 * value-import it (`tests/web-hub/boundary.test.ts` freezes its import closure), so
 * `tests/web-hub/protocol/proxy.test.ts` pins the two copies equal.
 */
export const DEFAULT_WEBHUB_PROXY_SETTINGS: WebHubProxySettings = {
  enabled: false,
  portRange: "7900-7949",
  maxProxies: 8,
};

/**
 * `feishuBot.*` defaults (feishu-bot plan v2 §9): off by default ⇒ nothing is wired. Literal mirrors of
 * `protocol/feishu.ts`'s `FEISHU_BOT_DEFAULTS` / `FEISHU_BOT_RANGES` (this module may not value-import
 * it — `tests/web-hub/boundary.test.ts` freezes its import closure), pinned equal by
 * `tests/web-hub/protocol/feishu.test.ts`.
 */
export const DEFAULT_FEISHU_BOT_SETTINGS: FeishuBotSettings = {
  enabled: false,
  allowGroups: true,
  groupRootTopics: false,
  securityAlerts: true,
  xsMirror: true,
  notify: "bound",
  spawnScope: "known",
  debounceMs: 1_500,
  staleMessageS: 300,
  files: { outbound: "auto", inbound: true, maxInboundMiB: 30 },
};

/**
 * `webHub.spawn.*` defaults（web-hub-spawn arch v2 §6.2 / plan §SP2）：与 lan 块同为非 live——
 * activate 时捕快照，改动需 `/reload` 后再 `/webhub restart` 才到达运行中的 hub（它们只随
 * `PI_WEBHUB_CONFIG` 传输）。默认 `enabled:false` ⇒ `HubConfig.spawn` 不被构造（arch §8.2
 * 未启用矩阵）。数值范围见 `parseWebHubSpawnBlock`（越界钳制、非法回落）。
 */
export const DEFAULT_WEBHUB_SPAWN_SETTINGS: WebHubSpawnSettings = {
  enabled: false,
  roots: [],
  maxProcesses: 4,
  maxPerPrincipal: 2,
  ratePerMinute: 3,
  maxLifetimeMinutes: 720,
  registerTimeoutS: 30,
  lan: "off",
  // web-hub-spawn-restore plan D18: restore managed sessions across hub restarts — default ON,
  // effective only under an explicitly enabled spawn block.
  restore: true,
  // web-hub-session-history plan §3.7 (P-cfg): browse all past sessions and resume/fork them
  // from the web — default ON, effective only under an explicitly enabled spawn block.
  history: true,
  // 2026-10-13 用户拍板（U1 单用户信任模型既判）: LAN 每次 spawn 的 E_CONFIRM_REQUIRED 确认门
  // 默认 ON（现状）；设为 false 即明示放弃这层 LAN 渠道证明（已知目录/历史会话直达 202，
  // 未知目录仍需确认；session-open 的 fork 决策不在豁免范围）。
  lanConfirm: true,
};

/**
 * web-hub settings block (plan 包 I): field-level fallback to defaults, never
 * throws (parseHudSettings 同款). `port` must be an integer in 0..65535 (0 =
 * ephemeral); `idleExitMinutes` must be finite and ≥ 1.
 *
 * `webHub.lan.*` (plan §9.1, S1-W3 LI): parsed by `parseWebHubLanBlock` below — same helper used
 * by `parseWebHubLanValidation` (exported for status-line consumers, e.g. `/webhub status`) so the
 * accepted/rejected classification of every host token never drifts between the two call sites.
 */
export function resolveWebHubPort(record: Record<string, unknown>): number {
  const defaults = DEFAULT_WEBHUB_SETTINGS;
  const port = record.port;
  return typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : defaults.port;
}

export function parseWebHubSettings(input: unknown): WebHubSettings {
  const defaults = DEFAULT_WEBHUB_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      ...defaults,
      lan: { ...defaults.lan! },
      spawn: parseWebHubSpawnBlock(undefined),
      proxy: { ...DEFAULT_WEBHUB_PROXY_SETTINGS },
    };
  const record = input as Record<string, unknown>;
  const idle = record.idleExitMinutes;
  const nodeLoader = record.nodeLoader;
  const resolvedPort = resolveWebHubPort(record);
  const lanParsed = parseWebHubLanBlock(record.lan, resolvedPort);
  const policy: Record<string, "allow" | "confirm" | "deny"> = {};
  let rawPolicy: unknown = record.webCommandPolicy;
  if (typeof rawPolicy === "string") {
    try {
      rawPolicy = JSON.parse(rawPolicy);
    } catch {
      rawPolicy = undefined;
    }
  }
  if (rawPolicy !== null && typeof rawPolicy === "object" && !Array.isArray(rawPolicy)) {
    for (const [key, value] of Object.entries(rawPolicy as Record<string, unknown>)) {
      if (
        /^[A-Za-z0-9:_.-]{1,64}(?: [A-Za-z0-9:_.-]{1,64})?$/.test(key) &&
        (value === "allow" || value === "confirm" || value === "deny")
      )
        policy[key] = value;
    }
  }
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    autoStart: typeof record.autoStart === "boolean" ? record.autoStart : defaults.autoStart,
    port: resolvedPort,
    idleExitMinutes: typeof idle === "number" && Number.isFinite(idle) && idle >= 1 ? idle : defaults.idleExitMinutes,
    nodeLoader: typeof nodeLoader === "string" ? nodeLoader : defaults.nodeLoader,
    control: typeof record.control === "boolean" ? record.control : (defaults.control ?? true),
    remoteAskUser: typeof record.remoteAskUser === "boolean" ? record.remoteAskUser : (defaults.remoteAskUser ?? true),
    webCommands: typeof record.webCommands === "boolean" ? record.webCommands : (defaults.webCommands ?? true),
    webCommandPolicy: policy,
    // web-hub-steer-recall plan §4.2: boolean only, anything else falls back to the default
    // `true` (arch §11 Q1) — never throws.
    steerRecall: typeof record.steerRecall === "boolean" ? record.steerRecall : (defaults.steerRecall ?? true),
    // web-hub-slash-args plan §5 (P0): tri-valued, any other value falls back to "all" (§11 D1 拍板).
    commandComplete: parseCommandCompleteSetting(record.commandComplete, defaults.commandComplete),
    // web-hub-cmd-history plan §4.9 (A1): boolean only, anything else falls back to the default true.
    cmdHistory: typeof record.cmdHistory === "boolean" ? record.cmdHistory : (defaults.cmdHistory ?? true),
    uploads: parseUploadsSetting(record.uploads, defaults.uploads),
    preview: parsePreviewSetting(record.preview, defaults.preview),
    avatar: typeof record.avatar === "boolean" ? record.avatar : (defaults.avatar ?? true),
    // web-hub-privacy plan v2.1 (P1): boolean only, anything else falls back to the default `true`.
    privacy: typeof record.privacy === "boolean" ? record.privacy : (defaults.privacy ?? true),
    subagentTranscript: parseSubagentTranscriptSetting(record.subagentTranscript, defaults.subagentTranscript),
    quota: typeof record.quota === "boolean" ? record.quota : (defaults.quota ?? true),
    // sysload plan §6.1: boolean only, anything else falls back to the default `true`.
    load: typeof record.load === "boolean" ? record.load : (defaults.load ?? true),
    // web-hub archive plan: finite number ≥ 0 (minutes); anything else falls back to the
    // default 30. 0 = sweep off.
    archiveAfterMin:
      typeof record.archiveAfterMin === "number" &&
      Number.isFinite(record.archiveAfterMin) &&
      record.archiveAfterMin >= 0
        ? record.archiveAfterMin
        : (defaults.archiveAfterMin ?? 30),
    // #59: non-negative integer count gates; 0 preserves time-only archiving.
    archiveKeepRuns:
      typeof record.archiveKeepRuns === "number" &&
      Number.isInteger(record.archiveKeepRuns) &&
      record.archiveKeepRuns >= 0
        ? record.archiveKeepRuns
        : (defaults.archiveKeepRuns ?? 6),
    archiveKeepBash:
      typeof record.archiveKeepBash === "number" &&
      Number.isInteger(record.archiveKeepBash) &&
      record.archiveKeepBash >= 0
        ? record.archiveKeepBash
        : (defaults.archiveKeepBash ?? 5),
    lan: lanParsed.lan,
    spawn: parseWebHubSpawnBlock(record.spawn),
    proxy: parseWebHubProxyBlock(record.proxy, resolvedPort, lanParsed.lan.port).proxy,
  };
}

/** web-hub-upload plan §6 U1: `webHub.uploads` is tri-valued; any other value falls back to "on". */
function parseUploadsSetting(raw: unknown, fallback: "on" | "loopback" | "off" | undefined): "on" | "loopback" | "off" {
  if (raw === "on" || raw === "loopback" || raw === "off") return raw;
  return fallback ?? "on";
}

/** web-hub-preview plan v3 §4.1/U1 (PV1): `webHub.preview` is tri-valued like `webHub.uploads`;
 * any other value falls back to the default "on" (U1). */
function parsePreviewSetting(raw: unknown, fallback: "on" | "loopback" | "off" | undefined): "on" | "loopback" | "off" {
  if (raw === "on" || raw === "loopback" || raw === "off") return raw;
  return fallback ?? "on";
}

/** web-hub-fleet-drawer plan §4.4 (F2): `webHub.subagentTranscript` is tri-valued;
 * any other value falls back to the default "all"（用户已拍板）. */
function parseSubagentTranscriptSetting(
  raw: unknown,
  fallback: "all" | "loopback" | "off" | undefined,
): "all" | "loopback" | "off" {
  if (raw === "all" || raw === "loopback" || raw === "off") return raw;
  return fallback ?? "all";
}

/** web-hub-slash-args plan §5 (P0): `webHub.commandComplete` is tri-valued like
 * `webHub.subagentTranscript`; any other value falls back to the default "all" (§11 D1
 * 拍板 — includes third-party commands via the TUI provider). Non-live like the rest of
 * webHub.*: change → /reload then /webhub restart. */
function parseCommandCompleteSetting(
  raw: unknown,
  fallback: "all" | "toolkit" | "off" | undefined,
): "all" | "toolkit" | "off" {
  if (raw === "all" || raw === "toolkit" || raw === "off") return raw;
  return fallback ?? "all";
}

/**
 * `webHub.spawn` 块解析（web-hub-spawn plan §SP2 / arch v2 §6.2；parseWebHubLanBlock 同款容错，
 * never throws）：`roots` 复用 `splitLanCsv`（CSV 字符串或 JSON 数组皆可，与 lan 三键同源）；
 * 数值按 arch §6.2 范围取整钳制，非法（非有限数）回落默认；`lan` 三选一。hub 侧
 * `hub/spawn/config.ts` 的 `parseHubSpawnConfig` 会再做一次严格重校验。
 */
export function parseWebHubSpawnBlock(input: unknown): WebHubSpawnSettings {
  const defaults = DEFAULT_WEBHUB_SPAWN_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...defaults, roots: [] };
  }
  const record = input as Record<string, unknown>;
  // arch §6.2: 每项 `/` 或 `~` 开头、无 NUL、≤4096 UTF-8 字节；非法项静静丢弃；最多 16 项。
  const roots = splitLanCsv(record.roots)
    .filter(
      (entry) =>
        (entry.startsWith("/") || entry.startsWith("~")) && !entry.includes("\0") && Buffer.byteLength(entry) <= 4096,
    )
    .slice(0, 16);
  const lan = record.lan;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    roots,
    maxProcesses: clampSpawnInt(record.maxProcesses, 1, 16, defaults.maxProcesses),
    maxPerPrincipal: clampSpawnInt(record.maxPerPrincipal, 1, 16, defaults.maxPerPrincipal),
    ratePerMinute: clampSpawnInt(record.ratePerMinute, 1, 30, defaults.ratePerMinute),
    maxLifetimeMinutes: clampSpawnInt(record.maxLifetimeMinutes, 10, 10_080, defaults.maxLifetimeMinutes),
    registerTimeoutS: clampSpawnInt(record.registerTimeoutS, 10, 120, defaults.registerTimeoutS),
    lan: lan === "off" || lan === "known" || lan === "roots" ? lan : defaults.lan,
    restore: typeof record.restore === "boolean" ? record.restore : defaults.restore,
    history: typeof record.history === "boolean" ? record.history : defaults.history,
    lanConfirm: typeof record.lanConfirm === "boolean" ? record.lanConfirm : defaults.lanConfirm,
  };
}

/** `parseWebHubProxyBlock` warning codes (web-hub-proxy plan v2 §5 "default + warning"). */
export type WebHubProxyWarning = "port-range-invalid" | "port-range-overlap" | "max-proxies-invalid";

export interface WebHubProxyParseResult {
  proxy: WebHubProxySettings;
  /** Every field that fell back to its default, for status-line consumers (`/webhub status`). */
  warnings: WebHubProxyWarning[];
}

/**
 * `webHub.proxy` block parse (web-hub-proxy plan v2 §5; `parseWebHubLanBlock` style — never
 * throws, field-by-field fallback, pure so repeated calls never spam logs; warnings are RETURNED):
 * - `enabled`: a real boolean, else `false`;
 * - `portRange`: `"<lo>-<hi>"` (decimal, no leading zero, lo ≤ hi, ports 1024..65535, span ≤ 256)
 *   that overlaps neither the resolved hub port nor the LAN port ⇒ stored canonically; anything
 *   else ⇒ the default range + a warning. `webHubPort` 0 (ephemeral) never overlaps — the real
 *   bound port is the engine's runtime `self-port` rule. If the DEFAULT range itself overlaps,
 *   the hub's second-line check (X1c) is the veto, same as `lan.port`'s default collision;
 * - `maxProxies`: an integer in 1..16, else 8 + a warning.
 * The range grammar is a parity copy of `protocol/proxy.ts`'s `parseProxyPortRange` (see
 * `DEFAULT_WEBHUB_PROXY_SETTINGS`' note); `tests/web-hub/protocol/proxy.test.ts` pins parity.
 */
export function parseWebHubProxyBlock(input: unknown, webHubPort: number, lanPort: number): WebHubProxyParseResult {
  const defaults = DEFAULT_WEBHUB_PROXY_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { proxy: { ...defaults }, warnings: [] };
  }
  const record = input as Record<string, unknown>;
  const warnings: WebHubProxyWarning[] = [];

  let portRange = defaults.portRange;
  if (record.portRange !== undefined) {
    const range = parseProxyPortRangeText(record.portRange);
    if (range === undefined) {
      warnings.push("port-range-invalid");
    } else if ([webHubPort, lanPort].some((port) => port > 0 && port >= range[0] && port <= range[1])) {
      warnings.push("port-range-overlap");
    } else {
      portRange = `${String(range[0])}-${String(range[1])}`;
    }
  }

  let maxProxies = defaults.maxProxies;
  if (record.maxProxies !== undefined) {
    const raw = record.maxProxies;
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 16) maxProxies = raw;
    else warnings.push("max-proxies-invalid");
  }

  return {
    proxy: {
      enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
      portRange,
      maxProxies,
    },
    warnings,
  };
}

/** Parity copy of `protocol/proxy.ts`'s `parseProxyPortRange` (see `parseWebHubProxyBlock`). */
function parseProxyPortRangeText(text: unknown): [number, number] | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^([1-9]\d{0,4})-([1-9]\d{0,4})$/.exec(text.trim());
  if (m === null) return undefined;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (lo > hi || lo < 1024 || hi > 65_535 || hi - lo + 1 > 256) return undefined;
  return [lo, hi];
}

/** `parseFeishuBotBlock` warning codes: one per leaf that fell back (`-invalid`) or was clamped (`-clamped`). */
export type FeishuBotWarning =
  | "block-invalid"
  | "enabled-invalid"
  | "security-alerts-invalid"
  | "xs-mirror-invalid"
  | "allow-groups-invalid"
  | "group-root-topics-invalid"
  | "notify-invalid"
  | "spawn-scope-invalid"
  | "debounce-invalid"
  | "debounce-clamped"
  | "stale-invalid"
  | "stale-clamped"
  | "files-invalid"
  | "files-outbound-invalid"
  | "files-inbound-invalid"
  | "files-max-inbound-invalid"
  | "files-max-inbound-clamped";

export interface FeishuBotParseResult {
  feishuBot: FeishuBotSettings;
  /** Every leaf that fell back to its default or was clamped, for `/webhub feishu status` (returned, never logged). */
  warnings: FeishuBotWarning[];
}

/**
 * Top-level `feishuBot` block parse (feishu-bot plan v2 §9; `parseWebHubProxyBlock` style — never
 * throws, field-by-field, pure so repeated calls never spam logs; warnings are RETURNED):
 * - booleans / enums (`notify` bound|off, `spawnScope` known|roots, `files.outbound` auto|buttons|off):
 *   a wrong type or unknown value ⇒ the default + `<leaf>-invalid`;
 * - numbers (`debounceMs` 0–10 000, `staleMessageS` 30–3 600, `files.maxInboundMiB` 1–100): a non-finite or
 *   non-number ⇒ default + `-invalid`; a finite number is rounded then CLAMPED into range (+ `-clamped`
 *   when it changed) — the hub-side normalizer then only ever sees in-range values;
 * - a non-object block ⇒ all defaults (+ `block-invalid` when it is present but not an object).
 * Literal mirror of `protocol/feishu.ts`'s ranges (see `DEFAULT_FEISHU_BOT_SETTINGS`' note).
 */
export function parseFeishuBotBlock(input: unknown): FeishuBotParseResult {
  const d = DEFAULT_FEISHU_BOT_SETTINGS;
  const defaults = (): FeishuBotSettings => ({ ...d, files: { ...d.files } });
  if (input === undefined || input === null) return { feishuBot: defaults(), warnings: [] };
  if (typeof input !== "object" || Array.isArray(input)) return { feishuBot: defaults(), warnings: ["block-invalid"] };
  const r = input as Record<string, unknown>;
  const warnings: FeishuBotWarning[] = [];

  const bool = (raw: unknown, fallback: boolean, code: FeishuBotWarning): boolean => {
    if (raw === undefined) return fallback;
    if (typeof raw === "boolean") return raw;
    warnings.push(code);
    return fallback;
  };
  const choice = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T, code: FeishuBotWarning): T => {
    if (raw === undefined) return fallback;
    if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
    warnings.push(code);
    return fallback;
  };
  const num = (
    raw: unknown,
    min: number,
    max: number,
    fallback: number,
    invalid: FeishuBotWarning,
    clamped: FeishuBotWarning,
  ): number => {
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      warnings.push(invalid);
      return fallback;
    }
    const rounded = Math.round(raw);
    const bounded = Math.min(max, Math.max(min, rounded));
    if (bounded !== raw) warnings.push(clamped);
    return bounded;
  };

  const filesRaw = r.files;
  let filesRecord: Record<string, unknown> = {};
  if (filesRaw !== undefined) {
    if (filesRaw !== null && typeof filesRaw === "object" && !Array.isArray(filesRaw)) {
      filesRecord = filesRaw as Record<string, unknown>;
    } else {
      warnings.push("files-invalid");
    }
  }

  return {
    feishuBot: {
      enabled: bool(r.enabled, d.enabled, "enabled-invalid"),
      securityAlerts: bool(r.securityAlerts, d.securityAlerts ?? true, "security-alerts-invalid"),
      xsMirror: bool(r.xsMirror, d.xsMirror ?? true, "xs-mirror-invalid"),
      allowGroups: bool(r.allowGroups, d.allowGroups, "allow-groups-invalid"),
      groupRootTopics: bool(r.groupRootTopics, d.groupRootTopics, "group-root-topics-invalid"),
      notify: choice(r.notify, ["bound", "off"] as const, d.notify, "notify-invalid"),
      spawnScope: choice(r.spawnScope, ["known", "roots"] as const, d.spawnScope, "spawn-scope-invalid"),
      debounceMs: num(r.debounceMs, 0, 10_000, d.debounceMs, "debounce-invalid", "debounce-clamped"),
      staleMessageS: num(r.staleMessageS, 30, 3_600, d.staleMessageS, "stale-invalid", "stale-clamped"),
      files: {
        outbound: choice(
          filesRecord.outbound,
          ["auto", "buttons", "off"] as const,
          d.files.outbound,
          "files-outbound-invalid",
        ),
        inbound: bool(filesRecord.inbound, d.files.inbound, "files-inbound-invalid"),
        maxInboundMiB: num(
          filesRecord.maxInboundMiB,
          1,
          100,
          d.files.maxInboundMiB,
          "files-max-inbound-invalid",
          "files-max-inbound-clamped",
        ),
      },
    },
    warnings,
  };
}

/** arch §6.2 数值域的容错读取：有限数 ⇒ 取整后钳进 [min,max]；其余（字符串/NaN/Infinity/缺失）回落默认。 */
function clampSpawnInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/**
 * List-valued LAN settings accept either a comma-separated string (the form the settings editor writes) or a JSON
 * array of strings (the natural hand-written form in settings.json). Non-string array items are dropped.
 */
function splitLanCsv(raw: unknown): string[] {
  const parts =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.flatMap((item) => (typeof item === "string" ? item.split(",") : []))
        : [];
  return parts.map((s) => s.trim()).filter((s) => s !== "");
}

/** §9.1 `webHub.lan.extraHosts`: 逐项 `classifyHostToken`；合法项进入白名单，非法项进入 `invalidExtraHosts`（不进白名单，不报错）。 */
function validateExtraHosts(raw: unknown): { hosts: string[]; invalid: InvalidHostToken[] } {
  const hosts: string[] = [];
  const invalid: InvalidHostToken[] = [];
  for (const token of splitLanCsv(raw)) {
    const cls = classifyHostToken(token);
    if (cls.ok) hosts.push(cls.host);
    else invalid.push({ token, reason: cls.reason });
  }
  return { hosts, invalid };
}

/** §2.4 `webHub.lan.trustProxyFrom`: 逐项必须是 IPv4 字面量；非法项静静丢弃（不单独列表，跟随 `proxyMismatch` 同步处理）。 */
function validateTrustProxyFrom(raw: unknown): string[] {
  const out: string[] = [];
  for (const token of splitLanCsv(raw)) {
    const cls = classifyHostToken(token);
    if (cls.ok && cls.kind === "ipv4") out.push(cls.host);
  }
  return out;
}

/** §2.4 `webHub.lan.externalOrigins`: 逐项 `parseOrigin` + scheme 必须 `https` + 主机部分再过 `classifyHostToken`。 */
function validateExternalOrigins(raw: unknown): string[] {
  const out: string[] = [];
  for (const token of splitLanCsv(raw)) {
    const parsed = parseOrigin(token);
    if (parsed === undefined || parsed.scheme !== "https") continue;
    const hostOnly = parsed.hostKey.slice(0, parsed.hostKey.lastIndexOf(":"));
    const hostCls = classifyHostToken(hostOnly);
    if (!hostCls.ok) continue;
    out.push(canonicalOrigin(parsed.scheme, parsed.hostKey));
  }
  return out;
}

/** Fail closed even for non-string configured values. Empty CSV/array alone is inactive.
 * Keep the first 64 distinct valid entries; overflow tokens are reported, never silently trusted. */
function parseAllowClients(raw: unknown): { entries: string[]; invalid: InvalidClientCidr[]; denyAll: boolean } {
  const values: unknown[] =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.flatMap((v) => (typeof v === "string" ? v.split(",") : [v]))
        : raw === undefined
          ? []
          : [raw];
  const entries: string[] = [];
  const invalid: InvalidClientCidr[] = [];
  let configured = false;
  for (const value of values) {
    if (typeof value === "string" && value.trim() === "") continue;
    configured = true;
    // JSON-valid objects may shadow toString/valueOf; never execute them for diagnostics.
    const token =
      typeof value === "string"
        ? value.trim()
        : value === null || typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : `<${typeof value}>`;
    const canonical = typeof value === "string" ? parseClientCidr(token) : undefined;
    if (canonical === undefined) invalid.push({ token, reason: "syntax" });
    else if (entries.includes(canonical)) continue;
    else if (entries.length >= CLIENT_ALLOW_MAX) invalid.push({ token, reason: "limit" });
    else entries.push(canonical);
  }
  return { entries, invalid, denyAll: configured && entries.length === 0 };
}

export interface WebHubLanParseResult {
  lan: WebHubLanSettings;
  /** §9.1: settings 解析时被丢弃的 `extraHosts` 项（status 列出，never `bad-config`）。 */
  invalidExtraHosts: InvalidHostToken[];
  invalidAllowClients: InvalidClientCidr[];
  /** §2.4: `trustProxyFrom`/`externalOrigins` 只设了其中一半 ⇒ 两者都被清空（fail-closed）。 */
  proxyMismatch: boolean;
}

/**
 * `webHub.lan` 块的唯一解析入口（L16 第一处，§9.1）。`webHubPort` 是已解析的 `webHub.port`（同时不能与
 * `lan.port` 相等，否则回退到默认 lan.port；默认本身碰撞的极端情形留给 hub 启动时的第二道校验，§9.1/§4）。
 * 从不 throw，从不修改入入参。
 */
export function parseWebHubLanBlock(input: unknown, webHubPort: number): WebHubLanParseResult {
  const defaults = DEFAULT_WEBHUB_LAN_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { lan: { ...defaults }, invalidExtraHosts: [], invalidAllowClients: [], proxyMismatch: false };
  }
  const record = input as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : defaults.enabled;
  const portRaw = record.port;
  let port =
    typeof portRaw === "number" && Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65_535
      ? portRaw
      : defaults.port;
  if (port === webHubPort) port = defaults.port; // §9.1: 必须与 webHub.port 不同；碰撞回退默认（若默认亦碰撞，hub 层的 checkLanPortConflict 否决）
  const { hosts: extraHosts, invalid: invalidExtraHosts } = validateExtraHosts(record.extraHosts);
  const { entries: allowClients, invalid: invalidAllowClients, denyAll } = parseAllowClients(record.allowClients);
  const sessionIdleMinutes = clampSpawnInt(record.sessionIdleMinutes, 5, 10080, 720);
  let trustProxyFrom = validateTrustProxyFrom(record.trustProxyFrom);
  let externalOrigins = validateExternalOrigins(record.externalOrigins);
  let proxyMismatch = false;
  if ((trustProxyFrom.length === 0) !== (externalOrigins.length === 0)) {
    trustProxyFrom = [];
    externalOrigins = [];
    proxyMismatch = true;
  }
  return {
    lan: {
      enabled,
      port,
      extraHosts,
      trustProxyFrom,
      externalOrigins,
      allowClients,
      sessionIdleMinutes,
      ...(denyAll ? { allowClientsDenyAll: true as const } : {}),
    },
    invalidAllowClients,
    invalidExtraHosts,
    proxyMismatch,
  };
}

/**
 * Settings-level LAN warnings (plan §9.1/§2.4) for status-line consumers — pure re-derivation of
 * the same raw `webHub.lan` block `parseWebHubSettings` already validated, so `/webhub status`
 * (or any other caller wired with the raw settings snapshot) can render `formatInvalidExtraHostsLine`/
 * `formatProxyMismatchLine` (`web-hub/agent/lan-status.ts`) without re-implementing §2.1/§2.4.
 */
export function parseWebHubLanValidation(
  input: unknown,
  webHubPort: number,
): { invalidExtraHosts: InvalidHostToken[]; invalidAllowClients: InvalidClientCidr[]; proxyMismatch: boolean } {
  const { invalidExtraHosts, invalidAllowClients, proxyMismatch } = parseWebHubLanBlock(input, webHubPort);
  return { invalidExtraHosts, invalidAllowClients, proxyMismatch };
}

export const DEFAULT_WEBHUB_SETTINGS: WebHubSettings = {
  enabled: false,
  autoStart: true,
  port: 7878,
  idleExitMinutes: 10,
  nodeLoader: "",
  control: true,
  remoteAskUser: true,
  webCommands: true,
  webCommandPolicy: {},
  // web-hub-steer-recall plan §2/§4.2 / arch §11 Q1: hold busy web steer/followUp until pi's
  // next queue drain so the browser can recall/re-edit them; default ON (user ruling Q1),
  // `false` ⇒ byte-identical rollback (W1/W2).
  steerRecall: true,
  // web-hub-slash-args plan §5 (§11 D1 拍板): / 命令参数提示与补全，默认 all（含第三方命令，
  // 经 TUI autocomplete provider）；non-live（/reload 后 /webhub restart）。
  commandComplete: "all",
  // web-hub-cmd-history plan §4.9 (A1): command-output history cards persisted as
  // `subagent:cmd` session entries. Default ON (Q1–Q5 rulings); `false` ⇒ no recorder, no
  // feature token, nothing written (`/reload` to take effect). NOTE the accepted residual:
  // command output is persisted VERBATIM (incl. e.g. `?token=` URLs — plan §5.3).
  cmdHistory: true,
  uploads: "on",
  preview: "on",
  avatar: true,
  // web-hub-privacy plan v2.1「设置」(P1): per-session privacy lock; default on, non-live.
  privacy: true,
  subagentTranscript: "all",
  quota: true,
  // sysload plan §6.1/§10 (P0 pre-approved cross-domain field, planning-gap fix): hub-side
  // on/off for its OWN load sampler (`buildHubConfig` writes `config.load` only when BOTH
  // this and `load.enabled` are true, §7.2). Default true.
  load: true,
  // web-hub archive plan (docs/dev/web-hub/archive-report.md): auto-archive TERMINAL fleet
  // rows / bash rows after N minutes (default 30). 0 disables the sweep; manual archive from
  // the web drawer always works. AGENT-side only (never read by buildHubConfig) — a change
  // needs `/reload` (picked up at the next stack build), NOT `/webhub restart`.
  archiveAfterMin: 30,
  archiveKeepRuns: 6,
  archiveKeepBash: 5,
  lan: DEFAULT_WEBHUB_LAN_SETTINGS,
  spawn: DEFAULT_WEBHUB_SPAWN_SETTINGS,
  // web-hub-proxy plan v2 §5 (X0): off by default, non-live.
  proxy: DEFAULT_WEBHUB_PROXY_SETTINGS,
};
