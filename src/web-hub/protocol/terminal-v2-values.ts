/** T51 pure browser/server value rules. Zero imports/IO; no second wire schema. */
export const TERMINAL_V2_LIMITS = Object.freeze({
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  hardTotal: 32,
  inputIdleMs: 3_600_000,
  maxLifetimeMs: 28_800_000,
  ringBytes: 1_048_576,
  replayBytes: 16_384,
  outputChunkBytes: 8192,
  inputBytes: 4096,
  frameBytes: 24_576,
  viewPendingBytes: 65_536,
  viewPendingItems: 128,
  viewSerializedBytes: 131_072,
  inputPendingBytes: 32_768,
  hubRateBytes: 524_288,
  viewRateBytes: 131_072,
  replayRateBytes: 131_072,
  viewerMs: 2000,
  pingMs: 5000,
  writerIdleMs: 15_000,
  authRecheckMs: 55_000,
  heartbeatMs: 5000,
  helperSilenceMs: 15_000,
  httpMs: 5000,
  contextMs: 2000,
  contextFlights: 32,
  backendMs: 3000,
  reapMs: 5000,
  reapRetryMs: 60_000,
  intentsTotal: 2048,
  intentsPerScope: 64,
  intentTerminalMs: 600_000,
  inputResults: 64,
  scopeRows: 32,
  ledgerBytes: 65_536,
  cwdBytes: 8192,
  authSelectors: 2048,
  archiveTransactions: 64,
  archiveBytes: 16_777_216,
});
export function terminalCwdV2Ok(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    utf8Bytes(value) <= TERMINAL_V2_LIMITS.cwdBytes
  );
}
/** Normalize only user rename input; stored rows must already equal this result. */
export function normalizeTerminalNameV2(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) &&
    [...trimmed].length <= 24 &&
    utf8Bytes(trimmed) <= 96
    ? trimmed
    : undefined;
}
export function terminalBase64BytesV2(s: string): number | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return undefined;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  if (padding && (alphabet.indexOf(s[s.length - padding - 1]!) & (padding === 2 ? 15 : 3)) !== 0) return undefined;
  return (s.length / 4) * 3 - padding;
}
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}
