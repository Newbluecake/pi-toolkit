import type { OutboxStore } from "../core/store.js";

export interface EngineOptions<
  R extends { key: string; state: S; attempts: number; updatedAt: number },
  S extends string,
> {
  store: OutboxStore<R>;
  allowed: Readonly<Record<S, readonly S[]>>;
  memoryOnly: ReadonlySet<S>;
  memoryOnlyFields: readonly (keyof R)[];
  now: () => number;
  onDegraded?: (key: string, reason: string) => void;
}

/**
 * fabric-cross-session plan v3 §3.5 / §4.1 (D-W11): the persist-before-memory, CAS-guarded siblings of
 * `transition`/`annotate`. Contract shared by all three strict ops:
 *  - `frozen` ⇒ refuse; unknown key / state mismatch / claimToken mismatch / edge not allowed ⇒ `conflict`;
 *  - the store write happens FIRST; if it throws the in-memory record is untouched (`persist_failed`) and the
 *    store's own cache is expected to roll back (createPiOutboxStore does) — `onDegraded` is NOT called, the caller
 *    owns the failure;
 *  - memory-only fields are never persisted, and the persisted form of a record held in a memory-only state
 *    (`claimed`) is its normalized `pending` form (the store only ever holds the persisted state);
 *  - a record sitting in a memory-only state must be addressed with its `claimToken` (a missing/wrong token ⇒ `conflict`).
 */
export type StrictFailure = "conflict" | "frozen" | "persist_failed";
/** What `reserveStrict` binds a record to (structurally `FabricRecord["reserved"]`). */
export interface ReservationMark {
  rsv: string;
  runId: string;
  at: number;
}
export type StrictExpect<S extends string> = { state: S | readonly S[]; claimToken?: string };

export interface DeliveryEngine<R, S extends string> {
  put(record: R): boolean;
  get(key: string): R | undefined;
  select(pred: (record: R) => boolean): R[];
  transition(
    key: string,
    from: S | readonly S[],
    to: S,
    patch?: Partial<R>,
    guard?: (record: R) => boolean,
  ): R | undefined;
  claim(key: string, token: string): R | undefined;
  annotate(key: string, patch: Partial<R>): boolean;
  /**
   * CAS + persist-first `transition`. `expect.claimToken` is required when the current state is memory-only. A patch
   * key explicitly set to `undefined` clears that field (memory and persisted form). Leaving a memory-only state also
   * drops every memory-only field from the in-memory record (the stale `claimToken` never lingers).
   */
  transitionStrict(
    key: string,
    expect: StrictExpect<S>,
    to: S,
    patch?: Partial<R>,
  ): { ok: true; record: R } | { ok: false; reason: StrictFailure };
  /** CAS + persist-first `annotate` (same state kept, `claimed` stays `claimed` in memory, persisted as `pending`+patch). */
  annotateStrict(
    key: string,
    expect: StrictExpect<S>,
    patch: Partial<R>,
  ): { ok: true } | { ok: false; reason: StrictFailure };
  /**
   * Claim-aware reservation (plan §3.5). `expect` is `{state:"pending"}` or `{state:"claimed", claimToken}`.
   * `conflict` also covers an already-`reserved`/`quarantined` record. `expired` uses the same comparison as the
   * mailbox TTL (F0): `now >= createdAt + ttlMs`. Success persists `pending + reserved` first, then moves memory to
   * `pending` (a claimed trigger's ownership passes from the mailbox to the reservation) and drops the claimToken.
   */
  reserveStrict(
    key: string,
    expect: { state: "pending" } | { state: "claimed"; claimToken: string },
    reserved: ReservationMark,
    now: number,
    ttlMs: number,
  ): { ok: true } | { ok: false; reason: StrictFailure | "expired" };
  freeze(): void;
  fold(list: readonly R[]): Map<string, R>;
  readonly stats: Record<S, number>;
}

function copy<T>(value: T): T {
  return { ...(value as object) } as T;
}

export function createDeliveryEngine<
  R extends { key: string; state: S; attempts: number; updatedAt: number },
  S extends string,
>(options: EngineOptions<R, S>): DeliveryEngine<R, S> {
  const records = new Map<string, R>();
  let frozen = false;
  for (const [key, record] of (() => {
    const folded = new Map<string, R>();
    for (const raw of options.store.list()) {
      const current = folded.get(raw.key);
      if (
        current !== undefined &&
        (current.updatedAt > raw.updatedAt || (current.updatedAt === raw.updatedAt && current.attempts >= raw.attempts))
      )
        continue;
      const normalized = copy(raw);
      if (options.memoryOnly.has(normalized.state)) {
        normalized.state = "pending" as S;
        for (const field of options.memoryOnlyFields) delete (normalized as Record<string, unknown>)[String(field)];
      }
      folded.set(raw.key, normalized);
    }
    return folded;
  })())
    records.set(key, record);

  const withoutMemoryOnly = (patch: Partial<R>): Partial<R> => {
    const result: Record<string, unknown> = { ...(patch as object) };
    for (const field of options.memoryOnlyFields) delete result[String(field)];
    return result as Partial<R>;
  };
  const withoutState = (patch: Partial<R>): Partial<R> => {
    const result: Record<string, unknown> = { ...(patch as object) };
    delete result.state;
    return result as Partial<R>;
  };

  const withoutMemoryOnlyKeys = (record: R): R => {
    const result: Record<string, unknown> = { ...(record as object) };
    for (const field of options.memoryOnlyFields) delete result[String(field)];
    return result as R;
  };
  /** Drops keys explicitly set to `undefined` (a cleared field must be absent, not present-and-undefined). */
  const withoutUndefined = (record: R): R => {
    const result: Record<string, unknown> = { ...(record as object) };
    for (const [name, value] of Object.entries(result)) if (value === undefined) delete result[name];
    return result as R;
  };
  /** CAS lookup shared by the strict ops: the live record iff its state (and claimToken, for a memory-only state) match. */
  const casTarget = (key: string, expect: StrictExpect<S>): R | undefined => {
    const current = records.get(key);
    if (current === undefined) return undefined;
    const states: readonly S[] = Array.isArray(expect.state) ? (expect.state as readonly S[]) : [expect.state as S];
    if (!states.includes(current.state)) return undefined;
    if (options.memoryOnly.has(current.state)) {
      const held = (current as unknown as { claimToken?: string }).claimToken;
      if (expect.claimToken === undefined || held !== expect.claimToken) return undefined;
    }
    return current;
  };

  const recordDegraded = (key: string, error: unknown): void => {
    options.onDegraded?.(key, error instanceof Error ? error.message : String(error));
  };

  const stats = (): Record<S, number> => {
    const result = {} as Record<S, number>;
    for (const record of records.values()) result[record.state] = (result[record.state] ?? 0) + 1;
    return result;
  };

  const engine: DeliveryEngine<R, S> = {
    put(record) {
      if (frozen || records.has(record.key)) return false;
      const persisted = withoutMemoryOnly(record);
      try {
        options.store.put(persisted as R);
      } catch (error) {
        throw error;
      }
      records.set(record.key, copy(record));
      return true;
    },
    get(key) {
      const record = records.get(key);
      return record === undefined ? undefined : copy(record);
    },
    select(pred) {
      return [...records.values()].filter(pred).map(copy);
    },
    transition(key, from, to, patch = {}, guard) {
      if (frozen) return undefined;
      const current = records.get(key);
      if (current === undefined) return undefined;
      const allowedFrom = Array.isArray(from) ? from : [from];
      if (
        !allowedFrom.includes(current.state) ||
        options.memoryOnly.has(to) ||
        !(options.allowed[current.state] ?? []).includes(to)
      )
        return undefined;
      if (guard !== undefined && !guard(current)) return undefined;
      const next = { ...current, ...patch, state: to, updatedAt: options.now() } as R;
      records.set(key, next);
      if (!options.memoryOnly.has(to)) {
        try {
          options.store.update(
            key,
            withoutMemoryOnly({ ...patch, state: to, updatedAt: next.updatedAt } as Partial<R>),
          );
        } catch (error) {
          recordDegraded(key, error);
        }
      }
      return copy(next);
    },
    claim(key, token) {
      if (frozen) return undefined;
      const current = records.get(key);
      if (current === undefined || current.state !== ("pending" as S)) return undefined;
      if (!(options.allowed[current.state] ?? []).includes("claimed" as S) || !options.memoryOnly.has("claimed" as S))
        return undefined;
      const next = { ...current, state: "claimed" as S, claimToken: token } as R;
      records.set(key, next);
      return copy(next);
    },
    annotate(key, patch) {
      if (frozen) return false;
      const current = records.get(key);
      if (current === undefined) return false;
      const next = { ...current, ...withoutState(patch), state: current.state, updatedAt: options.now() } as R;
      records.set(key, next);
      try {
        options.store.update(
          key,
          withoutMemoryOnly(withoutState({ ...patch, updatedAt: next.updatedAt } as Partial<R>)),
        );
      } catch (error) {
        recordDegraded(key, error);
      }
      return true;
    },
    transitionStrict(key, expect, to, patch = {}) {
      if (frozen) return { ok: false, reason: "frozen" };
      const current = casTarget(key, expect);
      if (current === undefined) return { ok: false, reason: "conflict" };
      if (options.memoryOnly.has(to) || !(options.allowed[current.state] ?? []).includes(to))
        return { ok: false, reason: "conflict" };
      const updatedAt = options.now();
      try {
        options.store.update(key, withoutMemoryOnly({ ...patch, state: to, updatedAt } as Partial<R>));
      } catch {
        return { ok: false, reason: "persist_failed" };
      }
      const next = withoutUndefined({
        ...(options.memoryOnly.has(current.state) ? withoutMemoryOnlyKeys(current) : current),
        ...patch,
        state: to,
        updatedAt,
      } as R);
      records.set(key, next);
      return { ok: true, record: copy(next) };
    },
    annotateStrict(key, expect, patch) {
      if (frozen) return { ok: false, reason: "frozen" };
      const current = casTarget(key, expect);
      if (current === undefined) return { ok: false, reason: "conflict" };
      const updatedAt = options.now();
      try {
        options.store.update(key, withoutMemoryOnly(withoutState({ ...patch, updatedAt } as Partial<R>)));
      } catch {
        return { ok: false, reason: "persist_failed" };
      }
      const next = withoutUndefined({ ...current, ...withoutState(patch), state: current.state, updatedAt } as R);
      records.set(key, next);
      return { ok: true };
    },
    reserveStrict(key, expect, reserved, now, ttlMs) {
      if (frozen) return { ok: false, reason: "frozen" };
      const current = casTarget(key, expect as unknown as StrictExpect<S>);
      if (current === undefined) return { ok: false, reason: "conflict" };
      const flags = current as unknown as { reserved?: unknown; quarantined?: unknown; createdAt?: unknown };
      if (flags.reserved !== undefined || flags.quarantined !== undefined) return { ok: false, reason: "conflict" };
      if (typeof flags.createdAt === "number" && now >= flags.createdAt + ttlMs)
        return { ok: false, reason: "expired" };
      const updatedAt = options.now();
      try {
        options.store.update(key, withoutMemoryOnly(withoutState({ reserved, updatedAt } as unknown as Partial<R>)));
      } catch {
        return { ok: false, reason: "persist_failed" };
      }
      const next = {
        ...(options.memoryOnly.has(current.state) ? withoutMemoryOnlyKeys(current) : current),
        reserved,
        state: "pending" as S,
        updatedAt,
      } as R;
      records.set(key, next);
      return { ok: true };
    },
    freeze() {
      frozen = true;
    },
    fold(list) {
      const folded = new Map<string, R>();
      for (const raw of list) {
        const current = folded.get(raw.key);
        if (
          current !== undefined &&
          (current.updatedAt > raw.updatedAt ||
            (current.updatedAt === raw.updatedAt && current.attempts >= raw.attempts))
        )
          continue;
        const normalized = copy(raw);
        if (options.memoryOnly.has(normalized.state)) {
          normalized.state = "pending" as S;
          for (const field of options.memoryOnlyFields) delete (normalized as Record<string, unknown>)[String(field)];
        }
        folded.set(raw.key, normalized);
      }
      return folded;
    },
    get stats() {
      return stats();
    },
  };

  return engine;
}
