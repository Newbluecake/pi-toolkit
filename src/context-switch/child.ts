/**
 * context-switch · child-session wiring (child-context-switch plan.md §2.1/§2.2/§3.1, package P3).
 *
 * The single `turn_end` handler the plan calls for: combines a boundary-draft switch commit
 * (via `boundary.ts`'s `buildChildSwitchDrafts`), the L2 zero-impact commit probe, and the
 * headless compact-hint fallback, always composing on top of `event.entries` (contract (a)).
 * A sibling `context` handler runs the L2/L3 self-check (plan §3.1) on the FIRST request after
 * a commit; `agent_end` catches the "run ended right before that request ever happened" failure
 * mode and reports it through the same `subagent:switch-selfcheck` channel P0's runner/driver
 * already understand (`src/runtime/session-driver.ts`, `src/runtime/runner.ts`).
 *
 * Everything here lives in THIS activate()'s closure (AGENTS.md: no module-scope mutable state) —
 * only the capability state machine (`capability.ts`) and the L2 probe/self-check are process-wide
 * by design (plan §3.1: capability must survive across child sessions in the same pi process).
 */
import { readFileSync } from "node:fs";
import * as piRuntime from "@earendil-works/pi-coding-agent";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../config/settings.js";
import { checkTurnEndShape, probeBoundaryStatic, type BoundaryStaticProbeInput } from "../adapters/pi-compat.js";
import { resolveKeepRecentTokens, resolveReserveTokens } from "../compact-hint/pi-settings.js";
import { createCompactHintHook, type CompactHintState, type Stack } from "../stack.js";
import { buildChildSwitchDrafts } from "./boundary.js";
import { getChildSwitchCapability, type CapabilityStatus } from "./capability.js";
import { collectSessionFacts } from "./session-facts.js";
import { checkSwitchSelfCheck, type DroppedFingerprintSet, type FingerprintableMessage } from "./selfcheck.js";
import { CHILD_SWITCH_SOURCE, ChildSwitchStore, PendingHandoffStore, countChildSwitches } from "./store.js";
import { createSwitchContextTool } from "../tools/switch-context-tool.js";

/** Zero-impact L2 commit probe (plan §3.1): a `custom` entry, never fed to the LLM. */
export const BOUNDARY_PROBE_CUSTOM_TYPE = "subagent:boundary-probe";
/** Non-fatal capability-state notice (plan §3.1 "要点"), read by the driver into `diag.contextSwitches.capability`. */
export const SWITCH_CAPABILITY_CUSTOM_TYPE = "subagent:switch-capability";
/** Run-fatal self-check-failed notice (plan §2.3.1 point 1), read by the driver/runner (P0, frozen). */
export const SWITCH_SELFCHECK_CUSTOM_TYPE = "subagent:switch-selfcheck";
/**
 * P3 acceptance follow-up (plan §2.3.1 V1-V6 visibility gap, additive): the driver
 * (`src/runtime/session-driver.ts`'s `CHILD_SWITCH_REJECTED_CUSTOM_TYPE`, matched by string
 * value only — same decoupling as the two consts above) folds this into
 * `diag.contextSwitches.rejected[]` (bounded FIFO, cap 5), readable from `get_subagent_result`.
 * Written for every V1-V6 structural rejection, the tool-result-not-ok "unpersisted" case, and a
 * `verified`-state self-check recheck failure that does NOT by itself disable the capability
 * (a single post-verified "uncommitted" — previously invisible in diagnostics).
 */
export const SWITCH_REJECTED_CUSTOM_TYPE = "subagent:switch-rejected";
/** Version-independent degrade/notice channel (plan §2.1 step 3 / §3.1): never a boundary draft. */
export const SWITCH_NOTICE_CUSTOM_TYPE = "subagent:switch-context-notice";

interface PendingCommit {
  seq: number;
  nonce: string;
  /** Whether this commit is the process's first-ever verification window (`ready` → `verifying`). */
  isFirst: boolean;
  commitProof: DroppedFingerprintSet;
  expectedSummary: string;
  tokensBefore: number;
  tokensAfter: number;
}

function makeNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** `data`/`type` shaped enough to recognize our own custom entries on a branch, without pi types. */
interface BranchEntryLike {
  id: string;
  type?: unknown;
  fromHook?: unknown;
  customType?: unknown;
  data?: unknown;
  details?: unknown;
  summary?: unknown;
}

function findProbeEntry(branch: readonly BranchEntryLike[], nonce: string): BranchEntryLike | undefined {
  return branch.find(
    (entry) =>
      entry?.type === "custom" &&
      entry.customType === BOUNDARY_PROBE_CUSTOM_TYPE &&
      (entry.data as Record<string, unknown> | undefined)?.["nonce"] === nonce,
  );
}

/**
 * plan §3.1 L3(a) note / §2.3.2: after our commit, pi's OWN automatic compaction (threshold or
 * overflow-retry) may fire again immediately — it merges our handoff as `previousSummary` into a
 * NEW summary, rewriting the text. When that happened, the LATEST branch compaction is pi's own
 * (not ours — its `details.nonce` will not match), and c3's `expectedSummary` must be re-pointed
 * at THAT summary, not our original one, or a legitimate re-compaction gets misjudged as
 * "content dropped" (v3.1 acceptance follow-up: T-S10 caught this as a genuine gap, not a
 * hypothetical).
 */
function findLatestCompactionAfter(
  branch: readonly BranchEntryLike[],
  afterIndex: number,
): BranchEntryLike | undefined {
  let found: BranchEntryLike | undefined;
  for (let i = afterIndex + 1; i < branch.length; i++) {
    if (branch[i]?.type === "compaction") found = branch[i];
  }
  return found;
}

/**
 * L2 (plan §3.1): three checks against the CURRENT session, run at the next `context` event
 * after the probe draft was committed. `{ok: undefined}` means "no conclusion" (no session file —
 * scheduling already gates on one, so this is only a defensive fallback, never expected in practice).
 */
function verifyBoundaryProbe(
  nonce: string,
  ctx: Pick<ExtensionContext, "sessionManager" | "cwd">,
): { ok: true } | { ok: false; reason: string } | { ok: undefined } {
  let branch: readonly BranchEntryLike[];
  try {
    branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntryLike[];
  } catch {
    return { ok: false, reason: "l2-drafts-ignored" };
  }
  const found = findProbeEntry(branch, nonce);
  if (!found) return { ok: false, reason: "l2-drafts-ignored" };
  // (ii) projection readable, and the probe contributes ZERO messages to it. Ground truth from
  // tests/conformance/pi-boundary.test.ts: a `custom` entry DOES still show up in
  // `projection.entries[].sourceEntry.id` (pi's projection is provenance-preserving) — the
  // zero-impact guarantee is that its own `messages` array is empty and it never contributes to
  // `projection.messages` (the flattened LLM-visible list), not that it is absent from `entries`.
  try {
    const projection = ctx.sessionManager.buildSessionProjection();
    const projected = projection.entries.find((entry) => entry.sourceEntry.id === found.id);
    if (projected && projected.messages.length > 0) return { ok: false, reason: "l2-projection" };
  } catch {
    return { ok: false, reason: "l2-projection" };
  }
  let sessionFile: string | undefined;
  try {
    sessionFile = ctx.sessionManager.getSessionFile?.();
  } catch {
    sessionFile = undefined;
  }
  if (!sessionFile) return { ok: undefined };
  try {
    const content = readFileSync(sessionFile, "utf8");
    const entries = piRuntime.parseSessionEntries(content);
    const reopened = piRuntime.SessionManager.inMemory(ctx.cwd, undefined, entries);
    const reBranch = reopened.getBranch() as unknown as readonly BranchEntryLike[];
    if (!findProbeEntry(reBranch, nonce)) return { ok: false, reason: "l2-not-persisted" };
  } catch {
    return { ok: false, reason: "l2-not-persisted" };
  }
  return { ok: true };
}

/** L3(a)/(c) + recheck (plan §3.1): only called once a compaction with our nonce is confirmed committed. */
function evaluateSelfCheck(
  commit: PendingCommit,
  event: Pick<ContextEvent, "messages">,
  ctx: Pick<ExtensionContext, "sessionManager">,
): { ok: true } | { ok: false; reason: string } {
  let branch: readonly BranchEntryLike[];
  try {
    branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntryLike[];
  } catch {
    return { ok: false, reason: "uncommitted" };
  }
  const ourIndex = branch.findIndex(
    (entry) =>
      entry?.type === "compaction" &&
      entry.fromHook === true &&
      (entry.details as Record<string, unknown> | undefined)?.["nonce"] === commit.nonce,
  );
  if (ourIndex < 0) return { ok: false, reason: "uncommitted" };
  let projectionIds: Set<string>;
  try {
    const projection = ctx.sessionManager.buildSessionProjection();
    projectionIds = new Set(projection.entries.map((entry) => entry.sourceEntry.id));
  } catch {
    return { ok: false, reason: "projection-unavailable" };
  }
  // plan §3.1 L3(a) note / §2.3.2: pi's own automatic re-compaction after ours rewrites the
  // summary text (our handoff becomes its `previousSummary`) — c3 must compare against THAT
  // summary, not our original one, once (a) has confirmed pi's compaction really is the later one.
  const laterCompaction = findLatestCompactionAfter(branch, ourIndex);
  const expectedSummary =
    typeof laterCompaction?.summary === "string" ? laterCompaction.summary : commit.expectedSummary;
  const check = checkSwitchSelfCheck({
    dropped: commit.commitProof,
    contextMessages: event.messages as unknown as readonly FingerprintableMessage[],
    projectionSourceEntryIds: projectionIds,
    expectedSummary,
    tokensBefore: commit.tokensBefore,
    tokensAfter: commit.tokensAfter,
  });
  return check.ok ? { ok: true } : { ok: false, reason: check.reason };
}

function safeTokensBefore(ctx: ExtensionContext): number | undefined {
  try {
    const tokens = ctx.getContextUsage()?.tokens;
    return typeof tokens === "number" ? tokens : undefined;
  } catch {
    return undefined;
  }
}

function safeSessionFile(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile?.();
  } catch {
    return undefined;
  }
}

/** Builds a fresh `CompactHintState` for a child session (mirrors `src/stack.ts`'s main-session construction, §2.2). */
function freshCompactHintState(
  settings: AgentSettings,
  cwd: string,
  switchesExhausted: () => boolean,
): CompactHintState {
  const compact = settings.compact;
  return {
    thresholdPercent: compact.hintThresholdPercent,
    forceAtPercent: compact.forceAtPercent,
    forceScaling: compact.forceScaling,
    thresholdTokens: compact.hintThresholdTokens,
    forceAtTokens: compact.forceAtTokens,
    reserveTokens: resolveReserveTokens(compact.assumedReserveTokens, cwd),
    lastHintAt: 0,
    hintedAt: undefined,
    tickStepPercent: compact.usageTickStepPercent,
    lastTickStep: 0,
    switchTool: true,
    forceDemandTurns: compact.forceDemandTurns,
    demandCount: 0,
    imminence: undefined,
    switchesExhausted,
  };
}

export function wireChildContextSwitch(
  pi: ExtensionAPI,
  settings: AgentSettings,
  deps: { onSwitchCommitted?: () => void } = {},
): void {
  const compact = settings.compact;
  if (!compact.enabled || !compact.switchTool || !compact.childSessions) return;

  const capability = getChildSwitchCapability();
  const l0 = probeBoundaryStatic(piRuntime as unknown as BoundaryStaticProbeInput);
  capability.noteL0(l0.ok ? { ok: true } : { ok: false, reason: l0.reason });
  // L0 gates REGISTRATION itself (plan §3.1 failure-mode table: "不注册工具、不授予；零 schema
  // 成本"). Any OTHER disabled reason (L1/L2/L3/repeat-uncommitted, from an EARLIER child
  // session in this same process) still gets the tool + handlers registered — the tool's own
  // capability check degrades to "unavailable" and the turn_end/context handlers become cheap
  // no-ops. L0 is deterministic for a given pi module, so a later session's own L0 check will
  // reach the same verdict as an earlier session's did.
  if (!l0.ok) return;

  const store = new ChildSwitchStore();
  let probePending: { nonce: string } | undefined;
  let pendingCommit: PendingCommit | undefined;
  let hintState: CompactHintState | undefined;
  let lastCtx: ExtensionContext | undefined;

  // Guards against re-appending the SAME diagnostic entry on every subsequent turn_end/context
  // call once disabled — `capability.get().state` stays "disabled" forever (process-wide, sticky),
  // so without this flag every later note*() call in THIS session would re-report the very same
  // transition. Scoped to this session's own closure (a fresh activate() per child session).
  let capabilityReported = false;
  function report(status: CapabilityStatus): CapabilityStatus {
    if (status.state === "disabled" && !capabilityReported) {
      capabilityReported = true;
      try {
        pi.appendEntry(SWITCH_CAPABILITY_CUSTOM_TYPE, { reason: status.reason });
      } catch {
        // best effort — the process-level state transition itself is unaffected.
      }
    }
    return status;
  }

  function switchesExhausted(): boolean {
    try {
      const branch = lastCtx?.sessionManager.getBranch() ?? [];
      return countChildSwitches(branch as never) >= (compact.childMaxSwitches ?? 5);
    } catch {
      return false;
    }
  }

  function getOrBuildHintState(cwd: string): CompactHintState {
    if (!hintState) hintState = freshCompactHintState(settings, cwd, switchesExhausted);
    return hintState;
  }

  // Built once (plan §2.2): the returned closure owns its own forcing/backoff state across turns.
  // `headless:true` skips print/json early-return and never calls `ctx.compact()`. The `holder`
  // param is unused (getState replaces it) — an empty object structurally satisfies `{current?: Stack}`.
  const hintHandler = createCompactHintHook({} as { current?: Stack }, {
    sendMessage: (message, options) => pi.sendMessage(message, options),
    headless: true,
    getState: () => (lastCtx ? getOrBuildHintState(lastCtx.cwd) : undefined),
  });

  function appendFailureNotice(entries: SessionBoundaryDraft[], reason: string): SessionBoundaryDraft[] {
    reportRejected(reason);
    return [
      ...entries,
      {
        type: "custom_message",
        customType: SWITCH_NOTICE_CUSTOM_TYPE,
        content: `switch_context 未生效（原因：${reason}），历史未替换，继续当前任务；可以稍后重试`,
        display: true,
        details: { reason },
      },
    ];
  }

  /**
   * P3 acceptance follow-up (plan §2.3.1 V1-V6 visibility gap, additive best-effort diag):
   * called at every point that already tells the MODEL a switch did not commit (V1-V6
   * structural rejection, "unpersisted", and a non-disabling post-verified self-check
   * recheck failure) so the same reason also reaches `get_subagent_result` via
   * `diag.contextSwitches.rejected[]`. Best effort — never load-bearing for the switch
   * itself or for the capability state machine.
   */
  function reportRejected(reason: string): void {
    try {
      pi.appendEntry(SWITCH_REJECTED_CUSTOM_TYPE, { reason });
    } catch {
      // best effort
    }
  }

  function notifyNotApplied(reason: string): void {
    try {
      pi.sendMessage(
        {
          customType: SWITCH_NOTICE_CUSTOM_TYPE,
          content: `[switch_context] 上一次切换未生效（原因：${reason}），历史未被替换，请继续当前任务。`,
          display: true,
          details: { reason },
        },
        { triggerTurn: false },
      );
    } catch {
      // best effort
    }
  }

  pi.registerTool(
    createSwitchContextTool({
      // Boundary mode never touches deps.store (see switch-context-tool.ts) — a fresh
      // throwaway instance just satisfies the required field.
      store: new PendingHandoffStore(),
      sendUserMessage: () => {
        // Never invoked in boundary mode (resume is always implicit — plan §2.1).
      },
      mode: "boundary",
      childStore: store,
      getCapabilityStatus: () => capability.get(),
      childMaxSwitches: compact.childMaxSwitches,
    }),
  );

  pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
    lastCtx = ctx;
    try {
      const l1 = checkTurnEndShape(event, ctx.sessionManager);
      report(capability.noteL1(l1.ok ? { ok: true } : { ok: false, reason: l1.reason }));
      const status = capability.get();

      const toolCallIds = Array.isArray(event.toolResults) ? event.toolResults.map((tr) => tr.toolCallId) : [];
      const staged = store.take(toolCallIds);

      if (status.state === "disabled") return undefined;

      if (event.outcome !== "completed") {
        // Abort/error: never continue on our own, and any not-yet-verified commit from a PRIOR
        // turn stays pending — the next context event (if any) still resolves it.
        return undefined;
      }

      let entries: SessionBoundaryDraft[] | undefined;
      const sessionFile = safeSessionFile(ctx);

      // L2 zero-impact commit probe (plan §3.1): once per process, while `observed`, only when
      // this turn is guaranteed to be followed by another request (has tool results) and a
      // session file exists to persist into.
      if (status.state === "observed" && !probePending && sessionFile && event.toolResults.length > 0) {
        const nonce = makeNonce();
        probePending = { nonce };
        entries = [...event.entries, { type: "custom", customType: BOUNDARY_PROBE_CUSTOM_TYPE, data: { nonce } }];
      }

      // Real switch commit (plan §2.1 steps 2-3).
      if (staged && (status.state === "ready" || status.state === "verified")) {
        const toolResult = event.toolResults.find((tr) => tr.toolCallId === staged.toolCallId);
        const details = toolResult?.details as { ok?: unknown } | undefined;
        const okResult = toolResult !== undefined && toolResult.isError !== true && details?.ok === true;
        if (okResult && sessionFile) {
          const branch = ctx.sessionManager.getBranch();
          const facts = collectSessionFacts(undefined, ctx, settings);
          const defaultKeepRecent =
            (piRuntime as { DEFAULT_COMPACTION_SETTINGS?: { keepRecentTokens?: number } }).DEFAULT_COMPACTION_SETTINGS
              ?.keepRecentTokens ?? 20_000;
          const keepRecentTokens = resolveKeepRecentTokens(undefined, defaultKeepRecent, ctx.cwd);
          const tokensBefore = safeTokensBefore(ctx);
          const result = buildChildSwitchDrafts({
            header: ctx.sessionManager.getHeader(),
            branch,
            cwd: ctx.cwd,
            turn: {
              messageEntryId: event.messageEntryId,
              toolResultEntryIds: event.toolResultEntryIds,
              toolResults: event.toolResults,
              priorDrafts: entries ?? event.entries,
            },
            staged: {
              toolCallId: staged.toolCallId,
              core: staged.core,
              keepRecent: staged.keepRecent,
              seq: staged.seq,
              nonce: staged.nonce,
            },
            keepRecentTokens,
            facts,
            tokensBefore,
          });
          if (result.ok) {
            const isFirst = status.state === "ready" ? capability.tryBeginVerification() : false;
            const compactionDraft = result.entries.find(
              (draft): draft is SessionBoundaryDraft & { type: "compaction" } => draft.type === "compaction",
            );
            pendingCommit = {
              seq: staged.seq,
              nonce: staged.nonce,
              isFirst,
              commitProof: result.commitProof,
              expectedSummary: compactionDraft?.summary ?? "",
              tokensBefore: result.diag.dropped.tokensBefore,
              tokensAfter: result.diag.dropped.tokensAfterEstimate,
            };
            entries = result.entries;
            hintState = undefined; // plan §2.2: a successful switch resets compact-hint state.
            try {
              deps.onSwitchCommitted?.();
            } catch {
              // best effort — keepalive invalidation is never load-bearing for the switch itself.
            }
          } else {
            entries = appendFailureNotice(entries ?? event.entries, result.reason);
          }
        } else {
          entries = appendFailureNotice(entries ?? event.entries, "unpersisted");
        }
      }

      // Headless compact-hint (plan §2.2), only when no switch happened this turn.
      if (!staged && (status.state === "ready" || status.state === "verified") && event.toolResults.length > 0) {
        let activeTools: string[] = [];
        try {
          activeTools = pi.getActiveTools();
        } catch {
          activeTools = [];
        }
        if (activeTools.includes("switch_context")) hintHandler(event, ctx);
      }

      return entries ? { entries } : undefined;
    } catch {
      // Handler exceptions must never escape into pi's event emitter (plan §2.1 step 3).
      return undefined;
    }
  });

  pi.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    try {
      if (probePending) {
        const status = capability.get();
        if (status.state !== "observed") {
          probePending = undefined; // capability moved on (or got disabled) meanwhile.
        } else {
          const result = verifyBoundaryProbe(probePending.nonce, ctx);
          if (result.ok !== undefined) {
            report(capability.noteL2(result));
            probePending = undefined;
          }
        }
      }
      if (pendingCommit) {
        const commit = pendingCommit;
        pendingCommit = undefined;
        const check = evaluateSelfCheck(commit, event, ctx);
        const newStatus = commit.isFirst
          ? capability.noteL3(check.ok ? { ok: true } : { ok: false, reason: check.reason })
          : capability.noteRecheck(check.ok ? { ok: true } : { ok: false, reason: check.reason });
        report(newStatus);
        if (!check.ok) {
          reportRejected(check.reason);
          notifyNotApplied(check.reason);
        }
      }
    } catch {
      // never throw
    }
    return undefined;
  });

  pi.on("agent_end", () => {
    if (!pendingCommit) return undefined;
    pendingCommit = undefined;
    try {
      pi.appendEntry(SWITCH_SELFCHECK_CUSTOM_TYPE, { ok: false, reason: "run-ended-after-switch" });
    } catch {
      // best effort — the runner's own `getSwitchTail()` settlement fallback (P0) does not
      // depend on this entry ever landing.
    }
    report(capability.noteFatal("run-ended"));
    return undefined;
  });

  // pi's own automatic compaction succeeded (plan §2.2): reset compact-hint state, same as a
  // successful boundary switch above.
  pi.on("session_compact", () => {
    hintState = undefined;
    return undefined;
  });
}
