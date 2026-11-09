/** Read-only P50.1 selection. No sidecar cache, soft-meta repair, raw snapshot or
 * audit writes. A fingerprint is NOT proof of data-applied/finalized (§5.2–5.3). */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { inspectDirNoFollow, readRegular } from "../safe-fs.js";
import { parseBlockName } from "../blocks/naming.js";
import { parseBlockFile } from "../blocks/format.js";
import { looksSecret } from "../secret-patterns.js";
import type { IncrementalCandidate, IncrementalCorpus, IncrementalDirectory } from "./incremental.js";
import { INCREMENTAL_ACTION_LIMIT } from "./incremental.js";

export function readIncrementalCorpus(directory: IncrementalDirectory): IncrementalCorpus | undefined {
  try {
    const root = inspectDirNoFollow(directory.realpath);
    if (root.dev !== directory.dev || root.ino !== directory.ino) return undefined;
    const dir = join(directory.realpath, "blocks"),
      before = inspectDirNoFollow(dir);
    if (before.dev !== root.dev) return undefined;
    const candidates: IncrementalCandidate[] = [];
    const entries: unknown[] = [];
    let omittedCount = 0;
    for (const name of before.names.filter((n) => parseBlockName(n)).sort()) {
      const raw = readRegular(dir, name).text;
      const block = parseBlockFile(name, raw);
      // Include even ineligible/invalid files in the corpus fingerprint, but never
      // pass their bodies, paths or metadata to the batch consumer.
      entries.push([name, createHash("sha256").update(raw).digest("hex")]);
      if (
        "stray" in block ||
        block.errors.length ||
        block.meta.status !== "active" ||
        block.meta.private === true ||
        block.meta.residue ||
        block.meta.origin ||
        block.meta.storageScope === "hub" ||
        block.meta.supersededBy ||
        looksSecret(block.body)
      )
        continue;
      if (candidates.length >= INCREMENTAL_ACTION_LIMIT) {
        omittedCount++;
        continue;
      }
      candidates.push({ id: block.id, rev: block.rev, topic: block.topic, authority: block.meta.authority });
    }
    const after = inspectDirNoFollow(dir),
      parent = inspectDirNoFollow(directory.realpath);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      JSON.stringify(after.names.sort()) !== JSON.stringify(before.names.sort()) ||
      parent.dev !== root.dev ||
      parent.ino !== root.ino
    )
      return undefined;
    return {
      fingerprint: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
      candidates,
      omittedCount,
    };
  } catch {
    return undefined;
  }
}
