/** First revoke synchronously denies admission; database success/touch is never a login proof. */
import { randomBytes } from "node:crypto";
import type { AuthIdentity } from "../auth-identity.js";
import type { AuthRevokeBus, AuthRevokeSelector } from "../auth-revoke.js";
import { TERMINAL_FENCE_CAPACITY } from "../../protocol/terminal.js";
import { TerminalFault } from "./limits.js";
export type TerminalLoginProof = {
  bootNonce: string;
  listener: AuthIdentity["listener"];
  principal: string;
  sidTag: string;
  userId?: number;
  authEpoch: number;
  issuedAfterFenceRevision: number;
  hardExpiry: number;
};
type Deny = { selector: AuthRevokeSelector; revision: number; cutoff?: { revision: number; epoch: number } };
const key = (s: AuthRevokeSelector) =>
  s === "all" ? "all" : "sidTag" in s ? `s:${s.sidTag}` : "userId" in s ? `u:${s.userId}` : `l:${s.listener}`;
export function matches(s: AuthRevokeSelector, id: Pick<AuthIdentity, "listener" | "sidTag" | "userId">) {
  return (
    s === "all" ||
    ("sidTag" in s ? s.sidTag === id.sidTag : "userId" in s ? s.userId === id.userId : s.listener === id.listener)
  );
}
export class TerminalRevocationFence {
  readonly bootNonce = randomBytes(24).toString("base64url");
  private rev = 0;
  private poison = false;
  private denies = new Map<string, Deny>();
  private logins = new Map<string, TerminalLoginProof>();
  private subscribers = new Set<(selector: AuthRevokeSelector) => void>();
  private off: (() => void) | undefined;
  constructor(
    private readonly now: () => number,
    bus?: AuthRevokeBus,
  ) {
    if (bus) this.connect(bus);
  }
  get revision() {
    return this.rev;
  }
  selectorRevision(selector: AuthRevokeSelector) {
    return this.denies.get(key(selector))?.revision;
  }
  connect(bus: AuthRevokeBus) {
    this.off?.();
    this.off = bus.subscribe((e) => this.revoke(e.sel));
  }
  subscribe(fn: (selector: AuthRevokeSelector) => void) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  revoke(selector: AuthRevokeSelector): number {
    const revision = ++this.rev;
    try {
      // No eviction: install a wider sticky latch BEFORE compacting exact denies.
      if (
        !this.denies.has(key(selector)) &&
        [...this.denies.values()].filter((d) => d.selector !== "all" && !("listener" in d.selector)).length >=
          TERMINAL_FENCE_CAPACITY
      ) {
        selector = "all";
      }
      this.denies.set(key(selector), { selector, revision });
      if (selector === "all") {
        for (const [k] of this.denies) if (k !== "all") this.denies.delete(k);
      }
      for (const [k, p] of this.logins) if (matches(selector, p)) this.logins.delete(k);
      for (const fn of this.subscribers) fn(selector);
    } catch {
      this.poison = true;
      this.logins.clear();
      for (const fn of this.subscribers) {
        try {
          fn("all");
        } catch {
          /* sticky poison cannot be undone by a failed consumer */
        }
      }
    }
    return revision;
  }
  /** Internal-only repair. Caller must independently verify CURRENT committed store epoch/batch,
   * never reuse a timed-out deletion promise. CAS rejects concurrent/reordered completion. */
  async repair(
    selector: AuthRevokeSelector,
    revision: number,
    epoch: number,
    verifyCurrent: () => Promise<boolean>,
  ): Promise<boolean> {
    const d = this.denies.get(key(selector));
    if (!d || d.revision !== revision || this.poison || !Number.isSafeInteger(epoch) || epoch < 0) return false;
    let valid = false;
    try {
      valid = await verifyCurrent();
    } catch {
      return false;
    }
    if (!valid || this.denies.get(key(selector)) !== d || d.revision !== revision) return false;
    if (selector !== "all" && "sidTag" in selector) this.denies.delete(key(selector));
    else d.cutoff = { revision: ++this.rev, epoch };
    return true;
  }
  /** Must be called ONLY at real successful session insertion, with revision captured BEFORE
   * the login transaction started. authorize/touch and old cookies have no such callback. */
  loginComplete(id: AuthIdentity, authEpoch: number, startedRevision: number): boolean {
    for (const [k, p] of this.logins) if (this.now() >= p.hardExpiry) this.logins.delete(k);
    if (this.poison || startedRevision !== this.rev || this.now() >= id.parentExpiresAt || this.logins.size >= 2048)
      return false;
    const proof: TerminalLoginProof = {
      bootNonce: this.bootNonce,
      listener: id.listener,
      principal: id.principal,
      sidTag: id.sidTag,
      ...(id.userId === undefined ? {} : { userId: id.userId }),
      authEpoch,
      issuedAfterFenceRevision: startedRevision,
      hardExpiry: id.parentExpiresAt,
    };
    if (
      [...this.denies.values()].some(
        (d) =>
          matches(d.selector, id) && (!d.cutoff || startedRevision < d.cutoff.revision || authEpoch < d.cutoff.epoch),
      )
    )
      return false;
    this.logins.set(`${id.listener}:${id.sidTag}`, proof);
    return true;
  }
  proof(id: AuthIdentity): TerminalLoginProof {
    if (this.poison || [...this.denies.values()].some((d) => matches(d.selector, id) && !d.cutoff))
      throw new TerminalFault("E_AUTH_REVOKING");
    const p = this.logins.get(`${id.listener}:${id.sidTag}`);
    if (
      !p ||
      p.bootNonce !== this.bootNonce ||
      p.principal !== id.principal ||
      p.userId !== id.userId ||
      this.now() >= Math.min(p.hardExpiry, id.parentExpiresAt) ||
      (id.lan && p.authEpoch !== id.lan.epoch)
    )
      throw new TerminalFault("E_AUTH");
    for (const d of this.denies.values())
      if (
        matches(d.selector, id) &&
        (!d.cutoff || p.issuedAfterFenceRevision < d.cutoff.revision || p.authEpoch < d.cutoff.epoch)
      )
        throw new TerminalFault("E_AUTH_REVOKING");
    return p;
  }
  dispose() {
    this.poison = true;
    this.off?.();
    this.revoke("all");
    this.subscribers.clear();
    this.logins.clear();
  }
  size() {
    return this.denies.size;
  }
}
