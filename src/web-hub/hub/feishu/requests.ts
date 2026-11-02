/** F6: durable singleton receive/ACK, debounce, deterministic batches, and query-only recovery. */
import { createHash } from "node:crypto";
import {
  FEISHU_CAPS,
  FEISHU_DEBOUNCE,
  FEISHU_IDENTITY,
  FEISHU_RECEIVED_BODY_MAX_BYTES,
  formatRequestHeader,
} from "../../protocol/feishu.js";
import type { ThreadMeta, ThreadRoutedResult, ThreadRunRef } from "../../protocol/thread.js";
import { computeRequestToken } from "./credentials.js";
import { systemFeishuClock, type FeishuClock } from "./http.js";
import type { FeishuAdmission, FeishuIdentityContext, FeishuInstallation } from "./admission.js";
import type { FeishuRequestRecord, FeishuState, NewRequestInput } from "./state.js";
import { feishuHandbackBody, feishuHandbackNote, threadRetainedRequests, type FeishuThreadGate } from "./thread-hub.js";

export const feishuDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
/** JSON framing is unambiguous even for ids containing ':' or sharing prefixes. */
export function feishuBatchIdentity(messageIds: readonly string[]): { batchId: string; id: string } {
  const batchId = feishuDigest(JSON.stringify([...messageIds].sort()));
  return { batchId, id: `fs${createHash("sha256").update(batchId).digest("base64url").slice(0, 30)}` };
}
export function feishuRequestText(record: FeishuRequestRecord, installSecret: string): string {
  if (record.payload === undefined) throw new Error("request-payload-missing");
  return `${formatRequestHeader(record.senderDisplay, record.chatLabel, computeRequestToken(installSecret, record.id))}\n${record.payload.body}`;
}
export type FeishuRequestEvent =
  | { type: "dispatching"; request: FeishuRequestRecord; text: string; thread?: true }
  | { type: "accepted"; request: FeishuRequestRecord; text: string; reactionEligible: boolean; recovered: boolean }
  | { type: "rejected" | "uncertain" | "expired"; request: FeishuRequestRecord; code: string }
  | { type: "merged"; request: FeishuRequestRecord; members: string[] }
  /** fabric-thread §8.1: a routed result went durable — the tracker was already detached and
   * the request migrated to `accepted{thr:routed}` (or straight to `replied{thread-routed}`
   * when over the §8.2 caps, `retained:false`). Service side: attachments→referenced, Typing
   * cleanup, receipt, retention timer. `runs` are the wire-validated subscribers. */
  | {
      type: "routed";
      request: FeishuRequestRecord;
      runs: ThreadRunRef[];
      retained: boolean;
      recovered: boolean;
    };
/** §8.3 handback outcome — mapped 1:1 onto the `thr_res` error vocabulary by the service. */
export type FeishuHandbackResult =
  | { ok: true; requestId: string; dup?: true }
  | {
      ok: false;
      code: "E_THR_STATE" | "E_THR_HANDBACK_GONE" | "E_THR_REBOUND" | "E_THR_REVOKED";
      effect: "none" | "unknown";
    };
export interface FeishuRequestsDeps {
  state: FeishuState;
  installation(): FeishuInstallation | undefined;
  admission: Pick<FeishuAdmission, "dispatch" | "resolve">;
  clock?: FeishuClock;
  debounceMs: number;
  staleMessageS: number;
  emit(event: FeishuRequestEvent): void;
  onHealth?(event: {
    degraded: true;
    reason: "persist-failed" | "background-failed" | "retry-full";
    operation: string;
  }): void;
  /** fabric-thread §4.2/§8: present iff `feishuBot.threads` exists — the attach gate, the routed
   *  result validation and the §8.2 retention caps. Absent ⇒ every cmd frame byte-identical. */
  threads?: FeishuThreadGate;
  /** §8.1 step 2: `runs.detach(id)` — clear the tracker's timers WITHOUT finishing it. */
  detachRun?(id: string): void;
}
export type FeishuReceiveInput = Omit<NewRequestInput, "id" | "batchId" | "textDigest">;
interface BufferEntry {
  ids: string[];
  context: string;
  timer: unknown;
}
export function createFeishuRequests(deps: FeishuRequestsDeps) {
  const clock = deps.clock ?? systemFeishuClock;
  const buffers = new Map<string, BufferEntry>();
  const inflight = new Set<string>();
  const queried = new Set<string>();
  const commitRetries = new Map<string, () => Promise<void>>();
  let retryTimer: unknown;
  let retrying = false;
  function health(reason: "persist-failed" | "background-failed" | "retry-full", operation: string): void {
    try {
      deps.onHealth?.({ degraded: true, reason, operation });
    } catch {
      /* A diagnostic sink cannot wedge request recovery. */
    }
  }
  function detached(work: Promise<void>, operation: string): void {
    void work.catch(() => {
      health("background-failed", operation);
    });
  }
  function armRetry(): void {
    if (disposed || retryTimer !== undefined || commitRetries.size === 0) return;
    retryTimer = clock.setTimeout(() => {
      retryTimer = undefined;
      detached(retryPending(), "retry");
    }, 1_000);
  }
  function park(id: string, run: () => Promise<void>, operation: string): void {
    health("persist-failed", operation);
    if (!commitRetries.has(id) && commitRetries.size >= FEISHU_CAPS.requestsNonTerminal) {
      health("retry-full", operation);
      return;
    }
    commitRetries.set(id, run);
    armRetry();
  }
  async function committed(id: string, operation: string, run: () => Promise<void>): Promise<void> {
    if (await deps.state.commit()) {
      if (!disposed) await run();
    } else park(id, run, operation);
  }
  async function retryPending(): Promise<void> {
    if (disposed || retrying || commitRetries.size === 0) return;
    retrying = true;
    try {
      if (!(await deps.state.commit())) {
        health("persist-failed", "retry");
        return;
      }
      const ready = [...commitRetries.values()];
      commitRetries.clear();
      for (const run of ready) {
        if (disposed) return;
        try {
          await run();
        } catch {
          health("background-failed", "retry");
        }
      }
    } finally {
      retrying = false;
      armRetry();
    }
  }
  let disposed = false;
  const delay = Math.max(0, Math.min(10_000, deps.debounceMs));
  function context(r: FeishuRequestRecord): string {
    return JSON.stringify([
      r.bindingKey,
      r.bindingRev,
      r.sessionId,
      r.senderOpenId,
      r.threadId ?? null,
      r.installGen,
      r.tenantKey,
    ]);
  }
  function identity(r: FeishuRequestRecord): FeishuIdentityContext | undefined {
    return r.installGen === undefined || r.tenantKey === undefined
      ? undefined
      : { installGen: r.installGen, tenantKey: r.tenantKey, senderOpenId: r.senderOpenId };
  }
  function emit(type: "rejected" | "uncertain" | "expired", id: string, code: string): void {
    const request = deps.state.requests.get(id);
    if (request !== undefined) deps.emit({ type, request, code });
  }
  function stale(r: FeishuRequestRecord): boolean {
    return r.sourceCreatedAt === undefined || clock.now() - r.sourceCreatedAt > deps.staleMessageS * 1_000;
  }
  async function reject(id: string, code: string, expired = false): Promise<void> {
    const to = expired ? "expired" : "rejected";
    if (deps.state.requests.transition(id, to, { code }).ok)
      await committed(id, "reject", async () => {
        if (deps.state.requests.get(id)?.state === to) emit(to, id, code);
      });
  }
  async function uncertain(id: string, code: string): Promise<void> {
    const current = deps.state.requests.get(id);
    const changed =
      current?.state === "uncertain"
        ? deps.state.requests.patch(id, { code })
        : deps.state.requests.transition(id, "uncertain", { code }).ok;
    if (changed)
      await committed(id, "uncertain", async () => {
        if (deps.state.requests.get(id)?.state === "uncertain") emit("uncertain", id, code);
      });
  }
  async function dispatch(id: string, queryOnly = false, beforeForwardRetry = false): Promise<void> {
    if (disposed || inflight.has(id)) return;
    const record = deps.state.requests.get(id);
    if (record === undefined || record.payload === undefined) return;
    if (
      queryOnly
        ? !(record.state === "dispatching" || record.state === "uncertain")
        : record.state !== (beforeForwardRetry ? "dispatching" : "received")
    )
      return;
    inflight.add(id);
    try {
      if (!queryOnly && stale(record)) {
        await reject(id, "stale", !beforeForwardRetry);
        return;
      }
      const install = deps.installation();
      const ctx = identity(record);
      if (
        install === undefined ||
        ctx === undefined ||
        ctx.installGen !== install.gen ||
        ctx.tenantKey !== deps.state.tenant.get()
      ) {
        if (!queryOnly) await reject(id, "installation-changed");
        else await uncertain(id, "installation-changed");
        return;
      }
      const text = feishuRequestText(record, install.installSecret);
      let agentKey = record.agentKey;
      if (!queryOnly && !beforeForwardRetry) {
        const route = deps.admission.resolve(record.sessionId);
        if (!route.ok) {
          await reject(id, route.code);
          return;
        }
        agentKey = route.agentKey;
      } else if (agentKey === undefined) {
        await uncertain(id, "agent-unknown");
        return;
      }
      if (!queryOnly) {
        // Freeze process cache for recovery; admission resolves AGAIN after the commit await.
        if (!beforeForwardRetry) {
          const changed = deps.state.requests.transition(id, "dispatching", {
            dispatchedAt: clock.now(),
            ...(agentKey ? { agentKey } : {}),
          });
          if (!changed.ok) return;
        }
        if (!(await deps.state.commit())) {
          park(id, async () => dispatch(id, false, true), "dispatch");
          return;
        }
      }
      if (disposed) return;
      if (!queryOnly && stale(record)) {
        await reject(id, "stale");
        return;
      }
      // fabric-thread §4.2: attach `cmd.thread` ONLY when the gate, the group topic and the
      // target agent's `thr.v1` cap all hold — otherwise the frame stays byte-identical (G2b).
      const threadMeta: ThreadMeta | undefined =
        deps.threads === undefined ? undefined : deps.threads.metaFor(deps.state.requests.get(id)!, agentKey);
      if (!queryOnly)
        deps.emit({
          type: "dispatching",
          request: deps.state.requests.get(id)!,
          text,
          // §8.1 结果竞争: candidates carry the flag — gap/epoch/session/consumed races defer to the result.
          ...(threadMeta !== undefined && threadMeta.bypass !== true ? { thread: true } : {}),
        });
      let outcome;
      try {
        outcome = await deps.admission.dispatch({
          ...ctx,
          id,
          sessionId: record.sessionId,
          bindingKey: record.bindingKey,
          bindingRev: record.bindingRev,
          ...(queryOnly ? { queryOnly: true } : {}),
          ...(agentKey ? { expectedAgentKey: agentKey } : {}),
          cmd: {
            op: "prompt",
            deliver: "followUp",
            expect: { sessionId: record.sessionId },
            text,
            ...(threadMeta !== undefined ? { thread: threadMeta } : {}),
          },
        });
      } catch {
        if (disposed) return;
        await uncertain(id, "router-threw");
        return;
      }
      // F8: a stopped/reset installation must not mutate its successor from a late router result.
      if (disposed) return;
      if (queryOnly) {
        if (!outcome.ok || !outcome.result.ok) {
          await uncertain(
            id,
            outcome.ok ? (!outcome.result.ok ? outcome.result.code : "query-incomplete") : outcome.code,
          );
          return;
        }
        const data = outcome.result.data;
        if (
          data === null ||
          typeof data !== "object" ||
          data.op !== "query" ||
          (data.state !== "ok" && data.state !== "failed") ||
          data.result === null ||
          typeof data.result !== "object" ||
          typeof data.result.ok !== "boolean" ||
          (data.state === "ok") !== data.result.ok
        ) {
          const code = data?.op === "query" && data.state === "running" ? "query-running" : "query-incomplete";
          await uncertain(id, code);
          return;
        }
        outcome = { ...outcome, result: { t: "cmd_result", rid: outcome.result.rid, id, ...data.result } };
      }
      if (outcome.ok && outcome.result.ok) {
        // fabric-thread §8.1: the routed branch wins over the plain accepted path — detach the
        // tracker FIRST (same sync step), then migrate, then commit; commit failure parks the
        // receipt (no回执 until the retry succeeds).
        const routed =
          deps.threads === undefined ? undefined : deps.threads.routedResultOk(outcome.result.data, outcome.agentKey);
        if (routed !== undefined) {
          await routedOutcome(id, routed, outcome.agentKey, queryOnly);
          return;
        }
        const transitioned = deps.state.requests.transition(id, "accepted", { agentKey: outcome.agentKey });
        if (transitioned.ok)
          await committed(id, "accepted", async () => {
            if (deps.state.requests.get(id)?.state !== "accepted") return;
            deps.emit({
              type: "accepted",
              request: transitioned.record,
              text,
              reactionEligible:
                !queryOnly &&
                record.sourceCreatedAt !== undefined &&
                clock.now() - record.sourceCreatedAt < FEISHU_IDENTITY.reactionMaxAgeMs,
              recovered: queryOnly,
            });
          });
      } else {
        const code = outcome.ok ? (!outcome.result.ok ? outcome.result.code : "unknown") : outcome.code;
        const uncertainEffect =
          outcome.ok && !outcome.result.ok && (outcome.result.effect === "unknown" || code === "E_DEADLINE");
        const to = uncertainEffect ? "uncertain" : "rejected";
        if (to === "uncertain") await uncertain(id, code);
        else await reject(id, code);
      }
    } finally {
      inflight.delete(id);
    }
  }
  /** §8.1 steps 1–4: detach → migrate `accepted{thr:routed}` → (§8.2 caps ⇒ immediate
   *  `replied{thread-routed}`) → commit → emit `routed`. Shared by dispatch (live + queryOnly
   *  recovery) and `lateRouted` (uncertain + cmd_late). */
  async function routedOutcome(
    id: string,
    routed: ThreadRoutedResult,
    agentKey: string | undefined,
    recovered: boolean,
  ): Promise<void> {
    deps.detachRun?.(id); // BEFORE the migration, same synchronous step (no tracker spans the commit)
    const candidateBytes = Buffer.byteLength(deps.state.requests.get(id)?.payload?.body ?? "");
    const transitioned = deps.state.requests.transition(id, "accepted", {
      ...(agentKey !== undefined ? { agentKey } : {}),
      code: "thr:routed",
    });
    if (!transitioned.ok) return;
    const retained = !(deps.threads?.retainWouldExceed(id, candidateBytes) ?? false);
    if (!retained) deps.state.requests.transition(id, "replied", { code: "thread-routed" });
    await committed(id, "routed", async () => {
      const current = deps.state.requests.get(id);
      if (
        current === undefined ||
        !(
          (current.state === "accepted" && current.code === "thr:routed") ||
          (current.state === "replied" && current.code === "thread-routed")
        )
      )
        return;
      deps.emit({ type: "routed", request: current, runs: routed.runs, retained, recovered });
    });
  }
  /** §8.1 晚到 cmd_late: `uncertain` + a routed late result ⇒ the same routed branch; anything
   *  else stays untouched (the existing resend card already covers it). */
  async function lateRouted(id: string, data: unknown, agentKey: string): Promise<void> {
    if (disposed || inflight.has(id)) return;
    const current = deps.state.requests.get(id);
    if (current === undefined || current.state !== "uncertain") return;
    const routed = deps.threads === undefined ? undefined : deps.threads.routedResultOk(data, agentKey);
    if (routed === undefined) return;
    inflight.add(id);
    try {
      await routedOutcome(id, routed, agentKey, true);
    } finally {
      inflight.delete(id);
    }
  }
  /** §8.3 handback (r3-2: 先认后继、再验源). The deterministic successor id
   *  (`feishuBatchIdentity(["thb:"+eventId])`) makes every repeat/concurrent call return the
   *  SAME requestId; the persistence barrier never ACKs a memory-only successor. */
  async function handback(input: {
    eventId: string;
    sessionId: string;
    by: ThreadRunRef | "system";
    note: string;
    ctx: { installGen: number; tenantKey: string };
  }): Promise<FeishuHandbackResult> {
    // Step 1 — caller recheck on EVERY call (first or repeat).
    const install = deps.installation();
    if (!install?.active || install.gen !== input.ctx.installGen || input.ctx.tenantKey !== deps.state.tenant.get())
      return { ok: false, code: "E_THR_STATE", effect: "none" };
    const ids = feishuBatchIdentity([`thb:${input.eventId}`]);
    const successor = deps.state.requests.get(ids.id);
    const source = deps.state.requests.get(input.eventId);
    if (successor !== undefined) {
      // Step 2 — successor identity + revocation, then the barrier.
      if (
        successor.batchId !== ids.batchId ||
        successor.sessionId !== input.sessionId ||
        (source !== undefined && successor.sessionId !== source.sessionId)
      )
        return { ok: false, code: "E_THR_STATE", effect: "none" };
      if (!deps.state.allowList.has(successor.senderOpenId))
        return {
          ok: false,
          code: "E_THR_REVOKED",
          effect:
            successor.state === "received" || successor.state === "revoked" || successor.state === "rejected"
              ? "none"
              : "unknown",
        };
      if (await deps.state.commit()) return { ok: true, requestId: ids.id, dup: true };
      return { ok: false, code: "E_THR_STATE", effect: "unknown" };
    }
    // Step 3 — only WITHOUT a successor is the source validated.
    if (
      source === undefined ||
      source.state !== "accepted" ||
      source.code !== "thr:routed" ||
      source.payload === undefined
    )
      return { ok: false, code: "E_THR_HANDBACK_GONE", effect: "none" };
    if (source.sessionId !== input.sessionId) return { ok: false, code: "E_THR_STATE", effect: "none" };
    if (!deps.state.allowList.has(source.senderOpenId)) return { ok: false, code: "E_THR_REVOKED", effect: "none" };
    const binding = deps.state.bindings.get(source.bindingKey);
    if (binding?.rev !== source.bindingRev || binding.sessionId !== source.sessionId || binding.offline !== undefined)
      return { ok: false, code: "E_THR_REBOUND", effect: "none" };
    // Steps 4–6 — successor content, receive + source finalization in ONE sync step, then commit.
    const body = feishuHandbackBody(
      feishuHandbackNote({ by: input.by, sourceCreatedAt: source.sourceCreatedAt, note: input.note }),
      source.payload.body,
    );
    const received = deps.state.requests.receive({
      id: ids.id,
      batchId: ids.batchId,
      sessionId: source.sessionId,
      bindingKey: source.bindingKey,
      bindingRev: source.bindingRev,
      senderOpenId: source.senderOpenId,
      senderDisplay: source.senderDisplay,
      chatLabel: source.chatLabel,
      chatId: source.chatId,
      chatType: source.chatType,
      ...(source.threadId ? { threadId: source.threadId } : {}),
      triggerMessageId: source.triggerMessageId,
      textDigest: feishuDigest(body),
      payload: { body, uploadIds: [...source.payload.uploadIds], messageIds: [`thb:${input.eventId}`] },
      sourceCreatedAt: clock.now(), // internal re-dispatch time — passes the stale check (resend() precedent)
      installGen: input.ctx.installGen,
      tenantKey: input.ctx.tenantKey,
    });
    if (!received.ok) return { ok: false, code: "E_THR_STATE", effect: "none" };
    deps.state.requests.transition(source.id, "replied", { code: "thread-handback" });
    if (await deps.state.commit()) {
      release(ids.id); // into the normal debounce/dispatch (bypass ⇒ native path, §5.5)
      return { ok: true, requestId: ids.id };
    }
    park(
      ids.id,
      async () => {
        release(ids.id);
      },
      "handback",
    );
    return { ok: false, code: "E_THR_STATE", effect: "unknown" };
  }
  async function close(entry: BufferEntry): Promise<void> {
    clock.clearTimeout(entry.timer);
    const first = deps.state.requests.get(entry.ids[0] ?? "");
    if (first === undefined) return;
    if (buffers.get(first.chatId) === entry) buffers.delete(first.chatId);
    const members: FeishuRequestRecord[] = [];
    for (const id of entry.ids) {
      const r = deps.state.requests.get(id);
      if (r?.state !== "received" || r.payload === undefined) continue;
      const b = deps.state.bindings.get(r.bindingKey);
      if (stale(r)) {
        await reject(id, "stale", true);
        continue;
      }
      if (b?.rev !== r.bindingRev || b.sessionId !== r.sessionId) {
        await reject(id, "binding-changed");
        continue;
      }
      members.push(r);
    }
    for (let i = members.length - 1; i >= 0; i--) {
      if (deps.state.requests.get(members[i]!.id)?.state !== "received") members.splice(i, 1);
    }
    if (members.length === 0 || disposed) return;
    if (members.length === 1) {
      await dispatch(members[0]!.id);
      return;
    }
    const lead = members[0]!;
    const payload = {
      body: members.map((r) => r.payload!.body).join("\n"),
      messageIds: members.flatMap((r) => r.payload!.messageIds),
      uploadIds: members.flatMap((r) => r.payload!.uploadIds),
    };
    const ids = feishuBatchIdentity(payload.messageIds);
    const input: NewRequestInput = {
      id: ids.id,
      batchId: ids.batchId,
      sessionId: lead.sessionId,
      bindingKey: lead.bindingKey,
      bindingRev: lead.bindingRev,
      senderOpenId: lead.senderOpenId,
      senderDisplay: lead.senderDisplay,
      chatLabel: lead.chatLabel,
      chatId: lead.chatId,
      chatType: lead.chatType,
      ...(lead.threadId ? { threadId: lead.threadId } : {}),
      triggerMessageId: lead.triggerMessageId,
      textDigest: feishuDigest(payload.body),
      payload,
      sourceCreatedAt: Math.min(...members.map((r) => r.sourceCreatedAt!)),
      ...(lead.installGen === undefined ? {} : { installGen: lead.installGen }),
      ...(lead.tenantKey === undefined ? {} : { tenantKey: lead.tenantKey }),
    };
    // No await from receive through all member transitions: one atomic state snapshot/commit.
    const batch = deps.state.requests.receive(input);
    if (!batch.ok) {
      // At cap we do not lose durable singleton payloads or fake a rejection. Run singly.
      for (const member of members) await dispatch(member.id);
      return;
    }
    for (const member of members) deps.state.requests.transition(member.id, "merged", { mergedBatchId: ids.batchId });
    await committed(ids.id, "batch", async () => {
      deps.emit({ type: "merged", request: batch.value, members: members.map((r) => r.id) });
      await dispatch(ids.id);
    });
  }
  function release(id: string): void {
    if (disposed) return;
    const r = deps.state.requests.get(id);
    if (r?.state !== "received" || r.payload === undefined) return;
    const old = buffers.get(r.chatId);
    if (old?.ids.includes(id)) return;
    const ctx = context(r);
    const prior =
      old?.ids.map((n) => deps.state.requests.get(n)).filter((m): m is FeishuRequestRecord => m !== undefined) ?? [];
    const uploads = prior.reduce((n, m) => n + (m.payload?.uploadIds.length ?? 0), 0) + r.payload.uploadIds.length;
    const bytes =
      prior.reduce((n, m) => n + Buffer.byteLength(m.payload?.body ?? "") + 1, 0) + Buffer.byteLength(r.payload.body);
    const count = prior.reduce((n, m) => n + (m.payload?.messageIds.length ?? 0), 0) + r.payload.messageIds.length;
    if (
      old !== undefined &&
      (old.context !== ctx ||
        uploads > FEISHU_DEBOUNCE.maxAttachments ||
        bytes > FEISHU_RECEIVED_BODY_MAX_BYTES ||
        count > 64)
    )
      detached(close(old), "close");
    let entry = buffers.get(r.chatId);
    if (
      entry === undefined ||
      entry.context !== ctx ||
      (entry === old &&
        (uploads > FEISHU_DEBOUNCE.maxAttachments || bytes > FEISHU_RECEIVED_BODY_MAX_BYTES || count > 64))
    ) {
      if (buffers.size >= FEISHU_CAPS.debounceBufferChats) {
        detached(dispatch(id), "dispatch");
        return;
      }
      entry = { ids: [], context: ctx, timer: undefined };
      buffers.set(r.chatId, entry);
    }
    entry.ids.push(id);
    clock.clearTimeout(entry.timer);
    const current = entry;
    if (
      delay === 0 ||
      entry.ids.reduce((n, i) => n + (deps.state.requests.get(i)?.payload?.uploadIds.length ?? 0), 0) >=
        FEISHU_DEBOUNCE.maxAttachments
    )
      detached(close(entry), "close");
    else
      entry.timer = clock.setTimeout(() => {
        detached(close(current), "close");
      }, delay);
  }
  return {
    /** Synchronous memory mutation ONLY. Inbound adds dedup and commits before release/ACK. */
    receive(input: FeishuReceiveInput) {
      if (
        input.payload.messageIds.length === 0 ||
        new Set(input.payload.messageIds).size !== input.payload.messageIds.length
      )
        return { ok: false as const, refused: "invalid" as const };
      const install = deps.installation();
      if (
        !install?.active ||
        !deps.state.allowList.has(input.senderOpenId) ||
        (input.installGen !== undefined && input.installGen !== install.gen) ||
        (input.tenantKey !== undefined && input.tenantKey !== deps.state.tenant.get())
      )
        return { ok: false as const, refused: "unavailable" as const };
      const ids = feishuBatchIdentity(input.payload.messageIds);
      const old = deps.state.requests.get(ids.id);
      if (old !== undefined) return { ok: true as const, value: old };
      return deps.state.requests.receive({ ...input, ...ids, textDigest: feishuDigest(input.payload.body) });
    },
    /** Explicit user-confirmed retry only. Synthetic callback membership creates a NEW cmdId. */
    resend(sourceId: string, eventId: string, ctx: FeishuIdentityContext) {
      const source = deps.state.requests.get(sourceId);
      const install = deps.installation();
      if (
        !source?.payload ||
        source.state !== "uncertain" ||
        !/^[A-Za-z0-9_.:-]{1,100}$/.test(eventId) ||
        !install?.active ||
        install.gen !== ctx.installGen ||
        ctx.tenantKey !== deps.state.tenant.get() ||
        source.installGen !== ctx.installGen ||
        source.tenantKey !== ctx.tenantKey ||
        source.senderOpenId !== ctx.senderOpenId ||
        !deps.state.allowList.has(ctx.senderOpenId)
      )
        return { ok: false as const, refused: "invalid" as const };
      const binding = deps.state.bindings.get(source.bindingKey);
      if (binding?.rev !== source.bindingRev || binding.sessionId !== source.sessionId || binding.offline !== undefined)
        return { ok: false as const, refused: "invalid" as const };
      const ids = feishuBatchIdentity([`resend:${eventId}`]);
      const existing = deps.state.requests.get(ids.id);
      if (existing !== undefined) return { ok: true as const, value: existing };
      return deps.state.requests.receive({
        ...ids,
        sessionId: source.sessionId,
        bindingKey: source.bindingKey,
        bindingRev: source.bindingRev,
        senderOpenId: source.senderOpenId,
        senderDisplay: source.senderDisplay,
        chatLabel: source.chatLabel,
        chatId: source.chatId,
        chatType: source.chatType,
        ...(source.threadId ? { threadId: source.threadId } : {}),
        triggerMessageId: source.triggerMessageId,
        textDigest: source.textDigest,
        payload: {
          body: source.payload.body,
          uploadIds: [...source.payload.uploadIds],
          messageIds: [`resend:${eventId}`],
        },
        sourceCreatedAt: clock.now(),
        installGen: ctx.installGen,
        tenantKey: ctx.tenantKey,
      });
    },
    release,
    /** §8.1 晚到 cmd_late routed 恢复（service 在 bus cmd_late 事件上调用）。 */
    lateRouted,
    /** §8.3 专用接口：确定性后继 + 持久化屏障；与 resend() 同级的复核链。 */
    handback,
    /** Also callable by F8 when the shared persistence health signal heals. */
    retryPending,
    get pendingRetries() {
      return commitRetries.size;
    },
    async flushChat(chatId: string) {
      const entry = buffers.get(chatId);
      if (entry !== undefined) await close(entry);
    },
    async recover() {
      // Never re-forward dispatching/uncertain, even when the agent ledger returns E_UNKNOWN_ID.
      const pending = deps.state.requests.list({ states: ["received", "dispatching", "uncertain"] });
      const ids = new Set(pending.map((r) => r.id));
      for (const id of queried) if (!ids.has(id)) queried.delete(id);
      for (const r of pending) {
        if (r.state === "received") await dispatch(r.id);
        else if (!queried.has(r.id) && !inflight.has(r.id)) {
          queried.add(r.id);
          await dispatch(r.id, true);
        }
      }
    },
    async revokeSender(openId: string) {
      deps.state.allowList.remove(openId);
      for (const [chatId, entry] of buffers) {
        entry.ids = entry.ids.filter((id) => deps.state.requests.get(id)?.senderOpenId !== openId);
        if (entry.ids.length === 0) {
          clock.clearTimeout(entry.timer);
          buffers.delete(chatId);
        }
      }
      deps.state.nonces.purgeOperator(openId);
      const ids = deps.state.requests.revokeSender(openId);
      // fabric-thread §8.2 撤权: state.revokeSender only sweeps `received` — the retained
      // `thr:routed` of the same sender finalize here (`replied{thread-revoked}`, payload dropped).
      for (const r of threadRetainedRequests(deps.state))
        if (r.senderOpenId === openId) deps.state.requests.transition(r.id, "replied", { code: "thread-revoked" });
      await committed(`revoke:${openId}`, "revocation", async () => {});
      return ids;
    },
    dispose() {
      disposed = true;
      for (const e of buffers.values()) clock.clearTimeout(e.timer);
      buffers.clear();
      queried.clear();
      clock.clearTimeout(retryTimer);
      retryTimer = undefined;
      commitRetries.clear();
    },
    get bufferedChats() {
      return buffers.size;
    },
  };
}
export type FeishuRequests = ReturnType<typeof createFeishuRequests>;
