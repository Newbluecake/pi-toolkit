/**
 * hub control-plane audit logging (plan §6.4, U7/D18, C3): a single structured log line per
 * request/rejection/late-result, written through a whitelisted field set so a message body,
 * steer text, ask_user answer/other text, question text or command args — or any hash of them —
 * can never reach `hub.log` even by accident (U7 "审计不记正文，也不记正文哈希"; only *lengths*
 * (`textLen`/`argsLen`, UTF-8 bytes) and *counts* (`answered`) are recorded). `hub/http.ts` is the
 * only writer of "reject"-phase lines (CSRF/auth/rate-limit failures before any `CmdFrame` is even
 * built); `hub/commands.ts`'s router writes "request"/"late" lines for everything that reaches it.
 */
export interface ControlAuditRecord {
  phase: "request" | "reject" | "late";
  reqId?: string;
  id?: string;
  op?: string;
  endpoint?: "cmd" | "dialog";
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  agentKey?: string;
  agentPid?: number;
  linkGen?: number;
  ok: boolean;
  code?: string | null;
  effect?: "none" | "unknown" | null;
  dup?: boolean;
  queryOnly?: boolean;
  ms?: number;
  /** UTF-8 byte length of the request's own free-text field (`prompt`/`steer_subagent`'s `text`);
   * never the text itself (U7). */
  textLen?: number | null;
  /** UTF-8 byte length of a `command` op's `args`; never `args` itself (U7). */
  argsLen?: number | null;
  deliver?: string | null;
  runId?: string | null;
  dialogId?: string | null;
  /** Answer *count*, never the answer text/labels (U7). */
  answered?: number | null;
  name?: string | null;
  kind?: string | null;
  confirmed?: boolean | null;
  sessionChanged?: boolean;
  /** v2.1 §4.9/§6.4: command-output size, never its content. */
  outputLen?: number | null;
  outputEntries?: number | null;
}

export function auditControl(log: { info(msg: string, data?: object): void }, record: ControlAuditRecord): void {
  log.info("control", { audit: "control", ...record });
}

export function auditAdmin(log: { info(msg: string, data?: object): void }, record: Record<string, unknown>): void {
  log.info("admin", { audit: "admin", ...record });
}
