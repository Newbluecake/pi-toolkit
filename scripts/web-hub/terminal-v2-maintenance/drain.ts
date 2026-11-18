/** Validate causal observations FROM the fixed live bridge. These pure checks do
 * not mint authority from JSON: deployment obtains facts only from its retained
 * actual runtime objects/owned measured child channel and re-observes them per lease.
 */
import { readFileSync } from "node:fs";
import { fail, type LegacyDrainEvidence, type NewDrainEvidence } from "./audit.js";
import { digest, json } from "./files.js";
import type { LiveRuntime } from "./live.js";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const key = (identity: any) =>
  JSON.stringify([
    identity.agentSessionId,
    identity.termId,
    identity.epoch,
    identity.ownerInstance,
    identity.reservationId,
  ]);
function complete(physical: any): boolean {
  return (
    physical?.outcome === "reaped" &&
    physical.spawnSettled === true &&
    physical.ptyClosed === true &&
    physical.helperReaped === true &&
    physical.managedGroupsGone === true &&
    Array.isArray(physical.identitiesChecked) &&
    physical.identitiesChecked.length >= 2 &&
    physical.identitiesChecked.some((i: any) => i.role === "shell") &&
    physical.identitiesChecked.some((i: any) => i.role === "helper") &&
    Array.isArray(physical.waited)
  );
}
export async function actualLegacyDrain(runtime: LiveRuntime): Promise<{ facts: any; evidence: LegacyDrainEvidence }> {
  if (!runtime.current()) fail("old-audit-owner-unavailable");
  const facts = await runtime.facts(),
    worker = facts.worker,
    owner = worker?.owner,
    fence = facts.fence,
    service = facts.service;
  if (
    worker?.state !== "stopped" ||
    worker.ownerFactoryFlights !== 0 ||
    worker.ownerFactoryRuns !== 1 ||
    owner?.disposed !== true ||
    owner.pendingFutures !== 0 ||
    owner.channels !== 0 ||
    owner.authorityKnown !== true ||
    owner.authorityActive !== false ||
    owner.auditOverflow !== false ||
    ![owner.resources, owner.receipts, owner.handoff].every((items) => Array.isArray(items) && items.length === 0) ||
    !Array.isArray(owner.rows) ||
    !owner.rows.length ||
    !Array.isArray(owner.acks) ||
    !owner.acks.length ||
    fence?.loaded !== true ||
    fence.failed !== false ||
    fence.busy !== false ||
    fence.auditOverflow !== false ||
    !["cleared", "lost"].includes(fence.state) ||
    !Array.isArray(fence.journal?.resources) ||
    fence.journal.resources.length !== 0 ||
    !Number.isSafeInteger(fence.journal.revision) ||
    !Array.isArray(fence.commits) ||
    !fence.commits.length ||
    service?.disposed !== true ||
    [
      service.pendingRequests,
      service.waits,
      service.offers,
      service.inventoryWaits,
      service.collections,
      service.pendingOpens,
    ].some((n) => n !== 0)
  )
    fail("old-live-drain-unproven");
  // Original O deliberately marks availability lost on link retirement even with
  // a known empty journal. Require the ACTUAL live cleared state before shutdown,
  // then exact unchanged journal/physical/ACK observations after original dispose.
  const before = facts.beforeStop;
  if (
    before?.worker?.state !== "live" ||
    before.worker.owner?.authorityActive !== true ||
    before.worker.owner?.disposed !== false ||
    before.fence?.state !== "cleared" ||
    before.fence?.failed !== false ||
    before.fence?.busy !== false ||
    !same(before.fence.journal, fence.journal) ||
    !same(before.worker.owner.rows, owner.rows) ||
    !same(before.worker.owner.acks, owner.acks)
  )
    fail("old-shutdown-causality-unproven");
  if (
    owner.processIdentity.pid !== worker.pid ||
    owner.processIdentity.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  )
    fail("old-process-identity-unproven");
  let last: any;
  for (const commit of fence.commits) {
    if (
      !Number.isSafeInteger(commit.before?.revision) ||
      commit.after?.revision !== commit.before.revision + 1 ||
      !Array.isArray(commit.before.resources) ||
      !Array.isArray(commit.after.resources) ||
      (last && !same(last, commit.before))
    )
      fail("old-commit-chain-unproven");
    last = commit.after;
  }
  if (!same(last, fence.journal)) fail("old-current-journal-unproven");
  for (const row of owner.rows) {
    if (!row.resolved || !row.spawnSettled || row.inputPending || row.resizePending || !complete(row.physical))
      fail("old-physical-proof-unproven");
    const identity = key(row.identity);
    const ack = owner.acks.find(
      (ack: any) => Array.isArray(ack.identities) && ack.identities.some((i: any) => key(i) === identity),
    );
    const prune =
      ack &&
      fence.commits.find(
        (commit: any) =>
          commit.after.revision === ack.journalRevision &&
          commit.before.resources.some((r: any) => key(r.entry.identity) === identity && r.status === "resolved") &&
          !commit.after.resources.some((r: any) => key(r.entry.identity) === identity),
      );
    const resolved = prune?.before.resources.find((r: any) => key(r.entry.identity) === identity);
    const proof = resolved?.proof;
    if (
      !prune ||
      !proof ||
      proof.outcome !== "reaped" ||
      !same(proof.identity, row.identity) ||
      !same(proof.identitiesChecked, row.physical.identitiesChecked) ||
      ["hubBootId", "challengeId", "linkGen", "inventoryId", "revision"].some((field) => proof[field] !== ack[field]) ||
      !fence.commits.some((commit: any) =>
        commit.after.resources.some((r: any) => key(r.entry.identity) === identity && r.status === "unresolved"),
      )
    )
      fail("old-proof-prune-exact-ack-unproven");
    if (!(await runtime.module.terminalIdentitiesGone(row.physical.identitiesChecked))) fail("old-identities-not-gone");
  }
  if (!runtime.current()) fail("old-audit-owner-unavailable");
  return {
    facts,
    evidence: {
      resources: 0,
      receipts: 0,
      active: 0,
      starting: 0,
      pendingSpawn: 0,
      authority: "revoked",
      durableRevision: fence.journal.revision,
      physicalProofPruneAckSha256: digest(json(facts)),
    },
  };
}
export async function actualNewDrain(runtime: LiveRuntime): Promise<{ facts: any; evidence: NewDrainEvidence }> {
  if (!runtime.current()) fail("new-audit-owner-unavailable");
  const facts = await runtime.facts(),
    state = facts.service;
  if (
    facts.worker?.state !== "stopped" ||
    facts.worker.ownerFactoryFlights !== 0 ||
    facts.worker.ownerFactoryRuns !== 0 ||
    facts.disposeResult?.clean !== true ||
    facts.disposeResult?.unresolved !== 0 ||
    state?.stopped !== true ||
    state.resourceAvailable !== true ||
    state.consistent !== true ||
    [state.pendingCreates, state.contextFlights, state.mutationFlights, state.allocationCount].some((n) => n !== 0) ||
    !Array.isArray(state.runtimes) ||
    state.runtimes.length !== 0 ||
    !Array.isArray(state.ledger?.allocations) ||
    state.ledger.allocations.length !== 0 ||
    !Number.isSafeInteger(state.ledger.revision) ||
    state.physicalPrunes < 1 ||
    !Array.isArray(facts.backends) ||
    facts.backends.length !== state.physicalPrunes ||
    facts.backends.some((b: any) => !b.spawnSettled || !complete(b.physical))
  )
    fail("new-live-drain-unproven");
  for (const backend of facts.backends)
    if (!(await runtime.module.terminalIdentitiesGone(backend.physical.identitiesChecked)))
      fail("new-identities-not-gone");
  if (!runtime.current()) fail("new-audit-owner-unavailable");
  return {
    facts,
    evidence: {
      allocations: 0,
      backend: 0,
      pendingSpawn: 0,
      dispose: "clean",
      durableRevision: state.ledger.revision,
      physicalProofPruneSha256: digest(json(facts)),
    },
  };
}
