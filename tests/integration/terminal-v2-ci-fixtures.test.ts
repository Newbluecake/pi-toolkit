/** Test-only gate regressions. All SQLite/CLI paths are fresh private fixtures. */
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { seedOversizedSessions } from "./helpers/terminal-sqlite-seed.js";
import { runRetainedFixtureCli } from "./helpers/terminal-retained-cli.js";
import { projectOf } from "../tiers.js";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

it("real SQLite seed waits for a competing writer, inserts all 65 atomically and propagates non-busy failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "sql-")),
    path = join(root, "db"),
    db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (sid_hash BLOB PRIMARY KEY, user_id INTEGER, epoch INTEGER, bound_origin TEXT,
    created_at INTEGER, last_seen_at INTEGER, expires_at INTEGER, absolute_expires_at INTEGER, created_ip TEXT)`);
  const keep = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions VALUES (?,1,1,'fixture',1,1,1,1,'fixture')").run(Buffer.from(keep, "base64url"));
  const holder = join(root, "hold.cjs");
  writeFileSync(
    holder,
    `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[2]);
    process.on('message',()=>{}); // Keep only this owned IPC handle alive while the unref timer holds the lock.
    db.exec('BEGIN IMMEDIATE'); process.send('locked');
    setTimeout(()=>{require('node:fs').writeFileSync(process.argv[3],'released');db.exec('COMMIT');db.close();process.disconnect()},500).unref();`,
    { mode: 0o600 },
  );
  const releaseMarker = join(root, "released");
  const child = fork(holder, [path, releaseMarker], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", (message) => (message === "locked" ? resolve() : reject(new Error("lock not acquired"))));
      child.once("error", reject);
      child.once("exit", () => reject(new Error("holder exited before lock")));
    });
    const hashes = Array.from({ length: 65 }, () => randomBytes(32).toString("base64url"));
    seedOversizedSessions(path, keep, hashes);
    expect(readFileSync(releaseMarker, "utf8")).toBe("released");
    expect(await closed).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()!.n).toBe(66);
    // A new first row must be rolled back if a later duplicate fails. No generic
    // retry/success manufacture may turn a constraint failure into a partial seed.
    const extra = randomBytes(32).toString("base64url");
    expect(() => seedOversizedSessions(path, keep, [extra, hashes[0]!])).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()!.n).toBe(66);
    expect(
      db.prepare("SELECT sid_hash FROM sessions WHERE sid_hash=?").get(Buffer.from(extra, "base64url")),
    ).toBeUndefined();
  } finally {
    db.close();
  }
}, 15000);

it("outer CLI envelope consumes internal nonzero/error code instead of masking it as ETIMEDOUT or JSON success", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-")),
    cli = join(root, "cli.mjs");
  writeFileSync(cli, `console.log(JSON.stringify({error:'E_RETAINED_LOAD_PROBE_TIMEOUT'}));process.exitCode=1;`);
  expect(() => runRetainedFixtureCli(cli, ["publish-new"], { cwd: root, env: process.env })).toThrow(
    "status=1 signal=null outer=none internal=E_RETAINED_LOAD_PROBE_TIMEOUT",
  );
  writeFileSync(cli, `console.log(JSON.stringify({phase:'publication-complete', sequence:1}));`);
  expect(runRetainedFixtureCli(cli, ["resume"], { cwd: root, env: process.env })).toEqual({
    phase: "publication-complete",
    sequence: 1,
  });
});

it("stock report gate rejects zero-selected, wrong phase, skipped and failed cells; tier ownership stays unchanged", async () => {
  const { verifyStockReport, STOCK_FILE } = await import(resolve("scripts/ci/terminal-stock.mjs"));
  expect(projectOf(STOCK_FILE)).toBe("tier2");
  const report = {
    success: true,
    numPassedTests: 1,
    numFailedTests: 0,
    testResults: [
      {
        name: `${process.cwd()}/${STOCK_FILE}`,
        assertionResults: [
          { status: "passed", fullName: "stock npm L2: sealed consumer restart phase preserves retained debt" },
          { status: "skipped", fullName: "stock zip L2: sealed consumer restart phase preserves retained debt" },
        ],
      },
    ],
  };
  expect(verifyStockReport(report, "npm", "restart")).toBeUndefined();
  for (const mutate of [
    (r: any) => {
      r.numPassedTests = 0;
    },
    (r: any) => {
      r.success = false;
    },
    (r: any) => {
      r.testResults = [];
    },
    (r: any) => {
      r.testResults[0].assertionResults[0].status = "skipped";
    },
    (r: any) => {
      r.testResults[0].assertionResults[0].fullName =
        "stock npm L2: sealed consumer rollback phase preserves retained debt";
    },
  ]) {
    const broken = structuredClone(report);
    mutate(broken);
    expect(() => verifyStockReport(broken, "npm", "restart")).toThrow();
  }
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(workflow).not.toMatch(/^\s+continue-on-error:/m);
  expect(workflow.match(/--exclude tests\/integration\/terminal-v2-retained-stock-restart.test.ts/g)).toHaveLength(1);
  for (const format of ["npm", "zip"])
    for (const phase of ["restart", "rollback"])
      expect(workflow).toContain(`run: node scripts/ci/terminal-stock.mjs cell ${format} ${phase}`);
});
