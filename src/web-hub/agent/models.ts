import * as piAi from "@earendil-works/pi-ai";
import type { AvailableModelEntry, ScopedModelLike } from "../../config/available-models.js";
import { readScopedModels } from "../../config/available-models.js";
import type { SessionModelsWire, ModelOptionWire } from "../protocol/messages.js";
import {
  MODEL_NAME_MAX_BYTES,
  MODELS_WIRE_BUDGET_BYTES,
  MODELS_WIRE_MAX_ITEMS,
  isValidModelId,
  isValidProvider,
  sanitizeModelName,
  truncateUtf8,
  utf8Bytes,
} from "../protocol/models.js";
import {
  effectivePolicy,
  parameterizedBuiltinPolicy,
  type CommandPolicy,
  type PolicyDecision,
} from "./command-policy.js";

export interface ModelsInput {
  available: () => readonly AvailableModelEntry[];
  registryError: () => string | undefined;
  scoped: () => readonly ScopedModelLike[];
  current: () => unknown;
  policy?: (name: "model" | "thinking") => CommandPolicy | PolicyDecision;
  shadowed?: (name: "model" | "thinking") => boolean;
  now: () => number;
}

export function supportedLevels(model: unknown): string[] | undefined {
  if (model === null || typeof model !== "object") return undefined;
  const getter = (piAi as unknown as { getSupportedThinkingLevels?: (value: unknown) => unknown })
    .getSupportedThinkingLevels;
  if (typeof getter !== "function") return undefined;
  try {
    const levels = getter(model);
    if (!Array.isArray(levels)) return undefined;
    const out = levels.filter((level): level is string => typeof level === "string").slice(0, 16);
    return out;
  } catch {
    return undefined;
  }
}

function bytes(wire: SessionModelsWire): number {
  return utf8Bytes(JSON.stringify(wire));
}

function option(model: AvailableModelEntry, scoped: boolean): ModelOptionWire | undefined {
  if (!isValidProvider(model.provider) || !isValidModelId(model.id)) return undefined;
  const result: ModelOptionWire = { provider: model.provider, id: model.id };
  const name = sanitizeModelName(model.name, model.id);
  if (name !== undefined) result.name = name;
  if (Number.isFinite(model.contextWindow) && model.contextWindow !== undefined && model.contextWindow >= 0) {
    result.ctx = Math.floor(model.contextWindow);
  }
  if (model.reasoning === true) result.reasoning = true;
  if (scoped) result.scoped = true;
  return result;
}

function defaultPolicy(input: ModelsInput, name: "model" | "thinking"): CommandPolicy {
  if (input.shadowed?.(name) === true) return "deny";
  const value = input.policy?.(name) ?? parameterizedBuiltinPolicy(name);
  return typeof value === "string" ? value : effectivePolicy(value, false);
}

export function __shrinkStepForTest(wire: SessionModelsWire): { changed: boolean; bytes: number } {
  for (let index = wire.items.length - 1; index >= 0; index -= 1) {
    const item = wire.items[index];
    if (item?.name !== undefined) {
      delete item.name;
      return { changed: true, bytes: bytes(wire) };
    }
  }
  if (wire.items.length > 0) {
    wire.items.pop();
    wire.omitted = (wire.omitted ?? 0) + 1;
    return { changed: true, bytes: bytes(wire) };
  }
  return { changed: false, bytes: bytes(wire) };
}

function fitBudget(wire: SessionModelsWire): void {
  while (wire.items.length > 0 && bytes(wire) > MODELS_WIRE_BUDGET_BYTES) {
    __shrinkStepForTest(wire);
  }
  if (wire.omitted === 0) delete wire.omitted;
}

export function projectModels(input: ModelsInput): SessionModelsWire {
  let failed = false;
  let available: readonly AvailableModelEntry[] = [];
  let scoped: readonly ScopedModelLike[] = [];
  try {
    const value = input.available();
    available = Array.isArray(value) ? value : [];
  } catch {
    failed = true;
  }
  try {
    const value = input.scoped();
    scoped = Array.isArray(value) ? value : [];
  } catch {
    failed = true;
  }

  const scopedEntries = readScopedModels(scoped);
  const scopedModels: AvailableModelEntry[] = [];
  if (scopedEntries.length > 0) {
    const availableByRef = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
    const scopedSeen = new Set<string>();
    for (const model of scopedEntries) {
      const ref = `${model.provider}/${model.id}`;
      const availableModel = availableByRef.get(ref);
      if (availableModel !== undefined && !scopedSeen.has(ref)) {
        scopedSeen.add(ref);
        scopedModels.push(availableModel);
      }
    }
  }
  const scopedRefs = new Set(scopedModels.map((model) => `${model.provider}/${model.id}`));
  const candidates = [
    ...scopedModels,
    ...available.filter((model) => !scopedRefs.has(`${model.provider}/${model.id}`)),
  ];
  const seen = new Set<string>();
  const items: ModelOptionWire[] = [];
  let invalid = 0;
  for (const model of candidates) {
    const ref = `${model.provider}/${model.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const projected = option(model, scopedRefs.has(ref));
    if (projected === undefined) invalid += 1;
    else items.push(projected);
  }

  try {
    if (input.registryError() !== undefined) failed = true;
  } catch {
    failed = true;
  }
  const wire: SessionModelsWire = {
    status: failed ? "error" : items.length === 0 ? "empty" : "ok",
    items: items.slice(0, MODELS_WIRE_MAX_ITEMS),
    total: items.length,
    policy: { model: defaultPolicy(input, "model"), thinking: defaultPolicy(input, "thinking") },
    sampledAt: input.now(),
  };
  const omitted = Math.max(0, items.length - wire.items.length);
  if (omitted > 0) wire.omitted = omitted;
  if (invalid > 0) wire.invalid = invalid;
  if (scopedModels.length > 0) wire.scoped = true;
  const levels = supportedLevels(input.current());
  if (levels !== undefined) wire.levels = levels;
  const shadowed: { model?: true; thinking?: true } = {};
  if (input.shadowed?.("model") === true) shadowed.model = true;
  if (input.shadowed?.("thinking") === true) shadowed.thinking = true;
  if (shadowed.model === true || shadowed.thinking === true) wire.shadowed = shadowed;
  fitBudget(wire);
  return wire;
}

export function modelsFingerprint(wire: SessionModelsWire): string {
  const { sampledAt: _sampledAt, ...stable } = wire;
  return JSON.stringify(stable);
}

export { MODEL_NAME_MAX_BYTES, truncateUtf8 };
