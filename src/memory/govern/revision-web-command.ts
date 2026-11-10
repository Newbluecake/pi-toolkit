/** R4 pure domain adapter. I1 must inject the ORIGINAL revision host and the
 * SAME owner command kernel. No production Web wiring, freeze, model, native
 * handler, second store, second lock around E, or generated LIVE capability. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MemoryWriteGate } from "../contracts.js";
import type { ReviewSuggestion, RevisionProposal } from "../jev/contracts.js";
import { readIndex, revisionSemanticSuppression, suggestionKey, mergeReview } from "../jev/index-store.js";
import { canonicalDir, inspectDirSecurityNoFollow, readRegularBytes } from "../safe-fs.js";
import { withMemoryDirLock } from "../lock.js";
import type { CommandConfirmKernel, CommandPlan, MemoryWebCall } from "../command-confirm.js";
import {
  CommandFlowRefusal,
  commandFlowConfirmationPlan,
  parseRevisionFlowCommand,
  flowFact,
  type CommandFlowDomain,
  type CommandFlowTarget,
} from "../command-flow.js";
import type { MemoryCommandFactRow } from "../../web-hub/protocol/memory-command-facts.js";
import { commitAction, type OwnedRevisionAction, type RevisionCommitDeps } from "./revision-commit.js";
import { createRevisionAuditPort } from "./revision-audit.js";
import {
  revisionCanonicalJson,
  revisionInputIsLiveLocked,
  revisionProposalMatchesInput,
  validateRevisionProposal,
} from "./revision.js";
import { governanceGate, writeGovernIndexLocked } from "./supersede.js";

const canonical = revisionCanonicalJson;
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const MAX_RAW = 128 * 1024;
export interface RevisionWebCommandDeps {
  readonly memDir: string;
  /** Exact actual command args and actualCtx.cwd supplied by I1, never inferred. */
  readonly rawArgs: string;
  readonly contextDir: string;
  readonly call: MemoryWebCall;
  readonly kernel: CommandConfirmKernel;
  /** ORIGINAL createRevisionHost instance, never a JSON-backed reconstruction. */
  readonly host: { actionLocked(memDir: string, actionId: string): OwnedRevisionAction | undefined };
  readonly gate?: MemoryWriteGate;
  readonly runtime: RevisionCommitDeps["runtime"];
  /** Actual owner/manager/epoch, separate from original proposal custody. */
  readonly isCurrent: () => boolean;
  readonly now: () => Date;
}
interface Selection {
  readonly target: CommandFlowTarget;
  readonly row: ReviewSuggestion;
  readonly rowBytes: string;
}
function lossless(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new CommandFlowRefusal("unavailable");
  return text;
}
/** Captures only bounded read/confirmation state. Host custody remains owned by
 * R2 beyond release of this command's NEW execution lease. */
export function createRevisionWebCommand(deps: RevisionWebCommandDeps): CommandFlowDomain {
  const { memDir: mem, kernel, call } = deps;
  const grammar = parseRevisionFlowCommand(deps.rawArgs);
  if (!grammar) throw new CommandFlowRefusal("unavailable");
  const binding = kernel.binding(call),
    lease = kernel.lease(call);
  if (!binding || !lease) throw new CommandFlowRefusal("E_MEM_NEEDS_HUMAN_COMMAND");
  const selections = new Map<CommandFlowTarget, Selection>();
  let snapshotted = false;
  const locked = async <T>(body: () => T): Promise<T> => {
    let entered = false;
    try {
      return await withMemoryDirLock(
        mem,
        () => {
          entered = true;
          return body();
        },
        { timeoutMs: 500 },
      );
    } catch (error) {
      // The original lock has no typed busy error. Phase, NOT error.message,
      // proves this is an admission failure and no domain callback was entered.
      if (!entered) throw new CommandFlowRefusal("E_MEM_BUSY");
      throw error;
    }
  };
  const guard = () => {
    // Reentrant trusted callbacks can revoke; finish with pure signal reads.
    if (
      deps.isCurrent() !== true ||
      !lease.check() ||
      !kernel.binding(call) ||
      binding.signal.aborted ||
      lease.signal.aborted
    )
      throw new CommandFlowRefusal("E_MEM_CONFIRM_STALE");
    const runtime = deps.runtime();
    if (runtime.plainMain !== true || runtime.enabled !== true || runtime.sessionEpoch !== binding.owner.sessionEpoch)
      throw new CommandFlowRefusal("gate");
    if (canonicalDir(mem)?.real !== mem) throw new CommandFlowRefusal("stale");
    governanceGate(mem, deps.gate, lease.signal);
    if (deps.isCurrent() !== true || !kernel.binding(call) || binding.signal.aborted || lease.signal.aborted)
      throw new CommandFlowRefusal("E_MEM_CONFIRM_STALE");
  };
  const strictIndex = () => {
    const raw = readRegularBytes(join(mem, "blocks", ".jev"), "index.json", { maxBytes: 1024 * 1024 }).bytes;
    const disk = JSON.parse(lossless(raw)) as { review?: unknown };
    const result = readIndex(mem);
    if (result.rebuilt || !result.index.review || canonical(result.index.review) !== canonical(disk.review))
      throw new CommandFlowRefusal("unavailable");
    return result.index;
  };
  const rowLocked = (s: Selection) => {
    guard();
    const index = strictIndex();
    const row = index.review!.suggestions.find((r) => r.id === s.row.id);
    if (!row || canonical(row) !== s.rowBytes) throw new CommandFlowRefusal("stale");
    const p = validateRevisionProposal(row.revision);
    if (!p || p.proposalDigest !== s.row.revision?.proposalDigest) throw new CommandFlowRefusal("digest");
    if (
      revisionSemanticSuppression(index, {
        action: p.action,
        reason: p.reason,
        target: { id: p.targetId, hash: row.a.hash },
        ...(p.contextId && row.b ? { context: { id: p.contextId, hash: row.b.hash } } : {}),
      })
    )
      throw new CommandFlowRefusal("stale");
    return { index, row, p };
  };
  const original = (p: RevisionProposal): OwnedRevisionAction | undefined => {
    const owned = deps.host.actionLocked(mem, p.actionId);
    return owned &&
      canonical(owned.proposal) === canonical(p) &&
      owned.frozen.directory.realpath === mem &&
      owned.frozen.directory.sessionEpoch === binding.owner.sessionEpoch &&
      revisionProposalMatchesInput(p, owned.frozen) &&
      revisionInputIsLiveLocked(owned.frozen)
      ? owned
      : undefined;
  };
  const rawCurrent = (id: string) => {
    // IDs have already passed D's closed proposal codec; no anchor/path fallback.
    try {
      return lossless(readRegularBytes(join(mem, "blocks"), `${id}.md`, { maxBytes: MAX_RAW }).bytes);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return null;
      throw e;
    }
  };
  const capture = (s: Selection, operation: "apply" | "keep") => {
    const { p, row } = rowLocked(s);
    const owned = original(p);
    if (operation === "apply" && (!s.target.live || !owned)) throw new CommandFlowRefusal("unavailable");
    const audit = createRevisionAuditPort(mem, {
      isCurrent: () => {
        try {
          guard();
          return true;
        } catch {
          return false;
        }
      },
      now: deps.now,
      ...(deps.gate ? { gate: deps.gate } : {}),
      signal: lease.signal,
    });
    const evidence = audit.readActionLocked(p.batchId, p.actionId);
    if (evidence.kind !== "ok" || evidence.audit.proposalDigest !== p.proposalDigest)
      throw new CommandFlowRefusal("unavailable");
    const targetCurrent = rawCurrent(p.targetId),
      contextCurrent = p.contextId ? rawCurrent(p.contextId) : null;
    const before = lossless(evidence.before);
    if (hash(before) !== evidence.audit.beforeDigest) throw new CommandFlowRefusal("digest");
    const contextBefore = owned?.frozen.context
      ? lossless(owned.frozen.context.rawBefore)
      : contextCurrent !== null && hash(contextCurrent) === evidence.audit.contextRawDigest
        ? contextCurrent
        : null;
    const identity = canonicalDir(mem);
    guard();
    return {
      v: 1,
      operation,
      command: {
        cmdId: binding.cmdId,
        commandOwner: binding.commandOwner,
        operationGeneration: binding.operationGeneration,
        sid: binding.owner.sid,
        epoch: binding.owner.sessionEpoch,
        branchGen: binding.owner.branchGen,
      },
      directory: {
        canonical: identity,
        mem: inspectDirSecurityNoFollow(mem),
        blocks: inspectDirSecurityNoFollow(join(mem, "blocks")),
        review: inspectDirSecurityNoFollow(join(mem, "blocks", ".jev")),
      },
      contextDir: deps.contextDir,
      proposal: p,
      review: row,
      auditDigest: hash(canonical(evidence.audit)),
      beforeDigest: evidence.audit.beforeDigest,
      targetBefore: before,
      targetCurrent,
      contextBefore,
      contextBeforeDigest: owned?.frozen.context?.rawDigest ?? evidence.audit.contextRawDigest ?? null,
      contextCurrent,
      targetCurrentDigest: targetCurrent === null ? null : hash(targetCurrent),
      contextCurrentDigest: contextCurrent === null ? null : hash(contextCurrent),
      contextBeforeUnavailable: p.contextId !== undefined && contextBefore === null,
      custody: owned ? "LIVE" : "history",
    };
  };
  const selection = (t: CommandFlowTarget): Selection => {
    const s = selections.get(t);
    if (!s) throw new CommandFlowRefusal("E_MEM_PLAN_CHANGED");
    return s;
  };
  const presentation = (c: ReturnType<typeof capture>) => {
    const p = c.proposal;
    return [
      `命令上下文目录：${deps.contextDir}\n记忆目录：${mem}\n状态：${c.custody}；操作：${c.operation === "keep" ? "keep（永久抑制此语义建议，不修改正文）" : p.action}`,
      `target：${p.targetId} rev：${p.expectedRev}\ncontext：${p.contextId ?? "none"} rev：${p.contextExpectedRev ?? "none"}`,
      `batch：${p.batchId}\naction：${p.actionId}\nproposal SHA256：${p.proposalDigest}\n原文 SHA256：${c.beforeDigest}\ncontext 原文 SHA256：${c.contextBeforeDigest ?? "none"}\n目录 identity SHA256：${p.directoryIdentityDigest}\n当前 target SHA256：${c.targetCurrentDigest ?? "missing"}\n当前 context SHA256：${c.contextCurrentDigest ?? "none/missing"}`,
      `完整冻结原始文件（包含 frontmatter）：\n${c.targetBefore}`,
      `当前目标完整文件（null = missing）：\n${c.targetCurrent ?? "[missing]"}`,
      `完整冻结 context：\n${c.contextBefore ?? (p.contextId ? "历史 context 原文字节不可得；只可查看/keep，不能执行。" : "[none]")}`,
      `当前 context 完整文件：\n${c.contextCurrent ?? "[none/missing]"}`,
      `新正文（仅 rewrite/merge）：\n${p.generatedBody ?? "[不生成新正文]"}`,
      p.action === "expires"
        ? `日期变更：${canonical(p.expiry)}`
        : p.action === "retire"
          ? `单向 retire：仅 ${p.targetId} → ${p.contextId}；context 不写。`
          : "",
      `效果范围：只修改此 target；merge 仅 survivor，不自动 retire context；keep 仅原 review/index suppression。user delete 永禁。`,
      `恢复限制：无全局事务/回滚，不恢复 context；正文恢复仅原 C committed 审计、精确 raw CAS 且无未知 restore intent，需另行确认。keep 为永久语义抑制，无自动撤销。unknown 勿盲重试；不补偿、不自动重试。`,
    ].join("\n\n");
  };
  return {
    async snapshot() {
      if (snapshotted) throw new CommandFlowRefusal("E_MEM_PLAN_CHANGED");
      guard();
      return locked(() => {
        guard();
        const index = strictIndex();
        const all = index.review!.suggestions.filter((r) => r.revision !== undefined);
        const targets: CommandFlowTarget[] = [];
        for (const row of all.slice(0, 16)) {
          const p = validateRevisionProposal(row.revision);
          if (!p || !/^[^\x00-\x1f\x7f-\x9f]{1,128}$/.test(p.targetId)) throw new CommandFlowRefusal("digest");
          const owned = original(p);
          const bodyReady =
            (p.action !== "rewrite-single" && p.action !== "merge-survivor") || p.generatedBody !== undefined;
          const target = Object.freeze({
            actionId: p.actionId,
            targetId: p.targetId,
            operation: p.action,
            live: !!owned && bodyReady && !(p.action === "delete" && owned.frozen.target.block.authority === "user"),
          });
          selections.set(target, { target, row, rowBytes: canonical(row) });
          targets.push(target);
        }
        guard();
        snapshotted = true;
        return { targets: Object.freeze(targets), omitted: Math.max(0, all.length - targets.length) };
      });
    },
    async view(target) {
      const s = selection(target);
      guard();
      return locked(() => presentation(capture(s, "keep")));
    },
    async prepare(target, operation, step) {
      if (
        grammar.listOnly ||
        (operation !== "apply" && operation !== "keep") ||
        !Number.isSafeInteger(step) ||
        step < 1 ||
        step > 16
      )
        throw new CommandFlowRefusal("permission");
      const s = selection(target);
      guard();
      const captured = await locked(() => capture(s, operation));
      guard();
      const manifest = canonical(captured);
      const plan: CommandPlan = Object.freeze({
        rawArgs: deps.rawArgs,
        step,
        manifest,
        presentation: presentation(captured),
      });
      const approvedPlan = commandFlowConfirmationPlan(plan);
      let attempted = false;
      return {
        plan,
        async execute(receipt, exactPlan, observe) {
          let row: MemoryCommandFactRow = {
            ...flowFact(target, step),
            operation: operation === "keep" ? "keep" : target.operation,
            stage: "authorization",
          };
          const emit = (r: MemoryCommandFactRow) => {
            row = Object.freeze(r);
            observe(row);
          };
          try {
            guard();
            if (
              attempted ||
              canonical(exactPlan) !== canonical(approvedPlan) ||
              !kernel.check(call, receipt, exactPlan)
            )
              throw new CommandFlowRefusal("E_MEM_PLAN_CHANGED");
            attempted = true;
            if (operation === "apply") {
              // E owns THE original lock and one consume; never wrap commitAction
              // in a second lock or runConfirmedStep. JSON cannot supply LIVE.
              const result = await commitAction(
                mem,
                {
                  origin: "web-b3",
                  actionId: target.actionId,
                  expectedRev: captured.proposal.expectedRev,
                  proposalDigest: captured.proposal.proposalDigest,
                  signal: lease.signal,
                },
                {
                  ...(deps.gate ? { gate: deps.gate } : {}),
                  signal: lease.signal,
                  runtime: deps.runtime,
                  now: deps.now,
                  isCurrent: () => {
                    try {
                      guard();
                      return true;
                    } catch {
                      return false;
                    }
                  },
                  leaseValid: () => lease.check() && !binding.signal.aborted,
                  actionLocked: (id) => (id === target.actionId ? original(captured.proposal) : undefined),
                  consumeConfirmedLocked: () => {
                    guard();
                    if (canonical(capture(s, operation)) !== manifest) return false;
                    guard();
                    return kernel.consume(call, receipt, exactPlan);
                  },
                  observeConfirmedLocked: (o) =>
                    emit({
                      ...row,
                      stage: o.stage,
                      receipt: o.receipt,
                      audit: o.audit,
                      data: o.data,
                      outcome: o.result === "committed" ? "completed" : o.result === "skipped" ? "rejected" : "unknown",
                      review: "unchanged",
                    }),
                },
              );
              // Committed replay without THIS command's consume/observations is
              // not a newly performed command effect. Do not invent observations.
              if (result.kind === "committed") {
                if (
                  row.receipt !== "consumed" ||
                  row.data !== "applied" ||
                  row.stage !== "finalize" ||
                  row.audit !== "barrier-observed"
                )
                  return { ...row, outcome: "rejected", code: "stale" };
                return { ...row, outcome: "completed" };
              }
              if (result.kind === "effect-unknown") return { ...row, outcome: "unknown", code: result.reason };
              return { ...row, outcome: "rejected", code: result.reason };
            }
            return await locked(() => {
              guard();
              row = { ...row, stage: "review" };
              if (canonical(capture(s, operation)) !== manifest) throw new CommandFlowRefusal("E_MEM_PLAN_CHANGED");
              const { index, row: current } = rowLocked(s);
              const review = index.review!;
              const dismissed = {
                suggestionKey: suggestionKey(current),
                kind: current.kind,
                hashKey: current.b ? [current.a.hash, current.b.hash].sort().join("+") : current.a.hash,
                anchorKey: current.b ? [current.a.anchor, current.b.anchor].sort().join("+") : current.a.anchor,
              };
              const next = {
                ...index,
                review: mergeReview(review, {
                  ...review,
                  suggestions: [],
                  dismissed: [...review.dismissed, dismissed],
                }),
              };
              // All trusted callbacks run BEFORE the last pure CAS reads. This
              // also protects the original writer's final pre-rename gate from
              // synchronous reentry (not a same-uid filesystem transaction).
              const verifyPure = () => {
                const pureAudit = createRevisionAuditPort(mem, {
                  isCurrent: () => !binding.signal.aborted && !lease.signal.aborted,
                  now: deps.now,
                }).readActionLocked(captured.proposal.batchId, captured.proposal.actionId);
                if (
                  pureAudit.kind !== "ok" ||
                  hash(canonical(pureAudit.audit)) !== captured.auditDigest ||
                  canonical(strictIndex()) !== canonical(index) ||
                  rawCurrent(captured.proposal.targetId) !== captured.targetCurrent ||
                  (captured.proposal.contextId ? rawCurrent(captured.proposal.contextId) : null) !==
                    captured.contextCurrent ||
                  canonical({
                    canonical: canonicalDir(mem),
                    mem: inspectDirSecurityNoFollow(mem),
                    blocks: inspectDirSecurityNoFollow(join(mem, "blocks")),
                    review: inspectDirSecurityNoFollow(join(mem, "blocks", ".jev")),
                  }) !== canonical(captured.directory)
                )
                  throw new CommandFlowRefusal("E_MEM_PLAN_CHANGED");
                if (binding.signal.aborted || lease.signal.aborted) throw new CommandFlowRefusal("E_MEM_CONFIRM_STALE");
              };
              guard();
              verifyPure();
              if (!kernel.consume(call, receipt, exactPlan)) throw new CommandFlowRefusal("E_MEM_CONFIRM_STALE");
              emit({ ...row, receipt: "consumed", outcome: "unknown" });
              guard();
              verifyPure();
              // Before the original review owner touches disk, observation becomes
              // unknown. Cancellation or any I/O throw can never be called none.
              emit({ ...row, review: "unknown", outcome: "unknown" });
              const writeGate: MemoryWriteGate = {
                check(dir) {
                  if (dir !== mem) throw new CommandFlowRefusal("gate");
                  guard();
                  verifyPure();
                  return { ok: true };
                },
                capture() {
                  throw new CommandFlowRefusal("permission");
                },
              };
              writeGovernIndexLocked(mem, next, writeGate, lease.signal);
              const saved = strictIndex();
              if (canonical(saved.review) !== canonical(next.review)) throw new CommandFlowRefusal("unavailable");
              emit({ ...row, review: "changed", outcome: "completed" });
              return row;
            });
          } catch (error) {
            const uncertain = row.audit !== "not-entered" || row.data !== "not-called" || row.review !== "unchanged";
            return {
              ...row,
              outcome: uncertain ? "unknown" : "rejected",
              code: uncertain
                ? "E_MEM_EFFECT_UNKNOWN"
                : error instanceof CommandFlowRefusal
                  ? error.code
                  : "unavailable",
            };
          } finally {
            kernel.revoke(receipt);
          }
        },
      };
    },
  };
}
