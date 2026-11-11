/** Own-temp D/C fixture, no provider/model/real user data. Shared only by P1 tests. */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect } from "vitest";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { freezeRevisionInputsLocked, planRevisionActions } from "../../../src/memory/govern/revision.js";
import { createRevisionAuditPort } from "../../../src/memory/govern/revision-audit.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { replaceRevisionObserved, writeTempRegular } from "../../../src/memory/safe-fs.js";
import type { RevisionAuditDeps } from "../../../src/memory/jev/contracts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const now = () => new Date("2026-11-10T00:00:00.000Z");
export const cDeps: RevisionAuditDeps = { isCurrent: () => true, now };
export type AuditState = "prepared" | "proposed" | "marker-missing" | "unknown" | "committed" | "corrupt" | "missing";

export async function startupFixture(states: readonly AuditState[] = []) {
  const dir = fs.mkdtempSync(join(tmpdir(), "memory-startup-p1-"));
  roots.push(dir);
  const blocks = join(dir, "blocks");
  fs.mkdirSync(blocks, { mode: 0o700 });
  fs.writeFileSync(join(blocks, ".layout.json"), '{"v":1,"source":"fresh"}', { mode: 0o600 });
  const records = [];
  for (const [i, state] of states.entries()) {
    const id = `rules.${String(i + 1).padStart(3, "0")}`;
    const raw = (version: number, body: string) =>
      Buffer.from(
        `\uFEFF---\r\nkind: block\r\nauthority: agent\r\nstatus: active\r\ncreated: 2026-01-01\r\nupdated: 2026-01-01\r\nversion: ${version}\r\n---\r\n\r\n${body}\r\n`,
      );
    const before = raw(7, "PRIVATE_TEST_BODY café 规则"),
      after = raw(8, "after body café 规则");
    const target = join(blocks, `${id}.md`);
    fs.writeFileSync(target, before, { mode: 0o600 });
    const parsed = parseBlockFile(`${id}.md`, before.toString());
    const parsedAfter = parseBlockFile(`${id}.md`, after.toString());
    if ("stray" in parsed || "stray" in parsedAfter) throw Error("fixture parse failed");
    const { dev, ino } = fs.statSync(dir);
    const record = await withMemoryDirLock(dir, () => {
      const frozen = freezeRevisionInputsLocked(
        dir,
        {
          directory: { realpath: dir, dev, ino, sessionEpoch: 1 },
          policyVersion: "p1-offline-v1",
          selectionBatchId: `selection-${i}`,
          action: "expires",
          target: parsed,
        },
        cDeps,
      );
      if ("kind" in frozen) throw Error(`fixture freeze refused: ${frozen.reason}`);
      const proposal = planRevisionActions({
        candidates: [{ frozen, reason: "expired", expiry: { op: "clear", dateRuleVersion: "date-v1" } }],
        autoEnabled: false,
        leaseValid: true,
      })[0];
      if (!proposal) throw Error("fixture proposal missing");
      const port = createRevisionAuditPort(dir, cDeps);
      expect(port.persistPreparedBarrierLocked({ frozen, proposal, origin: "p50-suggestion" }).kind).toBe("ok");
      const path = join(blocks, ".jev", "revisions", frozen.batchId, frozen.actionId);
      const expected = { kind: "file" as const, raw: after, digest: hash(after), rev: parsedAfter.rev };
      const ref = { batchId: frozen.batchId, actionId: frozen.actionId, proposalDigest: proposal.proposalDigest };
      if (["proposed", "marker-missing", "unknown", "committed"].includes(state))
        expect(port.persistExpectedAfterBarrierLocked({ ...ref, expected }).kind).toBe("ok");
      if (["marker-missing", "unknown", "committed"].includes(state)) {
        const temp = writeTempRegular(blocks, `${id}.md`, after, 0o600);
        const applied = replaceRevisionObserved(blocks, temp, `${id}.md`, expected);
        expect(applied.observation.kind).toBe("applied");
        if (state !== "marker-missing") {
          const result = port.finalizeCommitLocked({
            ...ref,
            observation:
              state === "unknown"
                ? { kind: "unknown", reason: "SECRET_REASON /private/arbitrary/path" }
                : applied.observation,
            dataDirectories: [blocks],
          });
          expect(result.kind).toBe(state === "unknown" ? "effect-unknown" : "committed");
        }
      }
      if (state === "corrupt") fs.writeFileSync(join(path, "audit.json"), "{corrupt PRIVATE_TEST_BODY");
      if (state === "missing") fs.unlinkSync(join(path, "audit.json"));
      return { id, target, before, after, frozen, proposal, path };
    });
    records.push(record);
  }
  return { dir, blocks, records };
}

/** Compare all pre-existing namespace identities and all file bytes/inodes.
 * Ignore only the ORIGINAL lock metadata; directory mtime/atime change on lock
 * creation/read, so they are not content invariants. Newly created dirs fail too. */
export function startupTree(dir: string) {
  const result: Record<string, { dev: number; ino: number; mode: number; uid: number; bytes?: string }> = {};
  const walk = (path: string, key: string) => {
    const stat = fs.lstatSync(path);
    result[key] = {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      uid: stat.uid,
      ...(stat.isFile() ? { bytes: fs.readFileSync(path).toString("base64") } : {}),
    };
    if (stat.isDirectory())
      for (const name of fs.readdirSync(path).sort()) if (name !== ".lock") walk(join(path, name), `${key}/${name}`);
  };
  walk(dir, ".");
  return result;
}
