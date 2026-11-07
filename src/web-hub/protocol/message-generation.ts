/** Shared, fail-closed generation contract. No SDK or runtime dependencies. */
export interface GenerationCore {
  v: 1;
  tokens: number;
  genMs: number;
  deltaCount: number;
}
export interface GenerationMetadata extends GenerationCore {
  mid: string;
}
export const WEB_MESSAGE_SPEED_ENTRY_TYPE = "subagent:web-msg-speed";
export const GENERATION_HISTORY_CAP = 512;

/** Own data only: accessors, inherited properties and throwing Proxy traps are unknown. */
export function generationOwnData(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d !== undefined && Object.hasOwn(d, "value") ? d.value : undefined;
  } catch {
    return undefined;
  }
}
export function isGenerationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
export function sanitizeGenerationCore(value: unknown): GenerationCore | undefined {
  const v = generationOwnData(value, "v");
  const tokens = generationOwnData(value, "tokens");
  const genMs = generationOwnData(value, "genMs");
  const deltaCount = generationOwnData(value, "deltaCount");
  if (
    v !== 1 ||
    typeof tokens !== "number" ||
    !Number.isSafeInteger(tokens) ||
    tokens < 1 ||
    tokens > 10_000_000 ||
    typeof genMs !== "number" ||
    !Number.isFinite(genMs) ||
    genMs < 500 ||
    genMs > 86_400_000 ||
    typeof deltaCount !== "number" ||
    !Number.isSafeInteger(deltaCount) ||
    deltaCount < 2 ||
    deltaCount > 1_000_000
  )
    return undefined;
  const ratio = (tokens * 1000) / genMs;
  return Number.isFinite(ratio) && ratio > 0 ? { v: 1, tokens, genMs, deltaCount } : undefined;
}
export function sanitizeGenerationMetadata(value: unknown): GenerationMetadata | undefined {
  const core = sanitizeGenerationCore(value);
  const mid = generationOwnData(value, "mid");
  return core !== undefined && isGenerationId(mid) ? { ...core, mid } : undefined;
}

/** Rebuilt from exactly the loaded wire entries. Never caches across replace/remove/branches. */
export function generationHistoryIndex(entries: readonly unknown[]): Map<string, GenerationCore> {
  const assistants = new Set<string>();
  for (const entry of entries) {
    const id = generationOwnData(entry, "id");
    if (
      generationOwnData(entry, "type") === "message" &&
      generationOwnData(generationOwnData(entry, "message"), "role") === "assistant" &&
      isGenerationId(id)
    )
      assistants.add(id);
  }
  const index = new Map<string, GenerationCore>();
  for (const entry of entries) {
    if (
      generationOwnData(entry, "type") !== "custom" ||
      generationOwnData(entry, "customType") !== WEB_MESSAGE_SPEED_ENTRY_TYPE
    )
      continue;
    const metadata = sanitizeGenerationMetadata(generationOwnData(entry, "piToolkitGeneration"));
    if (metadata === undefined || !assistants.has(metadata.mid)) continue;
    const core = sanitizeGenerationCore(metadata)!;
    index.delete(metadata.mid); // last legal metadata wins, including cap order
    index.set(metadata.mid, core);
    if (index.size > GENERATION_HISTORY_CAP) index.delete(index.keys().next().value!);
  }
  return index;
}
