/**
 * LAN security r2 §3.2 (package D): browser-side state for the settings 「登录会话」 card.
 *
 * The transport lives behind `deps` (I wires it to fetch + the `lan.sessions.v1` cap gate):
 * `enabled()` decides support once (the cap is static per hub config and the card is LAN-only),
 * `list`/`revoke` receive a per-request AbortSignal that this composable aborts on dispose, on
 * a superseding request, and at the `LAN_SESSIONS_CLIENT_TIMEOUT_MS` (15 s) client deadline —
 * deliberately longer than the server's 10 s `REVOKE_TOTAL_MS` so a server-side deadline answer
 * always wins the race.
 *
 * `phase` is the card's only status surface (the handle shape is P0-frozen): "unsupported"
 * (cap absent ⇒ the card renders nothing), "idle" (created, first load not settled), "loading",
 * "ok" (a list or revoke settled successfully) and "error" (the LAST operation failed; the
 * previous `snapshot` is kept and stays rendered). A successful revoke is mirrored into
 * `lastRevoke` (the card reads `complete:false` off it for the 「部分未完成，请重试」 note) and
 * immediately followed by a re-list.
 */
import { getCurrentInstance, onUnmounted, ref, type Ref } from "vue";
import {
  LAN_SESSIONS_CLIENT_TIMEOUT_MS,
  type LanSessionRevokeBody,
  type LanSessionRevokeResponse,
  type LanSessionsResponse,
} from "@protocol/lan-sessions.js";

export interface LanSessionsDeps {
  enabled(): boolean;
  list(signal: AbortSignal): Promise<LanSessionsResponse>;
  revoke(body: LanSessionRevokeBody, signal: AbortSignal): Promise<LanSessionRevokeResponse>;
}
export interface LanSessionsHandle {
  readonly phase: Readonly<Ref<"unsupported" | "idle" | "loading" | "ok" | "error">>;
  readonly snapshot: Readonly<Ref<LanSessionsResponse | undefined>>;
  readonly lastRevoke: Readonly<Ref<LanSessionRevokeResponse | undefined>>;
  refresh(): Promise<void>;
  revoke(body: LanSessionRevokeBody): Promise<void>;
  dispose(): void;
}

interface Tracked {
  ctl: AbortController;
  clear(): void;
}

export function useLanSessions(deps: LanSessionsDeps): LanSessionsHandle {
  const supported = deps.enabled();
  const phase: Ref<"unsupported" | "idle" | "loading" | "ok" | "error"> = ref(supported ? "idle" : "unsupported");
  const snapshot = ref<LanSessionsResponse | undefined>(undefined);
  const lastRevoke = ref<LanSessionRevokeResponse | undefined>(undefined);
  let disposed = false;
  let seq = 0;
  let listReq: Tracked | null = null;
  let revokeReq: Tracked | null = null;

  /** One controller + one 15 s timeout per request; superseding same-kind requests abort the old. */
  function begin(kind: "list" | "revoke"): Tracked {
    const prev = kind === "list" ? listReq : revokeReq;
    prev?.clear();
    prev?.ctl.abort();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("E_DEADLINE")), LAN_SESSIONS_CLIENT_TIMEOUT_MS);
    const tracked: Tracked = {
      ctl,
      clear() {
        clearTimeout(timer);
      },
    };
    if (kind === "list") listReq = tracked;
    else revokeReq = tracked;
    return tracked;
  }

  function end(kind: "list" | "revoke", tracked: Tracked): void {
    tracked.clear();
    if (kind === "list") {
      if (listReq === tracked) listReq = null;
    } else if (revokeReq === tracked) revokeReq = null;
  }

  async function refresh(): Promise<void> {
    if (disposed || !supported) return;
    const mySeq = ++seq;
    phase.value = "loading";
    const tracked = begin("list");
    try {
      const res = await deps.list(tracked.ctl.signal);
      if (disposed || mySeq !== seq) return;
      snapshot.value = res;
      phase.value = "ok";
    } catch {
      if (disposed || mySeq !== seq) return;
      phase.value = "error";
    } finally {
      end("list", tracked);
    }
  }

  async function revoke(body: LanSessionRevokeBody): Promise<void> {
    if (disposed || !supported) return;
    const mySeq = ++seq;
    const tracked = begin("revoke");
    let failed = false;
    try {
      const res = await deps.revoke(body, tracked.ctl.signal);
      if (disposed || mySeq !== seq) return;
      lastRevoke.value = res;
    } catch {
      failed = true;
    } finally {
      end("revoke", tracked);
    }
    if (disposed || mySeq !== seq) return;
    if (failed) {
      phase.value = "error";
      return;
    }
    // A self-revoke kills this very session server-side; the hub's SSE revoke will push the
    // client back to the login view. The re-list covers every other case (and is harmless here).
    await refresh();
  }

  function dispose(): void {
    disposed = true;
    seq += 1;
    for (const r of [listReq, revokeReq]) {
      r?.clear();
      r?.ctl.abort();
    }
    listReq = null;
    revokeReq = null;
  }

  if (getCurrentInstance() !== null) onUnmounted(dispose);
  // First paint should not wait for the integrator to remember a refresh call.
  if (supported) void refresh();
  return { phase, snapshot, lastRevoke, refresh, revoke, dispose };
}
