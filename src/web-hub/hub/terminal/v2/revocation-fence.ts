/** In-memory auth notification ONLY. Auth's DB/token/rotate protocol is the fact source. */
import type { PasswordCommitFact } from "../../auth-store-facts.js";
import type { AuthIdentity } from "../../auth-identity.js";
import type { AuthRevokeSelector } from "../../auth-revoke.js";
import type { TerminalAuthFact, TerminalAuthFenceV2 } from "../../terminal-v2-ports.js";
import { TERMINAL_V2_LIMITS as L } from "../../../protocol/terminal-v2-values.js";
import { fail, TerminalV2Fault } from "./local.js";

export function matchesTerminalAuthV2(
  selector: AuthRevokeSelector,
  id: Pick<AuthIdentity, "listener" | "sidTag" | "userId">,
): boolean {
  return (
    selector === "all" ||
    ("sidTag" in selector
      ? selector.sidTag === id.sidTag
      : "userId" in selector
        ? selector.userId === id.userId
        : selector.listener === id.listener)
  );
}
function key(selector: AuthRevokeSelector): string {
  return selector === "all"
    ? "all"
    : "sidTag" in selector
      ? `s:${selector.sidTag}`
      : "userId" in selector
        ? `u:${selector.userId}`
        : `l:${selector.listener}`;
}
export type TerminalAuthSubscriberV2 = (selector: AuthRevokeSelector, revision: number) => void;
/** Extra LOCAL capability, not a P0 wire/port change. A subscriber must synchronously seal
 * memory and initiate (not await) cleanup. Exceptions poison terminal only, never auth. */
export interface TerminalAuthNotificationsV2 {
  subscribe(listener: TerminalAuthSubscriberV2): () => void;
  dispose(): void;
}
export class TerminalRevocationFenceV2 implements TerminalAuthFenceV2, TerminalAuthNotificationsV2 {
  private rev = 0;
  private poisoned = false;
  private overflow = false;
  private disposed = false;
  private readonly denies = new Map<string, { selector: AuthRevokeSelector; revision: number }>();
  private readonly listeners = new Set<TerminalAuthSubscriberV2>();
  private readonly creatorListeners = new Set<TerminalAuthSubscriberV2>();
  private readonly userMutations = new Map<object, number>();
  constructor(private readonly now: () => number = Date.now) {}
  get revision(): number {
    return this.rev;
  }
  check(id: AuthIdentity, capturedRevision: number): void {
    if (
      this.disposed ||
      this.poisoned ||
      capturedRevision !== this.rev ||
      (id.listener === "lan" && this.userMutations.size > 0) ||
      [...this.denies.values()].some((deny) => matchesTerminalAuthV2(deny.selector, id))
    )
      throw new TerminalV2Fault(fail("E_REVOKING"));
    if (!Number.isFinite(id.parentExpiresAt) || this.now() >= id.parentExpiresAt)
      throw new TerminalV2Fault(fail("E_AUTH"));
  }
  subscribe(listener: TerminalAuthSubscriberV2): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.listeners.delete(listener);
      }
    };
  }
  /** Local auth transaction bridge, not P0 settle or a persistent intent. Before
   * the ORIGINAL transaction await, temporarily block LAN admission and seal views/
   * flights. Do not kill unrelated creators just because the userId is not yet known.
   * Each opaque token owns exactly its own block; other revocations are never removed. */
  beginUserMutation(): object {
    const token = Object.freeze({});
    const revision = this.bump();
    if (this.userMutations.size >= L.authSelectors) {
      this.invalidate({ listener: "lan" });
      return token;
    }
    this.userMutations.set(token, revision);
    for (const listener of [...this.listeners]) {
      try {
        listener({ listener: "lan" }, revision);
      } catch {
        this.poisoned = true;
      }
    }
    return token;
  }
  finishUserMutation(
    token: object,
    fact: PasswordCommitFact | { kind: "user-absent"; userId: number } | { kind: "no-change-confirmed" },
  ): void {
    const revision = this.userMutations.get(token);
    if (this.disposed || this.poisoned || revision === undefined) return;
    // The token/revision capability belongs only to this original same-operation
    // receipt. Later completions cannot clear a different operation, sticky deny,
    // or overflow. P0 settle still retains its stricter global revision CAS.
    if (fact.kind !== "no-change-confirmed" && (!Number.isSafeInteger(fact.userId) || fact.userId < 1)) return;
    if (
      fact.kind === "password-committed" &&
      (!Number.isSafeInteger(fact.afterEpoch) ||
        fact.afterEpoch < 0 ||
        (fact.beforeEpoch !== null &&
          (!Number.isSafeInteger(fact.beforeEpoch) || fact.beforeEpoch < 0 || fact.afterEpoch <= fact.beforeEpoch)))
    )
      return;
    if (fact.kind !== "no-change-confirmed") {
      for (const listener of [...this.creatorListeners]) {
        try {
          listener({ userId: fact.userId }, revision);
        } catch {
          this.poisoned = true;
        }
      }
    }
    if (!this.poisoned) {
      this.userMutations.delete(token);
      this.bump();
    }
  }
  subscribeCreators(listener: TerminalAuthSubscriberV2): () => void {
    this.creatorListeners.add(listener);
    return () => {
      this.creatorListeners.delete(listener);
    };
  }
  private bump(): number {
    if (this.rev >= Number.MAX_SAFE_INTEGER) this.poisoned = true;
    else this.rev++;
    return this.rev;
  }
  invalidate(selector: AuthRevokeSelector): number {
    const revision = this.bump();
    try {
      const k = key(selector);
      if (!this.denies.has(k) && this.denies.size >= L.authSelectors) {
        this.overflow = true;
        selector = "all";
        this.denies.clear();
      }
      // Copy caller-owned selector, so mutating it after notification cannot lift a deny.
      const captured = selector === "all" ? selector : { ...selector };
      this.denies.set(key(captured), { selector: captured, revision });
      let threw = false;
      for (const listener of [...this.listeners, ...this.creatorListeners]) {
        try {
          listener(captured, revision);
        } catch {
          threw = true;
        }
      }
      if (threw) {
        this.poisoned = true;
        for (const listener of [...this.listeners, ...this.creatorListeners]) {
          try {
            listener("all", revision);
          } catch {
            /* auth must still commit */
          }
        }
      }
    } catch {
      this.poisoned = true;
    }
    return revision;
  }
  settle(selector: AuthRevokeSelector, revision: number, fact: TerminalAuthFact): void {
    // Global revision CAS also rejects an older completion after a different revoke/settle.
    const deny = this.denies.get(key(selector));
    if (this.disposed || this.poisoned || revision !== this.rev || deny?.revision !== revision) return;
    let proven = false;
    if (fact.kind === "no-change-confirmed") proven = !this.overflow;
    else if (selector !== "all" && "sidTag" in selector)
      proven = fact.kind === "sid-absent" && fact.sidTag === selector.sidTag;
    else if (selector !== "all" && "userId" in selector)
      proven =
        (fact.kind === "user-absent" && fact.userId === selector.userId) ||
        (fact.kind === "user-epoch-advanced" &&
          fact.userId === selector.userId &&
          Number.isSafeInteger(fact.beforeEpoch) &&
          fact.beforeEpoch >= 0 &&
          Number.isSafeInteger(fact.afterEpoch) &&
          fact.afterEpoch > fact.beforeEpoch);
    else
      proven =
        fact.kind === "listeners-invalidated" &&
        Number.isSafeInteger(fact.loopAuthGen) &&
        fact.loopAuthGen >= 0 &&
        ((selector !== "all" && selector.listener === "loopback") || fact.lanComplete);
    if (!proven) return;
    this.denies.delete(key(selector));
    if (selector === "all") this.overflow = false;
    this.bump();
  }
  dispose(): void {
    if (this.disposed) return;
    this.invalidate("all");
    this.disposed = true;
    this.listeners.clear();
    this.creatorListeners.clear();
    this.userMutations.clear();
    this.denies.clear();
  }
}
