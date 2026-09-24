/** Pure state machine for a dynamic system-prompt section. */
export const SKIP: unique symbol = Symbol.for("pi-subagent:prompt-section-skip") as never;
export const POINTED: unique symbol = Symbol.for("pi-subagent:prompt-section-pointed") as never;

export type SectionName = "pi_project_memory" | "pi_subagent_types" | "pi_subagent_models";
export type Live = string | typeof SKIP;
export const UPDATE_LIMITS = { maxCount: 3, maxBytes: 32 * 1024 } as const;

export interface SectionState {
  snapshot: string | undefined;
  announced: string | typeof POINTED | undefined;
  stale: boolean;
  sentCount: number;
  sentBytes: number;
}

export const initialSectionState = (): SectionState => ({
  snapshot: undefined,
  announced: undefined,
  stale: true,
  sentCount: 0,
  sentBytes: 0,
});

export const markStale = (state: SectionState): SectionState => ({ ...state, stale: true });
export const forgetAnnounced = (state: SectionState): SectionState => ({ ...state, announced: state.snapshot });

export type SectionUpdate = { kind: "update"; content: string } | { kind: "removed" } | { kind: "pointer" };

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function refresh(state: SectionState, live: Live): SectionState {
  if (live === SKIP) return state;
  return { snapshot: live, announced: live, stale: false, sentCount: 0, sentBytes: 0 };
}

export function resolveAtTurn(
  state: SectionState,
  live: Live,
  limits: { maxCount: number; maxBytes: number } = UPDATE_LIMITS,
): { state: SectionState; text: string; update?: SectionUpdate } {
  if (state.stale || state.snapshot === undefined) {
    const next = refresh(state, live);
    return { state: next, text: next.snapshot ?? "" };
  }
  if (live === SKIP || live === state.announced || state.announced === POINTED) {
    return { state, text: state.snapshot };
  }
  if (live === "") {
    return {
      state: { ...state, announced: "", sentCount: state.sentCount + 1 },
      text: state.snapshot,
      update: { kind: "removed" },
    };
  }
  const size = bytes(live);
  if (state.sentCount + 1 > limits.maxCount || state.sentBytes + size > limits.maxBytes) {
    return { state: { ...state, announced: POINTED }, text: state.snapshot, update: { kind: "pointer" } };
  }
  return {
    state: { ...state, announced: live, sentCount: state.sentCount + 1, sentBytes: state.sentBytes + size },
    text: state.snapshot,
    update: { kind: "update", content: live },
  };
}

export function resolveAtSeed(state: SectionState, live: () => Live): { state: SectionState; text: string } {
  const next = state.stale || state.snapshot === undefined ? refresh(state, live()) : state;
  return { state: next, text: next.snapshot ?? "" };
}
