/**
 * The `/api/headless*` call surface (web-hub-spawn plan SP11 / arch §8.3). A thin delegator
 * over `HubTransport.spawn` — same "adapt, never re-implement" discipline as `useUploads`:
 * the wire behavior lives in the two transports (pinned identical by
 * `tests/web-hub/ui/transport-contract.test.ts`'s shared spawn suite), this layer only
 * defines the absent-capability degradation: a transport WITHOUT `spawn` (test fakes, future
 * read-only transports) yields `E_UNSUPPORTED` on every method instead of throwing a
 * TypeError deep inside a component — `spawnAvailability`'s truth table then keeps every
 * pick-dir entry hidden/disabled anyway.
 *
 * default-model plan F1 additions (D1/D2): the hub-wide 「新建会话默认模型」 preference.
 * `prefs` is a local ref fed by every successful `list()` (the `GET /api/headless` response
 * carries the `prefs` slot) and by a successful `setDefaultModel()` (the 200 echo is the
 * authoritative post-write value); `null` until either happens. `refreshPrefs()` is just a
 * `list()` under a settings-card-friendly name. A transport without `setPrefs` degrades the
 * write to `E_UNSUPPORTED` — the settings card never calls it without the `spawn.model.v1`
 * cap (`spawnModelSupported`), this is only the defense-in-depth half.
 */
import { shallowRef, type Ref } from "vue";
import type { SpawnPrefsWire, SpawnRequestBody } from "@protocol/spawn.js";
import type {
  HubTransport,
  SpawnDirsOutcome,
  SpawnListOutcome,
  SpawnOutcome,
  SpawnPrefsOutcome,
  SpawnStopOutcome,
} from "../transport/types.js";

/** `createSpawn`'s return: the transport surface plus the F1 prefs slot. */
export interface SpawnCallSurface {
  list(): Promise<SpawnListOutcome>;
  dirs(): Promise<SpawnDirsOutcome>;
  start(req: SpawnRequestBody): Promise<SpawnOutcome>;
  stop(spawnId: string, force?: boolean): Promise<SpawnStopOutcome>;
  readonly prefs: Readonly<Ref<SpawnPrefsWire | null>>;
  refreshPrefs(): Promise<SpawnListOutcome>;
  setDefaultModel(defaultModel: string): Promise<SpawnPrefsOutcome>;
}

const UNSUPPORTED_LIST: SpawnListOutcome = { ok: false, error: "E_UNSUPPORTED", status: 0 };
const UNSUPPORTED_DIRS: SpawnDirsOutcome = { ok: false, error: "E_UNSUPPORTED", status: 0 };
const UNSUPPORTED_START: SpawnOutcome = { ok: false, error: "E_UNSUPPORTED", retryable: false };
const UNSUPPORTED_STOP: SpawnStopOutcome = { ok: false, error: "E_UNSUPPORTED" };
const UNSUPPORTED_PREFS: SpawnPrefsOutcome = { ok: false, error: "E_UNSUPPORTED", retryable: false };

export function createSpawn(transport: HubTransport): SpawnCallSurface {
  const spawn = transport.spawn;
  const prefs = shallowRef<SpawnPrefsWire | null>(null);
  if (spawn === undefined) {
    return {
      prefs,
      list: () => Promise.resolve(UNSUPPORTED_LIST),
      refreshPrefs: () => Promise.resolve(UNSUPPORTED_LIST),
      dirs: () => Promise.resolve(UNSUPPORTED_DIRS),
      start: () => Promise.resolve(UNSUPPORTED_START),
      stop: () => Promise.resolve(UNSUPPORTED_STOP),
      setDefaultModel: () => Promise.resolve(UNSUPPORTED_PREFS),
    };
  }
  const sp = spawn; // narrowed alias — hoisted function declarations don't keep the guard's narrowing
  async function list(): Promise<SpawnListOutcome> {
    const r = await sp.list();
    // A well-formed prefs slot (already narrowed by the transport) updates the local mirror;
    // its ABSENCE (pre-feature hub) leaves the mirror untouched — unknown ≠ cleared.
    if (r.ok && r.prefs !== undefined) prefs.value = r.prefs;
    return r;
  }
  async function setDefaultModel(defaultModel: string): Promise<SpawnPrefsOutcome> {
    const setPrefs = sp.setPrefs;
    if (setPrefs === undefined) return UNSUPPORTED_PREFS;
    const r = await setPrefs.call(sp, defaultModel);
    if (r.ok) prefs.value = r.prefs;
    return r;
  }
  return {
    prefs,
    list,
    refreshPrefs: list,
    dirs: () => sp.dirs(),
    start: (req) => sp.start(req),
    stop: (spawnId, force) => sp.stop(spawnId, force),
    setDefaultModel,
  };
}

/** Alias matching this composable directory's `use*` naming (same shape as `useControl.ts`). */
export const useSpawn = createSpawn;
