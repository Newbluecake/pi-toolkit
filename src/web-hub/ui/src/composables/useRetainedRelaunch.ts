/** UI-only, sidebar-scoped intent controller. Never persists or retries a POST. */
import { computed, onScopeDispose, ref, watch, type InjectionKey } from "vue";
import type { SpawnRecordPublic } from "@protocol/spawn.js";
import type { HubHandle } from "../types.js";
import {
  isRetainedRestoreFailure,
  relaunchErrorKey,
  retainedExitedSupported,
  restoreFailureKey,
} from "../logic/spawn.js";

export const RETAINED_RELAUNCH: InjectionKey<RetainedRelaunch> = Symbol("web-hub-retained-relaunch");
export type RetainedRelaunch = ReturnType<typeof useRetainedRelaunch>;

export function useRetainedRelaunch(hub: HubHandle | null) {
  const pending = ref<ReadonlySet<string>>(new Set());
  const errors = ref<ReadonlyMap<string, string>>(new Map());
  const completed = ref(0);
  // HTTP locks survive intent cancellation: closing/reopening cannot duplicate an in-flight POST.
  const locks = ref<ReadonlySet<string>>(new Set());
  const intents = new Map<string, { original: string; accepted: boolean; progressed: boolean }>();
  let disposed = false;
  const busy = computed(() => pending.value.size > 0 || locks.value.size > 0);
  function error(id: string, key: string) {
    errors.value = new Map(errors.value).set(id, key);
    intents.delete(id);
    pending.value = new Set([...pending.value].filter((x) => x !== id));
  }
  function cancel() {
    intents.clear();
    pending.value = new Set();
    errors.value = new Map();
  }
  function signature(rec: SpawnRecordPublic): string {
    // A fresh SSE object (or a different property order) is not a completed attempt.
    return JSON.stringify([
      rec.state,
      rec.updatedAt,
      rec.endReason,
      rec.hint,
      rec.restore?.attempt,
      rec.restore?.failure,
    ]);
  }
  function observe() {
    if (disposed) return;
    for (const [id, intent] of intents) {
      const rec = hub?.state.value.spawns?.items.find((r) => r.spawnId === id);
      if (!rec) {
        error(id, "history.retainedEvicted");
        continue;
      }
      if (rec.removing) {
        error(id, "spawn.relaunchErrState");
        continue;
      }
      if (rec.state === "starting") intent.progressed = true;
      if (rec.state === "live" && rec.agentKey) {
        intents.delete(id);
        pending.value = new Set([...pending.value].filter((x) => x !== id));
        window.location.hash = `#/agent/${encodeURIComponent(rec.agentKey)}`;
        completed.value++;
      } else if (
        intent.accepted &&
        (intent.progressed || signature(rec) !== intent.original) &&
        (rec.state === "failed" || rec.state === "exited")
      ) {
        error(id, restoreFailureKey(rec.restore?.failure) ?? "history.retainedFailed");
      }
    }
  }
  watch(
    [
      () => hub?.state.value.conn,
      () => hub?.state.value.clientId,
      () => hub?.state.value.hub?.["epoch"],
      () => retainedExitedSupported(hub?.state.value.hub?.["caps"]),
    ],
    cancel,
    { flush: "sync" },
  );
  watch(() => hub?.state.value.spawns, observe, { flush: "sync" });
  onScopeDispose(() => {
    disposed = true;
    cancel();
  });

  async function request(id: string): Promise<void> {
    if (
      disposed ||
      !hub ||
      !retainedExitedSupported(hub.state.value.hub?.["caps"]) ||
      locks.value.has(id) ||
      pending.value.has(id)
    )
      return;
    const flow = hub.spawn?.newSession.flow?.value.phase;
    if (flow === "submitting" || flow === "confirming" || flow === "awaiting") return;
    const rec = hub.state.value.spawns?.items.find((r) => r.spawnId === id);
    if (!rec || rec.removing || !(rec.state === "exited" || isRetainedRestoreFailure(rec))) return;
    const intent = { original: signature(rec), accepted: false, progressed: false };
    intents.set(id, intent);
    errors.value = new Map([...errors.value].filter(([key]) => key !== id));
    locks.value = new Set(locks.value).add(id);
    pending.value = new Set(pending.value).add(id);
    try {
      const out = hub.spawn?.relaunch ? await hub.spawn.relaunch(id) : { ok: false, error: "E_UNSUPPORTED" };
      if (disposed || intents.get(id) !== intent) return;
      if (!out?.ok) {
        error(id, relaunchErrorKey(out));
        return;
      }
      intent.accepted = true;
      observe();
    } catch {
      if (!disposed && intents.get(id) === intent) error(id, "spawn.relaunchErrNetwork");
    } finally {
      locks.value = new Set([...locks.value].filter((x) => x !== id));
    }
  }
  const isPending = (id: string) => pending.value.has(id) || locks.value.has(id);
  return { pending, errors, completed, busy, isPending, request, cancel };
}
