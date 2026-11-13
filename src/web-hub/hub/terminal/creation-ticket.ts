import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  TerminalCreateTicketSchema,
  TERMINAL_LIMITS as L,
  type TerminalCreateTicket,
  type TerminalOwnerBinding,
} from "../../protocol/terminal.js";
import { TerminalFault } from "./limits.js";
export type TicketRow = {
  ticket: TerminalCreateTicket;
  phase: "issued" | "accepted" | "exited";
  termId?: string;
  until?: number;
};
const ownerKey = (o: TerminalOwnerBinding) =>
  JSON.stringify([o.listener, o.principal, o.sidTag, o.agentKey, o.sessionId, o.epoch, o.ownerInstance]);
const payloadDigest = (cols: number, rows: number) =>
  createHash("sha256").update(JSON.stringify({ cols, rows })).digest("hex");
function unsigned(t: Omit<TerminalCreateTicket, "mac">) {
  return JSON.stringify({
    v: t.v,
    bootId: t.bootId,
    ticketId: t.ticketId,
    issuedAt: t.issuedAt,
    expiresAt: t.expiresAt,
    ownerBinding: ownerKey(t.ownerBinding),
    payloadDigest: t.payloadDigest,
  });
}
export class TerminalCreationTickets {
  private readonly key = randomBytes(32);
  private readonly rows = new Map<string, TicketRow>();
  readonly bootId = randomBytes(24).toString("base64url");
  constructor(private readonly now: () => number) {}
  private prune() {
    const n = this.now();
    for (const [id, r] of this.rows)
      if ((r.phase === "issued" && n > r.ticket.expiresAt) || (r.phase === "exited" && n > r.until!))
        this.rows.delete(id);
  }
  prepare(owner: TerminalOwnerBinding, cols: number, rows: number): TerminalCreateTicket {
    this.prune();
    if (
      this.rows.size >= L.ticketsTotal ||
      [...this.rows.values()].filter((r) => ownerKey(r.ticket.ownerBinding) === ownerKey(owner)).length >=
        L.ticketsPerOwner
    )
      throw new TerminalFault("E_LIMIT");
    const t = {
      v: 1 as const,
      bootId: this.bootId,
      ticketId: randomBytes(24).toString("base64url"),
      issuedAt: this.now(),
      expiresAt: this.now() + L.ticketMs,
      ownerBinding: { ...owner },
      payloadDigest: payloadDigest(cols, rows),
    };
    const ticket = { ...t, mac: createHmac("sha256", this.key).update(unsigned(t)).digest("hex") };
    this.rows.set(t.ticketId, { ticket, phase: "issued" });
    return structuredClone(ticket);
  }
  verify(t: TerminalCreateTicket, owner: TerminalOwnerBinding, cols?: number, rows?: number): TicketRow | undefined {
    this.prune();
    if (!Value.Check(TerminalCreateTicketSchema, t) || t.bootId !== this.bootId)
      throw new TerminalFault("E_STALE_CREATION");
    const mac = createHmac("sha256", this.key).update(unsigned(t)).digest();
    if (
      !timingSafeEqual(mac, Buffer.from(t.mac, "hex")) ||
      ownerKey(t.ownerBinding) !== ownerKey(owner) ||
      (cols !== undefined && t.payloadDigest !== payloadDigest(cols, rows!))
    )
      throw new TerminalFault("E_STALE_CREATION");
    const row = this.rows.get(t.ticketId);
    if (row && row.phase !== "issued") return row;
    if (this.now() >= t.expiresAt) throw new TerminalFault("E_EXPIRED");
    if (!row) throw new TerminalFault("E_STALE_CREATION");
    return row;
  }
  /** Synchronous CAS. Retrying an accepted ticket returns the original physical fact. */
  redeem(t: TerminalCreateTicket, owner: TerminalOwnerBinding, cols: number, rows: number, termId: string) {
    const r = this.verify(t, owner, cols, rows)!;
    if (r.phase !== "issued") return { fresh: false, row: r };
    r.phase = "accepted";
    r.termId = termId;
    return { fresh: true, row: r };
  }
  exited(openId: string) {
    const r = this.rows.get(openId);
    if (r?.phase === "accepted") {
      r.phase = "exited";
      r.until = Math.max(r.ticket.expiresAt, this.now() + L.exitedMs);
    }
  }
  size() {
    this.prune();
    return this.rows.size;
  }
}
