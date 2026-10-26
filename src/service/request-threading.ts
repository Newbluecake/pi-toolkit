import type { SpawnRequest } from "../core/types.js";
import type { ResolvedSpawnRequest } from "../runtime/runner.js";

/**
 * CC4/FF4 (workflow design §4.4.1.1): explicit classification of every
 * `SpawnRequest` field into "must be threaded through to `ResolvedSpawnRequest`
 * as-is" vs "consumed/transformed elsewhere, never threaded verbatim".
 *
 * This is the fix for a real, previously-committed failure mode in this repo:
 * `runtime/runner.ts`'s `ResolvedSpawnRequest.parentRunId` doc comment records
 * that `parentRunId` used to be silently dropped because nothing threaded it
 * past `RunnerSpec.request` into the object literal `runtime-adapter.ts` built
 * for the runner. Hand-written `...(x === undefined ? {} : { x })` spreads at
 * the call site have no compile-time signal when a *new* `SpawnRequest` field
 * is added and nobody remembers to add a matching spread line — the field is
 * just silently absent from `ResolvedSpawnRequest` forever.
 *
 * The two `never`-exhaustiveness assertions below turn that into a compile
 * error instead: every key of `SpawnRequest` MUST appear in exactly one of
 * `THREADED` / `NOT_THREADED`, or `tsc --noEmit` fails pointing at the
 * assertion. See `tests/fixtures/ff4-*` for the negative fixtures that prove
 * the gate actually fires (WC13).
 */

/** Fields threaded verbatim into `ResolvedSpawnRequest` (same name, same meaning). */
const THREADED = [
  "signal",
  "detachSignalOnStart",
  "slotless",
  "resumeFrom",
  "parentRunId",
  "deadlineAt",
  "inputBudget",
  // Timeout-policy (agent-explicit-timeout-extend plan §2.2/C10): must reach the
  // runner so the `enqueued` dispatch can mirror it into diag.timeoutPolicy.
  "timeoutPolicy",
  // fabric-cross-session plan §4.1 (S0): spawn-service-internal switch for the acceptance markers
  // (promptDispatchedAt / inputAcceptedAt / promptOutcome). Runner-only: the runner/reducer read it (W2); it never
  // reaches a child session or a model. Absent unless an inbox reservation was bound to the resume.
  "trackInput",
  // fabric-cross-session plan §3.3 L4: the run's initial effective causal level (computed by spawn admission, never trusted
  // from a caller); the runner seeds diag.wakeLevel from it via the reducer's `wake_level` input.
  "wakeLevel",
] as const;

/**
 * Fields deliberately NOT threaded verbatim, with the reason each is excluded
 * (this table is what a reviewer should read when a new field shows up here):
 */
const NOT_THREADED = [
  "runId", // supplied directly as RunnerSpec.runId / ResolvedSpawnRequest.runId
  "type", // resolved to RunnerSpec.type (AgentTypeConfig) before this layer
  "prompt", // assembled by buildPrompt(spec), not passed through raw
  "label", // display/handle only, never reaches the execution layer
  "title", // display-only raw title — folded into RunDisplayMeta by the runtime adapter (like label), never threaded verbatim
  "cwd", // folded into sessionSpec.cwd (and may be rewritten by H2/X1 worktree)
  "modelOverride", // already merged into RunnerSpec.model -> sessionSpec.model
  "modelHintOverride", // resolved to a {provider,id} pair at spawn admission, then merged like modelOverride
  "thinkingOverride", // merged with type.thinkingLevel into sessionSpec.thinkingLevel by the runtime adapter
  "budgetOverride", // already merged into RunnerSpec.budget
  "expectAck", // consumed by spawn-service for the caller-ack hold registry
  "suppressDelivery", // consumed by the runtime adapter / spawn failure fallback; caller owns completion reporting
  "isolation", // consumed by the X1 worktree extension via H2, not threaded
  "schema", // consumed by the adapter to inject the StructuredOutput tool
  "poolFullPolicy", // consumed entirely by spawn() admission (L1) — decided and resolved before start()/RunnerSpec ever exist
  // sysload plan §6.2: consumed entirely by spawn() admission (same point/reason as
  // poolFullPolicy above) — the load gate either rejects admission outright or lets the
  // request through; the runner never sees this field.
  "loadPolicy",
  // consult A/B instrumentation plan (§3/§5 P1b): analytics-only, mirrored into
  // RunDisplayMeta.dispatchMeta by the runtime adapter, never part of the runner's own execution spec.
  "dispatchMeta",
  // consult A/B instrumentation plan (§4/§5 P1b): consumed by the adapter to pick renderStructuredForHost's
  // preset at settle time; the resolved `schema` field (already classified above) still carries the real JSON Schema.
  "schemaPreset",
  // #68: consumed by spawn admission only (resume without `schema` inherits the target run's schema); never reaches the runner.
  "inheritSchema",
  // P0-r (todo #22 optimize-plan §7.0 point 5): consumed by the runtime adapter to decide
  // readonlyDomain (tool set / policy / provenance / customTools narrowing); the runner never
  // sees this field verbatim — it only ever executes the toolScope the adapter already built.
  "toolDomain",
  // fabric-cross-session plan §4.1 (S0): programmatic wake provenance. Mirrored write-once into diag.wakeOrigin by
  // spawn/runner code (without trigger.claimToken); NEVER threaded verbatim — a child must not see (or forge) it,
  // and the claimToken is a mailbox-internal secret.
  "wakeOrigin",
  // fabric-cross-session plan §3.3 L4: consumed by spawn admission only (seeds wakeLevel = max(hop+1, prevFinal)); the
  // runner/child never sees it.
  "wakeHopLevel",
  // fabric-cross-session plan §4.5 (W5): admission-computed wake-ability verdict; reaches diag.wakeExclusion through the
  // adapter's display meta (like dispatchMeta), never as a runner/child field.
  "wakeExclusion",
  // W5: program-owned-result marker (workflow children). Consumed by spawn admission only.
  "callerOwned",
] as const;

type ClassifiedKeys = (typeof THREADED)[number] | (typeof NOT_THREADED)[number];

/**
 * Gate A: every key of `SpawnRequest` must be classified. Adding a field to
 * `SpawnRequest` without adding it to `THREADED` or `NOT_THREADED` makes
 * `Exclude<keyof SpawnRequest, ClassifiedKeys>` non-`never`, which makes this
 * type resolve to `never`, which makes the assignment below fail to compile.
 */
type AssertAllClassified = Exclude<keyof SpawnRequest, ClassifiedKeys> extends never ? true : never;
const assertAllClassified: AssertAllClassified = true;

/**
 * Gate B: the classification tables must not reference a key that doesn't
 * exist on `SpawnRequest` (stale entry after a field is renamed/removed).
 */
type AssertNoStaleKeys = Exclude<ClassifiedKeys, keyof SpawnRequest> extends never ? true : never;
const assertNoStaleKeys: AssertNoStaleKeys = true;

/**
 * Gate C (FF4-b): every `THREADED` field must actually exist, under the same
 * name, on `ResolvedSpawnRequest` — otherwise the iteration below would
 * silently type-widen through `Record<string, unknown>` and the field would
 * again vanish without a compile error.
 */
type AssertThreadedFieldsExistOnTarget =
  Exclude<(typeof THREADED)[number], keyof ResolvedSpawnRequest> extends never ? true : never;
const assertThreadedFieldsExistOnTarget: AssertThreadedFieldsExistOnTarget = true;

// Referenced only to keep the assertions from being flagged as unused by
// linters/tsc's noUnusedLocals-style tooling; their real job is done purely
// by existing (their *type* is what fails to compile, see above).
void assertAllClassified;
void assertNoStaleKeys;
void assertThreadedFieldsExistOnTarget;

/**
 * F3/F4 (workflow design §4.4.1): the actual transport. Iterates `THREADED`
 * instead of a hand-written spread list, so the *only* three possible
 * outcomes of adding a new `SpawnRequest` field are: (1) added to `THREADED`
 * -> threaded automatically, no adapter change needed; (2) added to
 * `NOT_THREADED` -> explicitly declared as not threaded, visible in review;
 * (3) added to neither -> compile failure (Gate A). There is no fourth
 * outcome where a field is silently dropped.
 *
 * Preserves the `undefined`-means-absent convention used throughout this
 * codebase's other spreads (compatible with `exactOptionalPropertyTypes`):
 * a field explicitly set to `undefined` on the input is *not* copied through
 * as an explicit `undefined` property.
 */
export function threadThroughRequestFields(req: SpawnRequest): Pick<SpawnRequest, (typeof THREADED)[number]> {
  const out: Record<string, unknown> = {};
  for (const key of THREADED) {
    const value = req[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Pick<SpawnRequest, (typeof THREADED)[number]>;
}
