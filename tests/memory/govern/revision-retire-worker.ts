/** Real-process retire/restore test driver. All rendezvous waits are OUTSIDE
 * the production lock; persistent IPC refs keep unref'd lock waits test-alive. */
import * as fs from "node:fs";
import { join } from "node:path";
import { inspectDirNoFollow } from "../../../src/memory/safe-fs.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { createRevisionAuditPort, restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";
import { freezeRevisionInputsLocked } from "../../../src/memory/govern/revision.js";
import { createRevisionCommitter } from "../../../src/memory/govern/revision-commit.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import type { RevisionProposal } from "../../../src/memory/jev/contracts.js";
async function main() {
  process.on("message", () => {});
  const start = new Promise<void>((resolve) => process.once("message", () => resolve()));
  const mem = process.argv[2]!,
    p = JSON.parse(process.argv[3]!) as RevisionProposal,
    mode = process.argv[4]!;
  if (p.action !== "retire" || !p.retireEvidence) throw Error("worker expects full retire proof");
  const deps = { isCurrent: () => true, now: () => new Date("2026-11-10T00:00:00.000Z") };
  const audit = createRevisionAuditPort(mem, deps);
  const source = p.retireEvidence.source;
  if (mode === "restore" || mode === "restore-put-back") {
    const captured = await withMemoryDirLock(mem, () => audit.readActionLocked(source.batchId, source.actionId));
    if (captured.kind !== "ok" || captured.expectedAfter?.kind !== "file") throw Error("missing source after");
    process.send?.({ phase: "ready" });
    await start;
    const result = await restoreRevisionRaw(mem, { actionId: source.actionId }, deps);
    if (mode === "restore-put-back" && result.kind === "restored")
      fs.writeFileSync(join(mem, "blocks", `${captured.audit.targetId}.md`), captured.expectedAfter.raw);
    process.send?.({ phase: "done", result }, () => process.disconnect());
    return;
  }
  const parse = (id: string) => {
    const b = parseBlockFile(`${id}.md`, fs.readFileSync(join(mem, "blocks", `${id}.md`), "utf8"));
    if ("stray" in b) throw Error("worker stray");
    return b;
  };
  const { dev, ino } = inspectDirNoFollow(mem);
  const frozen = await withMemoryDirLock(mem, () =>
    freezeRevisionInputsLocked(
      mem,
      {
        directory: { realpath: mem, dev, ino, sessionEpoch: 1 },
        selectionBatchId: "admitted-worker-pass",
        policyVersion: p.policyVersion,
        action: "retire",
        target: parse(p.targetId),
        context: parse(p.contextId!),
        retireSource: source,
      },
      { isCurrent: () => true, audit },
    ),
  );
  if ("kind" in frozen || frozen.actionId !== p.actionId || frozen.batchId !== p.batchId)
    throw Error("worker frozen binding mismatch");
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
    now: deps.now,
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
