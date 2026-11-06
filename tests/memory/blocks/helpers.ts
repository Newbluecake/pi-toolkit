// Shared fixture builder for the #36 P3 blocks tests (render / golden /
// inject-blocks / doctor-blocks / hub-wiring). NOT a test file — imported by
// the suites under tests/memory/blocks/. Builds a real migrated-shape
// directory: <memDir>/blocks/<topic>.<seq>.md + .layout.json, so `dirFormat`
// reports "blocks" and `readCorpus` parses it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeBlock, type BlockMeta } from "../../../src/memory/blocks/format.js";

export interface BlockSpec {
  /** File name WITHOUT `.md`, e.g. `quota.007`. */
  id: string;
  authority?: "user" | "agent";
  scope?: "global" | "topic";
  audience?: "all" | "main" | "child";
  expires?: string;
  until?: string;
  supersededBy?: string;
  status?: "active" | "superseded" | "archived";
  section?: string;
  heading?: string;
  residue?: true;
  private?: true;
  updated?: string;
  version?: number;
  /** Migration-exempt oversize body (arch 附录 A D20) — serializeBlock's
   *  allowOversize path; the file then parses with an E_TOO_LARGE error. */
  allowOversize?: true;
  body: string;
}

export function blockRaw(spec: BlockSpec): string {
  const meta: BlockMeta = {
    kind: "block",
    authority: spec.authority ?? "agent",
    ...(spec.scope === undefined ? {} : { scope: spec.scope }),
    ...(spec.audience === undefined ? {} : { audience: spec.audience }),
    ...(spec.expires === undefined ? {} : { expires: spec.expires }),
    ...(spec.until === undefined ? {} : { until: spec.until }),
    ...(spec.supersededBy === undefined ? {} : { supersededBy: spec.supersededBy }),
    status: spec.status ?? "active",
    ...(spec.section === undefined ? {} : { section: spec.section }),
    ...(spec.heading === undefined ? {} : { heading: spec.heading }),
    ...(spec.residue === true ? { residue: true } : {}),
    ...(spec.private === true ? { private: true } : {}),
    created: "2026-01-01T00:00:00.000Z",
    updated: spec.updated ?? "2026-01-02T00:00:00.000Z",
    version: spec.version ?? 1,
  };
  return serializeBlock(meta, spec.body, spec.allowOversize === true ? { allowOversize: true } : undefined);
}

export function writeBlocksDir(
  memDir: string,
  specs: readonly BlockSpec[],
  extra?: { strays?: readonly string[] },
): string {
  const realDir = join(memDir, "blocks");
  mkdirSync(realDir, { recursive: true });
  for (const spec of specs) writeFileSync(join(realDir, `${spec.id}.md`), blockRaw(spec));
  for (const stray of extra?.strays ?? []) writeFileSync(join(realDir, stray), "not a block\n");
  writeFileSync(
    join(realDir, ".layout.json"),
    JSON.stringify({
      v: 1,
      migratedAt: "2026-11-06T00:00:00.000Z",
      runId: "test",
      source: "migrate",
      gen: 1,
      files: [],
    }),
  );
  return realDir;
}
