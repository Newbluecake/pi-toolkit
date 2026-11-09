/** P50 E internal-only controlled applier. Caller holds the canonical memDir
 * lock and owns all authorization. Never call legacy store write fallbacks. */
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ExpectedAfter, FrozenRevisionInput, RevisionProposal } from "../jev/contracts.js";
import { parseBlockFile } from "../blocks/format.js";
import { prepareBlockReplacement } from "../blocks/store.js";
import { prepareGovernReplacement, prepareSupersedeOne } from "./supersede.js";
import {
  deleteRevisionObserved,
  ensureRevisionPrivateDir,
  inspectDirSecurityNoFollow,
  replaceRevisionObserved,
  writeTempRegular,
  type RevisionObservedResult,
} from "../safe-fs.js";
import { newMemoryId } from "../trash.js";

export interface PreparedRevisionApplication {
  /** A fresh Buffer on every access; these are the exact bytes applied. */
  readonly expected: ExpectedAfter;
  applyLocked(check: () => void): RevisionObservedResult & { readonly dataDirectories: readonly string[] };
}
/** Preparation does not mutate. A prepared application is one-attempt only,
 * including temp/mkdir faults. No compensation, cleanup or second syscall. */
export function prepareRevisionApplicationLocked(
  memDir: string,
  frozen: FrozenRevisionInput,
  proposal: RevisionProposal,
  now: Date,
): PreparedRevisionApplication {
  const blocks = join(memDir, "blocks"),
    name = `${proposal.targetId}.md`;
  const old = parseBlockFile(name, frozen.target.rawBefore.toString("utf8"));
  if ("stray" in old || old.errors.length) throw new Error("invalid frozen target");
  let raw: string | undefined;
  switch (proposal.action) {
    case "rewrite-single":
    case "merge-survivor":
      if (proposal.generatedBody === undefined) throw new Error("missing generated body");
      raw = prepareBlockReplacement(old, { meta: old.meta, body: proposal.generatedBody }, now);
      break;
    case "expires": {
      const meta = { ...old.meta };
      if (proposal.expiry.op === "clear") delete meta.expires;
      else meta.expires = proposal.expiry.nextExpires;
      raw = prepareGovernReplacement(old, meta, now);
      break;
    }
    case "retire": {
      if (!frozen.context) throw new Error("missing successor");
      const next = parseBlockFile(`${frozen.context.id}.md`, frozen.context.rawBefore.toString("utf8"));
      if ("stray" in next || next.errors.length) throw new Error("invalid successor");
      raw = prepareSupersedeOne(old, next, now);
      break;
    }
    case "delete":
      break;
  }
  const bytes = raw === undefined ? undefined : Buffer.from(raw);
  const parsed = raw === undefined ? undefined : parseBlockFile(name, raw);
  if (parsed && ("stray" in parsed || parsed.errors.length)) throw new Error("invalid after");
  const expected: ExpectedAfter =
    bytes && parsed && !("stray" in parsed)
      ? { kind: "file", raw: bytes, digest: createHash("sha256").update(bytes).digest("hex"), rev: parsed.rev }
      : { kind: "missing" };
  let attempted = false;
  return Object.freeze({
    get expected(): ExpectedAfter {
      return expected.kind === "file" ? { ...expected, raw: Buffer.from(expected.raw) } : { kind: "missing" };
    },
    applyLocked(check: () => void) {
      if (attempted) throw new Error("revision applier already attempted");
      attempted = true;
      const dataDirectories = expected.kind === "file" ? [blocks] : [blocks, join(blocks, ".trash")];
      let entered = false;
      try {
        check();
        if (expected.kind === "file") {
          const tmp = writeTempRegular(blocks, name, Buffer.from(expected.raw), 0o600);
          check();
          entered = true;
          return { ...replaceRevisionObserved(blocks, tmp, name, expected, { beforeSyscall: check }), dataDirectories };
        }
        ensureRevisionPrivateDir(blocks, ".trash", inspectDirSecurityNoFollow(blocks).dev);
        check();
        const trashName = `${newMemoryId(now, process.pid, randomBytes(3).toString("hex"))}-${name}`;
        entered = true;
        return {
          ...deleteRevisionObserved(
            blocks,
            name,
            join(blocks, ".trash"),
            trashName,
            { digest: frozen.target.rawDigest, rev: frozen.target.rev },
            { beforeSyscall: check },
          ),
          dataDirectories,
        };
      } catch (error) {
        // This catch only covers pre-data preparation. Syscall helpers return
        // their own observed results, including post-apply/dual-path failures.
        return {
          observation: entered
            ? { kind: "unknown" as const, reason: "observer-unavailable" }
            : { kind: "not-applied" as const },
          error: String(error),
          dataDirectories,
        };
      }
    },
  });
}
