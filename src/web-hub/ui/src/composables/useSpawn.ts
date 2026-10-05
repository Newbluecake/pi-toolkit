/**
 * The `/api/headless*` call surface (web-hub-spawn plan SP11 / arch §8.3). A thin delegator
 * over `HubTransport.spawn` — same "adapt, never re-implement" discipline as `useUploads`:
 * the wire behavior lives in the two transports (pinned identical by
 * `tests/web-hub/ui/transport-contract.test.ts`'s shared spawn suite), this layer only
 * defines the absent-capability degradation: a transport WITHOUT `spawn` (test fakes, future
 * read-only transports) yields `E_UNSUPPORTED` on every method instead of throwing a
 * TypeError deep inside a component — `spawnAvailability`'s truth table then keeps every
 * pick-dir entry hidden/disabled anyway.
 */
import type {
  HubTransport,
  SpawnDirsOutcome,
  SpawnListOutcome,
  SpawnOutcome,
  SpawnStopOutcome,
  SpawnTransport,
} from "../transport/types.js";

const UNSUPPORTED_LIST: SpawnListOutcome = { ok: false, error: "E_UNSUPPORTED", status: 0 };
const UNSUPPORTED_DIRS: SpawnDirsOutcome = { ok: false, error: "E_UNSUPPORTED", status: 0 };
const UNSUPPORTED_START: SpawnOutcome = { ok: false, error: "E_UNSUPPORTED", retryable: false };
const UNSUPPORTED_STOP: SpawnStopOutcome = { ok: false, error: "E_UNSUPPORTED" };

export function createSpawn(transport: HubTransport): SpawnTransport {
  const spawn = transport.spawn;
  if (spawn === undefined) {
    return {
      list: () => Promise.resolve(UNSUPPORTED_LIST),
      dirs: () => Promise.resolve(UNSUPPORTED_DIRS),
      start: () => Promise.resolve(UNSUPPORTED_START),
      stop: () => Promise.resolve(UNSUPPORTED_STOP),
    };
  }
  return {
    list: () => spawn.list(),
    dirs: () => spawn.dirs(),
    start: (req) => spawn.start(req),
    stop: (spawnId, force) => spawn.stop(spawnId, force),
  };
}

/** Alias matching this composable directory's `use*` naming (same shape as `useControl.ts`). */
export const useSpawn = createSpawn;
