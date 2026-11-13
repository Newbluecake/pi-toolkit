/** F2: atomic inventory collection, durable reservation/reap CAS and sticky lost isolation. */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import {
  TerminalInventorySchema,
  TerminalInventoryPageSchema,
  TerminalReapProofSchema,
  canonicalTerminalInventory,
  terminalIdentityKey,
  TERMINAL_LIMITS as L,
  type TerminalResolvedAck,
  type TerminalJournal,
  type TerminalResourceEntry,
  type TerminalChallenge,
  type TerminalInventory,
  type TerminalInventoryPage,
  type TerminalReapProof,
  type TerminalQuarantine,
  type TerminalProcessIdentity,
} from "../../protocol/terminal.js";
import type { TerminalResourceJournalPort, TerminalIngressMeta, TerminalResourceFencePort } from "../ports.js";
import { TerminalFault, bounded, sameTerminalMeta } from "./limits.js";
/** The local filesystem capability is verified in memory, never retained in the
 * resource journal (which persists identity/outcome metadata, not credentials). */
function durableProof(proof: TerminalReapProof): TerminalReapProof {
  const { receipt: _receipt, ...metadata } = structuredClone(proof);
  return metadata;
}
export const inventoryDigest = (entries: readonly TerminalResourceEntry[]) =>
  createHash("sha256").update(canonicalTerminalInventory(entries), "utf8").digest("hex");
const sameProcess = (a: TerminalProcessIdentity, b: TerminalProcessIdentity) =>
  a.bootId === b.bootId && a.pid === b.pid && a.starttime === b.starttime && a.uid === b.uid;
const processKey = (p: TerminalProcessIdentity) => JSON.stringify([p.bootId, p.pid, p.starttime, p.uid]);
type Collect = {
  ownerInstance: string;
  processIdentity: TerminalProcessIdentity;
  meta: TerminalIngressMeta;
  challenge: TerminalChallenge;
  begin?: Extract<TerminalInventoryPage, { phase: "begin" }>;
  entries: TerminalResourceEntry[];
  proofs: TerminalReapProof[];
  index: number;
  bytes: number;
  complete: boolean;
  invalid: boolean;
};
export class TerminalResourceFence implements TerminalResourceFencePort {
  readonly bootId = randomBytes(24).toString("base64url");
  private journal: TerminalJournal = { v: 1, revision: 0, resources: [] };
  private state: TerminalQuarantine["state"] = "collecting";
  private loaded = false;
  private failed = false;
  private busy = false;
  private collectionDeadlineAt: number | undefined;
  startCollection() {
    if (!this.loaded || this.failed) throw new TerminalFault("E_RESOURCE_QUARANTINED", "unknown");
    this.collectionDeadlineAt = this.deps.now() + L.inventoryMs;
    this.state = "collecting";
  }
  private collections = new Map<string, Collect>();
  // ACK may be lost after durable pruning. Keep bounded same-boot release receipts;
  // only a complete later inventory from the SAME process can prove them forgotten.
  private released = new Map<string, TerminalResourceEntry>();
  private recovery = new Set<string>();
  private resolvedListeners = new Set<
    (ack: TerminalResolvedAck, meta: TerminalIngressMeta, ownerInstance: string) => void
  >();
  onResolved(fn: (ack: TerminalResolvedAck, meta: TerminalIngressMeta, ownerInstance: string) => void) {
    this.resolvedListeners.add(fn);
    return () => {
      this.resolvedListeners.delete(fn);
    };
  }
  private releaseListeners = new Set<(reservationId: string) => void>();
  onRelease(fn: (reservationId: string) => void) {
    this.releaseListeners.add(fn);
    return () => {
      this.releaseListeners.delete(fn);
    };
  }
  constructor(
    private readonly deps: {
      journal: TerminalResourceJournalPort;
      now: () => number;
      verifyProof: (proof: TerminalReapProof, entry: TerminalResourceEntry, signal: AbortSignal) => Promise<boolean>;
      onRelease?: (reservationId: string) => void;
    },
  ) {}
  async initialize(signal: AbortSignal, handoff: readonly TerminalResourceEntry[] = []): Promise<void> {
    if (this.loaded) return;
    const r = await this.deps.journal.load(signal);
    this.loaded = true;
    if (r.kind === "unavailable") {
      this.failed = true;
      this.state = "lost";
      return;
    }
    this.journal = r.kind === "loaded" ? structuredClone(r.journal) : this.journal;
    const next = structuredClone(this.journal);
    let changed = false;
    // Root r4.2: resolved bytes might have landed after an unobserved/expired CAS.
    // A cold boot has no final in-memory CAS witness, so retained rows need fresh proof.
    for (const row of next.resources)
      if (row.status === "resolved") {
        row.status = "unresolved";
        changed = true;
      }
    for (const entry of handoff) {
      const key = terminalIdentityKey(entry.identity),
        old = next.resources.find((r) => terminalIdentityKey(r.entry.identity) === key);
      if (old) {
        if (!sameProcess(old.entry.agentProcessIdentity, entry.agentProcessIdentity)) {
          this.failed = true;
          this.state = "inconsistent";
          return;
        }
        // A pure-data unresolved handoff never loses to an older resolved disk fact.
        if (old.status === "resolved") {
          old.status = "unresolved";
          delete old.proof;
          changed = true;
        }
        for (const process of entry.managed)
          if (!old.entry.managed.some((p) => processKey(p) === processKey(process))) {
            old.entry.managed.push(structuredClone(process));
            changed = true;
          }
      } else {
        next.resources.push({ entry: structuredClone(entry), status: "unresolved" });
        changed = true;
      }
    }
    if (changed && !(await this.commit(next, signal))) {
      this.failed = true;
      return;
    }
    for (const r of this.unresolved()) this.recovery.add(terminalIdentityKey(r.entry.identity));
    this.state = this.recovery.size ? "collecting" : "cleared";
  }
  private unresolved() {
    return this.journal.resources.filter((r) => r.status === "unresolved");
  }
  physicalUsed() {
    // A resolved-but-not-yet-consumed row still pins allocation until durable prune.
    return this.journal.resources.length;
  }
  snapshot(): TerminalQuarantine {
    this.expire();
    if (this.state === "cleared" && !this.failed) return { state: "cleared", revision: this.journal.revision };
    return {
      state: this.failed ? "lost" : this.state === "cleared" ? "reconciling" : this.state,
      revision: this.journal.revision,
      code: "E_RESOURCE_QUARANTINED",
      effect: "unknown",
      reason:
        this.state === "inconsistent"
          ? "inventory-inconsistent"
          : this.state === "reap_incomplete"
            ? "cleanup-unproven"
            : "inventory-missing",
      physicalUsed: this.physicalUsed(),
    };
  }
  assertOpen() {
    if (!this.loaded || this.busy || this.snapshot().state !== "cleared")
      throw new TerminalFault("E_RESOURCE_QUARANTINED", "unknown");
  }
  async reserve(entry: TerminalResourceEntry, signal: AbortSignal) {
    this.assertOpen();
    if (
      this.physicalUsed() >= L.unresolvedResources ||
      this.journal.resources.some((r) => terminalIdentityKey(r.entry.identity) === terminalIdentityKey(entry.identity))
    )
      throw new TerminalFault("E_LIMIT");
    const next = structuredClone(this.journal);
    // Resolved facts no longer pin physical capacity; the separate ticket ledger pins openIds.
    next.resources = next.resources.filter((r) => r.status === "unresolved");
    next.resources.push({ entry: structuredClone(entry), status: "unresolved" });
    if (!(await this.commit(next, signal))) {
      this.failed = true;
      throw new TerminalFault("E_RESOURCE_QUARANTINED", "unknown");
    }
  }
  private async commit(next: TerminalJournal, signal: AbortSignal): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const old = this.journal;
    next.revision = old.revision + 1;
    try {
      const r = await this.deps.journal.commit(old.revision, next, signal);
      if (r !== "committed" || this.journal !== old) return false;
      this.journal = next;
      for (const key of this.recovery)
        if (!next.resources.some((r) => terminalIdentityKey(r.entry.identity) === key)) this.recovery.delete(key);
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }
  private async pruneConfirmed(
    identities: readonly TerminalReapProof["identity"][],
    c: Collect,
    scope: { hubBootId: string; challengeId: string; linkGen: number },
    signal: AbortSignal,
  ): Promise<"accepted" | "rejected" | "unavailable"> {
    if (!identities.length) return "accepted";
    if (signal.aborted || this.current(c.meta, scope) !== c) return "rejected";
    const keys = new Set(identities.map(terminalIdentityKey));
    if (
      keys.size !== identities.length ||
      identities.some(
        (identity) =>
          !this.journal.resources.some(
            (row) =>
              row.status === "resolved" && terminalIdentityKey(row.entry.identity) === terminalIdentityKey(identity),
          ),
      )
    )
      return "rejected";
    if (this.released.size + identities.filter((identity) => !this.released.has(identity.reservationId)).length > 2048)
      return "unavailable";
    const next = structuredClone(this.journal);
    next.resources = next.resources.filter((row) => !keys.has(terminalIdentityKey(row.entry.identity)));
    // Consumed fact is the durable absence of exactly these already-resolved rows.
    if (!(await this.commit(next, signal))) {
      this.state = "reap_incomplete";
      this.failed = true;
      return "unavailable";
    }
    if (signal.aborted || this.current(c.meta, scope) !== c) {
      this.state = "lost";
      this.failed = true;
      return "rejected";
    }
    return "accepted";
  }
  begin(meta: TerminalIngressMeta, ownerInstance: string, processIdentity: TerminalProcessIdentity): TerminalChallenge {
    if (!this.loaded || this.failed) throw new TerminalFault("E_RESOURCE_QUARANTINED", "unknown");
    this.expire();
    if (this.collectionDeadlineAt === undefined || this.deps.now() >= this.collectionDeadlineAt) this.startCollection();
    if (this.collections.size >= 32 && !this.collections.has(meta.agentKey)) throw new TerminalFault("E_LIMIT");
    const challenge = {
      hubBootId: this.bootId,
      challengeId: randomBytes(24).toString("base64url"),
      linkGen: meta.linkGen,
      deadlineAt: this.deps.now() + L.inventoryMs,
    };
    this.collections.set(meta.agentKey, {
      ownerInstance,
      processIdentity: { ...processIdentity },
      meta: { ...meta },
      challenge,
      entries: [],
      proofs: [],
      index: 0,
      bytes: 0,
      complete: false,
      invalid: false,
    });
    this.state = "collecting";
    return challenge;
  }
  private expire() {
    if (
      this.collectionDeadlineAt !== undefined &&
      this.deps.now() >= this.collectionDeadlineAt &&
      this.unresolved().some((r) => this.recovery.has(terminalIdentityKey(r.entry.identity)))
    )
      this.state = "lost";
    for (const [key, c] of this.collections)
      if (this.deps.now() >= c.challenge.deadlineAt) {
        if (!c.invalid && !c.complete) this.state = "lost";
        // Expire the challenge, NOT its physical reservations or the global lost fence.
        c.invalid = true;
        this.collections.delete(key);
      }
  }
  private current(
    meta: TerminalIngressMeta,
    scope: { hubBootId: string; challengeId: string; linkGen: number },
  ): Collect | undefined {
    if (this.failed) return undefined;
    this.expire();
    const c = this.collections.get(meta.agentKey);
    return c &&
      !c.invalid &&
      this.deps.now() < c.challenge.deadlineAt &&
      sameTerminalMeta(c.meta, meta) &&
      scope.hubBootId === this.bootId &&
      scope.challengeId === c.challenge.challengeId &&
      scope.linkGen === meta.linkGen
      ? c
      : undefined;
  }
  async page(
    meta: TerminalIngressMeta,
    page: TerminalInventoryPage,
    signal: AbortSignal,
  ): Promise<"accepted" | "rejected" | "unavailable"> {
    if (!Value.Check(TerminalInventoryPageSchema, page)) return "rejected";
    const c = this.current(meta, page);
    if (!c || c.complete) return "rejected";
    const reject = () => {
      c.invalid = true;
      this.state = "inconsistent";
      return "rejected" as const;
    };
    c.bytes += Buffer.byteLength(JSON.stringify(page));
    if (c.bytes > L.inventoryBytes) return reject();
    if (page.phase === "begin") {
      if (
        c.begin ||
        page.sender.agentSessionId !== meta.sessionId ||
        page.sender.epoch !== meta.epoch ||
        page.sender.ownerInstance !== c.ownerInstance ||
        !sameProcess(page.sender.processIdentity, c.processIdentity)
      )
        return reject();
      c.begin = page;
      return "accepted";
    }
    const b = c.begin;
    if (!b || page.inventoryId !== b.inventoryId || page.revision !== b.revision) return reject();
    if (page.phase === "chunk") {
      if (
        page.chunkIndex !== c.index ||
        c.index >= b.chunkCount ||
        c.entries.length + page.entries.length > 32 ||
        c.proofs.length + page.proofs.length > 32
      )
        return reject();
      c.index++;
      c.entries.push(...page.entries);
      c.proofs.push(...page.proofs);
      return "accepted";
    }
    if (
      page.chunkCount !== b.chunkCount ||
      c.index !== b.chunkCount ||
      page.totalCount !== b.totalCount ||
      page.digest !== b.digest
    )
      return reject();
    return this.inventory(
      meta,
      {
        v: 1,
        hubBootId: b.hubBootId,
        challengeId: b.challengeId,
        linkGen: b.linkGen,
        inventoryId: b.inventoryId,
        revision: b.revision,
        sender: b.sender,
        totalCount: b.totalCount,
        digest: b.digest,
        entries: c.entries,
        proofs: c.proofs,
        complete: true,
      },
      signal,
    );
  }
  async inventory(
    meta: TerminalIngressMeta,
    s: TerminalInventory,
    signal: AbortSignal,
  ): Promise<"accepted" | "rejected" | "unavailable"> {
    if (!Value.Check(TerminalInventorySchema, s)) return "rejected";
    const c = this.current(meta, s);
    if (!c || c.complete || this.busy) return "rejected";
    const reject = () => {
      c.invalid = true;
      this.state = "inconsistent";
      return "rejected" as const;
    };
    if (
      s.sender.agentSessionId !== meta.sessionId ||
      s.sender.epoch !== meta.epoch ||
      s.sender.ownerInstance !== c.ownerInstance ||
      !sameProcess(s.sender.processIdentity, c.processIdentity) ||
      s.totalCount !== s.entries.length ||
      inventoryDigest(s.entries) !== s.digest ||
      Buffer.byteLength(JSON.stringify(s)) > L.inventoryBytes
    )
      return reject();
    const entries = new Map(s.entries.map((e) => [terminalIdentityKey(e.identity), e]));
    const proofs = new Map(s.proofs.map((p) => [terminalIdentityKey(p.identity), p]));
    if (
      entries.size !== s.entries.length ||
      proofs.size !== s.proofs.length ||
      new Set(s.entries.map((e) => e.identity.reservationId)).size !== s.entries.length
    )
      return reject();
    for (const [k, e] of entries)
      if (
        this.journal.resources.some(
          (r) =>
            r.entry.identity.reservationId === e.identity.reservationId && terminalIdentityKey(r.entry.identity) !== k,
        )
      )
        return reject();
    // A report must cover ALL expected resources belonging to every reported old agent
    // incarnation. Empty snapshots do not remove expected resources or absent agents.
    for (const r of this.unresolved())
      if (
        (r.entry.identity.agentSessionId === s.sender.agentSessionId ||
          sameProcess(r.entry.agentProcessIdentity, s.sender.processIdentity) ||
          s.entries.some((e) => sameProcess(e.agentProcessIdentity, r.entry.agentProcessIdentity))) &&
        !entries.has(terminalIdentityKey(r.entry.identity)) &&
        !proofs.has(terminalIdentityKey(r.entry.identity))
      )
        return reject();
    for (const [k, e] of entries) {
      const old = this.journal.resources.find((r) => terminalIdentityKey(r.entry.identity) === k)?.entry;
      if (
        old &&
        (!sameProcess(old.agentProcessIdentity, e.agentProcessIdentity) ||
          old.managed.some(
            (p) =>
              !e.managed.some(
                (q) => processKey(p) === processKey(q) && p.sid === q.sid && p.pgid === q.pgid && p.role === q.role,
              ),
          ))
      )
        return reject();
    }
    for (const [k, p] of proofs) {
      const e =
        entries.get(k) ?? this.journal.resources.find((r) => terminalIdentityKey(r.entry.identity) === k)?.entry;
      if (
        !e ||
        !sameProcess(e.agentProcessIdentity, p.agentProcessIdentity) ||
        !this.proofScope(s, p) ||
        !this.covers(e, p)
      )
        return reject();
    }
    // Snapshot updates/proofs are all verified BEFORE any durable resolution or slot release.
    for (const [k, p] of proofs) {
      const e =
        entries.get(k) ?? this.journal.resources.find((r) => terminalIdentityKey(r.entry.identity) === k)!.entry;
      let ok = false;
      try {
        ok = await bounded(this.deps.verifyProof(p, e, signal), this.deps.now, c.challenge.deadlineAt, signal);
      } catch {
        return "unavailable";
      }
      if (!ok) {
        this.state = "reap_incomplete";
        return "rejected";
      }
      if (this.current(meta, s) !== c) return "rejected";
    }
    for (const [id, entry] of this.released)
      if (
        sameProcess(entry.agentProcessIdentity, s.sender.processIdentity) &&
        !entries.has(terminalIdentityKey(entry.identity)) &&
        !proofs.has(terminalIdentityKey(entry.identity))
      )
        this.released.delete(id);
    const next = structuredClone(this.journal);
    const discovered: string[] = [];
    for (const [k, e] of entries) {
      let r = next.resources.find((r) => terminalIdentityKey(r.entry.identity) === k);
      if (!r) {
        if (next.resources.length >= 32) return reject();
        next.resources.push({ entry: structuredClone(e), status: "unresolved" });
        discovered.push(k);
      } else if (r.status === "unresolved") {
        // Never allow inventory to erase previously observed managed identities.
        if (r.entry.managed.some((p) => !e.managed.some((q) => processKey(p) === processKey(q)))) return reject();
        r.entry = structuredClone(e);
      }
    }
    const release: string[] = [];
    for (const [k, p] of proofs) {
      const r = next.resources.find((r) => terminalIdentityKey(r.entry.identity) === k);
      if (r?.status === "unresolved") {
        r.status = "resolved";
        r.proof = durableProof(p);
        release.push(r.entry.identity.reservationId);
      }
    }
    if (signal.aborted || this.current(meta, s) !== c) return "rejected";
    if (!(await this.commit(next, signal))) {
      this.state = "reap_incomplete";
      return "unavailable";
    }
    // A concurrent first revoke/link change cannot release on stale in-flight verification.
    if (signal.aborted || this.current(meta, s) !== c) {
      this.state = "lost";
      this.failed = true;
      return "rejected";
    }
    const confirmed = [...proofs.values()].map((proof) => proof.identity);
    const releasedEntries = new Map(
      next.resources
        .filter((row) => release.includes(row.entry.identity.reservationId))
        .map((row) => [row.entry.identity.reservationId, row.entry]),
    );
    const pruned = await this.pruneConfirmed(confirmed, c, s, signal);
    if (pruned !== "accepted") return pruned;
    c.begin ??= {
      hubBootId: s.hubBootId,
      challengeId: s.challengeId,
      linkGen: s.linkGen,
      inventoryId: s.inventoryId,
      revision: s.revision,
      phase: "begin",
      sender: s.sender,
      totalCount: s.totalCount,
      chunkCount: c.index,
      digest: s.digest,
    };
    c.complete = true;
    for (const k of discovered)
      if (
        this.journal.resources.some(
          (row) => row.status === "unresolved" && terminalIdentityKey(row.entry.identity) === k,
        )
      )
        this.recovery.add(k);
    for (const id of release)
      if (!this.released.has(id)) {
        this.released.set(id, structuredClone(releasedEntries.get(id)!));
        try {
          this.deps.onRelease?.(id);
          for (const fn of this.releaseListeners) fn(id);
        } catch {
          this.failed = true;
        }
      }
    this.state = this.unresolved().some((r) => this.recovery.has(terminalIdentityKey(r.entry.identity)))
      ? "reconciling"
      : "cleared";
    this.acknowledge(
      c,
      s,
      [...proofs.values()].map((p) => p.identity),
    );
    return "accepted";
  }
  private acknowledge(
    c: Collect,
    scope: { hubBootId: string; challengeId: string; linkGen: number; inventoryId: string; revision: number },
    identities: TerminalResolvedAck["identities"],
  ) {
    if (!identities.length || this.failed || this.current(c.meta, scope) !== c) return;
    const ack: TerminalResolvedAck = {
      hubBootId: scope.hubBootId,
      challengeId: scope.challengeId,
      linkGen: scope.linkGen,
      inventoryId: scope.inventoryId,
      revision: scope.revision,
      journalRevision: this.journal.revision,
      identities: structuredClone(identities),
    };
    for (const fn of this.resolvedListeners) {
      try {
        fn(ack, { ...c.meta }, c.ownerInstance);
      } catch {
        /* lost ACK pins agent receipts; never re-release a physical slot */
      }
    }
  }
  private proofScope(
    s: { hubBootId: string; challengeId: string; linkGen: number; inventoryId: string; revision: number },
    p: TerminalReapProof,
  ) {
    return (
      s.hubBootId === p.hubBootId &&
      s.challengeId === p.challengeId &&
      s.linkGen === p.linkGen &&
      s.inventoryId === p.inventoryId &&
      s.revision === p.revision
    );
  }
  private covers(e: TerminalResourceEntry, p: TerminalReapProof) {
    return (
      Value.Check(TerminalReapProofSchema, p) &&
      e.managed.every((x) =>
        p.identitiesChecked.some(
          (y) => processKey(x) === processKey(y) && x.sid === y.sid && x.pgid === y.pgid && x.role === y.role,
        ),
      )
    );
  }
  async localProof(p: TerminalReapProof, signal: AbortSignal): Promise<"accepted" | "rejected" | "unavailable"> {
    if (!Value.Check(TerminalReapProofSchema, p)) return "rejected";
    const c = [...this.collections.values()].find(
      (c) =>
        this.current(c.meta, p) === c &&
        c.complete &&
        c.begin?.inventoryId === p.inventoryId &&
        c.begin.revision === p.revision,
    );
    if (!c || this.busy) return "rejected";
    const key = terminalIdentityKey(p.identity),
      row = this.journal.resources.find((r) => terminalIdentityKey(r.entry.identity) === key);
    if (
      !row ||
      row.status !== "unresolved" ||
      !sameProcess(row.entry.agentProcessIdentity, p.agentProcessIdentity) ||
      !this.covers(row.entry, p)
    )
      return "rejected";
    let valid = false;
    try {
      valid = await bounded(this.deps.verifyProof(p, row.entry, signal), this.deps.now, c.challenge.deadlineAt, signal);
    } catch {
      return "unavailable";
    }
    if (!valid || this.current(c.meta, p) !== c) {
      this.state = "reap_incomplete";
      return "rejected";
    }
    if (
      this.journal.resources.find((r) => terminalIdentityKey(r.entry.identity) === key) !== row ||
      row.status !== "unresolved"
    )
      return "rejected";
    const next = structuredClone(this.journal),
      target = next.resources.find((r) => terminalIdentityKey(r.entry.identity) === key)!;
    target.status = "resolved";
    target.proof = durableProof(p);
    if (!(await this.commit(next, signal))) {
      this.state = "reap_incomplete";
      return "unavailable";
    }
    if (this.current(c.meta, p) !== c) {
      this.failed = true;
      this.state = "lost";
      return "rejected";
    }
    const pruned = await this.pruneConfirmed([p.identity], c, p, signal);
    if (pruned !== "accepted") return pruned;
    if (!this.released.has(p.identity.reservationId)) {
      this.released.set(p.identity.reservationId, structuredClone(row.entry));
      try {
        this.deps.onRelease?.(p.identity.reservationId);
        for (const fn of this.releaseListeners) fn(p.identity.reservationId);
      } catch {
        this.failed = true;
      }
    }
    this.state = this.unresolved().some((r) => this.recovery.has(terminalIdentityKey(r.entry.identity)))
      ? "reconciling"
      : "cleared";
    this.acknowledge(c, p, [p.identity]);
    return "accepted";
  }
  retireLink(meta: TerminalIngressMeta) {
    const c = this.collections.get(meta.agentKey);
    if (c?.meta.linkGen === meta.linkGen) {
      c.invalid = true;
      this.state = "lost";
    }
  }
  records() {
    return structuredClone(this.journal);
  }
}

/** Local verifier: schema booleans alone NEVER establish waitpid/PTY/future settlement.
 * Trusted owner/reaper receipt must attest those facts and cover the exact original tuple;
 * this independent /proc check then verifies registered identities cannot still be alive.
 * Remote agents use their own trusted OS receipt verifier, not this host's /proc. */
export function createLocalTerminalProofVerifier(deps: {
  receipt: (proof: TerminalReapProof, entry: TerminalResourceEntry) => boolean;
  procRoot?: string;
}) {
  const root = deps.procRoot ?? "/proc";
  async function read(path: string, max: number) {
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const b = Buffer.alloc(max + 1);
      const { bytesRead } = await h.read(b, 0, b.length, 0);
      if (bytesRead > max) throw new Error("E_LIMIT");
      return b.subarray(0, bytesRead).toString("utf8");
    } finally {
      await h.close();
    }
  }
  return async (p: TerminalReapProof, e: TerminalResourceEntry, signal: AbortSignal): Promise<boolean> => {
    if (
      signal.aborted ||
      !Value.Check(TerminalReapProofSchema, p) ||
      terminalIdentityKey(p.identity) !== terminalIdentityKey(e.identity) ||
      !sameProcess(p.agentProcessIdentity, e.agentProcessIdentity) ||
      !e.managed.every((x) =>
        p.identitiesChecked.some(
          (y) => processKey(x) === processKey(y) && x.sid === y.sid && x.pgid === y.pgid && x.role === y.role,
        ),
      ) ||
      !deps.receipt(p, e)
    )
      return false;
    let boot;
    try {
      boot = (await read(`${root}/sys/kernel/random/boot_id`, 128)).trim();
    } catch {
      return false;
    }
    for (const id of e.managed) {
      if (signal.aborted) return false;
      if (id.bootId !== boot) continue; // proven different OS boot: the old process cannot exist.
      try {
        const stat = await read(`${root}/${id.pid}/stat`, 8192);
        const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const status = await read(`${root}/${id.pid}/status`, 16384);
        const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
        if (!uid || !tail[19] || !/^\d+$/.test(tail[19])) return false;
        if (tail[19] === id.starttime && Number(uid) === id.uid) return false; // even zombie not reaped
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ESRCH")
          return false;
      }
    }
    if (p.receipt) {
      // Production receipts require independent absence of the recorded sessions/groups,
      // not just absence of their original leaders (a descendant may outlive its leader).
      const ids = p.identitiesChecked.filter((id) => id.bootId === boot);
      const groups = new Set(ids.map((id) => id.pgid)),
        sessions = new Set(ids.map((id) => id.sid));
      const names = await readdir(root);
      if (names.length > 16384) return false;
      for (const name of names) {
        if (signal.aborted) return false;
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = await read(`${root}/${name}/stat`, 8192);
          const fields = stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
          if (groups.has(Number(fields[2])) || sessions.has(Number(fields[3]))) return false;
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        }
      }
    }
    return !signal.aborted;
  };
}
