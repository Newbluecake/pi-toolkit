// Scripted `ClassifierRegistryLike` fake for client.test.ts (jev-plan J2).
// Not pi-free-constrained (tests/ is outside the boundary glob), but kept
// dependency-free on purpose.

import type {
  ClassifierRegistryLike,
  FetchLike,
  JevAnswer,
  JsonObject,
  JevQuestion,
} from "../../../../src/memory/jev/contracts.js";

export interface ClassifyCallRecord {
  readonly id: string;
  readonly state: JsonObject;
  readonly questions: Record<string, JevQuestion>;
  readonly fetch: FetchLike | undefined;
  readonly signal: AbortSignal | undefined;
}

export type ClassifyResult =
  | { stopReason: "stop"; answers: Record<string, JevAnswer>; usage?: { input: number; cost?: { total: number } } }
  | { stopReason: "error"; errorMessage: string }
  | { stopReason: "aborted" };

export interface FakeRegistryOptions {
  /** `provider/id` strings `getAvailableOfType("classifier")` reports (has
   *  credentials, listed in catalog). */
  readonly available: readonly string[];
  /** `provider/id` strings NOT in the catalog at all (so `getModelOfType`
   *  returns `undefined` for them — distinct from merely lacking credits). */
  readonly notFound?: readonly string[];
  /** Per-id response queue: consumed in order; the last entry repeats once
   *  exhausted. A function receives the call record for dynamic scripting
   *  (e.g. aborting). Missing id ⇒ always succeeds trivially. */
  readonly responses?: Record<
    string,
    readonly (ClassifyResult | ((call: ClassifyCallRecord) => ClassifyResult | Promise<ClassifyResult>))[]
  >;
  readonly onGetAvailableOfType?: () => void;
  readonly onCall?: (record: ClassifyCallRecord) => void;
}

export interface FakeRegistryHandle {
  readonly registry: ClassifierRegistryLike;
  readonly calls: ClassifyCallRecord[];
  callCountFor(id: string): number;
}

function answerBool(q: JevQuestion): JevAnswer {
  if (q.type === "choice") {
    const firstKey = Object.keys(q.criteria)[0]!;
    return { type: "choice", choice: firstKey, probabilities: { [firstKey]: 0.9 }, confidence: 0.9 };
  }
  if (q.type === "score") return { type: "score", score: 1, confidence: 0.9 };
  return { type: "bool", probability: 0.9 };
}

/** Builds a scripted registry: `available`/`notFound` drive
 *  `getAvailableOfType`/`getModelOfType`; `responses[id]` drives `classify`'s
 *  outcome for that model, consumed in order (sticky on the last entry). */
export function createFakeRegistry(opts: FakeRegistryOptions): FakeRegistryHandle {
  const calls: ClassifyCallRecord[] = [];
  const cursors = new Map<string, number>();
  const availableSet = new Set(opts.available);
  const notFoundSet = new Set(opts.notFound ?? []);

  const registry: ClassifierRegistryLike = {
    getModelOfType: (_type, provider, id) => {
      const key = `${provider}/${id}`;
      return notFoundSet.has(key) ? undefined : { provider, id };
    },
    getAvailableOfType: async (_type) => {
      opts.onGetAvailableOfType?.();
      return opts.available.map((key) => {
        const slash = key.indexOf("/");
        return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
      });
    },
    classify: async (model, ctx, callOpts) => {
      const modelObj = model as { provider: string; id: string };
      const key = `${modelObj.provider}/${modelObj.id}`;
      const record: ClassifyCallRecord = {
        id: key,
        state: ctx.state,
        questions: ctx.questions,
        fetch: callOpts?.fetch,
        signal: callOpts?.signal,
      };
      calls.push(record);
      opts.onCall?.(record);
      const queue = opts.responses?.[key];
      let result: ClassifyResult;
      if (queue === undefined || queue.length === 0) {
        result = {
          stopReason: "stop",
          answers: Object.fromEntries(Object.entries(ctx.questions).map(([id, q]) => [id, answerBool(q)])),
        };
      } else {
        const idx = cursors.get(key) ?? 0;
        const entry = queue[Math.min(idx, queue.length - 1)]!;
        cursors.set(key, idx + 1);
        result = typeof entry === "function" ? await entry(record) : entry;
      }
      if (callOpts?.signal?.aborted === true) return { stopReason: "aborted", answers: {} };
      if (result.stopReason === "stop") {
        return {
          stopReason: "stop",
          answers: result.answers,
          provider: modelObj.provider,
          model: modelObj.id,
          usage: result.usage,
        };
      }
      if (result.stopReason === "aborted")
        return { stopReason: "aborted", answers: {}, provider: modelObj.provider, model: modelObj.id };
      return {
        stopReason: "error",
        answers: {},
        errorMessage: result.errorMessage,
        provider: modelObj.provider,
        model: modelObj.id,
      };
    },
  };

  return {
    registry,
    calls,
    callCountFor: (id: string) => calls.filter((c) => c.id === id).length,
  };
}
