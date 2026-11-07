/** #39 P4a2 feature-local coordinator. Factory only: no real hook/registration.
 * One WeakMap key is the SAME SectionProviderInput passed sequentially by the
 * hub. Views, own gates and owner are captured once; ctx/text are NOT turn keys.
 * Source/body caching belongs to inject.ts, not this projection cache.
 */
import type {
  SectionProviderInput,
  SectionRegistration,
  PromptSectionHub,
  SystemPromptMode,
} from "../sysprompt/hub.js";
import {
  initialSectionState,
  markStale,
  resolveAtSeed,
  resolveAtTurn,
  SKIP,
  type Live,
  type SectionName,
  type SectionState,
  type SectionUpdate,
} from "../prompt-sections/stable-section.js";
import { createSessionMemorySection } from "./scopes/session-section.js";
import { createHubMemorySection } from "./scopes/hub-section.js";
import type { SessionMemoryView, HubMemoryView, MemoryOwner } from "./scopes/types.js";
import { SESSION_MEMORY_RENDER_MAX_BYTES, HUB_MEMORY_RENDER_MAX_BYTES } from "./scopes/types.js";
import {
  planThreeLayerDuplicates,
  type ThreeLayerDuplicateCandidate,
  type ThreeLayerDuplicatePlan,
} from "./scopes/render.js";
import {
  legalProjectionAnchor,
  PROJECT_ENTRY_RESERVE,
  projectSourceText,
  type ProjectSource,
} from "./scoped-project-view.js";

export interface ScopedProjectionDeps {
  readonly enabled: () => boolean;
  readonly owner: () => MemoryOwner | undefined;
  readonly mode: () => SystemPromptMode;
  readonly state: Pick<PromptSectionHub, "_state">;
  readonly session?: {
    readonly available: (input: SectionProviderInput) => boolean;
    readonly view: (input: SectionProviderInput) => SessionMemoryView;
    readonly renderBudgetBytes?: number;
  };
  readonly hub?: {
    readonly available: (input: SectionProviderInput) => boolean;
    readonly view: (input: SectionProviderInput) => HubMemoryView;
    readonly projectSlug?: (input: SectionProviderInput) => string;
    readonly renderBudgetBytes?: number;
  };
}
export const sameProjectionOwner = (a: MemoryOwner | undefined, b: MemoryOwner | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.incarnation === b.incarnation &&
  a.sid === b.sid &&
  a.sessionFile === b.sessionFile &&
  a.sessionEpoch === b.sessionEpoch &&
  a.branchGen === b.branchGen;

type Layer = "session" | "hub";
interface LayerCapture {
  readonly name: SectionName;
  readonly candidates: readonly ThreeLayerDuplicateCandidate[];
  readonly render: (plan?: ThreeLayerDuplicatePlan) => Live;
  readonly full: (plan?: ThreeLayerDuplicatePlan) => Live;
  readonly budget: number;
  readonly state: SectionState;
  plain: Live;
  live: Live;
  predicted?: TrackedProjection;
}
interface Invocation {
  readonly owner: MemoryOwner | undefined;
  readonly mode: SystemPromptMode;
  readonly layers: Partial<Record<Layer, LayerCapture>>;
  readonly available: boolean;
  readonly unsafe: Partial<Record<Layer, boolean>>;
  plan?: ThreeLayerDuplicatePlan;
  source?: ProjectSource;
  projectPrediction?: TrackedProjection;
}
export interface ScopedProjectProjection {
  isEnabled(): boolean;
  begin(input: SectionProviderInput): MemoryOwner | undefined;
  ownerValid(input: SectionProviderInput): boolean;
  project(input: SectionProviderInput, source: ProjectSource, transform?: (text: string) => string): string;
  needsProjectResample(input: SectionProviderInput): boolean;
  readonly sessionSection?: SectionRegistration;
  readonly hubSection?: SectionRegistration;
}

/** Only a REAL refresh/full update can attach current source metadata to a
 * snapshot/announcement. Equal render text is NOT evidence of equal authority
 * (notably when inline metadata is stripped). */
interface VisibleManifest {
  readonly text: string;
  readonly candidates: readonly ThreeLayerDuplicateCandidate[];
}
interface TrackedProjection {
  readonly state: SectionState;
  readonly snapshot?: VisibleManifest;
  readonly announced?: VisibleManifest;
}
const sameSectionState = (a: SectionState, b: SectionState): boolean =>
  a.snapshot === b.snapshot &&
  a.announced === b.announced &&
  a.stale === b.stale &&
  a.sentCount === b.sentCount &&
  a.sentBytes === b.sentBytes;

function predict(state: SectionState, live: Live, mode: SystemPromptMode, phase: SectionProviderInput["phase"]) {
  if (mode === "legacy")
    return {
      state,
      current: typeof live === "string",
      refresh: true,
      texts: typeof live === "string" && live !== "" ? [live] : [],
    };
  if (phase === undefined) return { state, current: false, refresh: false, texts: [] as string[] };
  const input = mode === "live" && phase === "turn" ? markStale(state) : state;
  const refresh = input.stale || input.snapshot === undefined;
  let sampled = false;
  const result: { state: SectionState; text: string; update?: SectionUpdate } =
    phase === "seed"
      ? resolveAtSeed(input, () => {
          sampled = true;
          return live;
        })
      : resolveAtTurn(input, live);
  const current = live !== SKIP && (phase === "seed" ? sampled : refresh || result.update?.kind === "update");
  const texts = new Set<string>();
  if (result.text !== "") texts.add(result.text);
  if (typeof result.state.announced === "string" && result.state.announced !== "") texts.add(result.state.announced);
  return { state: result.state, current, refresh, texts: [...texts] };
}
/** Accepted pure state-machine prediction; POINTED never delivers latest live. */
export function predictScopedVisibility(
  state: SectionState,
  live: Live,
  mode: SystemPromptMode,
  phase: SectionProviderInput["phase"],
): readonly string[] {
  return predict(state, live, mode, phase).texts;
}
const candidateKey = (c: ThreeLayerDuplicateCandidate): string => JSON.stringify([c.layer, c.id, c.authority, c.text]);
const visibleCandidates = (tracked: TrackedProjection): readonly ThreeLayerDuplicateCandidate[] => [
  ...(tracked.snapshot?.candidates ?? []),
  ...(tracked.announced?.candidates ?? []),
];

/** P4c assembly contract: register project -> session -> hub consecutively.
 * All three receive the SAME input synchronously (no await), with no external
 * mutating provider between them. Arbitrary same-process host JS changing owner
 * or hub state after project returns is outside the approved threat model; the
 * later providers still fail closed on an observed actual-state mismatch. */
export function createScopedProjection(deps: ScopedProjectionDeps): ScopedProjectProjection {
  const memo = new WeakMap<SectionProviderInput, Invocation>();
  // One source manifest per actual snapshot/announcement, bound to owner AND
  // predicted hub state. Never overwrite historical authority just because the
  // newest disk source happens to render to the same (possibly stripped) text.
  const tracked = new Map<SectionName, TrackedProjection>();
  let historyOwner: MemoryOwner | undefined;
  const trusted = (name: SectionName, state: SectionState): TrackedProjection | undefined => {
    const known = tracked.get(name);
    return known !== undefined && sameSectionState(known.state, state) ? known : undefined;
  };
  function projectionOf(
    name: SectionName,
    state: SectionState,
    live: Live,
    candidates: readonly ThreeLayerDuplicateCandidate[],
    input: SectionProviderInput,
    mode: SystemPromptMode,
  ): TrackedProjection {
    const result = predict(state, live, mode, input.phase);
    const previous = trusted(name, state);
    const current = typeof live === "string" && result.current ? { text: live, candidates } : undefined;
    if (mode === "legacy")
      return { state: result.state, ...(current === undefined ? {} : { snapshot: current, announced: current }) };
    const snapshot = result.refresh && current !== undefined ? current : previous?.snapshot;
    const announced = current !== undefined ? current : previous?.announced;
    return {
      state: result.state,
      ...(snapshot !== undefined && snapshot.text === result.state.snapshot ? { snapshot } : {}),
      ...(announced !== undefined && announced.text === result.state.announced ? { announced } : {}),
    };
  }
  function capture(input: SectionProviderInput): Invocation {
    const hit = memo.get(input);
    if (hit !== undefined) return hit;
    const owner = deps.owner();
    const before = owner === undefined ? undefined : { ...owner };
    const enabled = deps.enabled();
    const mode = deps.mode();
    const layers: Invocation["layers"] = {};
    const unsafe: Invocation["unsafe"] = {};
    if (!sameProjectionOwner(before, historyOwner)) {
      tracked.clear();
      historyOwner = before;
    }
    if (enabled && before !== undefined) {
      if (deps.session !== undefined) unsafe.session = !deps.session.available(input);
      if (deps.session !== undefined && !unsafe.session) {
        try {
          const view = structuredClone(deps.session.view(input));
          const candidates = view.items
            .map(({ item }) => ({
              layer: "session" as const,
              id: item.id,
              authority: item.authority,
              text: item.text,
              visibility: "full" as const,
            }))
            .filter(legalProjectionAnchor);
          const budget = deps.session.renderBudgetBytes ?? SESSION_MEMORY_RENDER_MAX_BYTES;
          const render = (budget: number, plan?: ThreeLayerDuplicatePlan): Live =>
            createSessionMemorySection({
              isLocked: () => false,
              view: () => view,
              renderBudgetBytes: budget,
              ...(plan === undefined ? {} : { projection: () => plan }),
            })();
          layers.session = {
            name: "pi_session_memory",
            candidates,
            budget,
            state: deps.state._state("pi_session_memory") ?? initialSectionState(),
            plain: SKIP,
            live: SKIP,
            render: (plan) => render(budget, plan),
            full: (plan) => render(Number.MAX_SAFE_INTEGER, plan),
          };
        } catch {
          layers.session = {
            name: "pi_session_memory",
            candidates: [],
            budget: 0,
            state: deps.state._state("pi_session_memory") ?? initialSectionState(),
            plain: SKIP,
            live: SKIP,
            render: () => SKIP,
            full: () => SKIP,
          }; // read failure preserves its snapshot
        }
      }
      if (deps.hub !== undefined) unsafe.hub = !deps.hub.available(input);
      if (deps.hub !== undefined && !unsafe.hub) {
        try {
          const view = structuredClone(deps.hub.view(input));
          unsafe.hub = view.state === "disabled" || view.state === "inert";
          const slug = deps.hub.projectSlug?.(input) ?? "";
          const candidates =
            view.state !== "ok"
              ? []
              : view.items
                  .map((item) => ({
                    layer: "hub" as const,
                    id: item.id,
                    authority: item.authority,
                    text: item.text,
                    visibility: "full" as const,
                  }))
                  .filter(legalProjectionAnchor);
          const budget = deps.hub.renderBudgetBytes ?? HUB_MEMORY_RENDER_MAX_BYTES;
          const render = (budget: number, plan?: ThreeLayerDuplicatePlan): Live =>
            createHubMemorySection({
              isLocked: () => false,
              view: () => view,
              currentProjectSlug: () => slug,
              renderBudgetBytes: budget,
              ...(plan === undefined ? {} : { projection: () => plan }),
            })();
          layers.hub = {
            name: "pi_hub_memory",
            candidates,
            budget,
            state: deps.state._state("pi_hub_memory") ?? initialSectionState(),
            plain: SKIP,
            live: SKIP,
            render: (plan) => render(budget, plan),
            full: (plan) => render(Number.MAX_SAFE_INTEGER, plan),
          };
        } catch {
          layers.hub = {
            name: "pi_hub_memory",
            candidates: [],
            budget: 0,
            state: deps.state._state("pi_hub_memory") ?? initialSectionState(),
            plain: SKIP,
            live: SKIP,
            render: () => SKIP,
            full: () => SKIP,
          };
        }
      }
    }
    if (unsafe.hub) delete layers.hub;
    const available = enabled && sameProjectionOwner(before, deps.owner());
    const invocation: Invocation = {
      owner: before === undefined ? undefined : { ...before },
      mode,
      layers: available ? layers : {},
      available,
      unsafe,
    };
    memo.set(input, invocation);
    return invocation;
  }
  function valid(input: SectionProviderInput): boolean {
    const invocation = capture(input);
    return invocation.available && deps.enabled() && sameProjectionOwner(invocation.owner, deps.owner());
  }
  function prepare(
    input: SectionProviderInput,
    source?: ProjectSource,
    transform: (text: string) => string = (text) => text,
  ): Invocation {
    const invocation = capture(input);
    if (invocation.plan !== undefined) return invocation;
    const admitted: ThreeLayerDuplicateCandidate[] = [];
    let projectState: SectionState | undefined;
    if (valid(input)) {
      if (source !== undefined) {
        projectState = deps.state._state("pi_project_memory") ?? initialSectionState();
        admitted.push(
          ...visibleCandidates(
            projectionOf("pi_project_memory", projectState, transform(source.text), [], input, invocation.mode),
          ),
        );
        const probe = transform(source.text) + " ".repeat(source.reservedBytes);
        if (predict(projectState, probe, invocation.mode, input.phase).current) admitted.push(...source.entries);
      }
      for (const layer of Object.values(invocation.layers)) {
        const plain = layer.render();
        layer.plain = plain;
        admitted.push(...visibleCandidates(projectionOf(layer.name, layer.state, plain, [], input, invocation.mode)));
        if (typeof plain !== "string" || plain === "") continue;
        const bound = Buffer.byteLength(plain, "utf8") + layer.candidates.length * PROJECT_ENTRY_RESERVE;
        if (plain !== layer.full() || bound > layer.budget) continue;
        const probe = plain + " ".repeat(layer.candidates.length * PROJECT_ENTRY_RESERVE);
        if (predict(layer.state, probe, invocation.mode, input.phase).current) admitted.push(...layer.candidates);
      }
    }
    const unique = [...new Map(admitted.filter(legalProjectionAnchor).map((c) => [candidateKey(c), c])).values()];
    let plan = planThreeLayerDuplicates(unique);
    // Finalize once with the actual factory outputs. Only already-admitted
    // candidates can survive; no second admission or fixed-point rerender.
    const actual = new Set<string>();
    if (source !== undefined) {
      const live = transform(projectSourceText(source, plan));
      projectState = deps.state._state("pi_project_memory") ?? initialSectionState();
      invocation.projectPrediction = projectionOf(
        "pi_project_memory",
        projectState,
        live,
        source.entries,
        input,
        invocation.mode,
      );
      for (const c of visibleCandidates(invocation.projectPrediction)) actual.add(candidateKey(c));
    }
    for (const layer of Object.values(invocation.layers)) {
      const live = layer.render(plan);
      layer.live = live;
      const full = live === layer.full(plan) && typeof live === "string";
      layer.predicted = projectionOf(
        layer.name,
        layer.state,
        live,
        full ? layer.candidates : [],
        input,
        invocation.mode,
      );
      for (const c of visibleCandidates(layer.predicted)) actual.add(candidateKey(c));
    }
    if (!valid(input)) actual.clear();
    if (unique.some((c) => !actual.has(candidateKey(c)))) {
      // Prediction mismatch: fail closed, suppress annotations, never promote a
      // newly discovered winner. Reuse pre-rendered plain output, not a loop.
      const safe = plan.candidates.filter((c) => actual.has(candidateKey(c)));
      plan = { candidates: safe, markers: safe.map(() => undefined), markerMaxBytes: safe.map(() => 0) };
      for (const layer of Object.values(invocation.layers)) {
        layer.live = layer.plain;
        layer.predicted = projectionOf(
          layer.name,
          layer.state,
          layer.live,
          layer.live === layer.full() ? layer.candidates : [],
          input,
          invocation.mode,
        );
      }
      if (source !== undefined && projectState !== undefined)
        invocation.projectPrediction = projectionOf(
          "pi_project_memory",
          projectState,
          transform(source.text),
          source.entries,
          input,
          invocation.mode,
        );
    }
    invocation.plan = plan;
    if (source !== undefined) invocation.source = source;
    return invocation;
  }
  function registration(layer: Layer): SectionRegistration {
    const name = layer === "session" ? "pi_session_memory" : "pi_hub_memory";
    return {
      title: layer === "session" ? "Session memory" : "Hub memory",
      ...(layer === "session" ? { sessionScoped: true as const } : {}),
      pointerHint: "Use scoped_memory view to read current entries.",
      invalidateIf: (input) => !valid(input) || capture(input).unsafe[layer] === true,
      skipIf: (input) => !valid(input) || capture(input).unsafe[layer] === true,
      provider: (input) => {
        if (!valid(input)) return SKIP;
        const invocation = prepare(input);
        const captured = invocation.layers[layer];
        if (captured === undefined) return SKIP;
        // Detect interference with hub state between project prediction and the
        // actual provider. No DTO upgrades or fresh reads on a mismatch.
        const now = deps.state._state(name) ?? initialSectionState();
        if (!sameSectionState(now, captured.state)) return SKIP;
        if (captured.predicted !== undefined) tracked.set(name, captured.predicted);
        return captured.live;
      },
    };
  }
  return {
    isEnabled: deps.enabled,
    begin: (input) => capture(input).owner,
    ownerValid: valid,
    project: (input, source, transform = (text) => text) => {
      const invocation = prepare(input, source, transform);
      const text = transform(projectSourceText(source, valid(input) ? invocation.plan : undefined));
      if (valid(input) && invocation.projectPrediction !== undefined)
        tracked.set("pi_project_memory", invocation.projectPrediction);
      return text;
    },
    needsProjectResample: (input) => {
      if (!valid(input)) return false;
      const state = deps.state._state("pi_project_memory");
      return state?.snapshot !== undefined && trusted("pi_project_memory", state)?.snapshot === undefined;
    },
    ...(deps.session === undefined ? {} : { sessionSection: registration("session") }),
    ...(deps.hub === undefined ? {} : { hubSection: registration("hub") }),
  };
}
