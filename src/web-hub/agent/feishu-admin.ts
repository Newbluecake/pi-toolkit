/**
 * `/webhub feishu …` agent-side admin client (feishu-bot plan v2 §9/§10/§R2-e, package F9).
 *
 * Sends the frozen `fsb_req` frames over the EXISTING agent↔hub connection and renders the
 * `fsb_res` answers. Pi-free by convention (like `admin-cmds.ts`/`passwd-prompt.ts`): every
 * runtime dependency — the connection, the QR renderer, the notify/confirm UI, the clock —
 * is injected, so the whole surface is unit-testable without pi.
 *
 * Wiring status (F9 ships BEFORE the hub side — F1–F8/FA land later): no hub advertises the
 * `fsb.v1` cap yet, so every op currently reports 「当前 hub 尚不支持飞书机器人」. The production
 * port (`defaultFeishuAdminPort`) is built lazily on `connection.ts`'s process-level
 * `currentConnection()` singleton — the same zero-wiring pattern `admin-cmds.ts` uses — which
 * means `/webhub feishu` goes live the moment FA lands, WITHOUT any rewiring of
 * `agent/index.ts`/`src/index.ts`. See F9-report.md's wiring hand-off for what FA must do
 * (widen `HubConnection.request()` to the fsb frames + declare the cap hub-side).
 *
 * Secrets discipline (§10): the wire `fsb_res.data` is a closed union without any secret,
 * device_code or WS-URL field (F0-pinned), and every id rendered here passes
 * `maskFeishuId` first — even a misbehaving hub cannot leak a full open_id into the status
 * lines. Token lines are English-only per the AGENTS.md UI-text split; Chinese is reserved
 * for the prose hint/warning blocks.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  FsbReqFrame,
  FsbResData,
  FsbResFrame,
  FsbInfoData,
  FsbAllowData,
  FsbSetupView,
} from "../protocol/feishu.js";
import { FEISHU_SETUP } from "../protocol/feishu.js";
import { FSB_HUB_CAP } from "../protocol/version.js";
import { currentConnection, newAdminRid, type HubConnection } from "./connection.js";

// ---------------------------------------------------------------------------
// connection port (the ONE seam FA owns)
// ---------------------------------------------------------------------------

/**
 * The slice of the hub connection F9 needs. FA's production adapter widens
 * `HubConnection.request()` to accept `FsbReqFrame` and resolve the matching `fsb_res`
 * (mirroring how `agent-server.ts` intercepts `fsb_req` like `lan_req` hub-side); until then
 * `defaultFeishuAdminPort()` bridges with a localized structural cast that is unreachable in
 * practice — no hub advertises `fsb.v1` before FA, so `callFsb` never sends anything.
 */
export interface FeishuAdminPort {
  /** `hello_ack.caps` of the current link (empty until live). */
  readonly caps: readonly string[];
  /** Whether the link is currently `live`. */
  readonly live: boolean;
  /** Link state name (`"live" | "backoff" | "off" | …`) for the not-connected diagnostic. */
  readonly state: string;
  /** Send one `fsb_req`; resolves with the rid-matched `fsb_res` (decoded via `decodeHubFrame`). */
  request(frame: FsbReqFrame): Promise<FsbResFrame>;
}

/** Value imports stay within agent/; the cast target is the post-FA widened signature. */
type FsbRequestCapableConnection = HubConnection & {
  request(frame: FsbReqFrame, requiredCap: string): Promise<FsbResFrame>;
};

/**
 * Production port over the process-level connection singleton. `undefined` when web-hub is not
 * wired at all (`webHub.enabled=false`). Lazily re-read per call so `/reload`-replaced
 * connections are picked up — never cache the result.
 */
export function defaultFeishuAdminPort(
  getConn: () => HubConnection | undefined = currentConnection,
): FeishuAdminPort | undefined {
  const conn = getConn();
  if (conn === undefined) return undefined;
  const view = conn.status();
  const widened = conn as FsbRequestCapableConnection;
  return {
    live: view.state === "live",
    state: view.state,
    caps: conn.caps,
    request: (frame) => widened.request(frame, FSB_HUB_CAP),
  };
}

// ---------------------------------------------------------------------------
// one-call helper (never throws, always bounded)
// ---------------------------------------------------------------------------

export type FsbCallResult =
  | { ok: true; data?: FsbResData }
  | { ok: false; reason: "refused"; code: string; message: string }
  | { ok: false; reason: "not-live" | "no-cap" | "timeout" | "conn-lost" | "unexpected"; message: string };

/** Default per-call deadline (hub-side `info`/`allow`/`deny`/poll ops are local + fast). */
export const FSB_CALL_DEFAULT_DEADLINE_MS = 5_000;
/** Wider deadline for ops whose hub side performs network I/O or drain budgets first. */
export const FSB_CALL_WIDE_DEADLINE_MS = 12_000;

function unrefDeadline(ms: number): { promise: Promise<never>; clear: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error("E_TIMEOUT: fsb request timed out")), ms);
    t.unref();
  });
  return { promise, clear: () => clearTimeout(t) };
}

function classifyTransportError(err: unknown): Extract<FsbCallResult, { ok: false }> {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("E_NO_CAP")) {
    return { ok: false, reason: "no-cap", message: "当前 hub 尚不支持飞书机器人（缺少 fsb.v1 能力）。" };
  }
  if (message.startsWith("E_TIMEOUT")) return { ok: false, reason: "timeout", message };
  if (message.startsWith("E_CLOSED") || message.startsWith("E_CONN_LOST")) {
    return { ok: false, reason: "conn-lost", message };
  }
  if (message.startsWith("E_NOT_CONNECTED")) return { ok: false, reason: "not-live", message };
  return { ok: false, reason: "unexpected", message };
}

/** One `fsb_req` round trip: cap pre-check, own unref'd deadline, refusal/transport classification. */
export async function callFsb(
  port: FeishuAdminPort,
  frame: FsbReqFrame,
  deadlineMs: number = FSB_CALL_DEFAULT_DEADLINE_MS,
): Promise<FsbCallResult> {
  if (!port.live) {
    return { ok: false, reason: "not-live", message: `web-hub 未连接（state=${port.state}）` };
  }
  if (!port.caps.includes(FSB_HUB_CAP)) {
    return { ok: false, reason: "no-cap", message: "当前 hub 尚不支持飞书机器人（缺少 fsb.v1 能力）。" };
  }
  const deadline = unrefDeadline(deadlineMs);
  try {
    const res = await Promise.race([port.request(frame), deadline.promise]);
    if (res.ok) return res.data === undefined ? { ok: true } : { ok: true, data: res.data };
    return { ok: false, reason: "refused", code: res.code, message: res.message };
  } catch (err) {
    return classifyTransportError(err);
  } finally {
    deadline.clear();
  }
}

// ---------------------------------------------------------------------------
// §10 status rendering (pure; token lines English, prose lines Chinese)
// ---------------------------------------------------------------------------

/** Display mask for an open_id the hub reports. Already-masked values (`ou_…9f3c`) pass through. */
export function maskFeishuId(id: string): string {
  // Defence in depth against a misbehaving hub: only a well-formed, already-masked value
  // (`ou_XX…abcd`) passes through; anything else is masked or reduced to a fixed token.
  if (/^ou_[A-Za-z0-9]{0,4}…[A-Za-z0-9]{4}$/.test(id)) return id;
  if (id.length <= 8) return "ou_…";
  return `${id.slice(0, 5)}…${id.slice(-4)}`;
}

/** Compact English duration token: `45s` / `4m03s` / `1h07m` / `2d05h`. */
export function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

function agoToken(at: number, nowMs: number): string {
  return `${formatDurationCompact(Math.max(0, nowMs - at))} ago`;
}

/** Max allow-list ids spelled out in the status line before folding into `+N more`. */
export const FSB_STATUS_ALLOW_SHOWN = 6;

const CAP_SYMBOLS = { ok: "✓", denied: "✗", unknown: "?" } as const;

/**
 * §10 status lines (compact English tokens). Order: status line, counters, outbox, bindings,
 * caps, keepalive, owner/allow. Fields absent from the wire are omitted, never guessed.
 */
export function formatFeishuStatusLines(info: FsbInfoData, nowMs: number): string[] {
  const statusToken =
    info.status === "degraded" && info.degraded !== undefined && info.degraded.length > 0
      ? `degraded(${info.degraded.join(",")})`
      : info.status;
  const head = [`feishu: status=${statusToken}`];
  if (info.brand !== undefined) head.push(`brand=${info.brand}`);
  head.push(`gen=${info.gen}`);
  if (info.uptimeMs !== undefined) head.push(`uptime=${formatDurationCompact(info.uptimeMs)}`);
  head.push(`reconnects=${info.reconnects}`);
  if (info.lastClose !== undefined) {
    const code = info.lastClose.code !== undefined ? `/${info.lastClose.code}` : "";
    head.push(`lastClose=${info.lastClose.reason}${code} ${agoToken(info.lastClose.at, nowMs)}`);
  }
  const lines: string[] = [head.join(" ")];

  const dropped = Object.entries(info.counters.dropped).filter(([, n]) => n > 0);
  const droppedToken = dropped.length > 0 ? ` dropped{${dropped.map(([k, n]) => `${k}=${n}`).join(",")}}` : "";
  lines.push(`counters: in=${info.counters.in} dup=${info.counters.dup}${droppedToken}`);

  const lastCode = info.outbox.lastCode !== undefined ? ` last=${info.outbox.lastCode}` : "";
  lines.push(`outbox: ok=${info.outbox.ok} failed=${info.outbox.failed}${lastCode}`);

  lines.push(`bindings: total=${info.bindings.total} offline=${info.bindings.offline} amb=${info.bindings.ambiguous}`);

  const cap = (s: string) => CAP_SYMBOLS[s as keyof typeof CAP_SYMBOLS] ?? "?";
  lines.push(
    `caps: cards=${cap(info.caps.cards)} reactions=${cap(info.caps.reactions)} files=${cap(info.caps.files)} cb=${cap(info.caps.cardCallback)}`,
  );

  lines.push(`keepalive=${info.keepalive ? "on" : "off"}`);

  const allowShown = info.allow.slice(0, FSB_STATUS_ALLOW_SHOWN).map(maskFeishuId);
  const more = info.allow.length - allowShown.length;
  const allowToken =
    info.allow.length === 0
      ? "allow=0"
      : `allow=${info.allow.length}: ${allowShown.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
  lines.push(`owner=${info.owner !== undefined ? maskFeishuId(info.owner) : "-"} ${allowToken}`);
  return lines;
}

/** §1 statuses that make the whole status block a warning rather than info. */
export function feishuStatusLevel(info: FsbInfoData): "info" | "warning" {
  return info.status === "degraded" || info.status === "auth_failed" || info.status === "conn_limit"
    ? "warning"
    : "info";
}

const DEGRADED_PROSE: Record<string, string> = {
  "state-corrupt":
    "state.json 损坏：连接器未启动（fail closed）。执行 /webhub feishu repair 修复——保留凭据，清空去重/请求/绑定，并在下一个 owner 事件重新固定租户。",
  "credentials-unsafe":
    "凭据文件安全检查未通过（类型/属主/权限/大小）：未加载、也不会被自动覆盖。请手工检查后执行 reset 重新注册。",
  "persist-failed": "状态持久化超时：已暂停 ACK（不再确认事件），写入恢复后自动继续。",
  "ws-unavailable": "当前 Node 运行时缺少原生 WebSocket（需 ≥22.4）：机器人不可用。",
  "undecodable-events": "收到无法解码的事件：已 ACK 并计数（不会静默当作成功）。",
};

/** Chinese prose explanation lines for the degraded reasons (unknown reasons shown verbatim). */
export function degradedReasonLines(reasons: readonly string[]): string[] {
  return reasons.map((r) => {
    if (r.startsWith("capability-denied:")) {
      return `能力 ${r.slice("capability-denied:".length)} 被平台拒绝（99991672/230027 类返回）。`;
    }
    return DEGRADED_PROSE[r] ?? `降级原因：${r}`;
  });
}

/** Chinese prose hints keyed on the §1 status machine (empty for self-explaining states). */
export function feishuStatusProseLines(info: FsbInfoData): string[] {
  const out: string[] = [];
  if (info.degraded !== undefined && info.degraded.length > 0) out.push(...degradedReasonLines(info.degraded));
  switch (info.status) {
    case "unconfigured":
      out.push("尚未配置：执行 /webhub feishu setup 开始扫码注册（PersonalAgent 设备流）。");
      break;
    case "setup":
      out.push("设备流注册进行中：等待扫码授权；/webhub feishu cancel 可取消。");
      break;
    case "auth_failed":
      out.push(
        "认证失败（凭据被平台拒绝）：每 10 分钟自动重试。请核对应用凭据，必要时 /webhub feishu setup --replace 重新注册。",
      );
      break;
    case "conn_limit":
      out.push("连接数超限：可能有另一台机器/进程在用同一个应用（一台机器一个应用）。5 分钟后自动重试。");
      break;
    default:
      break;
  }
  if (info.keepalive) out.push("凭据已加载：hub 空闲时不会自动退出（/webhub stop 仍可停止，reset 后解除）。");
  return out;
}

/** `fsb_res{ok:false}` → user-facing message + level. */
export function formatFsbRefusal(code: string, message: string): { message: string; level: "warning" | "error" } {
  switch (code) {
    case "E_FSB_CONFIRM_REQUIRED":
      return {
        message: "hub 要求显式确认：已有凭据时请用 /webhub feishu setup --replace（repair/reset 同样需要确认）。",
        level: "warning",
      };
    case "E_FSB_SETUP_ACTIVE":
      return {
        message: "已有进行中的注册：用 /webhub feishu status 查看，或 /webhub feishu cancel 取消后重试。",
        level: "warning",
      };
    case "E_FSB_UNCONFIGURED":
      return { message: "机器人尚未配置：先执行 /webhub feishu setup。", level: "warning" };
    case "E_FSB_CAP":
      return { message: `已达上限（${message || "容量已满"}）。`, level: "warning" };
    case "E_FSB_BAD_REQUEST":
      return { message: `参数无效：${message || code}`, level: "warning" };
    case "E_FSB_STATE":
      return { message: `当前状态拒绝该操作：${message || code}`, level: "warning" };
    default:
      return { message: `hub 拒绝：${code}${message ? `（${message}）` : ""}`, level: "error" };
  }
}

/** Transport-level failure → user-facing message + level. */
export function formatFsbTransportFailure(
  f: Extract<FsbCallResult, { ok: false }> | { reason: "no-hub"; message: string },
): { message: string; level: "warning" | "error" } {
  switch (f.reason) {
    case "no-hub":
      return { message: "web-hub 未启用（webHub.enabled=false）或尚未初始化；启用后 /reload 生效。", level: "warning" };
    case "not-live":
      return { message: `${f.message}；稍后重试，或 /webhub restart 后再试。`, level: "warning" };
    case "no-cap":
      return {
        message: `${f.message}该能力随后续 hub 版本落地；升级 pi-toolkit 并 /webhub restart 后重试。`,
        level: "warning",
      };
    case "timeout":
      return { message: "hub 响应超时（fsb 通道）：稍后重试。", level: "warning" };
    case "conn-lost":
      return { message: "与 hub 的连接中断：稍后重试。", level: "warning" };
    case "unexpected":
    case "refused":
      return { message: f.message, level: "error" };
  }
}

/** `allow`/`deny` result line (English token). */
export function formatAllowResultLine(data: FsbAllowData, verb: "allow" | "deny"): string {
  return `${verb}: ${data.changed ? "changed" : "unchanged"} allow-list=${data.count}`;
}

// ---------------------------------------------------------------------------
// §8 feishu-notify coexistence probe (agent-side only, never in FsbInfoData)
// ---------------------------------------------------------------------------

export interface FeishuNotifyCoexistence {
  configured: boolean;
  watchDefault: boolean;
}

/**
 * Whether `src/feishu-notify` (Q4: untouched, coexists) is configured: `FEISHU_WEBHOOK_URL` set,
 * or `feishu-notify.json` carries a non-empty `webhookUrl`. The config path override
 * (`FEISHU_NOTIFY_CONFIG_PATH`) mirrors feishu-notify's own, for test isolation.
 */
export function readFeishuNotifyCoexistence(
  env: Record<string, string | undefined>,
  readConfigFile: (path: string) => string | undefined,
  configPath: string,
): FeishuNotifyCoexistence {
  let fileWebhook: unknown;
  let watchDefault = false;
  const text = readConfigFile(configPath);
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const r = parsed as Record<string, unknown>;
        fileWebhook = r.webhookUrl;
        watchDefault = r.watchDefault === true;
      }
    } catch {
      /* unparseable config is feishu-notify's own problem, not a coexistence signal */
    }
  }
  const envUrl = env.FEISHU_WEBHOOK_URL;
  const configured = (typeof envUrl === "string" && envUrl !== "") || typeof fileWebhook === "string";
  return { configured, watchDefault };
}

/** Production wrapper: reads the real env + `~/.pi/agent/feishu-notify.json`. */
export function detectFeishuNotifyCoexistence(env: NodeJS.ProcessEnv = process.env): FeishuNotifyCoexistence {
  const path = env.FEISHU_NOTIFY_CONFIG_PATH ?? join(homedir(), ".pi", "agent", "feishu-notify.json");
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    /* absent or unreadable: not configured via file */
  }
  return readFeishuNotifyCoexistence(env, () => text, path);
}

/** §8 coexistence warning lines (Chinese prose; empty when feishu-notify is not configured). */
export function coexistenceWarningLines(c: FeishuNotifyCoexistence): string[] {
  if (!c.configured) return [];
  const lines = [
    "检测到 feishu-notify（webhook 通知插件）已配置：两者可共存，但同一次运行可能各发一条通知。",
    '建议在 ~/.pi/agent/feishu-notify.json 中设置 "watchDefault": false，减少重复的完成类通知。',
  ];
  if (c.watchDefault) lines.push("当前 watchDefault:true——新会话默认开启 /watch，重复通知会更明显，建议改为 false。");
  return lines;
}

// ---------------------------------------------------------------------------
// §9 setup flow (device-flow orchestration: begin → QR → poll → terminal phase)
// ---------------------------------------------------------------------------

export interface FeishuSetupUi {
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** Persistent QR surface (TUI widget); lines are pre-rendered block rows. */
  showQr(lines: readonly string[]): void;
  clearQr(): void;
}

export interface FeishuSetupDeps {
  port: FeishuAdminPort;
  ui: FeishuSetupUi;
  /** Throws `Error("qr-too-large")` beyond capacity — the flow degrades to the raw URL. */
  renderQr(text: string): string;
  now(): number;
  /** Unref'd sleep (the production impl never pins the process). */
  sleep(ms: number): Promise<void>;
}

/** Slack added to the hub-reported `expiresAt` before the agent stops polling. */
export const FSB_SETUP_POLL_SLACK_MS = 15_000;

function hasStringField(v: unknown, key: string): boolean {
  return v !== null && typeof v === "object" && typeof (v as Record<string, unknown>)[key] === "string";
}

/** `fsb_res.data` union guards (the wire shape is closed; these keep a lying port honest). */
export function isFsbSetupView(data: FsbResData | undefined): data is FsbSetupView {
  return hasStringField(data, "phase");
}

export function isFsbInfoData(data: FsbResData | undefined): data is FsbInfoData {
  return hasStringField(data, "status");
}

export function isFsbAllowData(data: FsbResData | undefined): data is FsbAllowData {
  if (data === null || typeof data !== "object") return false;
  const r = data as unknown as Record<string, unknown>;
  return typeof r["changed"] === "boolean" && typeof r["count"] === "number";
}

function setupPhaseMessage(phase: string): { message: string; level: "info" | "warning" | "error" } {
  switch (phase) {
    case "done":
      return {
        message: "飞书机器人配置完成：凭据已保存、owner 已加入白名单、连接器已启动。/webhub feishu status 查看状态。",
        level: "info",
      };
    case "expired":
      return { message: "注册已过期（二维码有效期最长 600 秒）：重新执行 /webhub feishu setup。", level: "warning" };
    case "denied":
      return { message: "授权被拒绝（用户在飞书端取消）。可重新执行 /webhub feishu setup。", level: "warning" };
    case "cancelled":
      return { message: "注册已取消（/webhub feishu cancel）：凭据未变更。", level: "info" };
    case "failed":
      return {
        message: "注册失败：详情见 hub 日志（前缀 web-hub feishu:）。可重试 /webhub feishu setup。",
        level: "error",
      };
    default:
      return { message: `注册状态：${phase}`, level: "info" };
  }
}

/**
 * The full `/webhub feishu setup` flow AFTER its TUI confirm (the command builds the begin
 * frame — `replace`+`confirm` only once the user agreed). Sends `setup_begin`, renders the QR
 * (persistent surface + URL), polls `setup_status` every `FEISHU_SETUP.agentPollMs` until a
 * terminal phase, and always clears the QR. Bounded: the poll loop hard-stops at
 * `expiresAt + FSB_SETUP_POLL_SLACK_MS` (fallback `maxExpiresInS`), every call has its own
 * unref'd deadline, and a mid-flow `no-cap` (hub replaced by an older one) aborts at once.
 */
export async function runFeishuSetupFlow(deps: FeishuSetupDeps, req: { replace: boolean }): Promise<void> {
  const begin: FsbReqFrame = req.replace
    ? { t: "fsb_req", rid: newAdminRid(), op: "setup_begin", replace: true, confirm: true }
    : { t: "fsb_req", rid: newAdminRid(), op: "setup_begin" };
  const res = await callFsb(deps.port, begin, FSB_CALL_WIDE_DEADLINE_MS);
  if (!res.ok) {
    const f = res.reason === "refused" ? formatFsbRefusal(res.code, res.message) : formatFsbTransportFailure(res);
    deps.ui.notify(f.message, f.level);
    return;
  }
  let view: FsbSetupView;
  if (!isFsbSetupView(res.data)) {
    deps.ui.notify(`setup_begin 返回了意外的数据形状（${res.data === undefined ? "空" : "非 setup 视图"}）。`, "error");
    return;
  }
  view = res.data;
  if (view.phase !== "pending") {
    const m = setupPhaseMessage(view.phase);
    deps.ui.notify(m.message, m.level);
    return;
  }

  // QR + URL (the QR stays visible for the whole poll; cleared on every exit path below).
  if (view.qrUrl !== undefined) {
    try {
      deps.ui.showQr(deps.renderQr(view.qrUrl).split("\n"));
    } catch (err) {
      deps.ui.notify(
        `二维码渲染失败（${err instanceof Error ? err.message : String(err)}），请使用下面的链接。`,
        "warning",
      );
    }
    deps.ui.notify(view.qrUrl, "info");
    const ttl =
      view.expiresAt !== undefined
        ? `（约 ${formatDurationCompact(Math.max(0, view.expiresAt - deps.now()))} 后过期）`
        : "";
    deps.ui.notify(`在飞书 App 中扫码授权${ttl}；等待完成… 可随时执行 /webhub feishu cancel 取消。`, "info");
  } else {
    deps.ui.notify("注册已在进行中（无新二维码）：继续等待结果，/webhub feishu cancel 可取消。", "info");
  }

  const deadline = (view.expiresAt ?? deps.now() + FEISHU_SETUP.maxExpiresInS * 1_000) + FSB_SETUP_POLL_SLACK_MS;
  let warnedTransport = false;
  try {
    while (view.phase === "pending") {
      if (deps.now() >= deadline) {
        deps.ui.notify(
          "等待超时：本轮轮询停止（hub 侧注册可能仍在进行）。/webhub feishu status 查看，或 cancel 后重新 setup。",
          "warning",
        );
        return;
      }
      await deps.sleep(FEISHU_SETUP.agentPollMs);
      const r = await callFsb(deps.port, { t: "fsb_req", rid: newAdminRid(), op: "setup_status" });
      if (r.ok) {
        if (!isFsbSetupView(r.data)) continue; // malformed view: keep polling, deadline bounds us
        if (r.data.phase !== view.phase) {
          view = r.data;
          if (view.phase !== "pending") {
            const m = setupPhaseMessage(view.phase);
            deps.ui.notify(m.message, m.level);
          }
        } else {
          view = r.data; // refresh expiresAt if the hub re-issued it
        }
      } else if (r.reason === "no-cap") {
        deps.ui.notify("hub 已被不支持飞书机器人的版本替换：本轮等待中止。", "warning");
        return;
      } else if (r.reason === "refused") {
        // A hub refusal (e.g. E_FSB_STATE / E_FSB_UNCONFIGURED) is final for this setup — stop
        // polling instead of retrying until the deadline (verifier r_BM7T028N minor 1).
        const f = formatFsbRefusal(r.code, r.message);
        deps.ui.notify(f.message, f.level);
        return;
      } else if (!warnedTransport) {
        warnedTransport = true;
        const f = formatFsbTransportFailure(r);
        deps.ui.notify(`轮询暂时失败（${f.message}），继续重试…`, "warning");
      }
    }
  } finally {
    deps.ui.clearQr();
  }
}
