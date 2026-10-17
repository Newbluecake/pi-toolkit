// Diagnostic strings are generated locally; never print an arbitrary Error.message.
export type FailureKind =
  | "unreachable"
  | "timeout"
  | "credential"
  | "protocol"
  | "local-io"
  | "interrupted"
  | "ws-handshake-failed"
  | `http-${number}`
  | `api-code-${number}`;
export class ProbeError extends Error {
  kind: FailureKind;
  check?: string;
  retryable: boolean;
  scopes: string[] = [];
  constructor(kind: FailureKind, check?: string, retryable = false) {
    super(check ? `${kind}:${check}` : kind);
    this.kind = kind;
    this.check = check;
    this.retryable = retryable;
  }
}
export function failureInfo(error: unknown): { reason: FailureKind; check?: string; scopes?: string[] } {
  if (error instanceof ProbeError)
    return {
      reason: error.kind,
      ...(error.check ? { check: error.check } : {}),
      ...(error.scopes.length ? { scopes: error.scopes } : {}),
    };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(code ?? ""))
    return {
      reason: "credential",
      check: code === "ENOENT" ? "file-missing" : code === "ELOOP" ? "file-symlink" : "file-permission",
    };
  return { reason: "local-io" };
}
// Fixed scope namespaces + a restricted grammar, not arbitrary msg words/URLs.
// Examples: im:resource, im:message.reactions:write_only, contact:user.id:readonly.
export function missingScopes(message: unknown, secrets: readonly string[] = []): string[] {
  if (typeof message !== "string") return [];
  const found =
    message.match(
      /(?<![a-zA-Z0-9_.:/-])(?:im|contact|drive|docs|docx|bitable|application|cardkit|event|auth):[a-z_]+(?:[.:][a-z_]+)*(?![a-zA-Z0-9_.:/-])/g,
    ) ?? [];
  return [...new Set(found)]
    .filter(
      (scope) =>
        scope.length <= 120 &&
        !/secret|token|device_code|open_id/.test(scope) &&
        !secrets.some((s) => s && scope.includes(s)),
    )
    .slice(0, 16);
}
export function apiFailure(status: number, body: any, secrets: readonly string[] = []): ProbeError {
  const error =
    typeof body?.code === "number" && body.code !== 0
      ? new ProbeError(`api-code-${body.code}`)
      : status < 200 || status >= 300
        ? new ProbeError(`http-${status}`)
        : new ProbeError("protocol", "invalid-api-response");
  error.scopes = missingScopes(body?.msg, secrets);
  return error;
}

export function transportFailure(error: unknown, interrupted: boolean, timedOut: boolean): ProbeError {
  if (interrupted) return new ProbeError("interrupted");
  if (error instanceof ProbeError) return error;
  return new ProbeError(timedOut ? "timeout" : "unreachable", undefined, true);
}
