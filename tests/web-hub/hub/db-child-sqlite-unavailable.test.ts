/**
 * §4.1 "打开前" fail-closed: `sqlite-unavailable` when the running Node has no `node:sqlite`
 * (plan requires Node \u226522.13; this repo's own dev/CI Node always has it — the real absence
 * case is only reachable on an older/differently-built Node). Simulated here with the real
 * `--no-experimental-sqlite` CLI flag (verified to make `require('node:sqlite')` throw exactly
 * like a genuinely missing module) rather than mocking `require` — this exercises the *actual*
 * script text `db-child.ts` builds, unmodified.
 *
 * Before the fix (`db-child.ts`'s `COMMON_PRELUDE` doing a bare, unguarded
 * `const { DatabaseSync } = require('node:sqlite');`), this `require` throws synchronously
 * before either script's own `if (!DatabaseSync)` branch (query script ~line 102, maint script
 * ~line 246) is ever reached — the process dies with an uncaught exception and empty stdout, so
 * the caller (`lan-store.ts`'s `runMaint`, via `execFile`) only ever sees a generic non-zero exit
 * and falls through to `db-invalid` (task item 3's "缺失运行时被归为 db-invalid"). After the fix
 * the `require` is itself wrapped in `try/catch`, leaving `DatabaseSync === undefined` so both
 * scripts' existing `if (!DatabaseSync)` branches become reachable and reply the correct
 * `sqlite-unavailable` code on stdout with a normal exit.
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildMaintScript, buildQueryScript } from "../../../src/web-hub/hub/db-child.js";

const execFileP = promisify(execFile);

const hasNoExperimentalSqliteFlag = process.allowedNodeEnvironmentFlags.has("--no-experimental-sqlite");
const skipIfFlagUnsupported = hasNoExperimentalSqliteFlag ? describe : describe.skip;

function tmp(): { dir: string; dbFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wh-dbchild-nosqlite-"));
  return { dir, dbFile: join(dir, "hub.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

skipIfFlagUnsupported("node:sqlite unavailable (simulated via --no-experimental-sqlite)", () => {
  it("require('node:sqlite') really throws under the flag (sanity check for the rest of this file)", async () => {
    const { stdout } = await execFileP(process.execPath, [
      "--no-experimental-sqlite",
      "-e",
      "try { require('node:sqlite'); console.log('got-it'); } catch (err) { console.log('threw:' + err.message); }",
    ]);
    expect(stdout.trim()).toMatch(/^threw:/);
  });

  it("maintenance script (open-check-migrate) replies sqlite-unavailable instead of crashing with empty stdout", async () => {
    const t = tmp();
    try {
      const script = buildMaintScript();
      const { stdout } = await execFileP(
        process.execPath,
        ["--no-experimental-sqlite", "--disable-warning=ExperimentalWarning", "-e", script],
        {
          env: {
            ...process.env,
            PI_WEBHUB_DB_PATH: t.dbFile,
            PI_WEBHUB_DB_OP: "open-check-migrate",
            PI_WEBHUB_DB_DEADLINE_MS: "5000",
          },
          timeout: 5000,
        },
      );
      const line = stdout.trim().split("\n").pop() ?? "";
      expect(line.length).toBeGreaterThan(0); // before the fix: empty (process died before any reply)
      const parsed = JSON.parse(line) as { ok: boolean; code?: string; detail?: string };
      expect(parsed).toMatchObject({ ok: false, code: "sqlite-unavailable" });
    } finally {
      t.cleanup();
    }
  });

  it("query script replies-or-exits cleanly without an uncaught-exception crash (defensive secondary path)", async () => {
    // The resident query subprocess is only ever spawned *after* `runMaint("open-check-migrate")`
    // has already succeeded (plan §4.1's ordering) — so in practice `sqlite-unavailable` is always
    // caught at the maintenance step above. This only pins that the query script's own (mirrored)
    // guard doesn't regress into an uncaught-exception crash either, now that the shared
    // `COMMON_PRELUDE` require is guarded.
    const script = buildQueryScript();
    await expect(
      execFileP(process.execPath, ["--no-experimental-sqlite", "--disable-warning=ExperimentalWarning", "-e", script], {
        env: { ...process.env, PI_WEBHUB_DB_PATH: join(tmpdir(), "unused.db") },
        timeout: 5000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      // A pre-fix uncaught TypeError from the mirrored `if (!DatabaseSync)` branch referencing an
      // undeclared `__sqliteErr` would also exit 1, but with a stack trace on stderr; the fixed
      // script exits via its own deliberate `process.exit(1)` after a clean `stderr.write`, with
      // no uncaught-exception stack trace.
      stderr: expect.stringContaining("sqlite-unavailable"),
    });
  });
});
