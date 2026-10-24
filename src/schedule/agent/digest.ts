/**
 * Scheduled tasks — the "opening digest" (plan r3 §5.5; A3).
 *
 * When a session is opened, anything the ledger recorded that the user/AI has not been told about —
 * missed occurrences, runs that ended `unknown`/`dropped`/`refused`, reports lost to index overflow —
 * is written ONCE into the conversation as a quiet message (`subagent:schedule`, kind "digest").
 *
 * Exactly-once machinery (all in the ledger, no extra files):
 *  - the digest is CLAIMED under the ledger lock (`digest.inflight = {holder, id, at, fileOffset}`):
 *    two views of the same session cannot both send;
 *  - the watermark (`shownMissedTotal`, `shownRunsThrough`) only advances on PROOF that the message is
 *    in the session FILE (§6.3 — `message_start` / sendMessage's return / in-memory queues prove
 *    nothing: a quiet message can sit in pi's memory for the whole turn);
 *  - same process: never re-sent, only verified when the session is idle; another live process's
 *    claim is respected; a claim whose holder is provably dead is verified against the file first
 *    (found ⇒ just advance, confirmed absent ⇒ reclaim and send);
 *  - unverifiable (file > 16 MiB) ⇒ advance without re-sending (at-most-once beats duplicates).
 * `missedTotal` itself is never reset — hub reconciliation does not depend on digests.
 */
import { randomBytes } from "node:crypto";
import type { Clock, TimerHandle } from "../../core/clock.js";
import { judgeHolder } from "../core/recovery.js";
import { findSessionEntry, sessionFileAnchor, type FileAnchor, type ProofResult } from "../core/session-proof.js";
import { isTerminalRunState, SCHED_CUSTOM_TYPE, type RunRecord, type ScheduleStateFile } from "../core/spec.js";
import { localTime } from "./view.js";
import type { ScheduleAgent } from "./wire.js";

export interface DigestCovers {
  /** taskId → missedTotal the digest accounts for. */
  missed: Record<string, number>;
  /** Events up to this instant (ms) are accounted for. */
  runsThrough: number;
}

export interface DigestContent {
  text: string;
  summary: string;
  covers: DigestCovers;
}

const RUN_WORDS: Record<string, string> = { unknown: "结果未知", dropped: "未执行", refused: "被拒绝" };
const DIGEST_STATES = new Set(["unknown", "dropped", "refused"]);
const MAX_RUN_LINES = 12;

/** What is new relative to the ledger's digest watermarks (undefined ⇒ nothing to tell). */
export function computeDigest(state: ScheduleStateFile, now: number): DigestContent | undefined {
  const lines: string[] = [];
  const covers: DigestCovers = { missed: {}, runsThrough: now };
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  for (const t of state.tasks) {
    const occ = state.occ[t.id];
    if (occ === undefined) continue;
    const shown = state.digest.shownMissedTotal[t.id] ?? 0;
    if (occ.missedTotal <= shown) continue;
    covers.missed[t.id] = occ.missedTotal;
    const last = occ.missedLog.at(-1);
    lines.push(
      `任务「${t.name}」（${t.id}）错过了 ${occ.missedTotal - shown} 次运行（当时会话未打开或超过容差，不补跑）` +
        (last === undefined ? "" : `，最近一次约 ${localTime(t.when, last.to)}`) +
        `；累计错过 ${occ.missedTotal} 次。`,
    );
  }
  const fresh = state.runs
    .filter(
      (r) =>
        DIGEST_STATES.has(r.state) &&
        isTerminalRunState(r.state) &&
        (r.endedAt ?? r.startedAt) > state.digest.shownRunsThrough,
    )
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  const describe = (r: RunRecord): string => {
    const t = byId.get(r.taskId);
    const when = t === undefined ? new Date(r.scheduledAt).toISOString() : localTime(t.when, r.scheduledAt);
    return (
      `任务「${t?.name ?? r.taskId}」（${r.taskId}）${when} 的运行：${RUN_WORDS[r.state] ?? r.state}` +
      `${r.reason ? `（${r.reason}）` : ""}。`
    );
  };
  for (const r of fresh.slice(0, MAX_RUN_LINES)) lines.push(describe(r));
  if (fresh.length > MAX_RUN_LINES)
    lines.push(`……另有 ${fresh.length - MAX_RUN_LINES} 条类似记录（schedule 工具 history 可查）。`);
  const dropped = state.reportStats.lastDroppedAt;
  if (dropped !== undefined && dropped > state.digest.shownRunsThrough)
    lines.push(`有 ${state.reportStats.droppedIndexCap} 份报告因积压未推送到飞书，请在会话或网页查看。`);
  if (lines.length === 0) return undefined;
  const text = [
    "[定时任务提示] 自上次提示以来发生了下列情况（结果详情可用 schedule 工具 history 查看，报告在对应 reportFile）：",
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
  return { text, summary: `定时任务：${lines.length} 条新情况（已写入会话）`, covers };
}

/**
 * Covers for a digest we did NOT compose (a dead holder's claim whose message is proven present):
 * everything the ledger knew at the claim instant `at` — the last missed entry written no later than
 * `at` gives the per-task total; events through `at` are accounted for.
 */
export function deriveCoversAt(state: ScheduleStateFile, at: number): DigestCovers {
  const missed: Record<string, number> = {};
  for (const t of state.tasks) {
    const occ = state.occ[t.id];
    if (occ === undefined) continue;
    const upto = occ.missedLog.filter((e) => e.at <= at).at(-1);
    if (upto !== undefined) missed[t.id] = upto.totalAfter;
  }
  return { missed, runsThrough: at };
}

export interface DigestDeps {
  agent: Pick<ScheduleAgent, "store" | "mode" | "holder" | "self" | "epoch" | "changed" | "isDisposed">;
  sessionFile(): string | undefined;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: false },
  ): void;
  notify(text: string): void;
  isIdle(): boolean;
  clock: Clock;
  isEpochDisposed(epoch: string): boolean;
  newId?(): string;
  /** Tests: 0 so a freshly written session file can prove absence. */
  proofSettleMs?: number;
  warn?(message: string): void;
}

export interface ScheduleDigest {
  /** After session_start's sweep/recovery: resolve a stale claim, then send a digest if there is news. */
  run(): Promise<void>;
  /** Idle hook (agent_settled): verify our own pending digest / resolve a foreign claim. Never creates news. */
  tick(): Promise<void>;
  dispose(): void;
}

const VERIFY_DELAY_MS = 2_000;

export function createScheduleDigest(deps: DigestDeps): ScheduleDigest {
  let disposed = false;
  let sent: { id: string; anchor: FileAnchor | undefined; covers: DigestCovers } | undefined;
  let timer: TimerHandle | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const warn = deps.warn ?? ((m: string) => console.warn(`[pi-subagent] schedule digest: ${m}`));
  const dead = (): boolean => disposed || deps.agent.isDisposed();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  async function advance(covers: DigestCovers, id: string): Promise<boolean> {
    const s = deps.agent.store();
    if (s === undefined) return false;
    const r = await s.transact((draft) => {
      for (const [taskId, total] of Object.entries(covers.missed)) {
        if (!draft.tasks.some((t) => t.id === taskId)) continue;
        draft.digest.shownMissedTotal[taskId] = Math.max(draft.digest.shownMissedTotal[taskId] ?? 0, total);
      }
      draft.digest.shownRunsThrough = Math.max(draft.digest.shownRunsThrough, covers.runsThrough);
      if (draft.digest.inflight?.id === id) delete draft.digest.inflight;
      return { value: true, write: true };
    });
    if (r.ok) deps.agent.changed();
    return r.ok;
  }

  function proofOf(id: string, anchor: FileAnchor | undefined): ProofResult | undefined {
    const file = deps.sessionFile();
    if (file === undefined) return undefined;
    return findSessionEntry({
      file,
      key: "digestId",
      id,
      ...(anchor === undefined ? { offset: 0 } : { anchor }),
      ...(deps.proofSettleMs === undefined ? {} : { settleMs: deps.proofSettleMs }),
    });
  }

  /** Verify our own sent digest (idle only). found / unverifiable ⇒ advance; anything else ⇒ keep, never resend here. */
  async function verifyOwn(): Promise<void> {
    if (sent === undefined || dead() || !deps.isIdle()) return;
    const proof = proofOf(sent.id, sent.anchor);
    if (proof === undefined) return;
    if (proof.kind === "found") {
      const own = sent;
      sent = undefined;
      await advance(own.covers, own.id);
    } else if (proof.kind === "too-large") {
      const own = sent;
      sent = undefined;
      deps.notify("定时任务提示已发送，但会话文件过大无法核验；不会重发。");
      await advance(own.covers, own.id);
    }
  }

  function armVerify(): void {
    if (timer !== undefined) deps.clock.clearTimer(timer);
    timer = deps.clock.setTimer(VERIFY_DELAY_MS, () => {
      timer = undefined;
      void serial(verifyOwn).catch(() => undefined);
    });
  }

  async function resolveInflight(allowNew: boolean): Promise<void> {
    if (dead() || deps.agent.mode.kind !== "interactive") return;
    const s = deps.agent.store();
    const holder = deps.agent.holder;
    const self = deps.agent.self;
    const file = deps.sessionFile();
    if (s === undefined || holder === undefined || self === undefined || file === undefined) return;
    let snap = s.read();
    if (snap.kind !== "ok") return;
    let reclaim: string | undefined;
    const infl = snap.state.digest.inflight;
    if (infl !== undefined) {
      if (sent !== undefined && infl.id === sent.id) return void (await verifyOwn());
      const verdict = judgeHolder(infl, self, {
        currentEpoch: deps.agent.epoch,
        epochDisposed: deps.isEpochDisposed,
      });
      if (verdict.liveness !== "dead") return; // alive / unprovable ⇒ respect the claim
      const proof = proofOf(infl.id, undefined);
      if (proof === undefined) return;
      if (proof.kind === "found" || proof.kind === "too-large") {
        await advance(deriveCoversAt(snap.state, infl.at), infl.id);
        if (proof.kind === "too-large") deps.notify("上一份定时任务提示无法核验（会话文件过大），不会重发。");
        const again = s.read();
        if (again.kind !== "ok") return;
        snap = again;
      } else if (proof.kind === "absent") {
        reclaim = infl.id; // confirmed absent + dead holder ⇒ safe to claim again
      } else return; // inconclusive / refused: retry on a later tick, never resend blindly
    }
    if (!allowNew || dead()) return;

    const anchor = sessionFileAnchor(file);
    if (anchor === undefined) return;
    const id = (deps.newId ?? (() => `dg_${randomBytes(8).toString("hex")}`))();
    const claimed = await s.transact<DigestContent | "busy" | "none">((draft, ctx) => {
      const cur = draft.digest.inflight;
      if (cur !== undefined && cur.id !== reclaim) return { value: "busy", write: false };
      const content = computeDigest(draft, ctx.now);
      if (content === undefined) {
        if (cur === undefined) return { value: "none", write: false };
        delete draft.digest.inflight; // stale claim, nothing left to tell
        return { value: "none", write: true };
      }
      draft.digest.inflight = { ...holder, id, at: ctx.now, fileOffset: anchor.offset };
      return { value: content, write: true };
    });
    if (!claimed.ok || typeof claimed.value === "string") return;
    const content = claimed.value;
    sent = { id, anchor, covers: content.covers };
    try {
      deps.sendMessage(
        {
          customType: SCHED_CUSTOM_TYPE,
          content: content.text,
          display: true,
          details: { kind: "digest", digestId: id, covers: content.covers },
        },
        { triggerTurn: false },
      );
    } catch (err) {
      warn(
        `send failed (claim stays; a later process verifies the file): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    deps.notify(content.summary);
    armVerify();
  }

  return {
    run: () => serial(() => resolveInflight(true)).catch((err) => warn(String(err))),
    tick: () => serial(() => resolveInflight(false)).catch((err) => warn(String(err))),
    dispose() {
      disposed = true;
      if (timer !== undefined) deps.clock.clearTimer(timer);
      timer = undefined;
    },
  };
}
