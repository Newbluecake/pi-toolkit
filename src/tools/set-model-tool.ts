import { NoActiveSessionError, safeRunCandidates } from "../holder.js";
import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SET_MODEL_TIMEOUT_MS, withDeadline } from "../core/deadline.js";
import { systemClock, type Clock } from "../core/clock.js";
import { THINKING_LEVELS, type SetModelOutcome } from "../core/types.js";
import { parseStrictModelRef } from "../config/model-hint.js";
import { MSG_SET_MODEL_ON_EXTERNAL, MSG_SET_MODEL_TO_EXTERNAL } from "../external-agent/messages.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import { cleanLabel, runRefDetails, titleForHandle } from "./run-ref.js";

/**
 * "set_model" — switch the model used from the next LLM call onward, either
 * for the caller's own session (default) or for a currently running subagent
 * run (host form only). One factory, two forms (docs/dev/set-model
 * plan §4.9):
 *
 * - Host form (registered in src/index.ts): deps.host drives the main
 *   session through pi.setModel; deps.runs/resolveRun reach running
 *   subagents through QueryService.
 * - Run form (injected per-run by service/runtime-adapter.ts): deps.selfRunId
 *   pins "self" to the calling run; foreign run_ids are rejected (D-2).
 *
 * Semantics that are easy to get wrong (plan §5):
 * - pi's setModel recomputes the thinking level (per-model override → global
 *   defaultThinkingLevel → current), so "keep the current level" requires an
 *   explicit write-back after the switch; clamping itself stays with pi core.
 *   This deliberately overrides pi's per-model thinking preference (documented
 *   deviation; requirement 3 says "unspecified = keep current").
 * - Both paths are bounded by SET_MODEL_TIMEOUT_MS (the runner wraps its own
 *   call; here we wrap the host call — pi's auth check reads credential
 *   storage and is not provably bounded).
 * - Failures throw (pi hands the full message to the model; the details
 *   channel is always empty on the error path).
 */

export const SetModelParams = Type.Object({
  model: Type.String({
    description:
      "Target model: the full 'provider/id' copied from the system prompt's 'Available models' section (the " +
      "prefix rule is stated there). The resolved provider/id is reported back in the result.",
  }),
  run_id: Type.Optional(
    Type.String({
      description:
        "Which session to switch. Omit (or pass 'self') for your own session. Otherwise the run id of a " +
        "currently running subagent; a unique run_id prefix or the Agent call's label (its description) also works.",
    }),
  ),
  thinking: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description:
        "Optional thinking level to apply together with the switch ('off' | 'low' | 'medium' | 'high'). " +
        "Omit to keep the current level; the level is clamped to what the new model supports and the " +
        "effective value is reported back.",
    }),
  ),
});
export type SetModelParams = Static<typeof SetModelParams>;

export interface SetModelToolDeps {
  /** Host form: main-session self-switch (index.ts injects the ExtensionAPI in a closure). Absent in the run form. */
  host?: {
    /** pi.setModel: false = auth missing for the provider (model unchanged). */
    setModel: (model: unknown) => Promise<boolean>;
    getThinkingLevel: () => string | undefined;
    setThinkingLevel: (level: string) => void;
    /** {provider,id} → opaque pi Model (ctx.modelRegistry.find). */
    findModel: (provider: string, id: string) => unknown | undefined;
  };
  /** Run form: this run's id (where "self" lands). */
  selfRunId?: string;
  /** Switch some run's model (host form = query.setModel; run form = direct runner). */
  runs?: {
    setModel: (
      runId: string,
      model: { provider: string; id: string },
      opts?: { thinking?: string },
    ) => Promise<SetModelOutcome>;
  };
  /** Fuzzy hint resolution (same implementation spawn admission uses). */
  resolveHint?: (hint: string) => { provider: string; id: string } | undefined;
  /** Optional: candidate list for self-correcting error text (E2). */
  available?: () => readonly { provider: string; id: string; name?: string }[];
  /** run_id / unique prefix / label resolution (host form). */
  resolveRun?: (handle: string) => ResolveRunResult;
  /** Optional: effective label of a run (human name shown next to the run id). */
  labelOf?: (runId: string) => string | undefined;
  /** Clock for the host-path deadline (m2); defaults to systemClock, tests inject FakeClock. */
  clock?: Clock;
  /**
   * external-agent plan §5.4 (P4b): provider-claim predicate, injected by P5
   * only when the external port exists (`(p) => port.owns(p)`). Absent ⇒
   * `droid/x` follows the original unknown-model path (byte-identical).
   * Present ⇒ switching TO an external model is rejected, and an `unsupported`
   * outcome on an external run is reworded (mid-run switching is unsupported).
   */
  externalOwns?: (provider: string) => boolean;
}

const HOST_DESCRIPTION =
  "Switch the model used from the next LLM call onward — either your own session (omit run_id) or a " +
  "currently running subagent (run_id). Does not interrupt the current turn: the switch applies to the " +
  "next model call. Optionally set the thinking level at the same time; otherwise the current level is " +
  "kept (clamped to the new model's capabilities). The switch is remembered in the session transcript " +
  "(a resumed session keeps it) and never changes global defaults.";
const RUN_FORM_SUFFIX =
  " This instance can only switch YOUR OWN session's model; run_id must be omitted, 'self', or your own run id.";
const HOST_SNIPPET =
  "set_model(model, run_id?, thinking?) - switch the model for the next LLM call (self or a running subagent)";
// m5: the run form is self-only — its snippet must not mention "a running subagent".
const RUN_SNIPPET = "set_model(model, thinking?) - switch your own session's model for the next LLM call";

type SwitchEffect = "none" | "unknown" | "model_changed";
class ModelSwitchError extends Error {}
function switchError(reason: string, message: string, effect: SwitchEffect = "none"): ModelSwitchError {
  return new ModelSwitchError(
    `${message} [code=set_model_${reason} reason=${reason} retryable=false effect=${effect}]. ` +
      (effect === "none"
        ? ""
        : "Verify the effective model/thinking state before further action; do not automatically retry or submit a new request."),
  );
}
function switchException(error: unknown, effect: SwitchEffect): Error {
  if (error instanceof ModelSwitchError) return error;
  if (error instanceof NoActiveSessionError && effect !== "model_changed") return error;
  // SDK 1.5's literal invalidation guard, not a guess based on arbitrary auth/network exception text.
  if (
    error instanceof Error &&
    error.message.startsWith("This extension ctx is stale after session replacement or reload.")
  ) {
    return switchError(
      "stale_binding",
      "The host binding is stale after session replacement or reload. Wait for the actual session_start and use its live binding; stop calling the closed session.",
      effect,
    );
  }
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const reason = code === "ETIMEDOUT" ? "timeout" : "unknown";
  return switchError(reason, "Model switch failed; its effect has not been verified.", effect);
}

function availableSuffix(deps: SetModelToolDeps): string {
  const list = deps.available?.().slice(0, 8) ?? [];
  return list.length
    ? ` Available: ${list.map((m) => `${m.provider}/${m.id}`).join(", ")} (live list — the system-prompt section may be stale)`
    : "";
}

function thinkingText(effective: string | undefined, desired: string | undefined): string {
  if (effective === undefined) return "";
  return desired !== undefined && desired !== effective
    ? ` (thinking: ${effective} — clamped from ${desired})`
    : ` (thinking: ${effective})`;
}

function successResult(
  textTarget: string,
  detailsTarget: string,
  model: { provider: string; id: string },
  effectiveThinking: string | undefined,
  desired: string | undefined,
  label?: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Model for ${textTarget} set to ${model.provider}/${model.id}${thinkingText(effectiveThinking, desired)}. ` +
          "Takes effect on the next model call; the current turn continues unchanged.",
      },
    ],
    details: {
      ok: true,
      target: detailsTarget,
      ...(detailsTarget !== "self" && label !== undefined ? runRefDetails(detailsTarget, label) : {}),
      model,
      ...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
    },
  };
}

/** Map a runs.setModel outcome to either a success result or a thrown, self-correcting error (plan §6).
 *  textTarget is the caller-facing handle (what the model typed); detailsTarget is the resolved runId. */
function mapRunOutcome(
  textTarget: string,
  detailsTarget: string,
  outcome: SetModelOutcome,
  requestedThinking: string | undefined,
  externalRunTarget: boolean,
  label?: string,
) {
  const who = label === undefined ? `run ${textTarget}` : textTarget;
  if (outcome.ok)
    return successResult(
      textTarget,
      detailsTarget,
      outcome.model,
      outcome.thinking,
      requestedThinking ?? outcome.thinking,
      label,
    );
  switch (outcome.reason) {
    case "not_running":
      throw switchError(
        "not_running",
        `${who} is not currently running; a terminal run's model can only be chosen when you spawn ` +
          "(Agent(model: …)) or resume it",
      );
    case "unknown_model":
      throw switchError(
        "unknown_model",
        `unknown model for ${who} (not available in this installation — check the provider auth)`,
      );
    case "rejected":
      throw switchError(
        "rejected",
        `${who} refused the model switch; the failure cause and effective model are unverified.`,
        "unknown",
      );
    case "timeout":
      throw switchError(
        "timeout",
        `model switch for ${who} timed out after ${SET_MODEL_TIMEOUT_MS / 1000}s; the session may still be on the previous model, or the switch may still take effect`,
        "unknown",
      );
    case "unsupported":
      // external-agent plan §5.4 (P4b): an external (droid) run never exposes
      // set_model, so the runner reports `unsupported` — reword the generic
      // message when the target run is external (the port is what makes such
      // runs exist at all). Absent port ⇒ byte-identical original message.
      throw switchError(
        "unsupported",
        externalRunTarget ? MSG_SET_MODEL_ON_EXTERNAL : "this session cannot switch models mid-run",
      );
  }
}

export function createSetModelTool(deps: SetModelToolDeps): ToolDefinition<typeof SetModelParams> {
  const runForm = deps.selfRunId !== undefined;
  const clock = deps.clock ?? systemClock;
  return {
    name: "set_model",
    label: "Set Model",
    description: runForm ? HOST_DESCRIPTION + RUN_FORM_SUFFIX : HOST_DESCRIPTION,
    promptSnippet: runForm ? RUN_SNIPPET : HOST_SNIPPET,
    ...(runForm
      ? {}
      : {
          promptGuidelines: [
            "Use set_model when the remaining work clearly needs a different capability/cost point (e.g. drop to a cheap model for mechanical edits, escalate for hard reasoning).",
            "The switch takes effect on your NEXT model call — finish the current tool sequence normally, do not re-plan around it.",
            "Report/act on the resolved provider/id in the result: a fuzzy hint may resolve to a different model than you expected.",
          ],
        }),
    parameters: SetModelParams,
    /** Same convention as steer/compact: title + one muted meta line. */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Set Model: ${args?.model ?? "…"}`));
      const meta = [
        `target: ${args?.run_id === undefined || args.run_id === "self" ? "self" : titleForHandle(args.run_id, { resolveRun: deps.resolveRun, get: (id) => ({ diag: { label: deps.labelOf?.(id) } }) as never })}`,
        ...(args?.thinking ? [`thinking: ${args.thinking}`] : []),
      ].join("  ·  ");
      text.setText(`${title}\n${theme.fg("muted", meta)}`);
      return text;
    },
    async execute(_toolCallId, params) {
      let effect: SwitchEffect = "none";
      try {
        // E1: defensive re-validation beyond the schema (never rely on the host validating).
        const thinking = params.thinking as string | undefined;
        if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking))
          throw switchError(
            "invalid_thinking",
            `invalid thinking level "${thinking}"; use one of ${THINKING_LEVELS.join(", ")}`,
          );
        // D-1/D-2: target classification.
        const rawTarget = params.run_id;
        const isSelf = rawTarget === undefined || rawTarget === "self" || rawTarget === deps.selfRunId;
        if (!isSelf && runForm)
          throw switchError("policy", 'set_model here can only switch your own model; omit run_id or pass "self"');
        // Resolve first, act second (same discipline as spawn admission).
        const ref = parseStrictModelRef(params.model) ?? deps.resolveHint?.(params.model);
        if (!ref)
          throw switchError(
            "unknown_model",
            `unknown model: "${params.model}" — pass a strict provider/id from the 'Available models' section, or a bare id/substring of an available model.` +
              availableSuffix(deps),
          );
        const opts = thinking === undefined ? {} : { thinking };
        // external-agent plan §5.4 (P4b): switching TO an external model is
        // rejected before any target classification (self or foreign).
        if (deps.externalOwns?.(ref.provider) === true) throw switchError("unsupported", MSG_SET_MODEL_TO_EXTERNAL);
        if (isSelf && runForm) {
          effect = "unknown";
          const outcome = await deps.runs!.setModel(deps.selfRunId!, ref, opts);
          if (outcome.ok) effect = "model_changed";
          return mapRunOutcome("this session", "self", outcome, thinking, false);
        }
        if (isSelf) {
          // Host form self-switch.
          const host = deps.host;
          if (!host)
            throw switchError(
              "unsupported",
              "this pi build cannot switch the host session's model; target a running subagent instead (pass its run_id)",
            );
          const found = host.findModel(ref.provider, ref.id);
          if (found === undefined || found === null)
            throw switchError(
              "unknown_model",
              `unknown model: ${ref.provider}/${ref.id} (not available in this installation — check the provider auth)`,
            );
          const previous = host.getThinkingLevel();
          effect = "unknown";
          let hostException: unknown;
          const applied = await withDeadline(
            Promise.resolve()
              .then(() => host.setModel(found))
              .catch((error: unknown) => {
                hostException = error;
                throw error;
              }),
            SET_MODEL_TIMEOUT_MS,
            clock,
            "set_model",
          );
          if (!applied.ok) {
            if (applied.reason === "timeout")
              throw switchError(
                "timeout",
                `model switch timed out after ${SET_MODEL_TIMEOUT_MS / 1000}s; the session may still be on the previous model, or the switch may still take effect`,
                "unknown",
              );
            throw switchException(hostException, effect);
          }
          if (applied.value === false)
            throw switchError(
              "auth",
              `no auth configured for provider "${ref.provider}"; the session model is unchanged (run /login or set the provider key)`,
            );
          effect = "model_changed";
          // Plan §5: write the desired level back over pi's recompute; pi clamps.
          const desired = thinking ?? previous;
          if (desired !== undefined) {
            try {
              host.setThinkingLevel(desired);
            } catch {
              throw switchError(
                "thinking_failed",
                "The model changed, but the thinking-level write failed; its effective level is unverified.",
                effect,
              );
            }
          }
          return successResult("this session", "self", ref, host.getThinkingLevel(), desired);
        }
        // Foreign target (host form only).
        const resolved = deps.resolveRun?.(rawTarget!);
        if (resolved && !resolved.ok) throw switchError("target_resolution", safeRunCandidates(resolved.candidates));
        const runId = resolved?.ok ? resolved.runId : rawTarget!;
        effect = "unknown";
        const outcome = await deps.runs!.setModel(runId, ref, opts);
        if (outcome.ok) effect = "model_changed";
        // Classify the authoritative refusal before any optional display lookup.
        if (!outcome.ok) return mapRunOutcome(rawTarget!, runId, outcome, thinking, deps.externalOwns !== undefined);
        let label: string | undefined;
        try {
          label = cleanLabel(deps.labelOf?.(runId));
        } catch {
          // A label is display-only; neither lifecycle nor ordinary lookup failure undoes this switch.
        }
        return mapRunOutcome(
          label === undefined ? rawTarget! : `${label} (run_id: ${runId})`,
          runId,
          outcome,
          thinking,
          deps.externalOwns !== undefined,
          label,
        );
      } catch (error) {
        throw switchException(error, effect);
      }
    },
  } satisfies ToolDefinition<typeof SetModelParams>;
}
