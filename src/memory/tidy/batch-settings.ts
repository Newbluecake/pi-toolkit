/**
 * Frozen, pi-free settings surface for `/mem tidy --batch` (§11).
 *
 * The settings adapter in `config/settings.ts` is intentionally deferred to
 * P4. Until then callers use `DEFAULT_TIDY_BATCH_SETTINGS`; this module only
 * owns the data contract and its tolerant parser.
 */

export interface TidyBatchSettings {
  enabled: boolean;
  targetBytes: number;
  maxModelRuns: number;
  maxTotalCostUsd: number;
  totalTimeoutMs: number;
  outputTokPerSec: number;
}

export const DEFAULT_TIDY_MAX_INPUT_BYTES = 49_152;

export const DEFAULT_TIDY_BATCH_SETTINGS: Readonly<TidyBatchSettings> = Object.freeze({
  enabled: true,
  targetBytes: 32_768,
  maxModelRuns: 6,
  maxTotalCostUsd: 5,
  totalTimeoutMs: 2_700_000,
  outputTokPerSec: 40,
});

function finiteNumber(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

function safeInteger(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

/**
 * Parse the optional batch block field-by-field. `maxInputBytes` is supplied
 * by the owning memory settings parser in P4; the default keeps this module
 * useful and deterministic before that wiring exists.
 */
export function resolveTidyBatchSettings(
  input: unknown,
  maxInputBytes = DEFAULT_TIDY_MAX_INPUT_BYTES,
): TidyBatchSettings {
  const defaults = DEFAULT_TIDY_BATCH_SETTINGS;
  const inputCap =
    typeof maxInputBytes === "number" && Number.isSafeInteger(maxInputBytes) && maxInputBytes >= 8_192
      ? maxInputBytes
      : DEFAULT_TIDY_MAX_INPUT_BYTES;
  const targetDefault = Math.min(defaults.targetBytes, inputCap);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ...defaults, targetBytes: targetDefault };
  }
  const raw = input as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
    targetBytes: safeInteger(raw.targetBytes, 8_192, inputCap, targetDefault),
    maxModelRuns: safeInteger(raw.maxModelRuns, 1, 20, defaults.maxModelRuns),
    maxTotalCostUsd: finiteNumber(raw.maxTotalCostUsd, 0.1, 100, defaults.maxTotalCostUsd),
    totalTimeoutMs: safeInteger(raw.totalTimeoutMs, 300_000, 7_200_000, defaults.totalTimeoutMs),
    outputTokPerSec: finiteNumber(raw.outputTokPerSec, 5, 500, defaults.outputTokPerSec),
  };
}

/** Compile-time batch cap required by M-T7/G-maxfiles. */
export { BATCH_MAX_FILES, TIDY_MAX_FILES } from "../contracts.js";
