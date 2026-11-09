/** Conservative, pi-free classification for the future Web command seam.
 * Unknown and malformed input is never classified as read-only. This module does
 * not authorize execution; callers must still validate syntax and capabilities.
 */
import { isHubMemoryId } from "./scopes/limits.js";

export type MemoryCommandClass = "read" | "single" | "destructive" | "flow" | "effect" | "unknown";

/** Classify the original argument string, not a caller-supplied class field. */
export function classifyMemoryCommand(rawArgs: string): MemoryCommandClass {
  const words = rawArgs.trim().split(/\s+/).filter(Boolean);
  const [head, ...tail] = words;
  const exact = (...values: string[]): boolean =>
    tail.length === values.length && values.every((v, i) => tail[i] === v);
  if (head === undefined || (["list", "path", "doctor"].includes(head) && tail.length === 0)) return "read";
  if (head === "init" && tail.length === 0) return "single";
  if (head === "import") return "destructive";
  if (head === "migrate") {
    const allowed = new Set(["--all", "--dry-run", "--report", "--status", "--import-legacy", "--rollback"]);
    if (tail.some((x) => !allowed.has(x)) || new Set(tail).size !== tail.length) return "unknown";
    const f = new Set(tail);
    if (["--report", "--status", "--import-legacy", "--rollback"].filter((x) => f.has(x)).length > 1) return "unknown";
    if (f.has("--dry-run") && (f.has("--rollback") || f.has("--report") || f.has("--status"))) return "unknown";
    if (f.has("--all") && (f.has("--report") || f.has("--status") || f.has("--import-legacy") || f.has("--rollback")))
      return "unknown";
    return f.has("--dry-run") || f.has("--report") || f.has("--status") ? "read" : "destructive";
  }
  if (head === "restore") {
    if (tail.length === 0 || exact("--trash")) return "read";
    const flags = tail.filter((x) => x.startsWith("-"));
    if (
      flags.some((x) => !["--trash", "--block"].includes(x)) ||
      new Set(flags).size !== flags.length ||
      flags.length > 1 ||
      tail.length > 2
    )
      return "unknown";
    if (tail.length === 2 && (flags.length !== 1 || tail[0] !== flags[0])) return "unknown";
    return "destructive";
  }
  if (head === "jev") {
    if (tail.length === 0 || exact("report")) return "read";
    if (exact("probe") || exact("reset-index") || exact("retag") || exact("retag", "--all")) return "effect";
    return "unknown";
  }
  if (head === "tags") {
    if (tail.length === 0 || exact("list")) return "read";
    if (tail[0] === "add" || tail[0] === "enable") return "effect";
    if (tail[0] === "rm" || tail[0] === "disable") return "single";
    return "unknown";
  }
  if (head === "review") {
    if (exact("--list")) return "read";
    if (exact("--run")) return "effect";
    return tail.length === 0 ? "flow" : "unknown";
  }
  if (head === "expired") return tail.length === 0 ? "flow" : "unknown";
  if (head === "session" || head === "hub") {
    const [op, ...args] = tail;
    if ((op === undefined || ["list", "status", "path"].includes(op)) && args.length === 0) return "read";
    if (
      head === "hub" &&
      ((op === "trash" && args.length === 0) || (op === "show" && args.length === 1 && isHubMemoryId(args[0])))
    )
      return "read";
    if (op === "add") return "single";
    if (head === "hub" && op === "rm") return "single";
    if (head === "hub" && (op === "adopt" || op === "restore")) return "destructive";
  }
  return "unknown";
}

/** Unknown syntax is deliberately confirmation-required, never implicitly read. */
export function needsConfirm(rawArgs: string): boolean {
  return classifyMemoryCommand(rawArgs) !== "read";
}

/** Strict Web-only syntax. The original text and spacing after the fixed prefix are retained. */
export interface MemoryWriteRequest {
  readonly kind: "session.add";
  readonly rawArgs: string;
  readonly text: string;
}
export function parseMemoryWriteRequest(
  rawArgs: string,
):
  | { ok: true; request: MemoryWriteRequest }
  | { ok: false; code: "E_MEM_WEB_UNSUPPORTED" | "E_MEM_ARGS"; message: string } {
  const trimmed = rawArgs.trim();
  const match = /^session add ([\s\S]+)$/.exec(trimmed);
  if (match?.[1] && match[1].trim()) return { ok: true, request: { kind: "session.add", rawArgs, text: match[1] } };
  if (trimmed === "session add" || trimmed.startsWith("session add "))
    return { ok: false, code: "E_MEM_ARGS", message: "session add 需要非空正文。" };
  return { ok: false, code: "E_MEM_WEB_UNSUPPORTED", message: "此 Web 记忆写入不受支持。" };
}
