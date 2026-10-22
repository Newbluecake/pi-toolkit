/**
 * `useTrackedCommand` (alias-plan r4 §7.1, package ALU) — track ONE web command by its own
 * cmdId all the way to its final captured output. Built for the alias section of
 * `ChannelsDialog` (set / clear / take); `DetailDock.vue` deliberately keeps its own
 * orchestration untouched (R2-4: no regression surface there).
 *
 * Why not the dock's path: the dock renders results into the queue/CommandResult chrome; the
 * dialog instead needs the RESULT TEXT of exactly the command it sent (the take-preview's
 * token is parsed out of that single command's output via `parseTakeConfirm` — never out of
 * the transcript, model text, or any other cmdId).
 *
 * Semantics (§7.1):
 * - `run(name, args)` mints its own cmdId (`@logic/control.js`'s `newCmdId`) and passes it to
 *   `ControlHandle.runCommand(…, { id })`, so the request is tracked by id BEFORE the wire
 *   round-trip settles (the web-model-switch §5.2 #6 / answerDialog precedent).
 * - `E_CONFIRM_REQUIRED` (`webCommandPolicy.fabric:"confirm"`) ⇒ phase flips to `"confirm"`
 *   and the caller shows the generic `CommandConfirm`; `confirm()` re-sends with a NEW cmdId
 *   and `confirm:true` (the old id is never reused — it provably never ran), `cancel()` drops
 *   the whole logical operation. The 15 s clock does NOT run while waiting for the user.
 * - `completion:"async"|"unknown"` ⇒ watch `pendingCtl` for THIS cmdId: the item turning
 *   `failed`/`notExecuted` fails the run; the item disappearing (cmd_late settled it) triggers
 *   exactly ONE `query(agentKey, id)` (queryOnly — §6.6: SSE cmd_late carries no output) and
 *   the wrapped `result.data.output` is unwrapped (same shape DetailDock reads).
 * - One 15 s budget per wire flight, covering the round trip, the async settle and the single
 *   queryOnly; a confirm re-send starts a fresh 15 s (plan-author ruling: user think time is
 *   not counted; the take token's own 5-minute expiry is the real deadline there).
 * - Cancellation (timeout, `cancel()`, dialog close ⇒ scope dispose, agentKey change) settles
 *   the run `{ok:false, cancelled:true}`/`E_TIMEOUT` and drops every late result: the command
 *   itself is NOT revoked — the hub/agent side proceeds, and the following status push is the
 *   source of truth (§7.1 「不撤销已经发出的命令」).
 * - The promise resolves with ONLY this operation's final captured output text.
 */
import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from "vue";
import { newCmdId } from "@logic/control.js";
import type { CmdOutcome, ControlHandle } from "../types.js";

/** What the composable needs from the control plane. The getter MUST read through reactive
 *  refs (e.g. `view.agent.value.pendingCtl`) so the internal watcher tracks changes. */
export interface TrackedCommandView {
  readonly control: ControlHandle | null;
  readonly agentKey: string;
  readonly pendingCtl: readonly unknown[] | undefined;
}

export interface UseTrackedCommandOptions {
  view(): TrackedCommandView | null;
  /** Per-wire-flight budget (round trip + async settle + the one queryOnly). Default 15 s. */
  timeoutMs?: number;
}

export type TrackedCommandResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: string; readonly message?: string }
  | { readonly ok: false; readonly cancelled: true };

export type TrackedCommandPhase = "idle" | "running" | "confirm";

export interface TrackedCommandHandle {
  readonly phase: Readonly<Ref<TrackedCommandPhase>>;
  /** Set while a `E_CONFIRM_REQUIRED` resend waits for the user (CommandConfirm props). */
  readonly confirmReq: Readonly<Ref<{ readonly name: string; readonly args: string } | null>>;
  run(name: string, args: string): Promise<TrackedCommandResult>;
  /** Policy confirm accepted: re-send with a NEW cmdId + `confirm:true`, fresh 15 s budget. */
  confirm(): void;
  /** Cancel the policy-confirm wait or drop in-flight tracking (the command is NOT revoked). */
  cancel(): void;
}

/** Flatten a captured `CommandOutputWire`-shaped value to plain text (entries' text joined). */
export function commandOutputText(output: unknown): string {
  if (output === null || typeof output !== "object") return "";
  const entries = (output as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return "";
  const parts: string[] = [];
  for (const e of entries) {
    const text = e !== null && typeof e === "object" ? (e as { text?: unknown }).text : undefined;
    if (typeof text === "string" && text !== "") parts.push(text);
  }
  return parts.join("\n");
}

/** A queryOnly answer wraps the real result: `{op:"query", result:{ok, data:{…cmd data}}}`
 *  (commands.ts handleQueryOnly). A flat/legacy shape still reads the top level. */
function unwrapQueryData(data: unknown): { output?: unknown } {
  if (data === null || typeof data !== "object") return {};
  const d = data as { result?: unknown };
  const r = d.result;
  if (r !== null && typeof r === "object") {
    const inner = r as { ok?: unknown; data?: unknown };
    if (inner.ok === true && inner.data !== null && typeof inner.data === "object") {
      return inner.data as { output?: unknown };
    }
  }
  return data as { output?: unknown };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

interface Active {
  id: string;
  readonly name: string;
  readonly args: string;
  /** agentKey captured at run() time; a mismatch at any settle point cancels. */
  readonly key: string;
  resolve(result: TrackedCommandResult): void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  stopWatch: (() => void) | undefined;
}

export function useTrackedCommand(opts: UseTrackedCommandOptions): TrackedCommandHandle {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const phase = ref<TrackedCommandPhase>("idle") as Ref<TrackedCommandPhase>;
  const confirmReq = ref<{ name: string; args: string } | null>(null);
  let active: Active | null = null;

  function cleanup(a: Active): void {
    if (a.timer !== undefined) clearTimeout(a.timer);
    a.timer = undefined;
    a.stopWatch?.();
    a.stopWatch = undefined;
  }

  function settle(a: Active, result: TrackedCommandResult): void {
    if (a.settled) return;
    a.settled = true;
    cleanup(a);
    if (active === a) {
      active = null;
      phase.value = "idle";
      confirmReq.value = null;
    }
    a.resolve(result);
  }

  function cancel(): void {
    const a = active;
    confirmReq.value = null;
    if (a !== null) settle(a, { ok: false, cancelled: true });
    phase.value = "idle";
  }

  /** Arm the per-flight 15 s budget (round trip + async settle + one queryOnly). */
  function arm(a: Active): void {
    if (a.timer !== undefined) clearTimeout(a.timer);
    a.timer = setTimeout(() => settle(a, { ok: false, error: "E_TIMEOUT", message: "command timed out" }), timeoutMs);
  }

  function keyLost(a: Active): boolean {
    return opts.view()?.agentKey !== a.key;
  }

  async function dispatch(a: Active, confirm: boolean): Promise<void> {
    const v = opts.view();
    const c = v?.control ?? null;
    if (v === null || c === null) {
      settle(a, { ok: false, error: "E_UNAVAILABLE", message: "control channel unavailable" });
      return;
    }
    phase.value = "running";
    arm(a);
    const outcome = await c
      .runCommand(v.agentKey, a.name, a.args, { id: a.id, ...(confirm ? { confirm: true as const } : {}) })
      .catch((): CmdOutcome => ({ ok: false, error: "E_NETWORK" }));
    if (a.settled) return;
    if (keyLost(a)) {
      settle(a, { ok: false, cancelled: true });
      return;
    }
    if (!outcome.ok) {
      if (outcome.error === "E_CONFIRM_REQUIRED") {
        // User think time is NOT on the clock; the resend arms a fresh budget.
        if (a.timer !== undefined) clearTimeout(a.timer);
        a.timer = undefined;
        phase.value = "confirm";
        confirmReq.value = { name: a.name, args: a.args };
        return;
      }
      const msg = outcome.message;
      settle(a, { ok: false, error: outcome.error ?? "E_FAILED", ...(msg === undefined ? {} : { message: msg }) });
      return;
    }
    const data = (outcome.data ?? {}) as { completion?: unknown; output?: unknown };
    if (data.completion === "async" || data.completion === "unknown") {
      trackAsync(a);
      return;
    }
    settle(a, { ok: true, output: commandOutputText(data.output) });
  }

  /** Async completion (§7.1): the optimistic item for THIS cmdId sits in `pendingCtl`; when it
   *  leaves (cmd_late settled it) do ONE queryOnly for the captured output; a terminal
   *  failed/notExecuted item fails the run straight from the item. */
  function trackAsync(a: Active): void {
    let firstCheck = true;
    a.stopWatch = watch(
      () => opts.view()?.pendingCtl,
      (pending) => {
        void onPending(a, pending, firstCheck);
        firstCheck = false;
      },
      { immediate: true },
    );
  }

  async function onPending(a: Active, pending: readonly unknown[] | undefined, allowRecheck: boolean): Promise<void> {
    if (a.settled || active !== a) return;
    let items = Array.isArray(pending) ? (pending as readonly Record<string, unknown>[]) : [];
    let item = items.find((it) => it !== null && typeof it === "object" && it["id"] === a.id);
    // The optimistic item is dispatched synchronously by runCommand's ctl_send, so it is
    // already here; one microtask re-check covers a lagging reducer without a second query.
    if (item === undefined && allowRecheck) {
      await Promise.resolve();
      if (a.settled || active !== a) return;
      const again = opts.view()?.pendingCtl;
      items = Array.isArray(again) ? (again as readonly Record<string, unknown>[]) : [];
      item = items.find((it) => it !== null && typeof it === "object" && it["id"] === a.id);
    }
    if (item !== undefined) {
      const state = item["state"];
      if (state === "failed" || state === "notExecuted") {
        const msg = str(item["message"]);
        settle(a, {
          ok: false,
          error: str(item["error"]) ?? "E_FAILED",
          ...(msg === undefined ? {} : { message: msg }),
        });
      }
      return; // still in flight — keep waiting (the 15 s budget is the bound)
    }
    // Item gone ⇒ settled ok. Exactly one queryOnly (SSE cmd_late never carries output).
    a.stopWatch?.();
    a.stopWatch = undefined;
    const v = opts.view();
    const c = v?.control ?? null;
    if (v === null || c === null || keyLost(a)) {
      settle(a, { ok: false, cancelled: true });
      return;
    }
    const outcome = await c.query(v.agentKey, a.id).catch(() => undefined);
    if (a.settled) return;
    if (keyLost(a)) {
      settle(a, { ok: false, cancelled: true });
      return;
    }
    if (outcome !== undefined && outcome.ok) {
      settle(a, { ok: true, output: commandOutputText(unwrapQueryData(outcome.data).output) });
    } else {
      const msg = outcome?.message;
      settle(a, {
        ok: false,
        error: (outcome !== undefined && str(outcome.error)) || "E_QUERY_FAILED",
        ...(msg === undefined ? {} : { message: msg }),
      });
    }
  }

  function run(name: string, args: string): Promise<TrackedCommandResult> {
    cancel(); // one logical operation at a time
    const v = opts.view();
    if (v === null || v.control === null) {
      return Promise.resolve({ ok: false, error: "E_UNAVAILABLE", message: "control channel unavailable" });
    }
    return new Promise<TrackedCommandResult>((resolve) => {
      const a: Active = {
        id: newCmdId(),
        name,
        args,
        key: v.agentKey,
        resolve,
        settled: false,
        timer: undefined,
        stopWatch: undefined,
      };
      active = a;
      void dispatch(a, false);
    });
  }

  function confirm(): void {
    const a = active;
    if (a === null || phase.value !== "confirm") return;
    confirmReq.value = null;
    a.id = newCmdId(); // a NEW id — the refused one provably never ran and is never reused
    void dispatch(a, true);
  }

  // agentKey change mid-flight ⇒ cancel (session switch normally unmounts the dialog first,
  // which cancels through the scope dispose below — this watcher is the belt-and-braces for a
  // view whose agentKey swaps under a still-mounted dialog).
  watch(
    () => opts.view()?.agentKey,
    (key) => {
      if (active !== null && key !== active.key) cancel();
    },
  );
  if (getCurrentScope()) onScopeDispose(cancel);

  return {
    phase,
    confirmReq,
    run,
    confirm,
    cancel,
  };
}
