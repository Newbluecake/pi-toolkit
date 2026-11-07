import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runMigration, rollbackMigration, resumeRollback } from "../../../src/memory/blocks/migrate.js";
import { dirFormat } from "../../../src/memory/blocks/naming.js";
import { readHold, readBlocksState } from "../../../src/memory/blocks/state.js";
const roots: string[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), "rollback-"));
  roots.push(p);
  writeFileSync(join(p, "core.md"), "- original rule\n");
  return p;
};
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("rollback retains new blocks and current legacy writes; explicit migration clears hold with new generation", async () => {
  const p = root();
  await runMigration(p);
  writeFileSync(join(p, "blocks/new.001.md"), "new block retained");
  appendFileSync(join(p, "core.md"), "- old-session append\n");
  // Rollback promises CURRENT old-layout bytes, not migration-time bytes (P8 tar owns that guarantee).
  const rollback = await rollbackMigration(p);
  expect(rollback.changed).toContain("new.001.md");
  expect(dirFormat(p)).toBe("held");
  expect(readFileSync(join(p, "core.md"), "utf8")).toContain("old-session append");
  const rolled = readdirSync(p).find((n) => n.startsWith(".blocks-rolledback"))!;
  expect(readFileSync(join(p, rolled, "new.001.md"), "utf8")).toBe("new block retained");
  expect(readHold(p)?.rollback?.done).toBe(true);
  expect((await runMigration(p)).outcome).toBe("held");
  const gen = readBlocksState(p).gen;
  expect((await runMigration(p, { explicit: true })).outcome).toBe("committed");
  expect(readBlocksState(p).gen).toBe(gen + 2);
  expect(readdirSync(p)).toContain(rolled);
});
it.each(["rollback-gen", "rollback-hold", "rollback-renamed"] as const)(
  "recovers interrupted %s boundary",
  async (stop) => {
    const p = root();
    await runMigration(p);
    await expect(
      rollbackMigration(p, {
        phase: (phase) => {
          if (phase === stop) throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    expect(dirFormat(p)).toBe(stop === "rollback-gen" ? "blocks" : "held");
    if (stop === "rollback-gen") await rollbackMigration(p);
    else await resumeRollback(p);
    expect(dirFormat(p)).toBe("held");
    expect(readHold(p)?.rollback?.done).toBe(true);
    expect(readdirSync(p).filter((n) => n.startsWith(".blocks-rolledback"))).toHaveLength(1);
  },
);
