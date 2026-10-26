// Mirror of src/core/agent-dir.ts — parity: tests/config/agent-dir-parity.test.ts.
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export interface AgentDirInfo {
  readonly dir: string;
  readonly home: string;
  readonly source: "default" | "env";
  readonly ignored?: { readonly raw: string; readonly reason: "relative" };
}

/** Lexical resolution only: no trim, realpath, I/O or pi imports. Relative values are unsupported. */
export function resolveAgentDir(env: Readonly<Record<string, string | undefined>>, home: string): AgentDirInfo {
  const H = join(home, ".pi", "agent");
  const raw = env[AGENT_DIR_ENV];
  if (raw === undefined || raw === "") return { dir: H, home: H, source: "default" };
  let expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  if (raw.startsWith("file://")) {
    try {
      expanded = fileURLToPath(raw);
    } catch {
      // Invalid file URLs are unsupported too; fall back without throwing.
    }
  }
  if (!isAbsolute(expanded)) return { dir: H, home: H, source: "default", ignored: { raw, reason: "relative" } };
  const dir = resolve(expanded);
  return dir === H ? { dir: H, home: H, source: "default" } : { dir, home: H, source: "env" };
}
