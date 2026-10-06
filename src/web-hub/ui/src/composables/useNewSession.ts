/**
 * The plan §3.2 new-session orchestrator (web-hub-spawn SP11). Owns the whole UI-side state
 * machine for 「选择目录新建」 — `idle → submitting → (409 ⇒ confirming) → awaiting → done |
 * failed`, plus `unknown` (the local watchdog fired; keep listening — SSE reconnect
 * snapshots still settle the flow). The state is LOCAL (a shallowRef here), never in the
 * reducer: nothing about an in-flight spawn intent belongs to the shared SSE-driven state,
 * and the hub's own `spawns` slot (fed back in via `noteSpawns`) is the only cross-tab view.
 *
 * Invariants (§3.2 rows, each pinned by `tests/web-hub/ui/use-new-session.test.ts`):
 *
 * - **Idempotency**: the request id is one `newCmdId()` per flow (`@logic/control.js` — K18,
 *   never `crypto.randomUUID`). A network error / 16s timeout before the 202 resends the
 *   SAME id exactly once; the hub's idempotency LRU dedupes it (`dup:true`, never a second
 *   record). A 409 `E_CONFIRM_REQUIRED` keeps the id; `confirm()` resends it with
 *   `confirm:true` + `expectCwd:resolvedCwd`. `retry()` after a failure uses a NEW id.
 * - **「我发起的」**: navigation to `#/agent/<key>` on `live` only happens when the record's
 *   `origin.reqId` is one of this tab's ids (`@logic/spawn.js`'s `isMine`) — another tab's
 *   spawns never hijack this one's view.
 * - **First-prompt body retention**: the body lives ONLY in a closure `Map<reqId, text>`
 *   (memory, never storage — source-scan rule unchanged). On `failed`/`expired` it goes back
 *   to the composer draft via `control.setDraft(agentKey, text)` when the record has an
 *   `agentKey`, otherwise back to the DirPicker (`refilled:"picker"`, the body rides the
 *   flow's `input`). The map entry is deleted on deliver AND on every refill (`stats()` pins
 *   it) — a superseded flow's entry is dropped too.
 * - **No double submit**: a `submit()` while `submitting` returns `false` without touching
 *   the wire (double-click guard).
 *
 * Timers: exactly one (the `registerTimeoutS*1000 + 15_000` awaiting watchdog, from the last
 * known `SpawnPolicyWire`, default 30s when no list() ever succeeded), cleared on settle /
 * supersede / `dispose()`. No rAF, no intervals.
 */
import { shallowRef, type Ref } from "vue";
import { newCmdId } from "@logic/control.js";
import { classifySpawnError, isMine } from "@logic/spawn.js";
import type { SpawnPolicyWire, SpawnRecordPublic, SpawnRequestBody, SpawnsPayload } from "@protocol/spawn.js";
import type { SpawnOutcome } from "../transport/types.js";
import type { ControlHandle, FirstPromptMirror, NewSessionFlow, NewSessionHandle, NewSessionInput } from "../types.js";

/** plan §3.2: awaiting watchdog = `registerTimeoutS*1000 + 15_000` (policy default 30s). */
const REGISTER_TIMEOUT_DEFAULT_S = 30;
const AWAITING_SLACK_MS = 15_000;
/** FIFO caps for the local id/text memories (a tab never accumulates unbounded flows). */
const LOCAL_MEMORY_CAP = 64;

export interface NewSessionDeps<TTimer = ReturnType<typeof setTimeout>> {
  /** `useSpawn`'s `start` (already capability-degraded to E_UNSUPPORTED when absent). */
  start(req: SpawnRequestBody): Promise<SpawnOutcome>;
  /** Latest known policy (from the last successful `list()`) — drives the awaiting watchdog. */
  policy?(): SpawnPolicyWire | undefined;
  /** default-model plan F1 (D4 二次 cap 守卫): may `model` go on the wire at all (`spawn.model.v1`
   * advertised)? Absent/false ⇒ the field is silently dropped from the POST body — the caller
   * (SpawnRow retry, F2's DirPicker) may set `input.model` unconditionally. */
  modelCap?(): boolean;
  /** Draft refill target (§3.2 首条消息结果 row). Absent ⇒ picker refill instead. */
  control?: ControlHandle | undefined;
  /** `live` navigation target (`#/agent/<key>` — useHub wires the route event / hash). */
  navigate?(agentKey: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): TTimer;
  clearTimeout(handle: TTimer): void;
  /** Test seam; defaults to `@logic/control.js`'s `newCmdId`. */
  newId?(): string;
}

type AwaitingLike = Extract<NewSessionFlow, { phase: "awaiting" | "unknown" }>;

export function createNewSession<TTimer = ReturnType<typeof setTimeout>>(
  deps: NewSessionDeps<TTimer>,
): NewSessionHandle {
  const newId = deps.newId ?? (() => newCmdId());
  const flow = shallowRef<NewSessionFlow>({ phase: "idle" }) as Ref<NewSessionFlow>;
  /** reqId → first-prompt body, memory only (never storage) — see the header's retention rule. */
  const texts = new Map<string, string>();
  /** reqIds this tab originated (the `isMine` input), insertion-ordered FIFO. */
  const mine = new Set<string>();
  let awaitTimer: TTimer | null = null;
  let disposed = false;

  function clearAwaitTimer(): void {
    if (awaitTimer !== null) {
      deps.clearTimeout(awaitTimer);
      awaitTimer = null;
    }
  }

  function remember(reqId: string, input: NewSessionInput): void {
    mine.add(reqId);
    while (mine.size > LOCAL_MEMORY_CAP) {
      const oldest = mine.values().next().value;
      if (oldest === undefined) break;
      mine.delete(oldest);
      texts.delete(oldest);
    }
    if (input.firstPrompt !== undefined) {
      texts.set(reqId, input.firstPrompt.text);
      while (texts.size > LOCAL_MEMORY_CAP) {
        const oldest = texts.keys().next().value;
        if (oldest === undefined) break;
        texts.delete(oldest);
      }
    }
  }

  /** §3.2 submitting row: a network error / timeout resends the SAME id exactly once. */
  async function sendWithOneRetry(body: SpawnRequestBody): Promise<SpawnOutcome> {
    const first = await deps.start(body);
    if (first.ok === false && (first.error === "E_NETWORK" || first.error === "E_DEADLINE")) {
      return deps.start(body); // hub idempotency LRU dedupes the same id ⇒ dup:true
    }
    return first;
  }

  function armAwaitTimeout(reqId: string, spawnId: string, input: NewSessionInput): void {
    clearAwaitTimer();
    const timeoutS = deps.policy?.()?.registerTimeoutS ?? REGISTER_TIMEOUT_DEFAULT_S;
    awaitTimer = deps.setTimeout(
      () => {
        awaitTimer = null;
        if (disposed) return;
        const cur = flow.value;
        if (cur.phase === "awaiting" && cur.spawnId === spawnId) {
          // 状态未知 — keep listening; a later SSE snapshot still settles this flow.
          flow.value = { phase: "unknown", reqId, spawnId, input };
        }
      },
      timeoutS * 1000 + AWAITING_SLACK_MS,
    );
  }

  /** Shared 202/409/error settlement for submit() and confirm() (§3.2 submitting/confirming rows). */
  function settleStartOutcome(reqId: string, input: NewSessionInput, outcome: SpawnOutcome): void {
    if (outcome.ok === true) {
      flow.value = { phase: "awaiting", reqId, spawnId: outcome.data.spawnId, input };
      armAwaitTimeout(reqId, outcome.data.spawnId, input);
      return;
    }
    if (outcome.error === "E_CONFIRM_REQUIRED") {
      flow.value = {
        phase: "confirming",
        reqId,
        input,
        resolvedCwd: outcome.resolvedCwd ?? input.cwd,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      };
      return;
    }
    // Start failed: no record will ever deliver the first prompt — drop the retention and
    // surface the taxonomy (§3.2: 其他错误 ⇒ DirPicker 内显示，保留输入).
    texts.delete(reqId);
    flow.value = {
      phase: "failed",
      kind: classifySpawnError(outcome) ?? "network",
      reqId,
      input,
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      ...(outcome.retryAfterS !== undefined ? { retryAfterS: outcome.retryAfterS } : {}),
    };
  }

  function firstPromptMirrorOf(rec: SpawnRecordPublic): FirstPromptMirror | undefined {
    const fp = rec.firstPrompt;
    if (fp === undefined) return undefined;
    return { state: fp.state, ...(fp.code !== undefined ? { code: fp.code } : {}) };
  }

  /** Terminal failed/expired first prompt: draft refill with agentKey, picker refill without (§3.2). */
  function refillFirstPrompt(
    cur: AwaitingLike,
    fp: { state: "failed" | "expired"; code?: string },
    agentKey: string | undefined,
    terminal: boolean,
  ): void {
    const text = texts.get(cur.reqId);
    texts.delete(cur.reqId);
    const mirror: FirstPromptMirror = { state: fp.state, ...(fp.code !== undefined ? { code: fp.code } : {}) };
    if (agentKey !== undefined && text !== undefined && deps.control !== undefined) {
      deps.control.setDraft(agentKey, text); // 回填草稿并提示
      if (terminal) {
        flow.value = {
          phase: "failed",
          kind: "first-prompt",
          reqId: cur.reqId,
          spawnId: cur.spawnId,
          agentKey,
          input: cur.input,
          refilled: "draft",
          ...(fp.code !== undefined ? { code: fp.code } : {}),
        };
      } else {
        flow.value = {
          phase: "done",
          spawnId: cur.spawnId,
          agentKey,
          firstPrompt: { ...mirror, refilled: "draft" },
        };
      }
      return;
    }
    // 没有 agentKey ⇒ 留在 DirPicker (the body rides the flow's input)
    flow.value = {
      phase: "failed",
      kind: "first-prompt",
      reqId: cur.reqId,
      spawnId: cur.spawnId,
      input: cur.input,
      refilled: "picker",
      ...(fp.code !== undefined ? { code: fp.code } : {}),
    };
  }

  function handleRecord(cur: AwaitingLike, rec: SpawnRecordPublic): void {
    if (rec.state === "live") {
      clearAwaitTimer();
      const agentKey = typeof rec.agentKey === "string" ? rec.agentKey : undefined;
      // 仅「我发起的」自动跳转 (§3.2) — another tab's record never navigates this one.
      if (agentKey !== undefined && isMine(rec, mine)) deps.navigate?.(agentKey);
      if (cur.input.firstPrompt === undefined) {
        texts.delete(cur.reqId);
        flow.value = { phase: "done", spawnId: cur.spawnId, ...(agentKey !== undefined ? { agentKey } : {}) };
        return;
      }
      const fp = rec.firstPrompt;
      if (fp === undefined || fp.state === "pending" || fp.state === "sending") {
        // firstPrompt not settled yet — keep awaiting, mirror what we know (SSE drives from here).
        flow.value = {
          phase: "awaiting",
          reqId: cur.reqId,
          spawnId: cur.spawnId,
          input: cur.input,
          ...(fp !== undefined
            ? { firstPrompt: { state: fp.state, ...(fp.code !== undefined ? { code: fp.code } : {}) } }
            : {}),
        };
        return;
      }
      if (fp.state === "delivered") {
        texts.delete(cur.reqId);
        flow.value = {
          phase: "done",
          spawnId: cur.spawnId,
          ...(agentKey !== undefined ? { agentKey } : {}),
          firstPrompt: { state: "delivered" },
        };
        return;
      }
      refillFirstPrompt(cur, { state: fp.state, ...(fp.code !== undefined ? { code: fp.code } : {}) }, agentKey, false);
      return;
    }
    if (rec.state === "failed" || rec.state === "exited") {
      clearAwaitTimer();
      const agentKey = typeof rec.agentKey === "string" ? rec.agentKey : undefined;
      const fp = rec.firstPrompt;
      if (fp !== undefined && (fp.state === "failed" || fp.state === "expired")) {
        // expired{never_live|stopped} — 正文回填 (draft when somehow bound, picker otherwise).
        refillFirstPrompt(
          cur,
          { state: fp.state, ...(fp.code !== undefined ? { code: fp.code } : {}) },
          agentKey,
          true,
        );
        return;
      }
      const text = texts.get(cur.reqId);
      texts.delete(cur.reqId);
      // A retained body still goes back: draft when the record had bound an agent, picker
      // otherwise (same rule as the explicit firstPrompt failed/expired slot above).
      if (text !== undefined && agentKey !== undefined && deps.control !== undefined) {
        deps.control.setDraft(agentKey, text);
        flow.value = {
          phase: "failed",
          kind: "spawn",
          reqId: cur.reqId,
          spawnId: cur.spawnId,
          input: cur.input,
          agentKey,
          refilled: "draft",
          ...(rec.hint !== undefined ? { hint: rec.hint } : {}),
          ...(rec.endReason !== undefined ? { code: rec.endReason } : {}),
        };
        return;
      }
      // failed ⇒ 显示 hint，「详情」走 GET 取 owner 明细 (SpawnRow/SP12 reads the hint off the flow).
      flow.value = {
        phase: "failed",
        kind: "spawn",
        reqId: cur.reqId,
        spawnId: cur.spawnId,
        input: cur.input,
        ...(agentKey !== undefined ? { agentKey } : {}),
        ...(text !== undefined ? { refilled: "picker" as const } : {}),
        ...(rec.hint !== undefined ? { hint: rec.hint } : {}),
        ...(rec.endReason !== undefined ? { code: rec.endReason } : {}),
      };
      return;
    }
    // starting/stopping: mirror a settled-looking firstPrompt slot if the hub already reports one.
    if (cur.phase === "awaiting") {
      const mirror = firstPromptMirrorOf(rec);
      if (mirror !== undefined && mirror.state !== cur.firstPrompt?.state) {
        flow.value = { ...cur, firstPrompt: mirror };
      }
    }
  }

  return {
    flow: flow as Readonly<Ref<NewSessionFlow>>,

    async submit(input: NewSessionInput): Promise<boolean> {
      if (disposed) return false;
      if (flow.value.phase === "submitting") return false; // 重复点击提交 ⇒ 只发一次请求
      clearAwaitTimer();
      // A superseded flow's retained text is dropped — only one flow is ever tracked.
      const prev = flow.value;
      if ("reqId" in prev && typeof prev.reqId === "string") texts.delete(prev.reqId);
      const reqId = newId();
      remember(reqId, input);
      flow.value = { phase: "submitting", reqId, input };
      const body: SpawnRequestBody = {
        id: reqId,
        cwd: input.cwd,
        ...(input.model !== undefined && deps.modelCap?.() === true ? { model: input.model } : {}),
        ...(input.firstPrompt !== undefined ? { firstPrompt: input.firstPrompt } : {}),
      };
      const outcome = await sendWithOneRetry(body);
      if (disposed) return true;
      settleStartOutcome(reqId, input, outcome);
      return true;
    },

    async confirm(): Promise<void> {
      const cur = flow.value;
      if (cur.phase !== "confirming") return;
      flow.value = { phase: "submitting", reqId: cur.reqId, input: cur.input };
      const body: SpawnRequestBody = {
        id: cur.reqId, // 同一 id + confirm + expectCwd (§3.2 confirming row)
        cwd: cur.input.cwd,
        confirm: true,
        expectCwd: cur.resolvedCwd,
        ...(cur.input.model !== undefined && deps.modelCap?.() === true ? { model: cur.input.model } : {}),
        ...(cur.input.firstPrompt !== undefined ? { firstPrompt: cur.input.firstPrompt } : {}),
      };
      const outcome = await sendWithOneRetry(body);
      if (disposed) return;
      settleStartOutcome(cur.reqId, cur.input, outcome);
    },

    cancel(): void {
      const cur = flow.value;
      if (cur.phase === "confirming") {
        texts.delete(cur.reqId); // 取消 ⇒ idle (nothing was ever created hub-side)
        flow.value = { phase: "idle" };
        return;
      }
      if (cur.phase === "failed" || cur.phase === "done" || cur.phase === "unknown") {
        if (cur.phase !== "done" && "reqId" in cur && typeof cur.reqId === "string") texts.delete(cur.reqId);
        if (cur.phase === "unknown") clearAwaitTimer();
        flow.value = { phase: "idle" };
      }
    },

    async retry(): Promise<boolean> {
      const cur = flow.value;
      if (cur.phase !== "failed" || cur.input === undefined) return false;
      const input = cur.input;
      flow.value = { phase: "idle" };
      return this.submit(input); // 失败后重试 ⇒ 新的 id (§3.2)
    },

    noteSpawns(payload: SpawnsPayload | null): void {
      if (disposed) return;
      const cur = flow.value;
      if (cur.phase !== "awaiting" && cur.phase !== "unknown") return;
      const items = payload && typeof payload === "object" && Array.isArray(payload.items) ? payload.items : [];
      const rec = items.find((it) => it !== null && typeof it === "object" && it.spawnId === cur.spawnId);
      if (rec === undefined) return;
      handleRecord(cur, rec);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearAwaitTimer();
      texts.clear();
      mine.clear();
    },

    stats(): { readonly retainedTexts: number } {
      return { retainedTexts: texts.size };
    },
  };
}

/** Alias matching this composable directory's `use*` naming. */
export const useNewSession = createNewSession;
