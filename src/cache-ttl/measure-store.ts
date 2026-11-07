/**
 * Persistent store of `/cache-ttl measure` results (measure-plan.md r4 §7.3/§8). Pure and pi-free (node:fs/promises,
 * node:path, node:os).
 *
 * `<agentDir>/cache-ttl-measurements.json` (`$PI_CODING_AGENT_DIR` else `~/.pi/agent`), dir 0700, file 0600, tmp +
 * rename, schema v1, per route only `latest` + `inProgress`. Writes are:
 *  - async (`fs.promises`), never awaited by the runner, never throwing;
 *  - single-writer: ONE write in flight per process (the slot lives on the process-level claim, so it also holds
 *    across `/reload`); a newer snapshot of the same route+slot replaces the pending one (coalescing);
 *  - bounded: each step (read-merge, write tmp, rename) is raced against `persistStepDeadlineMs`; a timed-out step
 *    turns the slot into a `zombie` — later persists are skipped and reported, late completions are ignored;
 *  - cross-process last-writer-wins on the whole file: every write re-reads the file, applies the pending updates and
 *    replaces it;
 *  - budgeted: the serialized output stays ≤ `writeBudgetBytes` (192 KiB) by stepwise trimming, so it is always
 *    readable under the 256 KiB read cap. A file that is unreadable / over the read cap / of an unknown version is
 *    renamed to `….corrupt` (single backup, overwritten) and treated as empty.
 */

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { resolveAgentDir } from "../core/agent-dir.js";
import { systemClock, type Clock } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import { getMeasureClaim, type MeasurePersistSlot, type MeasurePendingUpdate } from "./measure-claim.js";
import { recordEligible } from "./measure-classify.js";
import {
  MEASURE_APIS,
  MEASURE_STORE_CORRUPT_SUFFIX,
  MEASURE_STORE_FILE,
  MEASURE_STORE_LIMITS,
  MEASURE_STORE_VERSION,
  type LearnedTtl,
  type MeasurePersistState,
  type MeasureRouteIdentity,
  type MeasureRouteRecord,
  type MeasureRunRecord,
  type MeasureStoreFile,
  type MeasureStorePort,
  type RenewsOnRead,
} from "./measure-types.js";

/** Pi-free agentDir resolution; relative overrides fall back to `~/.pi/agent`. */
export function defaultMeasureStorePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return path.join(resolveAgentDir(env, home).dir, MEASURE_STORE_FILE);
}

// ---------------------------------------------------------------------------------------------------------------------
// Parse / sanitize
// ---------------------------------------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function sanitizeRun(x: unknown): MeasureRunRecord | null | undefined {
  if (x === null) return null;
  if (!isObj(x)) return undefined;
  const ttl = x.ttl;
  if (
    typeof x.runId !== "string" ||
    typeof x.status !== "string" ||
    !isNum(x.startedAt) ||
    !isObj(ttl) ||
    typeof ttl.consistent !== "boolean" ||
    !isNum(ttl.validHits) ||
    !Array.isArray(x.samples)
  ) {
    return undefined;
  }
  return x as unknown as MeasureRunRecord;
}

function sanitizeRoute(x: unknown): MeasureRouteRecord | undefined {
  if (!isObj(x)) return undefined;
  if (
    typeof x.key !== "string" ||
    typeof x.label !== "string" ||
    typeof x.wireModel !== "string" ||
    typeof x.effectiveTier !== "string" ||
    (x.requestedRetention !== "short" && x.requestedRetention !== "long") ||
    !(MEASURE_APIS as readonly unknown[]).includes(x.api)
  ) {
    return undefined;
  }
  const latest = sanitizeRun(x.latest ?? null);
  const inProgress = sanitizeRun(x.inProgress ?? null);
  if (latest === undefined || inProgress === undefined) return undefined;
  return { ...(x as unknown as MeasureRouteRecord), latest, inProgress };
}

export type ParsedStore = { ok: true; file: MeasureStoreFile } | { ok: false };

/** Strict file-level parse (size cap, JSON, version); malformed ROUTES are dropped individually. */
export function parseStoreText(text: string): ParsedStore {
  if (Buffer.byteLength(text, "utf8") > MEASURE_STORE_LIMITS.readCapBytes) return { ok: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!isObj(raw) || raw.version !== MEASURE_STORE_VERSION || !Array.isArray(raw.routes)) return { ok: false };
  const routes: MeasureRouteRecord[] = [];
  for (const r of raw.routes) {
    const s = sanitizeRoute(r);
    if (s !== undefined) routes.push(s);
  }
  return { ok: true, file: { version: MEASURE_STORE_VERSION, routes } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Budget trimming (§8)
// ---------------------------------------------------------------------------------------------------------------------

export const serializeStore = (file: MeasureStoreFile): string => JSON.stringify(file);
const sizeOf = (file: MeasureStoreFile): number => Buffer.byteLength(serializeStore(file), "utf8");

const activityOf = (r: MeasureRouteRecord): number =>
  Math.max(r.latest?.finishedAt ?? r.latest?.startedAt ?? 0, r.inProgress?.startedAt ?? 0);

function stripRun(run: MeasureRunRecord | null): MeasureRunRecord | null {
  if (run === null) return null;
  const stripped: MeasureRunRecord = { ...run, samples: [] };
  if (run.renewal !== undefined && run.renewal.read !== undefined) {
    const { read: _read, ...rest } = run.renewal;
    void _read;
    stripped.renewal = rest;
  }
  return stripped;
}

/**
 * Trim to `budget` bytes (default `writeBudgetBytes`) and `routeCap` routes, in this order: (1) `inProgress` of routes
 * not in `liveKeys` (non-live runs), (2) `samples` and `renewal.read` of non-live routes, oldest-first, (3) oldest
 * non-live routes whole, (4) as a last resort the live routes' own detail, then whole routes. Never mutates `file`.
 */
export function trimStoreToBudget(
  file: MeasureStoreFile,
  liveKeys: ReadonlySet<string>,
  budget: number = MEASURE_STORE_LIMITS.writeBudgetBytes,
  routeCap: number = MEASURE_STORE_LIMITS.routeCap,
): MeasureStoreFile {
  let routes = file.routes.map((r) => ({ ...r }));
  const out = (): MeasureStoreFile => ({ version: MEASURE_STORE_VERSION, routes });
  const oldestFirst = (list: MeasureRouteRecord[]) => [...list].sort((a, b) => activityOf(a) - activityOf(b));
  const dropOldest = (live: boolean): boolean => {
    const victim = oldestFirst(routes).find((r) => liveKeys.has(r.key) === live);
    if (victim === undefined) return false;
    routes = routes.filter((r) => r !== victim);
    return true;
  };

  // route cap first (oldest non-live routes, then — impossible in practice — oldest live ones)
  while (routes.length > routeCap) {
    if (!dropOldest(false) && !dropOldest(true)) break;
  }
  if (sizeOf(out()) <= budget) return out();

  // (1) inProgress of non-live runs
  routes = routes.map((r) => (!liveKeys.has(r.key) && r.inProgress !== null ? { ...r, inProgress: null } : r));
  if (sizeOf(out()) <= budget) return out();

  // (2) samples + renewal.read of non-live routes, oldest first
  for (const victim of oldestFirst(routes).filter((r) => !liveKeys.has(r.key))) {
    const i = routes.indexOf(victim);
    routes[i] = { ...victim, latest: stripRun(victim.latest), inProgress: stripRun(victim.inProgress) };
    if (sizeOf(out()) <= budget) return out();
  }

  // (3) whole non-live routes, oldest first
  while (dropOldest(false)) {
    if (sizeOf(out()) <= budget) return out();
  }

  // (4) live routes: detail first, then whole routes (oldest first) — the budget is a hard promise
  routes = routes.map((r) => ({ ...r, latest: stripRun(r.latest), inProgress: stripRun(r.inProgress) }));
  while (sizeOf(out()) > budget && dropOldest(true)) {
    /* drop until it fits */
  }
  return out();
}

/** Apply pending updates onto a (freshly read) file: LWW on the whole route+slot. */
export function applyUpdates(file: MeasureStoreFile, updates: readonly MeasurePendingUpdate[]): MeasureStoreFile {
  const routes = file.routes.map((r) => ({ ...r }));
  for (const u of updates) {
    const idx = routes.findIndex((r) => r.key === u.route.key);
    const identity: MeasureRouteIdentity = {
      key: u.route.key,
      label: u.route.label,
      api: u.route.api,
      wireModel: u.route.wireModel,
      requestedRetention: u.route.requestedRetention,
      effectiveTier: u.route.effectiveTier,
    };
    if (idx < 0) {
      routes.push({ ...identity, latest: null, inProgress: null, [u.slot]: u.run });
    } else {
      routes[idx] = { ...routes[idx]!, ...identity, [u.slot]: u.run };
    }
  }
  return { version: MEASURE_STORE_VERSION, routes };
}

// ---------------------------------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------------------------------

/** The subset of `fs.promises` the store uses (test seam). */
export interface MeasureStoreFs {
  mkdir(dir: string, options: { recursive: true; mode: number }): Promise<unknown>;
  stat(file: string): Promise<{ size: number }>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  writeFile(file: string, data: string, options: { mode: number; flag: string }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(file: string): Promise<unknown>;
}

export interface MeasureStoreOptions {
  filePath?: string;
  clock?: Clock;
  fs?: MeasureStoreFs;
  /** The process-wide single-writer slot; default: the one on the process claim. */
  slot?: MeasurePersistSlot;
  /** Test seam for tmp-file uniqueness. */
  tmpSuffix?: () => string;
}

export interface MeasureStore extends MeasureStorePort {
  /** Resolves when the writer loop of THIS instance is idle (test/diagnostic helper; never rejects). */
  flush(): Promise<void>;
  readonly filePath: string;
  /** Bounded read-only status listing; never guesses the authenticated route key. */
  readRoutes(): Promise<readonly MeasureRouteRecord[]>;
  /** Only a successfully written batch containing this run can supply its save timestamp. */
  lastSavedAtFor(runId: string): Millis | undefined;
}

type Raced<T> = { timedOut: false; value: T } | { timedOut: true };

export function createMeasureStore(options: MeasureStoreOptions = {}): MeasureStore {
  const filePath = options.filePath ?? defaultMeasureStorePath();
  const clock = options.clock ?? systemClock;
  const fs: MeasureStoreFs = options.fs ?? (fsp as unknown as MeasureStoreFs);
  const slot = options.slot ?? getMeasureClaim().persistSlot;
  const savedRuns = (slot.savedRuns ??= new Map<string, Millis>());
  const tmpSuffix = options.tmpSuffix ?? (() => `${process.pid}.${Math.random().toString(36).slice(2, 10)}`);
  const stepMs = MEASURE_STORE_LIMITS.persistStepDeadlineMs;
  let loop: Promise<void> | undefined;

  /** Race one async step against the step deadline (unref'd clock timer; always cleared). */
  const race = <T>(op: () => Promise<T>): Promise<Raced<T>> =>
    new Promise<Raced<T>>((resolve, reject) => {
      let done = false;
      const timer = clock.setTimer(stepMs, () => {
        if (done) return;
        done = true;
        resolve({ timedOut: true });
      });
      let p: Promise<T>;
      try {
        p = op();
      } catch (error) {
        done = true;
        clock.clearTimer(timer);
        reject(error);
        return;
      }
      p.then(
        (value) => {
          if (done) return; // late completion of a timed-out step: ignored
          done = true;
          clock.clearTimer(timer);
          resolve({ timedOut: false, value });
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          clock.clearTimer(timer);
          reject(error);
        },
      );
    });

  const goZombie = (): void => {
    slot.state = "zombie";
    slot.zombieSince ??= clock.now();
    slot.pending.clear();
  };

  /** Read + parse the file. `undefined` ⇒ step timed out. Corrupt ⇒ rename to `.corrupt` (writer only) and empty. */
  async function readFile(quarantine: boolean): Promise<MeasureStoreFile | undefined> {
    let text: string | undefined;
    let tooBig = false;
    try {
      const r = await race(async () => {
        const st = await fs.stat(filePath);
        if (st.size > MEASURE_STORE_LIMITS.readCapBytes) return { big: true as const };
        return { big: false as const, text: await fs.readFile(filePath, "utf8") };
      });
      if (r.timedOut) return undefined;
      if (r.value.big) tooBig = true;
      else text = r.value.text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: MEASURE_STORE_VERSION, routes: [] };
      // unreadable: same as corrupt
      tooBig = true;
    }
    if (!tooBig && text !== undefined) {
      const parsed = parseStoreText(text);
      if (parsed.ok) return parsed.file;
    }
    if (quarantine) {
      try {
        const r = await race(() => fs.rename(filePath, `${filePath}${MEASURE_STORE_CORRUPT_SUFFIX}`));
        if (r.timedOut) return undefined;
      } catch {
        /* best effort */
      }
    }
    return { version: MEASURE_STORE_VERSION, routes: [] };
  }

  async function writeOnce(updates: MeasurePendingUpdate[]): Promise<"ok" | "failed" | "zombie"> {
    try {
      await (async () => {
        const dir = path.dirname(filePath);
        const mk = await race(() => fs.mkdir(dir, { recursive: true, mode: MEASURE_STORE_LIMITS.dirMode }));
        if (mk.timedOut) throw Object.assign(new Error("timeout"), { zombie: true });
      })();
      const current = await readFile(true);
      if (current === undefined) return "zombie";
      const live = new Set(updates.filter((u) => u.run !== null && u.slot === "inProgress").map((u) => u.route.key));
      for (const u of updates) live.add(u.route.key);
      const merged = trimStoreToBudget(applyUpdates(current, updates), live);
      const body = serializeStore(merged);
      const tmp = `${filePath}.${tmpSuffix()}.tmp`;
      const w = await race(() => fs.writeFile(tmp, body, { mode: MEASURE_STORE_LIMITS.fileMode, flag: "wx" }));
      if (w.timedOut) return "zombie";
      const rn = await race(() => fs.rename(tmp, filePath));
      if (rn.timedOut) return "zombie";
      return "ok";
    } catch (error) {
      if ((error as { zombie?: boolean })?.zombie === true) return "zombie";
      return "failed";
    }
  }

  async function runLoop(): Promise<void> {
    slot.writing = true;
    slot.state = "writing";
    try {
      while (slot.pending.size > 0 && (slot.state as MeasurePersistState) !== "zombie") {
        const batch = [...slot.pending.values()];
        slot.pending.clear();
        const result = await writeOnce(batch);
        if (result === "zombie") {
          goZombie();
          return;
        }
        if (result === "ok") {
          const at = clock.now();
          slot.lastSavedAt = at;
          for (const update of batch) if (update.run) savedRuns.set(update.run.runId, at);
          // Same bound as two records per retained route; no unbounded process history.
          while (savedRuns.size > MEASURE_STORE_LIMITS.routeCap * 2) savedRuns.delete(savedRuns.keys().next().value!);
        }
        // "failed": swallowed — the next snapshot of the run replaces it anyway
      }
    } finally {
      slot.writing = false;
      if (slot.state === "writing") slot.state = "idle";
    }
  }

  const kick = (): void => {
    if (slot.writing || slot.state === "zombie") return;
    loop = runLoop().catch(() => {
      slot.writing = false;
      if (slot.state === "writing") slot.state = "idle";
    });
  };

  return {
    filePath,
    get persistState(): MeasurePersistState {
      return slot.state;
    },
    lastSavedAtFor(runId) {
      return savedRuns.get(runId);
    },
    get lastSavedAt(): Millis | undefined {
      return slot.lastSavedAt;
    },
    persist(route, which, run) {
      try {
        if (slot.state === "zombie") return; // skipped and reported through `persistState`
        slot.pending.set(`${route.key}\u0000${which}`, { route, slot: which, run });
        kick();
      } catch {
        /* never throws */
      }
    },
    async readRoutes() {
      try {
        return (await readFile(false))?.routes ?? [];
      } catch {
        return [];
      }
    },
    async readRoute(key) {
      try {
        const file = await readFile(false);
        return file?.routes.find((r) => r.key === key);
      } catch {
        return undefined;
      }
    },
    async lookupLearnedTtl(key, now): Promise<LearnedTtl | undefined> {
      const route = await this.readRoute(key);
      const latest = route?.latest;
      if (latest === null || latest === undefined || !recordEligible(latest, now)) return undefined;
      const lowerMs = latest.ttl.lowerMs;
      if (lowerMs === undefined) return undefined;
      const renews: RenewsOnRead = latest.renewal?.renewsOnRead === "true" ? "true" : "unknown";
      return {
        lowerMs,
        renewsOnRead: renews,
        ...(renews === "true" && latest.renewal?.basis !== undefined ? { renewalBasis: latest.renewal.basis } : {}),
        sampledAt: latest.finishedAt ?? latest.startedAt,
      };
    },
    async flush() {
      for (let i = 0; i < 50; i++) {
        const l = loop;
        if (l === undefined) return;
        await l;
        if (loop === l && !slot.writing && slot.pending.size === 0) return;
        if (slot.state === "zombie") return;
      }
    },
  };
}
