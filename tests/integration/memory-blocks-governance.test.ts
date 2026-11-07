import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runMigration } from "../../src/memory/blocks/migrate.js";
import { createBlockLocked, readCorpus } from "../../src/memory/blocks/store.js";
import { createSweepRunner, readArchiveIndex, restoreBlock } from "../../src/memory/govern/sweep.js";
import { renderBlocks } from "../../src/memory/blocks/render.js";
import { firstUserReviewPass } from "../../src/memory/govern/review-lite.js";
import { readIndex } from "../../src/memory/jev/index-store.js";
const roots: string[] = [],
  children: ChildProcess[] = [];
const repo = join(import.meta.dirname, "../..");
function setup() {
  const root = mkdtempSync(join(tmpdir(), "governance-integration-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("migrate → user-only review → startup budget suggestion, no truncation → write sweep → archive restore", async () => {
  const root = setup();
  writeFileSync(
    join(root, "core.md"),
    "# Rules\n- <!-- mem user --> old user rule\n- <!-- mem user --> new user rule\n",
  );
  expect((await runMigration(root)).outcome).toBe("committed");
  const blocks = join(root, "blocks");
  for (let i = 0; i < 4; i++)
    createBlockLocked(
      blocks,
      "global",
      { authority: "user", scope: "global" },
      `${i}: ${"rules ".repeat(140)}`,
      new Date(),
    );
  const a = createBlockLocked(
    blocks,
    "agent",
    { authority: "agent", expires: "2000-01-01" },
    "expired state",
    new Date(),
  );
  let pairs: readonly { a: string; b: string }[] = [];
  const count = await firstUserReviewPass(root, async (p) => {
    pairs = p;
    return p.slice(0, 1).map((x) => ({ ...x, p: 1 }));
  });
  expect(count).toBe(1);
  expect(pairs.every((p) => !p.a.startsWith("agent.") && !p.b.startsWith("agent."))).toBe(true);
  const notices: string[] = [];
  const runner = createSweepRunner({ enabled: true, residentBudget: 512, notify: (m) => notices.push(m) });
  const result = await runner.runSweep(root, "startup");
  expect(result.archived).toContain(a.id);
  expect(notices.some((m) => m.includes("resident budget exceeded"))).toBe(true);
  expect(notices.some((m) => m.includes("reload"))).toBe(true);
  expect(readIndex(root).index.review?.suggestions.some((s) => s.kind === "resident-budget")).toBe(true);
  const rendered = renderBlocks(readCorpus(blocks), {
    slug: "test",
    today: new Date().toISOString().slice(0, 10),
    isChild: false,
    residentBytes: 512,
  });
  for (let i = 1; i <= 4; i++) expect(rendered.text).toContain(`global.${String(i).padStart(3, "0")}`);
  expect(await restoreBlock(root, a.id)).toContain("restored:");
  expect(readFileSync(join(root, "core.md"), "utf8")).toContain("old user rule");
});
it("real busy lock waits at most its bounded acquisition, then a later signal retries", async () => {
  const root = setup();
  mkdirSync(join(root, "blocks"));
  writeFileSync(join(root, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  const b = createBlockLocked(
    join(root, "blocks"),
    "quota",
    { authority: "agent", expires: "2000-01-01" },
    "expired",
    new Date(),
  );
  const worker = join(root, "lock.mts");
  writeFileSync(
    worker,
    `
import {lockCreate,readProcIdentity,lockRelease} from ${JSON.stringify(join(repo, "src/memory/safe-fs.ts"))};import {hostname} from 'node:os';
const identity=readProcIdentity(process.pid);lockCreate(process.argv[2],{pid:process.pid,host:hostname(),token:'test',at:Date.now(),...identity});process.send('ready');process.once('message',()=>{lockRelease(process.argv[2],'test');process.disconnect();});
`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", worker, root], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  await new Promise<void>((r) => child.once("message", () => r()));
  const runner = createSweepRunner({ enabled: true });
  const started = Date.now();
  const result = await runner.runSweep(root, "write");
  expect(result.stopped).toContain("busy");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(result.operations).toBe(0);
  expect(existsSync(join(root, "blocks", `${b.id}.md`))).toBe(true);
  const done = new Promise<void>((resolve, reject) =>
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`)))),
  );
  child.send("release");
  await done;
  expect((await runner.runSweep(root, "write")).archived).toContain(b.id);
}, 10000);
it("crash after archive mapping, before rename: restarted runner cleans dangling record", async () => {
  const root = setup();
  mkdirSync(join(root, "blocks"));
  writeFileSync(join(root, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  const worker = join(root, "crash.mts");
  writeFileSync(
    worker,
    `
import {ensurePrivateDir,writeTempRegular,replaceAtomic} from ${JSON.stringify(join(repo, "src/memory/safe-fs.ts"))};import {join} from 'node:path';
const archive=join(process.argv[2],'blocks/archive');ensurePrivateDir(archive);const temp=writeTempRegular(archive,'index.json',Buffer.from(JSON.stringify({'quota.007.md':{id:'quota.007',archivedAt:new Date().toISOString(),reason:'write'}})),384);replaceAtomic(archive,temp,'index.json');process.send('mapped');process.on('message',()=>{});
`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", worker, root], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  await new Promise<void>((resolve) => child.once("message", () => resolve()));
  const dead = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await dead;
  expect(readArchiveIndex(root)).toHaveProperty("quota.007.md");
  await createSweepRunner({ enabled: true }).runSweep(root, "startup");
  expect(readArchiveIndex(root)).toEqual({});
}, 10000);
