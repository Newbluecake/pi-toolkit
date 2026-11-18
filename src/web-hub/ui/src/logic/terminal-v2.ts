import {
  TERMINAL_V2_LIMITS,
  TERMINAL_V2_UI_SCHEMAS,
  normalizeTerminalNameV2,
  terminalBase64BytesV2,
  terminalCwdV2Ok,
  terminalSchemaCheck,
  type TerminalHttpRequestsV2,
  type TerminalHttpResponseV2,
  type TerminalQuotaV2,
  type TerminalScopeV2,
  type TerminalTabsV2,
  type TerminalViewFrameV2,
} from "../components/terminal/protocol-v2.js";

export type TerminalJsonOpV2 = Exclude<keyof TerminalHttpRequestsV2, "view">;

function jsonBytesOk(raw: unknown, newline = false): boolean {
  try {
    const json = JSON.stringify(raw);
    return (
      json !== undefined &&
      new TextEncoder().encode(json + (newline ? "\n" : "")).byteLength <= TERMINAL_V2_LIMITS.frameBytes
    );
  } catch {
    return false;
  }
}

export function terminalTabsValueV2Ok(raw: TerminalTabsV2): boolean {
  return (
    raw.rows.every((row) => normalizeTerminalNameV2(row.name) === row.name) &&
    new Set(raw.rows.map((row) => row.termId)).size === raw.rows.length &&
    Object.values(raw.quota).every((dimension) => dimension.unknown <= dimension.used)
  );
}

/** Browser-side structural + semantic validation; it never infers readiness or physical state. */
export function terminalRequestV2Ok<K extends keyof TerminalHttpRequestsV2>(
  op: K,
  raw: unknown,
): raw is TerminalHttpRequestsV2[K] {
  if (!jsonBytesOk(raw) || !terminalSchemaCheck(TERMINAL_V2_UI_SCHEMAS.requests[op], raw)) return false;
  const value = raw as Record<string, unknown>;
  if (op === "rename") return typeof value.name === "string" && normalizeTerminalNameV2(value.name) !== undefined;
  if (op === "input" && value.queryOnly !== true) {
    const size = terminalBase64BytesV2(String(value.bytesB64));
    return size !== undefined && size <= TERMINAL_V2_LIMITS.inputBytes;
  }
  return true;
}

export function terminalResponseV2Ok<K extends TerminalJsonOpV2>(
  op: K,
  raw: unknown,
): raw is TerminalHttpResponseV2<K> {
  if (!jsonBytesOk(raw) || !raw || typeof raw !== "object" || !("ok" in raw)) return false;
  if (raw.ok === false) return terminalSchemaCheck(TERMINAL_V2_UI_SCHEMAS.failure, raw);
  if (raw.ok !== true || !terminalSchemaCheck(TERMINAL_V2_UI_SCHEMAS.results[op], raw)) return false;
  if (op === "list" && !terminalTabsValueV2Ok(raw as TerminalHttpResponseV2<"list"> & { ok: true })) return false;
  if (op === "rename") {
    const result = raw as TerminalHttpResponseV2<"rename"> & { ok: true };
    return normalizeTerminalNameV2(result.row.name) === result.row.name;
  }
  return true;
}

export function terminalViewFrameValueV2Ok(raw: unknown): raw is TerminalViewFrameV2 {
  if (!jsonBytesOk(raw, true) || !terminalSchemaCheck(TERMINAL_V2_UI_SCHEMAS.frame, raw)) return false;
  const frame = raw as TerminalViewFrameV2;
  if (frame.t === "output") {
    const size = terminalBase64BytesV2(frame.bytesB64);
    return (
      size !== undefined && size <= TERMINAL_V2_LIMITS.outputChunkBytes && Number.isSafeInteger(frame.offset + size)
    );
  }
  if (frame.t === "gap") return frame.from < frame.to && Number.isSafeInteger(frame.to);
  if (frame.t === "attached") {
    return (
      frame.start <= frame.end &&
      frame.end - frame.start <= TERMINAL_V2_LIMITS.replayBytes &&
      (!frame.metadata || terminalCwdV2Ok(frame.metadata.cwd))
    );
  }
  if (frame.t === "tabs") return terminalTabsValueV2Ok(frame);
  return true;
}

/** All three physical dimensions must have room. Unknown allocations remain included in used. */
export function terminalCanCreateV2(quota: TerminalQuotaV2 | undefined): boolean {
  return !!quota && Object.values(quota).every((dimension) => dimension.used < dimension.limit);
}

export interface TerminalRestoreV2 {
  open: boolean;
  hubInstance: string | null;
  activeTermId: string | null;
  pendingRequestIds: string[];
}

interface StoredScopeV2 extends TerminalRestoreV2 {
  agentKey: string;
  sessionId: string;
  epoch: string;
  savedAt: number;
}

export interface TerminalRestoreStorageV2 {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const TERMINAL_V2_RESTORE_KEY = "pwh_terminal_v2_restore";
export const TERMINAL_V2_RESTORE_MS = 600_000;
const idOk = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(value);
const nullableIdOk = (value: unknown): value is string | null => value === null || idOk(value);

const storedKeys = new Set([
  "agentKey",
  "sessionId",
  "epoch",
  "open",
  "hubInstance",
  "activeTermId",
  "pendingRequestIds",
  "savedAt",
]);
const scopeKeyOk = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function parseStored(raw: string | null, now: number): StoredScopeV2[] {
  if (raw === null || raw.length > 65_536) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.slice(0, 32).filter((entry): entry is StoredScopeV2 => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const row = entry as Record<string, unknown>;
      return (
        Object.keys(row).every((key) => storedKeys.has(key)) &&
        scopeKeyOk(row.agentKey) &&
        scopeKeyOk(row.sessionId) &&
        scopeKeyOk(row.epoch) &&
        typeof row.open === "boolean" &&
        nullableIdOk(row.hubInstance) &&
        nullableIdOk(row.activeTermId) &&
        Array.isArray(row.pendingRequestIds) &&
        row.pendingRequestIds.length <= 64 &&
        row.pendingRequestIds.every(idOk) &&
        typeof row.savedAt === "number" &&
        Number.isSafeInteger(row.savedAt) &&
        row.savedAt <= now &&
        now - row.savedAt <= TERMINAL_V2_RESTORE_MS
      );
    });
  } catch {
    return [];
  }
}

function sameScope(entry: StoredScopeV2, scope: TerminalScopeV2): boolean {
  return entry.agentKey === scope.agentKey && entry.sessionId === scope.sessionId && entry.epoch === scope.epoch;
}

/** Read-only restore data. It contains no title, cwd, cookie, token, output or environment. */
export function loadTerminalV2Restore(
  storage: TerminalRestoreStorageV2 | undefined,
  scope: TerminalScopeV2,
  now = Date.now(),
): TerminalRestoreV2 | undefined {
  if (!storage) return undefined;
  try {
    const entry = parseStored(storage.getItem(TERMINAL_V2_RESTORE_KEY), now).find((row) => sameScope(row, scope));
    if (!entry) return undefined;
    return {
      open: entry.open,
      hubInstance: entry.hubInstance,
      activeTermId: entry.activeTermId,
      pendingRequestIds: [...entry.pendingRequestIds],
    };
  } catch {
    return undefined;
  }
}

/** Bounded best-effort session persistence, called only after an explicit UI action. */
export function saveTerminalV2Restore(
  storage: TerminalRestoreStorageV2 | undefined,
  scope: TerminalScopeV2,
  restore: TerminalRestoreV2,
  now = Date.now(),
): void {
  if (!storage) return;
  try {
    const rows = parseStored(storage.getItem(TERMINAL_V2_RESTORE_KEY), now).filter((row) => !sameScope(row, scope));
    rows.unshift({ ...scope, ...restore, pendingRequestIds: [...restore.pendingRequestIds], savedAt: now });
    storage.setItem(TERMINAL_V2_RESTORE_KEY, JSON.stringify(rows.slice(0, 32)));
  } catch {
    // Storage is a convenience, never evidence that a shell was or was not created.
  }
}
