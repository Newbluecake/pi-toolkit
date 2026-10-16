/**
 * web-hub-version plan §5.1 (V2): the version-info state machine behind the top-bar version
 * chip, its popover, and the settings 「版本」 card. ONE instance per TopBar
 * (`provide(VERSION_CTX)`), shared by both surfaces so the popover and the settings card ride
 * the same single-flight fetch (D4 refinement: 「共用 composable 单飞，不重复请求」).
 *
 * - phase `idle|loading|ok|error|unsupported`; `unsupported` = the hub frame has arrived and
 *   does NOT advertise `version.v1` (old hub) — in that state `refresh()` NEVER sends a
 *   request (§6 compat matrix「不请求端点」; a missing `versionInfo` method on the transport is
 *   the same posture);
 * - single-flight: concurrent `refresh()` calls join the in-flight round (exactly one request);
 * - the `/api/version` result is validated through V0's `parseVersionInfoWire` (imported,
 *   never re-implemented) AND generation-filtered: `hub.pid/startedAt` must match the CURRENT
 *   hub frame at settle time — a snapshot from another hub generation is dropped; a generation
 *   CHANGE also clears the stored snapshot (§4「代际变化时清空快照」);
 * - recompute triggers (§4): the `match` computed re-runs off the reactive hub frame / selected
 *   session / stored snapshot; a fetch happens when a panel/card mounts (`VersionPanel`'s
 *   onMounted → `refresh()`) and on `visibilitychange→visible` when ≥10min passed since the
 *   last fetch and the cap is present. The listener is registered/removed as a PAIR
 *   (create ↔ `dispose()`); no polling, no timers.
 */
import { computed, ref, watch, type InjectionKey, type Ref } from "vue";
import { VERSION_HUB_CAP } from "@protocol/version.js";
import { parseVersionInfoWire, type VersionInfoWire } from "@protocol/version-info.js";
import { tabAssets as readTabAssets } from "@logic/build-stamp.js";
import { versionMatch } from "@logic/version-match.js";
import { UI_BUILD } from "../build-info.js";
import type { HubHandle } from "../types.js";
import type { VersionInfoOutcome } from "../transport/types.js";

export type VersionInfoPhase = "idle" | "loading" | "ok" | "error" | "unsupported";

/** §4: the visibility refresh floor — never re-fetch more often than this. */
export const VERSION_VISIBLE_REFRESH_MS = 10 * 60 * 1000;

/** Minimal transport surface this composable needs (a subset of `HubTransport`). */
interface VersionTransportLike {
  versionInfo?(signal?: AbortSignal): Promise<VersionInfoOutcome>;
}

export interface VersionInfoDeps {
  /** The hub handle from `HUB_CTX` (null in unit tests / pre-connect). */
  readonly hub: HubHandle | null;
  /** Overrides for testability; default to the globals when absent. */
  readonly doc?: Document | null;
  readonly win?: Window | null;
  readonly now?: () => number;
}

export interface VersionInfoHandle {
  readonly phase: Readonly<Ref<VersionInfoPhase>>;
  readonly snapshot: Readonly<Ref<VersionInfoWire | undefined>>;
  /** The §4 matcher result — re-runs on hub frame / selection / snapshot changes. */
  readonly match: Readonly<Ref<ReturnType<typeof versionMatch>>>;
  /** Single-flight fetch; a no-op without the cap (never requests an old hub). */
  refresh(): void;
  /** Removes the visibilitychange listener (TopBar's onUnmounted). */
  dispose(): void;
}

export const VERSION_CTX: InjectionKey<VersionInfoHandle> = Symbol("web-hub-version");

export function useVersionInfo(deps: VersionInfoDeps): VersionInfoHandle {
  const { hub } = deps;
  const doc = deps.doc ?? (typeof document === "undefined" ? null : document);
  const win = deps.win ?? (typeof window === "undefined" ? null : window);
  const now = deps.now ?? Date.now;

  /** §4: tab identity — read ONCE from the page's own DOM at composable creation (startup),
   *  non-reactive by design (`null` under `vite dev` ⇒ tab-stale unverifiable). */
  const tabAssets = doc !== null ? readTabAssets(doc) : null;

  const fetchState = ref<"idle" | "loading" | "ok" | "error">("idle");
  const snapshot = ref<VersionInfoWire | undefined>(undefined);

  const hubFrame = computed<Record<string, unknown> | null>(() => hub?.state.value.hub ?? null);
  const capOn = computed<boolean>(() => {
    const caps = hubFrame.value?.["caps"];
    return Array.isArray(caps) && caps.includes(VERSION_HUB_CAP);
  });
  /** §4 generation key `${pid}:${startedAt}` — null before the first hub frame. */
  const genKey = computed<string | null>(() => {
    const h = hubFrame.value;
    const pid = h?.["pid"];
    const startedAt = h?.["startedAt"];
    return typeof pid === "number" && typeof startedAt === "number" ? `${pid}:${startedAt}` : null;
  });
  // §4: a generation change invalidates whatever snapshot the old generation produced.
  watch(genKey, (_next, prev) => {
    if (prev !== undefined) snapshot.value = undefined;
  });

  /** The exposed phase: `unsupported` once a hub frame exists WITHOUT the cap (an old hub —
   *  §6); before any frame it stays `idle` (nothing is requestable yet either). */
  const phase = computed<VersionInfoPhase>(() =>
    hubFrame.value !== null && !capOn.value ? "unsupported" : fetchState.value,
  );

  const agents = computed<ReadonlyMap<string, { card: Record<string, unknown> }>>(() => {
    const a = hub?.state.value.agents;
    return a ?? new Map();
  });
  const selectedKey = computed<string | null>(() => hub?.state.value.selected ?? null);
  const selectedCard = computed<Record<string, unknown> | undefined>(() => {
    const k = selectedKey.value;
    return k === null ? undefined : agents.value.get(k)?.card;
  });
  const otherCards = computed<readonly Record<string, unknown>[]>(() => {
    const k = selectedKey.value;
    const out: Record<string, unknown>[] = [];
    for (const [key, a] of agents.value) if (key !== k) out.push(a.card);
    return out;
  });

  const match = computed(() =>
    versionMatch({
      uiBuild: UI_BUILD,
      tabAssets,
      hub: hubFrame.value,
      snapshot: snapshot.value,
      card: selectedCard.value,
      otherCards: otherCards.value,
    }),
  );

  let inFlight: Promise<void> | null = null;
  let lastFetchAt = -Infinity;

  async function run(): Promise<void> {
    const call = (hub as { transport?: VersionTransportLike } | null)?.transport?.versionInfo;
    if (call === undefined) {
      fetchState.value = "error";
      return;
    }
    fetchState.value = "loading";
    const genAtStart = genKey.value;
    let r: VersionInfoOutcome;
    try {
      r = await call();
    } catch {
      fetchState.value = "error";
      return;
    }
    // Generation moved under us (hub restarted mid-flight): the answer is stale by definition.
    if (genKey.value !== genAtStart) {
      fetchState.value = "idle";
      return;
    }
    if (!r.ok) {
      fetchState.value = "error";
      return;
    }
    const parsed = parseVersionInfoWire(r.data);
    if (parsed === undefined) {
      fetchState.value = "error";
      return;
    }
    // §4 generation filter: the snapshot's own hub key must equal the CURRENT frame's.
    const h = hubFrame.value;
    const pid = h?.["pid"];
    const startedAt = h?.["startedAt"];
    if (typeof pid === "number" && typeof startedAt === "number") {
      if (parsed.hub.pid !== pid || parsed.hub.startedAt !== startedAt) {
        fetchState.value = "error";
        return;
      }
    }
    snapshot.value = parsed;
    fetchState.value = "ok";
  }

  function refresh(): void {
    if (!capOn.value) return; // unsupported / pre-frame: NEVER request
    if (inFlight !== null) return; // single-flight join
    lastFetchAt = now();
    const p = run().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
  }

  function onVisibility(): void {
    if (doc === null || doc.visibilityState !== "visible") return;
    if (!capOn.value) return;
    if (now() - lastFetchAt < VERSION_VISIBLE_REFRESH_MS) return;
    refresh();
  }
  if (doc !== null) doc.addEventListener("visibilitychange", onVisibility);

  function dispose(): void {
    if (doc !== null) doc.removeEventListener("visibilitychange", onVisibility);
  }

  return { phase, snapshot, match, refresh, dispose };
}
