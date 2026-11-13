/** P1-C F2 contract boundary ONLY. The explicit TODOs below are dependent release
 * gates, not skips/PASS. P1-H owns actual journal/fence/proof verification; P1-A Q4 OS facts. */
import { afterEach, describe, expect, it } from "vitest";
import { terminalUnavailable } from "../../src/web-hub/hub/ports.js";
import { terminalHarness, type TerminalHarness } from "./web-hub-terminal-harness.js";

const lives: TerminalHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.close();
});
const processIdentity = { bootId: "linux-boot", pid: 7, starttime: "100", uid: 1000 };
const identity = {
  agentSessionId: "old-session",
  termId: "term",
  epoch: "old-epoch",
  ownerInstance: "old-owner",
  reservationId: "reservation",
};
const evidence = { hubBootId: "hub-boot", challengeId: "challenge", linkGen: 1, inventoryId: "inventory", revision: 1 };
const proof = {
  ...evidence,
  identity,
  agentProcessIdentity: processIdentity,
  proofId: "proof",
  spawnSettled: true,
  ptyClosed: true,
  helperReaped: true,
  managedGroupsGone: true,
  identitiesChecked: [],
  outcome: "reaped",
};
const frame = (page: unknown) => ({
  t: "term_res",
  v: 1,
  rid: "inventory-rid",
  sessionId: "session",
  epoch: "epoch-1",
  ownerInstance: "owner",
  channelId: "resource-channel",
  op: "inventory",
  ok: true,
  page,
});

describe("F2 Q1–Q4 P1-C schema/ingress subsets (§5.5.1)", () => {
  it("Q1 / Q2 / Q4 invalid evidence is isolated before the optional verifier, valid evidence stays private", async () => {
    const received: unknown[] = [];
    const h = await terminalHarness({
      terminal: { ownsCommand: () => false, consumeAgentFrame: (_meta, raw) => received.push(raw), retireLink() {} },
    });
    lives.push(h);
    const streams = await Promise.all([h.sse(0), h.sse(1)]);
    const valid = frame({ ...evidence, phase: "chunk", chunkIndex: 0, entries: [], proofs: [proof] });
    h.client.send(valid);
    // Q1 mandatory incarnation/string identity; Q2 page cardinality/closed union; Q4 evidence booleans.
    h.client.send(
      frame({
        ...evidence,
        phase: "chunk",
        chunkIndex: 0,
        entries: [],
        proofs: [{ ...proof, identity: { ...identity, epoch: 2 } }],
      }),
    );
    h.client.send(
      frame({
        ...evidence,
        phase: "begin",
        sender: { agentSessionId: "s", epoch: "e", ownerInstance: "o", processIdentity },
        totalCount: 33,
        chunkCount: 1,
        digest: "a".repeat(64),
      }),
    );
    h.client.send(
      frame({ ...evidence, phase: "end", totalCount: 1, chunkCount: 1, digest: "invalid", complete: true }),
    );
    for (const field of ["spawnSettled", "ptyClosed", "helperReaped", "managedGroupsGone"])
      h.client.send(
        frame({ ...evidence, phase: "chunk", chunkIndex: 0, entries: [], proofs: [{ ...proof, [field]: false }] }),
      );
    h.client.send(
      frame({ ...evidence, phase: "chunk", chunkIndex: 0, entries: [], proofs: [{ ...proof, cleaned: true }] }),
    );
    await h.barrier();
    expect(received).toEqual([valid]);
    expect(h.bus.filter((e) => JSON.stringify(e).includes("reservation"))).toEqual([]);
    for (const s of streams) expect(JSON.stringify(s.events)).not.toContain("reservation");
  });
  it("Q3 absent service is explicitly Unavailable, never zero inventory / cleared permission", () => {
    expect(terminalUnavailable()).toEqual({ ok: false, code: "E_UNAVAILABLE", effect: "none" });
    expect(terminalUnavailable()).not.toHaveProperty("physicalUsed");
    expect(terminalUnavailable()).not.toHaveProperty("state", "cleared");
  });
  it.todo(
    "Q1 [P1-H/P3] real journal+fence: reject stale boot/challenge/link, wrong session/epoch/owner/reservation; current exact proof releases once",
  );
  it.todo(
    "Q2 [P1-H/P3] real snapshot: count/digest/duplicate identity/missing/out-of-order page/expected-set coverage, no partial release; complete positive control",
  );
  it.todo(
    "Q3 r4 [P1-H/P3] A fully inventoried+all expected identities reaped+resolved commit asserted; ONLY B absent, 5/30/60s still lost/global E_RESOURCE_QUARANTINED; old challenge rejected; B fresh proof+commit clears once",
  );
  it.todo(
    "Q4 [P1-A/P1-H/P3] real helper/PTY/foreground+background pgids/late spawn future: close ACK and helper exit insufficient; actual waitpid+groups+PTY+settled future proof; failed durable commit rejects, successful CAS releases once",
  );
});
