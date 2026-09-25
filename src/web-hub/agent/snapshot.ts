/**
 * Snapshot / branch replies (plan §包 D — snapshot.ts; arch §7 steps 2 / 3).
 *
 * `buildSnapshotReply` reads `leafId`, `seq`, `recent`, `inflight` in the same
 * tick — the leafId is the hub's single alignment point (spike K7②).
 * `buildBranchReply` is the fallback when the hub cannot read the session file:
 * `getBranch()` → `projectSessionEntry` (byte-identical to the hub's jsonl
 * projection), keeping the newest entries within the byte budget.
 */
import { Buffer } from "node:buffer";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { projectSessionEntry } from "../protocol/keys.js";
import { LIMITS, type AgentFrame, type FleetRowWire, type StatusInfo, type WireEntry } from "../protocol/messages.js";
import type { EventTap } from "./event-tap.js";

export function buildSnapshotReply(
  rid: string,
  parts: { seq: number; ctx: ExtensionContext; tap: EventTap; status: StatusInfo; fleet: FleetRowWire[] },
): Extract<AgentFrame, { t: "snapshot_reply" }> {
  const sm = parts.ctx.sessionManager;
  const leafId = safe(() => sm.getLeafId(), null);
  const sessionFile = safe(() => sm.getSessionFile(), undefined);
  const reply: Extract<AgentFrame, { t: "snapshot_reply" }> = {
    t: "snapshot_reply",
    rid,
    seq: parts.seq,
    leafId,
    recent: parts.tap.recent(),
    prompts: parts.tap.prompts(),
    status: { ...parts.status, leafId },
    fleet: parts.fleet,
  };
  if (sessionFile !== undefined) reply.sessionFile = sessionFile;
  const inflight = parts.tap.inflight();
  if (inflight !== undefined) reply.inflight = inflight;
  return reply;
}

export function buildBranchReply(
  rid: string,
  ctx: ExtensionContext,
  maxBytes: number,
): Extract<AgentFrame, { t: "branch_reply" }> {
  const budget = Math.max(0, Math.min(maxBytes, LIMITS.branchReplyBytes));
  const raw = safe(() => ctx.sessionManager.getBranch(), [] as unknown[]);
  const projected: WireEntry[] = [];
  for (const r of raw) {
    const e = projectSessionEntry(r);
    if (e !== undefined) projected.push(e);
  }
  // Keep the tail: walk newest → oldest until the byte budget is exhausted.
  let used = 0;
  let start = projected.length;
  for (let i = projected.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(projected[i]), "utf8") + 1;
    if (used + size > budget) break;
    used += size;
    start = i;
  }
  return { t: "branch_reply", rid, entries: projected.slice(start), truncated: start > 0 };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
