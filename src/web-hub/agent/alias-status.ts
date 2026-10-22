/**
 * `/webhub status`'s alias-store degraded line (alias-plan §3.3, AL6). Pure formatting — no I/O, no pi
 * imports. The hub writes `hub.json.alias` ONLY when the binding store booted degraded, so a healthy /
 * off / old hub yields no lines (status output byte-identical).
 */
import type { XsAliasHubStatus } from "../protocol/xs-alias.js";

/** One-line terse path/reason (hub.json is same-uid data: strip control characters, cap length). */
const clean = (s: string, max: number): string => s.replace(/\p{C}/gu, " ").slice(0, max);

export function formatAliasStatusLines(alias: XsAliasHubStatus | undefined): string[] {
  if (alias === undefined) return [];
  return [
    `warning：alias store degraded (${clean(alias.reason, 60)}) · ${clean(alias.path, 240)}`,
    "别名服务已停用且文件保持原样；修复或移走该文件后执行 /webhub restart 恢复（修复前用别名形状的名字寻址会得到 UNAVAILABLE，请改用 ref）。",
  ];
}
