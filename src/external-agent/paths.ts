/**
 * 外部 agent 路径函数（external-agent plan §2.10，P1 冻结面）。纯函数、零 IO：
 * `path.resolve`/`join` 是纯字符串运算；调用方决定何时真正读写。
 */
import { join, resolve, sep } from "node:path";

export const EXTERNAL_AGENT_DIRNAME = "external-agent";

/** `<agentDir>/external-agent` */
export function externalAgentRoot(agentDir: string): string {
  return join(agentDir, EXTERNAL_AGENT_DIRNAME);
}

/** `<root>/<provider>/sessions` */
export function externalSessionsDir(agentDir: string, provider: string): string {
  return join(externalAgentRoot(agentDir), provider, "sessions");
}

/** droid 会话 sessionId 的合法形状（外部 sessionId 是自造的，不信任任意输入）。 */
const EXTERNAL_SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** `<root>/<provider>/sessions/<sessionId>.jsonl`；sessionId 须过 /^[A-Za-z0-9-]{8,64}$/，否则 throw。 */
export function externalSessionPath(agentDir: string, provider: string, sessionId: string): string {
  if (!EXTERNAL_SESSION_ID_RE.test(sessionId))
    throw new Error(`invalid external session id: ${JSON.stringify(sessionId.slice(0, 32))}`);
  return join(externalSessionsDir(agentDir, provider), `${sessionId}.jsonl`);
}

/** resolve 后前缀判断（结构性证据：路径在 `<agentDir>/external-agent/` 之下）；undefined ⇒ false。 */
export function isExternalSessionPath(path: string | undefined, agentDir: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  const root = `${resolve(externalAgentRoot(agentDir))}${sep}`;
  return resolve(path).startsWith(root);
}

/** `<agentDir>/cache/external-agent/<provider>-catalog.json` */
export function catalogCachePath(agentDir: string, provider: string): string {
  return join(agentDir, "cache", EXTERNAL_AGENT_DIRNAME, `${provider}-catalog.json`);
}

/** `<agentDir>/cache/external-agent/probe-cwd`（目录探测的固定 cwd，S4：只 init 也会落会话文件 ⇒ 固定 slug 归档）。 */
export function probeCwd(agentDir: string): string {
  return join(agentDir, "cache", EXTERNAL_AGENT_DIRNAME, "probe-cwd");
}
