/** Real-process test driver only; IPC rendezvous is OUTSIDE the memory lock. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freezeRevisionInputsLocked } from "../../../src/memory/govern/revision.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { inspectDirNoFollow } from "../../../src/memory/safe-fs.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { createRevisionCommitter } from "../../../src/memory/govern/revision-commit.js";
import type { RevisionProposal } from "../../../src/memory/jev/contracts.js";

async function main() {
  // Keep the child IPC channel referenced while the production lock's retry
  // clock is (correctly) unref'd, including after the one-shot go message.
  process.on("message", () => {});
  const start = new Promise<void>((resolve) => process.once("message", () => resolve()));
  const mem = process.argv[2]!,
    p = JSON.parse(process.argv[3]!) as RevisionProposal;
  const identity = inspectDirNoFollow(mem);
  const block = (id: string) => {
    const b = parseBlockFile(`${id}.md`, readFileSync(join(mem, "blocks", `${id}.md`), "utf8"));
    if ("stray" in b) throw Error("worker stray");
    return b;
  };
  const frozen = await withMemoryDirLock(mem, () =>
    freezeRevisionInputsLocked(
      mem,
      {
        directory: { realpath: mem, dev: identity.dev, ino: identity.ino, sessionEpoch: 1 },
        selectionBatchId: "worker",
        policyVersion: p.policyVersion,
        action: p.action,
        target: block(p.targetId),
        ...(p.contextId ? { context: block(p.contextId) } : {}),
      },
      { isCurrent: () => true },
    ),
  );
  if ("kind" in frozen) throw Error(`worker freeze ${frozen.reason}`);
  if (frozen.batchId !== p.batchId || frozen.actionId !== p.actionId) throw Error("worker binding mismatch");
  process.send?.({ phase: "ready" });
  await start;
  const result = await createRevisionCommitter(mem, {
    actionLocked: () => ({ frozen, proposal: p }),
    runtime: () => ({
      plainMain: true,
      enabled: true,
      autoEnabled: true,
      sessionEpoch: 1,
      policyVersion: p.policyVersion,
      dateRuleVersion: "date-v1",
    }),
    isCurrent: () => true,
    leaseValid: () => true,
    now: () => new Date("2026-11-10T00:00:00.000Z"),
  }).commitAction({
    origin: "p50-auto",
    actionId: p.actionId,
    expectedRev: p.expectedRev,
    proposalDigest: p.proposalDigest,
  });
  process.send?.({ phase: "done", result }, () => process.disconnect());
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
