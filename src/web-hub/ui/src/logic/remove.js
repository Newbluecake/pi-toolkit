/**
 * Pure delete-target / error-classification helpers (web-hub-delete-session plan v2 §5.2). No
 * DOM, no I/O — same discipline as `./spawn.js`/`./control.js`. Backs the two two-step delete
 * entry points: `AgentCard`'s target comes from `removalTargetForAgent`, `SpawnRow`'s from
 * `removalTargetForSpawn`; both feed the same `RemoveButton.vue`. `classifyRemoveError` maps a
 * `removeAgent()` outcome to the six inline-failure buckets `agents.removeErr.*` translates.
 *
 * `removalTargetForAgent` deliberately covers `starting` too, not just `managedFor`'s
 * live/stopping (`./spawn.js`'s AgentCard `web`-badge lookup): a record can carry a bound
 * `agentKey` before its state transitions out of `starting` in the rare bind-then-recheck
 * window (arch §7.5), and the hub's own `agent-remove.ts` re-derives the authoritative state
 * from the target itself regardless of what this pure helper guessed — this only decides
 * whether a button renders at all.
 *
 * Anti-drift (verifier r1 #2, P2 打回): `E_AGENT_ONLINE`/`E_SPAWN_DENIED`/`E_RATE`/
 * `E_UNSUPPORTED` are pinned against the REAL frozen `API_ERRORS` array (`@protocol/
 * http-contract.ts` has zero runtime typebox cost — it only TYPE-imports `messages.js`, same
 * free-to-import rationale `./contract.js`'s header already documents for `SSE_EVENTS`); the
 * `"online"`/`"exit-unconfirmed"`/`"lan-off"` reason literals come from `../transport/types.ts`'s
 * `AGENT_REMOVE_REASON_*` constants, themselves pinned against `AgentRemoveErrorReason` by an
 * exhaustive TS record (that type has no runtime export of its own to import). A protocol
 * rename of any of these trips `pinned()`'s module-load-time throw — caught the instant any
 * test (or the real app) imports this module, not just when someone remembers to update a test.
 */
import { API_ERRORS } from "@protocol/http-contract.ts";
import { AGENT_REMOVE_REASON_UNCONFIRMED } from "../transport/types.ts";

/**
 * @param {string} code
 * @returns {string}
 */
function pinnedErrorCode(code) {
  if (!API_ERRORS.includes(code)) {
    throw new Error(
      `@logic/remove.js: protocol drift — "${code}" is no longer in protocol/http-contract.ts's API_ERRORS`,
    );
  }
  return code;
}

const E_AGENT_ONLINE = pinnedErrorCode("E_AGENT_ONLINE");
const E_SPAWN_DENIED = pinnedErrorCode("E_SPAWN_DENIED");
const E_RATE = pinnedErrorCode("E_RATE");
const E_UNSUPPORTED = pinnedErrorCode("E_UNSUPPORTED");

/**
 * @typedef {import("../../../protocol/spawn.js").SpawnsPayload} SpawnsPayload
 * @typedef {import("../../../protocol/spawn.js").SpawnRecordPublic} SpawnRecordPublic
 */

/**
 * @typedef {{ kind: "managed", spawnId: string, removing: boolean } | { kind: "offline" }} AgentRemovalTarget
 * @typedef {{ kind: "spawn", spawnId: string, removing: boolean }} SpawnRemovalTarget
 */

const MANAGED_REMOVE_STATES = new Set(["starting", "live", "stopping"]);

/**
 * AgentCard's target (§5.2 table):
 *  1) a record (any of starting/live/stopping) bound to this agent's key — `managed` (latest
 *     `updatedAt` wins, same tie-break as `./spawn.js`'s `managedFor`).
 *  2) `agent.down` or `agent.card.state === "stale"` — `offline` (checked directly, not via the
 *     derived visual state; a terminal managed record's offline card also lands here — the hub
 *     looks the spawn record up again by `agentKey` and runs its own death-confirmation gate).
 *  3) anything else (an online, unmanaged card) — `null`: no button renders (user 拍板: 在线
 *     TUI 会话不可删).
 * @param {{ key?: unknown, down?: unknown, card?: { state?: unknown } } | null | undefined} agent
 * @param {SpawnsPayload | null | undefined} spawns
 * @returns {AgentRemovalTarget | null}
 */
export function removalTargetForAgent(agent, spawns) {
  if (!agent || typeof agent !== "object" || typeof agent.key !== "string") return null;
  const items = spawns && typeof spawns === "object" && Array.isArray(spawns.items) ? spawns.items : [];
  /** @type {SpawnRecordPublic | undefined} */
  let best;
  for (const rec of items) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.agentKey !== agent.key || !MANAGED_REMOVE_STATES.has(rec.state)) continue;
    if (
      best === undefined ||
      (typeof rec.updatedAt === "number" ? rec.updatedAt : 0) >=
        (typeof best.updatedAt === "number" ? best.updatedAt : 0)
    ) {
      best = rec;
    }
  }
  if (best !== undefined) return { kind: "managed", spawnId: best.spawnId, removing: best.removing === true };
  const card = agent.card && typeof agent.card === "object" ? agent.card : undefined;
  if (agent.down === true || card?.state === "stale") return { kind: "offline" };
  return null;
}

const PENDING_REMOVE_STATES = new Set(["starting", "failed"]);

/**
 * SpawnRow's target: `starting`/`failed` records only — the ones with no bound `agentKey` yet,
 * or that failed before ever getting one (`AgentCard`'s target above covers every record that
 * DOES have one). Everything else (`live`/`stopping`/`exited`) is `null`.
 * @param {{ state?: unknown, spawnId?: unknown, removing?: unknown } | null | undefined} rec
 * @returns {SpawnRemovalTarget | null}
 */
export function removalTargetForSpawn(rec) {
  if (!rec || typeof rec !== "object" || typeof rec.spawnId !== "string") return null;
  if (typeof rec.state !== "string" || !PENDING_REMOVE_STATES.has(rec.state)) return null;
  return { kind: "spawn", spawnId: rec.spawnId, removing: rec.removing === true };
}

/**
 * §5.2's six-bucket classification for `RemoveButton.vue`'s inline failure text
 * (`agents.removeErr.*`). Returns `undefined` for a non-error outcome.
 * @param {{ ok?: unknown, error?: unknown, reason?: unknown } | null | undefined} outcome
 * @returns {"online" | "unconfirmed" | "managedLan" | "rate" | "unsupported" | "network" | undefined}
 */
export function classifyRemoveError(outcome) {
  if (!outcome || typeof outcome !== "object" || outcome.ok === true) return undefined;
  if (outcome.error === E_AGENT_ONLINE) {
    return outcome.reason === AGENT_REMOVE_REASON_UNCONFIRMED ? "unconfirmed" : "online";
  }
  if (outcome.error === E_SPAWN_DENIED) return "managedLan";
  if (outcome.error === E_RATE) return "rate";
  if (outcome.error === E_UNSUPPORTED) return "unsupported";
  return "network";
}
