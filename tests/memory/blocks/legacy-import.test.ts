import { mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runMigration } from "../../../src/memory/blocks/migrate.js";
import { importLegacy, legacyDrift } from "../../../src/memory/blocks/legacy.js";
import { readCorpus } from "../../../src/memory/blocks/store.js";
import type { MemoryWriteGate } from "../../../src/memory/contracts.js";
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("detects legacy drift and imports only new body hashes; repeated import is idempotent", async () => {
  const p = mkdtempSync(join(tmpdir(), "legacy-import-"));
  roots.push(p);
  writeFileSync(join(p, "core.md"), "- rule one\n");
  await runMigration(p);
  expect(legacyDrift(p)).toEqual([]);
  appendFileSync(join(p, "core.md"), "- rule two\n");
  const bytes = readFileSync(join(p, "core.md"), "utf8");
  expect(legacyDrift(p).map((f) => f.name)).toEqual(["core.md"]);
  expect(await importLegacy(p, { dryRun: true })).toEqual({ created: [], files: ["core.md"] });
  const imported = await importLegacy(p);
  expect(imported.created).toHaveLength(1);
  expect(readCorpus(join(p, "blocks")).blocks).toHaveLength(2);
  expect(await importLegacy(p)).toEqual({ created: [], files: [] });
  expect(readFileSync(join(p, "core.md"), "utf8")).toBe(bytes);
  const ledger = JSON.parse(readFileSync(join(p, "blocks/.legacy-import.json"), "utf8"));
  expect(ledger[0].created).toEqual(imported.created);
});
it("an interrupted legacy import replays by hash without duplicate blocks or source edits", async () => {
  const p = mkdtempSync(join(tmpdir(), "legacy-import-interrupted-"));
  roots.push(p);
  writeFileSync(join(p, "core.md"), "- original\n");
  await runMigration(p);
  appendFileSync(join(p, "core.md"), "- added one\n- added two\n");
  const source = readFileSync(join(p, "core.md"), "utf8");
  const dir = join(p, "blocks");
  const gate: MemoryWriteGate = {
    capture: () => {},
    check: () => (readCorpus(dir).blocks.length > 1 ? { ok: false, reason: "unmounted" } : { ok: true }),
  };
  await expect(importLegacy(p, { gate })).rejects.toThrow("unmounted");
  expect(readCorpus(dir).blocks).toHaveLength(2);
  expect(readFileSync(join(p, "core.md"), "utf8")).toBe(source);
  const resumed = await importLegacy(p);
  expect(resumed.created).toHaveLength(1);
  expect(
    readCorpus(dir)
      .blocks.map((b) => b.body)
      .sort(),
  ).toEqual(["- added one", "- added two", "- original"]);
  expect(await importLegacy(p)).toEqual({ created: [], files: [] });
  expect(readFileSync(join(p, "core.md"), "utf8")).toBe(source);
});
