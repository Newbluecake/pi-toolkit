export interface AvailableModelEntry {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

/** Minimal structural surface shared by pi's ModelRegistry and test fakes. */
export interface ModelRegistryLike {
  getAvailable(): readonly AvailableModelEntry[];
}

/** pi's `ExtensionContext.scopedModels` element (ScopedModel) — only the ref matters here. */
export interface ScopedModelLike {
  model: AvailableModelEntry;
}

/** Copy just the prompt-entry fields, dropping everything else pi's Model carries. */
function pickEntry(model: AvailableModelEntry): AvailableModelEntry {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  };
}

/**
 * Session-scoped models (`--models` / `enabledModels`). Preferred prompt source:
 * it is the set the user actually cycles through, so it stays short enough to
 * list in full instead of being truncated away by MAX_PROMPT_MODELS. Empty when
 * no scoping is configured (pi's documented contract).
 */
export function readScopedModels(scoped: readonly ScopedModelLike[] | undefined): AvailableModelEntry[] {
  if (!scoped || scoped.length === 0) return [];
  return scoped.flatMap((entry) => (entry?.model ? [pickEntry(entry.model)] : []));
}

/**
 * Models the extension may **recommend** (quota alternatives): the session scope
 * (`--models` / `enabledModels`, i.e. what `/models` shows) when one is configured,
 * intersected with the usable registry snapshot so a scoped-but-unauthenticated
 * entry never gets suggested; scope order wins (it is the user's own ranking).
 * No scope configured ⇒ the full usable snapshot (pi's documented "unscoped"
 * contract). Pure — the caller supplies both lists.
 */
export function recommendableModels(
  scoped: readonly AvailableModelEntry[],
  available: readonly AvailableModelEntry[],
): AvailableModelEntry[] {
  if (scoped.length === 0) return [...available];
  const usable = new Map(available.map((m) => [`${m.provider}/${m.id}`, m]));
  const seen = new Set<string>();
  const out: AvailableModelEntry[] = [];
  for (const m of scoped) {
    const ref = `${m.provider}/${m.id}`;
    const hit = usable.get(ref);
    if (hit === undefined || seen.has(ref)) continue;
    seen.add(ref);
    out.push(hit);
  }
  return out;
}

/**
 * Copy a registry snapshot into prompt-entry shape. Kept synchronous and
 * fail-open: before_agent_start is a prompt-decoration path, so a registry
 * hiccup must degrade to "no models section" rather than break the turn.
 */
export function availableModelsFromRegistry(registry: ModelRegistryLike | undefined): AvailableModelEntry[] {
  if (!registry || typeof registry.getAvailable !== "function") return [];
  try {
    return registry.getAvailable().map(pickEntry);
  } catch {
    return [];
  }
}

const MAX_PROMPT_MODELS = 30;

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) return `${contextWindow / 1_000_000}M`;
  if (contextWindow >= 1_000) return `${contextWindow / 1_000}k`;
  return String(contextWindow);
}

export function formatAvailableModelsForPrompt(models: readonly AvailableModelEntry[]): string {
  const seen = new Set<string>();
  const unique: AvailableModelEntry[] = [];
  for (const model of models) {
    const ref = `${model.provider}/${model.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    unique.push(model);
  }
  if (unique.length === 0) return "";

  const visible = unique.slice(0, MAX_PROMPT_MODELS);
  const lines = visible.map((model) => {
    const ref = `${model.provider}/${model.id}`;
    const name = model.name ? ` — ${model.name}` : "";
    const annotations = [
      model.contextWindow === undefined ? undefined : `ctx ${formatContextWindow(model.contextWindow)}`,
      model.reasoning === true ? "reasoning" : undefined,
    ].filter((annotation): annotation is string => annotation !== undefined);
    return `- ${ref}${name}${annotations.length > 0 ? ` (${annotations.join(", ")})` : ""}`;
  });
  const remaining = unique.length - visible.length;
  if (remaining > 0) lines.push(`- ... and ${remaining} more`);

  return [
    "## Available models (pi-subagent)",
    "`set_model` and `Agent` require the FULL `provider/id` exactly as written below — the provider prefix is " +
      "mandatory and a bare model id may be rejected. Copy one of these values verbatim:",
    ...lines,
  ].join("\n");
}

export function appendAvailableModelsToSystemPrompt(
  systemPrompt: string,
  models: readonly AvailableModelEntry[],
): string {
  const section = formatAvailableModelsForPrompt(models);
  return section ? `${systemPrompt}\n\n${section}` : systemPrompt;
}

/**
 * Priority used for the "Available models" prompt section (sysprompt-stable
 * plan.md §4.6): session-scoped models first (the set the user actually
 * cycles through), then the session stack's model port (`holder.current`,
 * only populated post `session_start`), then a fresh registry snapshot.
 * `stackAvailable` is the already-evaluated array (or `undefined` before the
 * stack exists) — callers resolve `ctx.scopedModels` / `ctx.modelRegistry`
 * themselves (property access on the live ExtensionContext can throw, and
 * that has to happen at the call site, not inside this pure function).
 */
export function resolvePromptModels(
  scoped: readonly ScopedModelLike[] | undefined,
  stackAvailable: readonly AvailableModelEntry[] | undefined,
  registry: ModelRegistryLike | undefined,
): AvailableModelEntry[] {
  const scopedEntries = readScopedModels(scoped);
  if (scopedEntries.length > 0) return scopedEntries;
  return [...(stackAvailable ?? availableModelsFromRegistry(registry))];
}

/** Structural slice of pi's ModelRegistry the strict-model admission check needs. */
export interface ModelLookupLike {
  find?: (provider: string, id: string) => unknown;
  getAll?: () => readonly unknown[];
  getAvailable?: () => readonly unknown[];
}

/**
 * Strict `provider/id` existence check for spawn admission — the same exact
 * `find` PiSessionDriver's create() resolves through, done before a run
 * exists. Tri-state and fail-open: `true` known, `false` definitely unknown,
 * `undefined` when the registry is missing, throws, or knows no models at all
 * (not loaded / a stub) — admission must never block on an unusable registry.
 */
export function registryModelExists(
  registry: ModelLookupLike | undefined,
  ref: { provider: string; id: string },
): boolean | undefined {
  try {
    if (!registry || typeof registry.find !== "function") return undefined;
    if (registry.find(ref.provider, ref.id) !== undefined) return true;
    const known =
      typeof registry.getAll === "function"
        ? registry.getAll()
        : typeof registry.getAvailable === "function"
          ? registry.getAvailable()
          : [];
    return Array.isArray(known) && known.length > 0 ? false : undefined;
  } catch {
    return undefined;
  }
}
