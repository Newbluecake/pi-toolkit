/** Local-only, pure terminal diagnostics. hub.json describes STARTUP policy, not
 * hello_ack/browser capabilities, login proof, SSE readiness or realtime usage.
 * All untrusted input is projected onto fixed tokens/numbers; never print paths. */
import { Value } from "@sinclair/typebox/value";
import { TerminalMachineLimitsV2Schema } from "../protocol/terminal-v2.js";
import type { TerminalHubConfig } from "../protocol/terminal.js";

export type TerminalEligibility = "eligible" | "not-connected" | "guard-denied" | "context-unavailable";
export interface TerminalStatusInput {
  /** Activation settings after D8 overrides. No disk reread of session settings. */
  settings: (TerminalHubConfig & { enabled: boolean }) | undefined;
  eligibility: TerminalEligibility;
  /** Caller verified hub pid/starttime/argv/uid using the existing identity chain. */
  hubIdentityVerified: boolean;
  hubSnapshot?: unknown;
}
// Fixed reasons only. Never display arbitrary error bodies or a value merely because
// it matches a lowercase regex. Unknown future reasons are deliberately "unknown".
const REASONS = new Set([
  "settings-invalid",
  "policy-invalid",
  "settings-io",
  "settings-not-directory",
  "settings-unsafe-file",
  "settings-dangling-compat-link",
  "settings-json",
  "settings-oversize",
  "settings-unsafe",
  "settings-conflict",
  "settings-timeout",
  "startup-domain-denied",
  "startup-domain-unknown",
  "initializing",
  "resource-unavailable",
  "privacy-unavailable",
  "setup-required",
]);
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
function limits(v: unknown): TerminalHubConfig | undefined {
  return Value.Check(TerminalMachineLimitsV2Schema, v) ? v : undefined;
}
export function formatTerminalStatusLines(input: TerminalStatusInput): string[] {
  const local = input.settings;
  if (local?.enabled !== true) return [];
  const lines = [
    `本会话终端：配置开启；资格 ${input.eligibility}；声明 ${input.eligibility === "eligible" ? "write-time" : "absent"}。`,
    `本会话限额：${local.maxPerSession}；输入空闲 ${local.inputIdleMs / 1000}s；硬寿命 ${local.maxLifetimeMs / 1000}s（activation 快照，修改需 /reload）。`,
  ];
  const hub = input.hubIdentityVerified ? record(input.hubSnapshot) : undefined;
  const source = hub?.source;
  const scope = source === "default" || source === "agentDir" || source === "inherited" ? source : "unknown";
  if (hub?.mode === "per-session" && (hub.state === "ready" || hub.state === "unavailable")) {
    lines.push(`hub 终端启动快照：per-session / ${hub.state}；scope ${scope}（非浏览器能力回执）。`);
    if (hub.state === "ready") {
      const global = limits(hub.effectiveMachineLimits);
      if (global)
        lines.push(
          `机器上限：total ${global.maxTotal} / principal ${global.maxPerPrincipal}（启动冻结，修改需 /webhub restart）。`,
        );
      else lines.push("机器上限：unknown（启动记录缺字段）。");
    }
  } else if (hub?.state === "ready") lines.push("hub 终端启动快照：legacy-ready；per-session 能力 unknown。");
  else if (hub?.state !== "unavailable") {
    lines.push(
      input.eligibility === "eligible"
        ? "本会话符合资格；hub终端能力未知（关闭或旧版），请核对本地启动环境。"
        : "hub终端能力未知（关闭或旧版）；启动记录缺失或身份未验证。",
    );
  }
  if (hub?.state === "unavailable") {
    const reason = typeof hub.reason === "string" && REASONS.has(hub.reason) ? hub.reason : "unknown";
    lines.push(
      `终端不可用：${reason}。保留已有 allocation，不自动重置或接管；同 kernel unknown 逐条占额，坏账本仅封终端新建。修复后 /webhub restart。`,
    );
  }
  lines.push("浏览器需本boot真实登录；本地状态不证明当前登录或独立终端流可用。");
  return lines;
}
