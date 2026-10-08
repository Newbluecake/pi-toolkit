/**
 * web-hub session-history plan §4.5.5 (`occupancy.ts`): `prove`/`reprove` — kind gate + C1
 * (live card) + C2 (managed record) + C3 (`/proc` scan / re-stat). Best-effort occupancy per
 * §14.1: the hub never proves "nobody has it open", only "nothing was detected, and the check
 * itself was complete".
 */
import type { AgentView } from "../../ports.js";
import type { ReqDeadline } from "../../req-deadline.js";
import type { ForkReason, HistoryLiveWire } from "../../../protocol/session-history.js";
import {
  type HistoryServiceDeps,
  type ManagedSessionView,
  type OccupancyProof,
  type ProcScanToken,
  type SessionPin,
} from "./ports.js";
import { PROC_SCAN_BUDGET_MS } from "./budget.js";
import { rescanSync, scanAsync, type ProcFs, type ProcSyncFs } from "./proc.js";
import { defaultHistorySyncFs, type HistorySyncFs } from "./fs.js";

const SEVERITY: Record<ForkReason, number> = { unverified: 0, maybe: 1, subagent: 2, open: 3 };

type DeniedProof = Extract<OccupancyProof, { free: false }>;

function worstOf(a: DeniedProof | undefined, b: DeniedProof): DeniedProof {
  if (a === undefined) return b;
  return SEVERITY[b.reason] > SEVERITY[a.reason] ? b : a;
}

export interface OccupancyChecker {
  prove(pin: SessionPin, deadline: ReqDeadline): Promise<OccupancyProof>;
  reprove(pin: SessionPin, scan: ProcScanToken): OccupancyProof;
}

export function createOccupancyChecker(
  deps: HistoryServiceDeps,
  procFs: ProcFs,
  procSyncFs: ProcSyncFs,
  syncFs: Pick<HistorySyncFs, "realpathSync"> = defaultHistorySyncFs(),
): OccupancyChecker {
  // Finding 7b fix: cache the canonical sessionsRoot ONCE (graceful fallback — never throw,
  // never a per-call syscall; the slug directory may itself be a symlink, same trust boundary
  // as the identical realpath cached in `pin.ts`/`generation.ts`). `R` staying `undefined`
  // simply means the literal-path match form below is unavailable — C1's existing two forms
  // (sessionId / already-canonical sessionFile) still apply unconditionally.
  let R: string | undefined;
  try {
    R = syncFs.realpathSync(`${deps.agentDir}/sessions`);
  } catch {
    R = undefined;
  }

  /** Finding 7b fix: `pin.abs` is always the CANONICAL (realpath'd) form; a card may instead
   * report the LITERAL, un-realpath'd `sessionFile` it was launched with (e.g. `agentDir`
   * reached through a symlink) — derive that literal form once per pin so `cardMatch` can
   * compare against it too. */
  function literalSessionFileFor(pin: SessionPin): string | undefined {
    if (R === undefined) return undefined;
    const prefix = `${R}/`;
    if (!pin.abs.startsWith(prefix)) return undefined;
    const key = pin.abs.slice(prefix.length);
    return `${deps.agentDir}/sessions/${key}`;
  }

  function cardMatch(pin: SessionPin): AgentView | undefined {
    const literal = literalSessionFileFor(pin);
    for (const card of deps.registry.list()) {
      if (card.session === undefined) continue;
      if (
        card.session.sessionId === pin.id ||
        card.session.sessionFile === pin.abs ||
        (literal !== undefined && card.session.sessionFile === literal)
      ) {
        return card;
      }
    }
    return undefined;
  }

  function managedMatch(pin: SessionPin): { rec: ManagedSessionView; terminal: boolean } | undefined {
    for (const rec of deps.managed()) {
      const targetId = rec.sessionTarget?.id ?? rec.sessionId;
      const targetFile = rec.sessionTarget?.file ?? rec.sessionFile;
      if (targetId === pin.id || (targetFile !== undefined && targetFile === pin.abs)) {
        const terminal = rec.state === "exited" || rec.state === "failed";
        return { rec, terminal };
      }
    }
    return undefined;
  }

  /** C1/C2 only, synchronous — shared by `prove` and `reprove`. */
  function cardsAndManaged(pin: SessionPin): DeniedProof | undefined {
    const c1 = cardMatch(pin);
    if (c1 !== undefined) {
      const live: HistoryLiveWire = { state: "open", by: "card" };
      if (c1.agentKey !== undefined) live.agentKey = c1.agentKey;
      if (c1.pid !== undefined) live.pid = c1.pid;
      return { free: false, reason: "open", live };
    }
    const c2 = managedMatch(pin);
    if (c2 !== undefined) {
      if (!c2.terminal || deps.deathOf(c2.rec.spawnId) !== "confirmed") {
        const live: HistoryLiveWire = { state: "open", by: "managed" };
        if (c2.rec.agentKey !== undefined) live.agentKey = c2.rec.agentKey;
        if (c2.rec.pid !== undefined) live.pid = c2.rec.pid;
        return { free: false, reason: "open", live };
      }
    }
    return undefined;
  }

  /** §4.5.5 step 5: every `cls:"pi"` candidate must resolve against a card (by pid) or a
   * non-terminal managed record (by pid+startTicks). */
  function candidateVerdict(pid: number, startTicks: number): "proven" | "card-unproven" | undefined {
    for (const card of deps.registry.list()) {
      if (card.pid === pid) {
        // A card is only "proven" when it is live AND has reported a session — claiming/stale
        // or a live-but-session-less card cannot rule out occupancy (card-unproven).
        if (card.state === "live" && card.session !== undefined) return "proven";
        return "card-unproven";
      }
    }
    for (const rec of deps.managed()) {
      if (rec.pid === pid && rec.procStartTicks === startTicks) {
        const nonTerminal = rec.state !== "exited" && rec.state !== "failed";
        if (nonTerminal) return "proven";
      }
    }
    return undefined;
  }

  async function prove(pin: SessionPin, deadline: ReqDeadline): Promise<OccupancyProof> {
    if (pin.kind === "sub") return { free: false, reason: "subagent" };
    if (pin.kind === "unknown") return { free: false, reason: "unverified", gap: "kind" };
    const cm = cardsAndManaged(pin);
    if (cm !== undefined) return cm;
    const budgetMs = Math.max(0, Math.min(PROC_SCAN_BUDGET_MS, deadline.remaining()));
    const scan = await scanAsync({ procFs, uid: deps.uid, hubPid: deps.hubPid, now: deps.now, budgetMs });
    if (!scan.complete) return { free: false, reason: "unverified", gap: "proc-partial", scan };
    let worst: DeniedProof | undefined;
    for (const [pid, seen] of scan.pids) {
      if (seen.cls !== "pi") continue;
      const verdict = candidateVerdict(pid, seen.startTicks);
      if (verdict === "proven") continue;
      const candidate: DeniedProof =
        verdict === "card-unproven"
          ? { free: false, reason: "unverified", gap: "card-unproven", live: { state: "maybe", by: "card", pid } }
          : { free: false, reason: "maybe", gap: "unconnected-pi", live: { state: "maybe", by: "proc", pid } };
      worst = worstOf(worst, candidate);
    }
    if (worst !== undefined) return { ...worst, scan };
    return { free: true, scan };
  }

  function reprove(pin: SessionPin, scan: ProcScanToken): OccupancyProof {
    if (!scan.complete) {
      throw new Error("reprove: scan token must be complete (prove already returned proc-partial)");
    }
    if (pin.kind === "sub") return { free: false, reason: "subagent" };
    if (pin.kind === "unknown") return { free: false, reason: "unverified", gap: "kind" };
    const cm = cardsAndManaged(pin);
    if (cm !== undefined) return cm;
    const verdict = rescanSync(scan, { procFs: procSyncFs, uid: deps.uid, hubPid: deps.hubPid, now: deps.now });
    if ("gap" in verdict) {
      if (verdict.gap === "new-process") {
        return {
          free: false,
          reason: "unverified",
          gap: "new-process",
          live: { state: "maybe", by: "proc", pid: verdict.pid },
          scan,
        };
      }
      return { free: false, reason: "unverified", gap: "proc-partial", scan };
    }
    return { free: true, scan };
  }

  return { prove, reprove };
}
