/** Local original-auth transaction receipts, never P0, HTTP/agent wire or disk.
 * The concrete store gets this from the SAME setPassword DB transaction, not a
 * second getUser/listSessions roundtrip. Absence is unknown, not manufactured facts. */
import type { LanStorePort, PortOptions } from "./ports.js";
export interface PasswordCommitFact {
  readonly kind: "password-committed";
  readonly userId: number;
  readonly beforeEpoch: number | null;
  readonly afterEpoch: number;
}
export interface PasswordFactStore {
  setPasswordWithFact(
    input: Parameters<LanStorePort["setPassword"]>[0],
    options?: PortOptions,
  ): Promise<PasswordCommitFact>;
}
export function passwordFactStore(store: LanStorePort): PasswordFactStore | undefined {
  const candidate = store as LanStorePort & Partial<PasswordFactStore>;
  return typeof candidate.setPasswordWithFact === "function" ? (candidate as PasswordFactStore) : undefined;
}
export function passwordCommitFact(value: unknown): PasswordCommitFact {
  if (typeof value !== "object" || value === null) throw new Error("E_DB");
  const fact = value as PasswordCommitFact;
  if (
    Object.keys(fact).sort().join(",") !== "afterEpoch,beforeEpoch,kind,userId" ||
    fact.kind !== "password-committed" ||
    !Number.isSafeInteger(fact.userId) ||
    fact.userId < 1 ||
    !Number.isSafeInteger(fact.afterEpoch) ||
    fact.afterEpoch < 0 ||
    (fact.beforeEpoch !== null &&
      (!Number.isSafeInteger(fact.beforeEpoch) || fact.beforeEpoch < 0 || fact.afterEpoch <= fact.beforeEpoch))
  )
    throw new Error("E_DB");
  return Object.freeze({ ...fact });
}
