import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runMigration, rollbackMigration } from "../../src/memory/blocks/migrate.js";
import { readProcIdentity } from "../../src/memory/safe-fs.js";
import { dirFormat } from "../../src/memory/blocks/naming.js";
const roots: string[] = [],
  children: ChildProcess[] = [];
const repo = join(import.meta.dirname, "../..");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rollback-race-"));
  roots.push(root);
  const dir = join(root, "memory");
  mkdirSync(dir);
  writeFileSync(join(dir, "core.md"), "- one\n- two\n");
  const worker = join(root, "worker.mts");
  writeFileSync(
    worker,
    `
import { runMigration } from ${JSON.stringify(join(repo, "src/memory/blocks/migrate.ts"))};
const result=await runMigration(process.argv[2],{phase:async (phase,staging)=>{if(phase==='built'){process.send({phase,staging});await new Promise(resolve=>process.once('message',resolve));}}});process.send({result});process.disconnect();
`,
  );
  return { dir, worker };
}
function paused(f: ReturnType<typeof fixture>): Promise<{ child: ChildProcess; staging: string; done: Promise<any> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", f.worker, f.dir], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    let err = "";
    child.stderr!.on("data", (b) => (err += b));
    let finish: (value: any) => void;
    const done = new Promise<any>((r, j) => {
      finish = r;
      child.once("error", j);
      child.once("exit", (code) => {
        if (code !== 0) j(new Error(err));
      });
    });
    child.on("message", (m: any) => {
      if (m.phase === "built") resolve({ child, staging: m.staging, done });
      if (m.result) finish(m.result);
    });
    child.once("error", reject);
  });
}
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("A build → B commit+rollback → A commit is rejected by hold/generation", async () => {
  const f = fixture(),
    a = await paused(f);
  expect((await runMigration(f.dir)).outcome).toBe("committed");
  await rollbackMigration(f.dir);
  a.child.send("continue");
  expect((await a.done).outcome).toBe("aborted");
  expect(dirFormat(f.dir)).toBe("held");
  expect(existsSync(a.staging)).toBe(false);
});
it("SIGSTOP owner is never age-cleaned; B commits; resumed A cannot publish", async () => {
  const f = fixture(),
    a = await paused(f);
  a.child.kill("SIGSTOP");
  expect((await runMigration(f.dir)).outcome).toBe("committed");
  expect(existsSync(a.staging)).toBe(true);
  a.child.kill("SIGCONT");
  a.child.send("continue");
  expect((await a.done).outcome).toBe("aborted");
  expect(dirFormat(f.dir)).toBe("blocks");
  expect((await runMigration(f.dir)).outcome).toBe("already-migrated");
  expect(readdirSync(f.dir).some((n) => n.includes(".trash-"))).toBe(false);
});
it("isolated owner's resumed submission cannot rename a missing staging tree", async () => {
  const f = fixture(),
    a = await paused(f);
  const resultB = await runMigration(f.dir, {
    identity: (pid) => {
      const ident = readProcIdentity(pid);
      return pid === a.child.pid && ident ? { ...ident, startTicks: ident.startTicks + 1 } : ident;
    },
  });
  expect(resultB.outcome).toBe("committed");
  expect(existsSync(a.staging)).toBe(false);
  a.child.send("continue");
  const result = await a.done;
  expect(result.outcome).toBe("aborted");
  expect(dirFormat(f.dir)).toBe("blocks");
  expect(existsSync(join(f.dir, "blocks"))).toBe(true);
});

it("clearing hold cannot resurrect a stale builder's generation", async () => {
  const f = fixture(),
    a = await paused(f);
  await runMigration(f.dir);
  await rollbackMigration(f.dir);
  expect((await runMigration(f.dir, { explicit: true })).outcome).toBe("committed");
  a.child.send("continue");
  const result = await a.done;
  expect(result.outcome).toBe("aborted");
  expect(result.reason).toContain("generation changed");
  expect(dirFormat(f.dir)).toBe("blocks");
});
