import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBlockLocked, readCorpus } from "../../src/memory/blocks/store.js";
const roots: string[] = [],
  children: ChildProcess[] = [];
const repo = join(import.meta.dirname, "../..");
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("two real processes race reciprocal edges: at most one committed edge, no cycles", async () => {
  const root = mkdtempSync(join(tmpdir(), "supersede-race-"));
  roots.push(root);
  mkdirSync(join(root, "blocks"));
  writeFileSync(join(root, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  const worker = join(root, "worker.mts");
  writeFileSync(
    worker,
    `
import {createBlockLocked} from ${JSON.stringify(join(repo, "src/memory/blocks/store.ts"))};
import {supersede,readGovernBlock} from ${JSON.stringify(join(repo, "src/memory/govern/supersede.ts"))};
import {withMemoryDirLock} from ${JSON.stringify(join(repo, "src/memory/lock.ts"))};
import {join} from 'node:path';
const dir=process.argv[2];
process.on('message',()=>{});
const b=await withMemoryDirLock(dir,()=>createBlockLocked(join(dir,'blocks'),'rule',{authority:'user'},process.argv[3],new Date()));
process.send({ready:b});
process.once('message',async ({other})=>{const result=await supersede(dir,[{kind:'supersedes',newId:b.id,newRev:b.rev,oldId:other.id,oldRev:other.rev,p:1,auto:true}]);process.send({result});process.disconnect();});
`,
  );
  function start(body: string) {
    let readyResolve: (v: any) => void = () => {};
    const ready = new Promise<any>((r) => (readyResolve = r));
    let resultResolve: (v: any) => void = () => {};
    const result = new Promise<any>((r) => (resultResolve = r));
    const child = spawn(process.execPath, ["--import", "tsx", worker, root, body], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    let error = "";
    child.stderr!.on("data", (b) => (error += b));
    child.on("message", (m: any) => {
      if (m.ready) readyResolve(m.ready);
      if (m.result) resultResolve(m.result);
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(error || `exit ${code}`))));
    });
    return { child, ready, result, exited };
  }
  const a = start("new rule A"),
    b = start("new rule B");
  const [aa, bb] = await Promise.all([a.ready, b.ready]);
  a.child.send({ other: bb });
  b.child.send({ other: aa });
  const results = (await Promise.all([a.result, b.result])).flat();
  await Promise.all([a.exited, b.exited]);
  expect(results.filter((r) => r.outcome === "superseded")).toHaveLength(1);
  expect(results.filter((r) => r.outcome === "skipped")).toHaveLength(1);
  const blocks = readCorpus(join(root, "blocks")).blocks;
  expect(blocks.filter((x) => x.meta.supersededBy)).toHaveLength(1);
  for (const block of blocks) {
    const seen = new Set<string>();
    let current: typeof block | undefined = block;
    while (current) {
      expect(seen.has(current.id)).toBe(false);
      seen.add(current.id);
      const id = current.meta.supersededBy;
      current = id ? blocks.find((x) => x.id === id) : undefined;
    }
  }
}, 20000);

it.each(["before-cas", "after-cas"])(
  "real SIGKILL %s leaves a whole old file and a recoverable dead-owner lock",
  async (phase) => {
    const { supersede, readGovernBlock } = await import("../../src/memory/govern/supersede.js");
    const root = mkdtempSync(join(tmpdir(), "supersede-crash-"));
    roots.push(root);
    mkdirSync(join(root, "blocks"));
    writeFileSync(join(root, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
    const a = createBlockLocked(join(root, "blocks"), "rule", { authority: "user" }, "new rule", new Date()),
      b = createBlockLocked(join(root, "blocks"), "rule", { authority: "user" }, "old rule", new Date());
    const verdict = {
      kind: "supersedes" as const,
      newId: a.id,
      newRev: a.rev,
      oldId: b.id,
      oldRev: b.rev,
      p: 1,
      auto: true,
    };
    const worker = join(root, "crash.mts");
    writeFileSync(
      worker,
      `
import {supersede} from ${JSON.stringify(join(repo, "src/memory/govern/supersede.ts"))};
let checks=0;const before=${JSON.stringify(phase)}==='before-cas';
await supersede(process.argv[2],[${JSON.stringify(verdict)}],{gate:{capture(){},check(){if(before&&++checks===4)process.kill(process.pid,'SIGKILL');return {ok:true};}},notify:()=>{if(!before)process.kill(process.pid,'SIGKILL');}});
`,
    );
    const child = spawn(process.execPath, ["--import", "tsx", worker, root], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (b) => (stderr += b));
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, sig) => (sig ? resolve(sig) : reject(new Error(`unexpected exit ${code}: ${stderr}`))));
    });
    expect(signal).toBe("SIGKILL");
    const old = readGovernBlock(root, b.id);
    expect(old.meta.status).toBe(phase === "before-cas" ? "active" : "superseded");
    expect(readGovernBlock(root, a.id).raw).toBe(a.raw);
    if (phase === "before-cas") expect(old.raw).toBe(b.raw);
    const rerun = await supersede(root, [verdict]);
    expect(rerun[0]?.outcome).toBe(phase === "before-cas" ? "superseded" : "skipped");
    expect(readCorpus(join(root, "blocks")).blocks.filter((x) => x.meta.supersededBy)).toHaveLength(1);
  },
  10000,
);
