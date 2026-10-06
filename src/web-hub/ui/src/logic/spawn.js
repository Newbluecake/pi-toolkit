/**
 * Headless-spawn pure helpers (web-hub-spawn plan §包 SP11 / arch v2 §8.2–§8.3, §9.1 —
 * `docs/dev/web-hub-spawn/plan.md` §3.2). No DOM, no I/O: every function here runs unchanged
 * under vitest (node) and in the browser, same discipline as `./control.js`/`./upload.js`.
 *
 * - `spawnAvailability({ hubCaps, listResult })` — the single capability truth table the
 *   NewSessionMenu/EmptyState entries hang off: hub cap `spawn.v1` (protocol/version.ts's
 *   `SPAWN_HUB_CAP`, imported — never copied) ∧ `GET /api/headless` outcome ⇒
 *   available / denied(policy reason) / unavailable(no-cap | not-found | error) / unknown.
 *   arch §8.3: a 404 (feature off, or LAN `lan:"off"`) means "treat pick-dir as unavailable
 *   and HIDE it" — it is NOT an error worth surfacing.
 * - `newSessionActions({ hubCaps, listResult, selected })` — arch §8.3's `NewSessionAction[]`:
 *   the existing same-cwd `/new` action (byte-identical enable formula to AgentList.vue's
 *   `newSessionEnabled`) plus the pick-dir entry. pick-dir never depends on the selected
 *   agent (0-agent EmptyState shows it too), same-cwd is omitted without one.
 * - `classifySpawnError(outcome)` — §3.2's error taxonomy for the DirPicker inline display.
 * - `isMine(rec, localIds)` — the 「我发起的」 test (`origin.reqId` ∈ this tab's ids, §3.2):
 *   only my own records auto-navigate / refill my drafts.
 * - `pendingRows(spawns)` — SpawnRow's model: `starting`/`failed` records, newest first.
 * - `managedFor(spawns, agentKey)` — the non-terminal record managing a given agent (the
 *   `web` badge / 「停止会话」 button lookup, arch §9.1).
 *
 * Runtime imports use the literal `.ts` extension (`@protocol/version.ts`) — the same
 * `.js`-importer constraint `./contract.js` documents: Vite/esbuild only remap `./foo.js` →
 * `./foo.ts` for a `.ts`/`.vue` importer, so a plain `.js` module must spell `.ts` out.
 * `@protocol/spawn.ts` itself is only ever referenced through JSDoc `import()` TYPES here —
 * it pulls typebox at runtime and this module doesn't need a single runtime value from it.
 */
import { SPAWN_HUB_CAP } from "@protocol/version.ts";

/**
 * @typedef {import("../../../protocol/spawn.js").SpawnPolicyWire} SpawnPolicyWire
 * @typedef {import("../../../protocol/spawn.js").SpawnRecordPublic} SpawnRecordPublic
 * @typedef {import("../../../protocol/spawn.js").SpawnsPayload} SpawnsPayload
 * @typedef {import("../../../protocol/spawn.js").SpawnState} SpawnState
 */

/**
 * @typedef {{ ok: true, policy: SpawnPolicyWire, items: readonly SpawnRecordPublic[] }
 *   | { ok: false, error: string, status: number }} SpawnListResult
 */

/**
 * @typedef {{ state: "no-cap" }
 *   | { state: "not-found" }
 *   | { state: "error" }
 *   | { state: "unknown" }
 *   | { state: "denied", policy: SpawnPolicyWire }
 *   | { state: "available", policy: SpawnPolicyWire }} SpawnAvailability
 */

/**
 * @typedef {{ kind: "spawn-cwd", agentKey: string, cwd: string, enabled: boolean,
 *   reason?: SpawnPolicyWire["reason"] | "unavailable" }
 *   | { kind: "same-cwd", agentKey: string, cwd: string, enabled: boolean }
 *   | { kind: "pick-dir", enabled: boolean, reason?: SpawnPolicyWire["reason"] | "unavailable" }} NewSessionAction
 */

/** `SpawnPolicyWire.reason` → its `spawn.denied*` i18n key (NewSessionMenu + AgentList hint). */
const DENIED_KEYS = {
  platform: "spawn.deniedPlatform",
  launcher: "spawn.deniedLauncher",
  persist: "spawn.deniedPersist",
  reaper: "spawn.deniedReaper",
  cooldown: "spawn.deniedCooldown",
  breaker: "spawn.deniedBreaker",
};

/**
 * @param {string | undefined} reason
 * @returns {string}
 */
export function spawnDeniedKey(reason) {
  const key = reason !== undefined ? DENIED_KEYS[reason] : undefined;
  return key ?? "spawn.deniedUnknown";
}

/**
 * The availability truth table (arch §8.2 response matrix + §8.3's 404 rule).
 * @param {{ hubCaps?: unknown, listResult?: SpawnListResult | null | undefined }} p
 * @returns {SpawnAvailability}
 */
export function spawnAvailability({ hubCaps, listResult } = {}) {
  const caps = Array.isArray(hubCaps) ? hubCaps : [];
  if (!caps.includes(SPAWN_HUB_CAP)) return { state: "no-cap" };
  if (listResult === undefined || listResult === null) return { state: "unknown" };
  if (listResult.ok === false) {
    return listResult.status === 404 ? { state: "not-found" } : { state: "error" };
  }
  const policy = listResult.policy;
  if (!policy || typeof policy !== "object") return { state: "error" };
  return policy.allowed === true ? { state: "available", policy } : { state: "denied", policy };
}

/**
 * arch §8.3's `NewSessionAction[]` (2026-10 redesign: the main button is a managed spawn in the
 * selected session's cwd — `spawn-cwd`; the old `/new` rerun moved into the menu as `same-cwd`
 * behind an inline confirm). `selected` carries everything the same-cwd formula needs
 * (`agent` = the reducer's AgentState-ish view, `hubControl` = the hub frame's cmd.v1
 * negotiation, `controlPresent` = a ControlHandle exists) so this stays a pure function.
 * spawn-cwd/same-cwd are omitted entirely without a selected agent; pick-dir is always present
 * (the 0-agent EmptyState entry, arch §9.1). spawn-cwd's enablement is the spawn availability
 * alone (it never touches the selected agent's control plane).
 * @param {{ hubCaps?: unknown, listResult?: SpawnListResult | null | undefined,
 *   selected?: { agent?: any, hubControl?: boolean, controlPresent?: boolean } | null }} p
 * @returns {NewSessionAction[]}
 */
export function newSessionActions({ hubCaps, listResult, selected } = {}) {
  /** @type {NewSessionAction[]} */
  const out = [];
  const avail = spawnAvailability({ hubCaps, listResult });
  const spawnReason =
    avail.state === "denied" ? (avail.policy.reason !== undefined ? avail.policy.reason : undefined) : "unavailable";
  const agent = selected && typeof selected === "object" ? selected.agent : undefined;
  if (agent && typeof agent === "object" && typeof agent.key === "string") {
    const card = agent.card && typeof agent.card === "object" ? agent.card : {};
    const cwd = typeof card.cwd === "string" ? card.cwd : "";
    out.push({
      kind: "spawn-cwd",
      agentKey: agent.key,
      cwd,
      enabled: avail.state === "available",
      ...(avail.state === "available" || spawnReason === undefined ? {} : { reason: spawnReason }),
    });
    const enabled =
      selected.controlPresent === true &&
      selected.hubControl === true &&
      card.control === true &&
      agent.down !== true &&
      card.state !== "stale";
    out.push({ kind: "same-cwd", agentKey: agent.key, cwd, enabled });
  }
  if (avail.state === "available") {
    out.push({ kind: "pick-dir", enabled: true });
  } else if (avail.state === "denied") {
    out.push({
      kind: "pick-dir",
      enabled: false,
      ...(avail.policy.reason !== undefined ? { reason: avail.policy.reason } : {}),
    });
  } else {
    out.push({ kind: "pick-dir", enabled: false, reason: "unavailable" });
  }
  return out;
}

/**
 * §3.2's DirPicker error taxonomy. Returns `undefined` for a non-error outcome.
 *
 * web-hub-delete-session plan v2 §2.5: `E_BAD_REQUEST` with `reason:"spawn-gone"` (the
 * idempotent-replay-but-record-deleted rejection) is its own `"gone"` bucket, checked before
 * the generic `E_BAD_REQUEST"⇒"dir"` fallback — the literal is hand-copied rather than
 * importing `protocol/spawn.ts`'s `SPAWN_GONE_REASON` runtime value (that module pulls
 * typebox at runtime; this file stays typebox-free, same rationale as every other hardcoded
 * wire literal already here).
 * @param {any} outcome
 * @returns {"confirm" | "dir" | "denied" | "limit" | "rate" | "launcher" | "deadline" | "network" | "gone" | undefined}
 */
export function classifySpawnError(outcome) {
  if (!outcome || typeof outcome !== "object" || outcome.ok === true) return undefined;
  switch (outcome.error) {
    case "E_CONFIRM_REQUIRED":
      return "confirm";
    case "E_BAD_REQUEST":
      return outcome.reason === "spawn-gone" ? "gone" : "dir";
    case "E_DIR":
      return "dir";
    case "E_SPAWN_DENIED":
      return "denied";
    case "E_LIMIT":
      return "limit";
    case "E_RATE":
      return "rate";
    case "E_LAUNCHER":
      return "launcher";
    case "E_DEADLINE":
      return "deadline";
    default:
      return "network";
  }
}

/**
 * The 「我发起的」 test (§3.2): this record's `origin.reqId` is one this tab generated.
 * @param {any} rec @param {ReadonlySet<string> | readonly string[]} localIds
 * @returns {boolean}
 */
export function isMine(rec, localIds) {
  if (!rec || typeof rec !== "object") return false;
  const origin = rec.origin;
  if (!origin || typeof origin !== "object" || typeof origin.reqId !== "string") return false;
  if (localIds && typeof localIds.has === "function") return localIds.has(origin.reqId);
  return Array.isArray(localIds) ? localIds.includes(origin.reqId) : false;
}

/** States SpawnRow renders a placeholder for (plan SP12: starting / failed rows). */
const PENDING_ROW_STATES = new Set(["starting", "failed"]);

/**
 * SpawnRow's model: `starting`/`failed` records, newest first. Garbage in ⇒ `[]` out.
 * @param {SpawnsPayload | null | undefined} spawns
 * @returns {SpawnRecordPublic[]}
 */
export function pendingRows(spawns) {
  const items = spawns && typeof spawns === "object" && Array.isArray(spawns.items) ? spawns.items : [];
  return items
    .filter((rec) => rec && typeof rec === "object" && PENDING_ROW_STATES.has(rec.state))
    .slice()
    .sort(
      (a, b) =>
        (typeof b.createdAt === "number" ? b.createdAt : 0) - (typeof a.createdAt === "number" ? a.createdAt : 0),
    );
}

/** States in which a record with an `agentKey` still manages that agent. */
const MANAGED_STATES = new Set(["live", "stopping"]);

/**
 * The non-terminal record managing `agentKey` (latest `updatedAt` wins), or `undefined` —
 * AgentCard's `web` badge / DetailHeader's 「停止会话」 lookup (arch §9.1). `starting` records
 * never match: they don't have an `agentKey` until the bind completes (arch §7.5).
 * @param {SpawnsPayload | null | undefined} spawns @param {string} agentKey
 * @returns {SpawnRecordPublic | undefined}
 */
export function managedFor(spawns, agentKey) {
  const items = spawns && typeof spawns === "object" && Array.isArray(spawns.items) ? spawns.items : [];
  /** @type {SpawnRecordPublic | undefined} */
  let best;
  for (const rec of items) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.agentKey !== agentKey || !MANAGED_STATES.has(rec.state)) continue;
    if (
      best === undefined ||
      (typeof rec.updatedAt === "number" ? rec.updatedAt : 0) >=
        (typeof best.updatedAt === "number" ? best.updatedAt : 0)
    ) {
      best = rec;
    }
  }
  return best;
}
