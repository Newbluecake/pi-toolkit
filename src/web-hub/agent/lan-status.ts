/**
 * `/webhub status`'s LAN-related text (plan §9.3; LE). Pure formatting only —
 * no I/O, no pi imports — so it composes with whatever `commands/webhub.ts`
 * (LI, S1-W3) ends up wiring around it. Every function takes already-decoded
 * data (`LanStatus`, `LanInfoPayload`, settings booleans) and returns lines
 * (never a single blob) so a caller can interleave them with other status
 * lines exactly like the table in the plan lays out ("各占一行").
 *
 * The initial-password display rule (plan §5.2 展示, §9.3 "初始密码（仅
 * TUI）") is enforced *here*, not at the transport: `connection.request()` /
 * `WebHubControl.lan.info()` always return whatever the hub sent (the hub
 * already omits `initialPassword` once the password has been changed) —
 * `formatInitialPasswordLines` is the single place that decides whether the
 * plaintext itself may be rendered, keyed on `mode`.
 */
import type { HostTokenRejectReason, InvalidHostToken, LanStatus } from "../protocol/lan.js";
import type { LanInfoPayload } from "../protocol/messages.js";

export type UiMode = "tui" | "rpc" | "print" | "json";

export interface LanStatusPaths {
  /** `HubPaths.dbFile` (plan §9.3 off/db-invalid, off/db-too-large). */
  dbFile: string;
  /** `webHub.lan.port` setting (plan §9.3 off/listen-failed — the off state itself carries no port). */
  lanPortSetting: number;
}

/** Counts for the rate-limiter warnings (plan §9.3 "收紧/饱和"); not part of `LanStatus.warnings`
 * itself (those are flag strings) — supplied by the caller (LC/LD own the limiter) when available. */
export interface LanLimiterCounts {
  tightenedFailures?: number;
  tightenedAddresses?: number;
}

function hostRejectLine(host: string, reason: HostTokenRejectReason): string {
  switch (reason) {
    case "numeric":
      return `提示：主机名「${host}」是纯数字，浏览器会把它当作数值地址、无法用它访问，未纳入白名单。请用 IP 或 ${host}.local 访问。`;
    case "denylisted":
      return `提示：主机名「${host}」与常见顶级域同名（denylisted），未纳入白名单。请用 IP 或 ${host}.local 访问，或在 webHub.lan.extraHosts 中显式添加。`;
    case "syntax":
      return `提示：主机名「${host}」不是合法主机名（syntax），未纳入白名单。`;
    case "too-long":
      return `提示：主机名「${host}」过长（too-long），未纳入白名单。`;
    case "ipv6":
      return `提示：主机名「${host}」是 IPv6 地址（ipv6），未纳入白名单。`;
  }
}

/** `webHub.lan.extraHosts` 中被丢弃的非法项（settings 层结果，plan §9.1）——单行合并列出。 */
export function formatInvalidExtraHostsLine(tokens: readonly InvalidHostToken[]): string | undefined {
  if (tokens.length === 0) return undefined;
  const parts = tokens.map((t) => `${t.token}（${t.reason}）`);
  return `忽略无效的 extraHosts：${parts.join("、")}。`;
}

/** `trustProxyFrom`/`externalOrigins` 只设置了一半（settings 层结果，plan §9.1）。 */
export function formatProxyMismatchLine(): string {
  return "忽略代理配置：trustProxyFrom 与 externalOrigins 必须同时设置。";
}

function proxyLine(proxy: { trustedFrom: string[]; externalOrigins: string[] }): string {
  return (
    `代理：采信 ${proxy.trustedFrom.join("、")} 的 X-Forwarded-*；对外 ${proxy.externalOrigins.join("、")}。` +
    "注意：受信任代理若失陷，该入口的所有会话（密码、cookie、客户端地址）都随之失陷，且可绕过每 IP 限流。"
  );
}

function warningLine(w: string, counts: LanLimiterCounts | undefined): string | undefined {
  if (w === "plaintext") return "⚠ 直连为 HTTP 明文：密码与会话在局域网上未加密";
  if (w === "login-tightened") {
    const f = counts?.tightenedFailures;
    const a = counts?.tightenedAddresses;
    return f !== undefined && a !== undefined
      ? `登录限流：收紧模式（10 分钟内 ${f} 次失败，${a} 个地址）。`
      : "登录限流：收紧模式。";
  }
  if (w === "login-saturated") {
    return "登录限流：饱和——24h 内失败地址已达 4096，来自新地址的登录被拒绝；执行 /webhub unlock 解除。";
  }
  if (w === "db-checkpoint-failed") return "警告：数据库 checkpoint 失败，详见 hub.log。";
  if (w === "initial-password-residue") return "警告：旧初始密码在磁盘上可能仍有残留，详见 hub.log。";
  if (w === "db-restarting") return "数据库子进程正在重启。";
  if (w === "proxy-xff-warnings") return "警告：最近收到过不受信任的转发头，详见 hub.log。";
  if (w.startsWith("hostname-omitted:") || w.startsWith("invalid-extra-host:")) return undefined; // rendered from omitted/invalidExtraHosts directly
  return undefined; // unknown/forward-compat warning token: silently ignore, never throw
}

/** `LanStatus.state === "on"` → lines (main line + omitted + proxy + warnings), one entry per line. */
export function formatLanOnLines(status: Extract<LanStatus, { state: "on" }>, counts?: LanLimiterCounts): string[] {
  const lines: string[] = [];
  const first = status.hosts[0];
  const extra = status.hosts.length - 1;
  const suffix = extra > 0 ? ` (+${extra} 个地址，/webhub open 查看)` : "";
  const url = first !== undefined ? `http://${first}:${status.port}/` : `(无可用地址):${status.port}`;
  const plaintextWarning = status.warnings.includes("plaintext") ? `  ${warningLine("plaintext", counts)}` : "";
  lines.push(`lan=on ${url}${suffix}${plaintextWarning}`);
  for (const o of status.omitted) lines.push(hostRejectLine(o.host, o.reason));
  if (status.proxy !== undefined) lines.push(proxyLine(status.proxy));
  for (const w of status.warnings) {
    if (w === "plaintext") continue; // already folded into the main line
    const line = warningLine(w, counts);
    if (line !== undefined) lines.push(line);
  }
  return lines;
}

/** `LanStatus.state === "off"` → the single explanatory line (plan §9.3 off/* rows). */
export function formatLanOffLine(status: Extract<LanStatus, { state: "off" }>, paths: LanStatusPaths): string {
  const detail = status.detail ?? "";
  switch (status.reason) {
    case "sqlite-unavailable":
      return "未开启：当前运行时没有 node:sqlite（需要 Node ≥22.13）。";
    case "db-invalid":
      return `未开启：hub.db 无法使用（${detail}）。把 ${paths.dbFile} 移走后执行 /webhub restart 会重建（生成新的初始密码，旧会话失效）。`;
    case "db-unavailable":
      return "未开启：数据库子进程在 10 分钟内连续失败 4 次，局域网入口已关闭。详见 hub.log；执行 /webhub restart 重试。";
    case "db-too-large":
      return `未开启：hub.db 异常大（${detail}），为了避免挂起没有打开它。请检查 ${paths.dbFile}。`;
    case "db-timeout":
      return "未开启：数据库检查超时（5s），详见 hub.log。";
    case "listen-failed":
      return `未开启：端口 ${paths.lanPortSetting} 监听失败（${detail}），请修改 webHub.lan.port。`;
    case "timeout":
      return "未开启：局域网入口启动超时（30s），详见 hub.log。";
    case "bad-config":
      return `未开启：hub 收到的 LAN 配置无效（${detail}）。`;
  }
}

export interface LanStatusMismatch {
  /** `webHub.lan.enabled` but `hub.json` has no `lan` at all (loopback-only hub, e.g. stale process). */
  hubMissingLan?: { hubPid: number };
  /** `!webHub.lan.enabled` but the running hub's `lan.state === "on"`. */
  settingsOffHubOn?: boolean;
}

export function formatLanMismatchLines(m: LanStatusMismatch): string[] {
  const lines: string[] = [];
  if (m.hubMissingLan !== undefined) {
    lines.push(
      `未生效：当前 hub（pid ${m.hubMissingLan.hubPid}）以仅本机模式运行（由其它 pi 进程或旧版本拉起）。执行 /webhub restart。`,
    );
  }
  if (m.settingsOffHubOn === true) {
    lines.push("注意：设置已关闭 LAN，但当前 hub 仍在局域网监听。执行 /webhub restart。");
  }
  return lines;
}

/**
 * Top-level entry point: `settingsEnabled` + `hub.json.lan` (`status`, `undefined`
 * when the hub.json record has no `lan` key at all) → every LAN status line,
 * in table order. `hubPid` is only consulted for the "settings on, hub has no
 * lan" mismatch.
 */
export function formatLanStatusLines(
  status: LanStatus | undefined,
  opts: {
    settingsEnabled: boolean;
    hubPid?: number;
    paths: LanStatusPaths;
    counts?: LanLimiterCounts;
  },
): string[] {
  const lines: string[] = [];
  if (opts.settingsEnabled && status === undefined && opts.hubPid !== undefined) {
    return formatLanMismatchLines({ hubMissingLan: { hubPid: opts.hubPid } });
  }
  if (!opts.settingsEnabled && status !== undefined && status.state === "on") {
    return formatLanMismatchLines({ settingsOffHubOn: true });
  }
  if (status === undefined) return lines;
  if (status.state === "starting") {
    lines.push("lan=starting…");
    return lines;
  }
  if (status.state === "on") return formatLanOnLines(status, opts.counts);
  return [formatLanOffLine(status, opts.paths)];
}

// --------------------------------------------------------------------------
// initial password (plan §5.2 展示, §9.3 "初始密码")
// --------------------------------------------------------------------------

function formatLocalMinute(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `LanInfoPayload` → the initial-password lines for the given UI mode.
 * `initialPassword` present ⇒ still in use: TUI shows the plaintext + reminder;
 * every other mode shows only the reminder (never the plaintext, plan §11 LE
 * row: "非 TUI 不显示初始密码"). Absent ⇒ already changed ⇒ no lines at all.
 */
export function formatInitialPasswordLines(info: LanInfoPayload | undefined, mode: UiMode): string[] {
  if (info === undefined || info.initialPassword === undefined) return [];
  const lines: string[] = [];
  if (mode === "tui") {
    lines.push(
      `初始密码：${info.initialPassword}（用户 ${info.username}；请尽快执行 /webhub passwd 修改，修改后不再显示）`,
    );
  } else {
    lines.push("（初始密码仅在 TUI 中显示）请尽快修改初始密码。");
  }
  lines.push("请尽快修改初始密码：在本机执行 /webhub passwd。");
  if (info.initialLogin !== undefined) {
    lines.push(`已有设备（${info.initialLogin.ip}，${formatLocalMinute(info.initialLogin.at)}）用初始密码登录过。`);
  }
  return lines;
}
