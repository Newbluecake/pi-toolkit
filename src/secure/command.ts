/**
 * `/secure status` (data-encryption plan r4 §2.2 「插件内只有一个只读命令」, §2.6 D5 check).
 * Read-only, main session only (post-guard). Registered only when the process has a secure
 * section / verdict worth reporting, so a plain process without vaults keeps its command list
 * byte-identical.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { judgeVaultMount, readProcMountinfo, statePathsOf, type SecureDomain } from "./domain.js";
import { PI_SECURE_SESSION } from "./env.js";

export const TRAFFIC_RECORD_HONORS = "PI_SECURE_SESSION/1";

export interface TrafficRecordCheck {
  /** package spec as written in settings.json */
  spec: string;
  /** remote = installed from npm/git/https: cannot be verified locally (security review P2 #5). */
  verdict: "honors" | "missing" | "unknown" | "remote";
}

function packageSpec(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    const source = (entry as { source?: unknown }).source;
    if (typeof source === "string") return source;
  }
  return undefined;
}

/** D5: find traffic-record packages in pi's settings and check their `piSecure.honors` declaration. */
export function checkTrafficRecord(agentDir: string): TrafficRecordCheck[] {
  let packages: unknown;
  try {
    packages = (JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown }).packages;
  } catch {
    return [];
  }
  if (!Array.isArray(packages)) return [];
  const out: TrafficRecordCheck[] = [];
  for (const entry of packages) {
    const spec = packageSpec(entry);
    if (spec === undefined || !spec.includes("traffic-record")) continue;
    const local = !/^(npm|git|https?|ssh):/.test(spec) && !spec.startsWith("git@");
    const pkgJson = join(resolve(agentDir, spec), "package.json");
    if (!local) {
      out.push({ spec, verdict: "remote" });
      continue;
    }
    if (!existsSync(pkgJson)) {
      out.push({ spec, verdict: "unknown" });
      continue;
    }
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { piSecure?: { honors?: unknown } };
      out.push({ spec, verdict: pkg.piSecure?.honors === TRAFFIC_RECORD_HONORS ? "honors" : "missing" });
    } catch {
      out.push({ spec, verdict: "unknown" });
    }
  }
  return out;
}

export interface SecureStatusInput {
  domain: SecureDomain;
  runtimeLock: string | undefined;
  agentDir: string;
  packageRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  readMountinfo?: () => string;
}

export function renderSecureStatus(input: SecureStatusInput): string {
  const { domain } = input;
  const lines: string[] = [];
  const lockText = input.runtimeLock ?? (domain.kind === "locked" ? domain.reason : undefined);
  lines.push(`加密会话：${domain.kind}${lockText !== undefined ? "（已锁定）" : ""}`);
  if (lockText !== undefined) lines.push(`  锁定原因：${lockText}`);
  if (domain.kind === "secure") {
    const p = statePathsOf(domain.vault);
    lines.push(`  保险库：${domain.vault.vault.name}（经 ${domain.via === "env" ? "PI_SECURE_VAULT" : "cwd"} 判定）`);
    lines.push(`  项目根：${p.work}`);
    lines.push(`  私有区：${p.state}（会话 / tmp / bash-jobs / workflows / consult / memory）`);
    lines.push(`  TMPDIR=${input.env.TMPDIR ?? "(未设置)"}`);
    lines.push("  已关闭：feishu-notify、跨会话消息（xs）、droid、cron；worktree 隔离会被拒绝");
  }
  if (domain.config.present) {
    const cfg = domain.config;
    lines.push(`配置：secure.enabled=${cfg.enabled}${cfg.valid ? "" : `（非法：${cfg.error ?? "?"}）`}`);
    for (const v of domain.vaults) {
      const mount = judgeVaultMount(v, input.readMountinfo ?? readProcMountinfo);
      lines.push(
        `  - ${v.vault.name}：${mount.ok ? "mounted" : "not mounted"} · ${v.root} · 挂载点 ${v.vault.mnt}${v.vault.layout === "legacy" ? "（旧布局，只读兼容）" : ""}`,
      );
    }
    for (const bad of cfg.invalid) lines.push(`  - ${bad.name}：invalid (${bad.reason})`);
  }
  for (const t of checkTrafficRecord(input.agentDir)) {
    if (t.verdict === "honors") lines.push(`traffic-record（${t.spec}）：已声明遵守 ${PI_SECURE_SESSION}=1`);
    else if (t.verdict === "remote")
      lines.push(
        `提示：traffic-record（${t.spec}）是远端安装，无法在本地核验是否遵守 ${PI_SECURE_SESSION}=1；请确认其版本已适配（R10）`,
      );
    else
      lines.push(
        `警告：traffic-record（${t.spec}）${t.verdict === "missing" ? "未声明" : "无法确认是否"}遵守 ${PI_SECURE_SESSION}=1，加密会话的请求正文可能写进 traffic.db（R10）`,
      );
  }
  // Security review P2 #3: the verdict is frozen per pi process.
  lines.push("注意：secure 配置变更（如 pi-secure init 登记新保险库）需重启 pi 进程才生效；/reload 不会重新判定。");
  lines.push(`启动器：ln -s ${join(input.packageRoot, "src", "secure", "bin", "pi-secure")} ~/.local/bin/pi-secure`);
  return lines.join("\n");
}

interface CommandCtx {
  ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void };
}
export type SecureCommandPi = Pick<ExtensionAPI, "registerCommand">;

/** Register `/secure` only when there is something to report (keeps off/absent byte-identical). */
export function secureCommandWanted(domain: SecureDomain): boolean {
  if (domain.kind !== "plain" || domain.vaults.length > 0) return true;
  return domain.config.present && domain.config.enabled && !domain.config.valid;
}

export function registerSecureCommand(
  pi: SecureCommandPi,
  deps: { domain: SecureDomain; runtimeLock: () => string | undefined },
): void {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  pi.registerCommand("secure", {
    description: "Encrypted vault session: /secure status",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as unknown as CommandCtx;
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub !== "" && sub !== "status") {
        ctx.ui?.notify?.("usage: /secure status", "warning");
        return;
      }
      let agentDir: string;
      try {
        agentDir = getAgentDir();
      } catch {
        agentDir = join(process.env.HOME ?? "", ".pi", "agent");
      }
      ctx.ui?.notify?.(
        renderSecureStatus({
          domain: deps.domain,
          runtimeLock: deps.runtimeLock(),
          agentDir,
          packageRoot,
          env: process.env,
        }),
        "info",
      );
    },
  });
}
