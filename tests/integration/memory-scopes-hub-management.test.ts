/** Real independent Node processes, real root lock and CAS. All state is own /tmp.
 * No SDK, daemon, paid API, user HOME, mounts, dist or subprocess dependency install. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubMemoryProvider } from "../../src/memory/scopes/hub-store.js";
import { createMemoryOpCapRegistry } from "../../src/memory/scopes/op-cap.js";
import { lockCreate, lockRelease, readProcIdentity } from "../../src/memory/safe-fs.js";
import type { MemoryOwner } from "../../src/memory/scopes/types.js";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "p3c-process-"));
  dirs.push(dir);
  const slot = { effectiveStateDir: dir, uid: process.getuid?.() ?? 0 };
  const owner: MemoryOwner = { incarnation: {}, sid: "session", sessionEpoch: 1, branchGen: 0 };
  const make = () =>
    createHubMemoryProvider({
      slot: () => slot,
      owner: () => owner,
      capability: () => "ok",
      registry: createMemoryOpCapRegistry(),
      trustedCommand: () => true,
    });
  return { dir, slot, make };
}
const add = { storageScope: "hub", authority: "user", op: "create", topic: "general", text: "original" } as const;
describe("Hub management real lock integration", () => {
  it("two independent providers serialize same-rev commands, one winner and no mixed provenance", async () => {
    const f = fixture(),
      p = f.make(),
      q = f.make();
    const c = await p.management.command(add);
    if (!c.ok || !c.rev) throw Error("create");
    const operation = { ...add, op: "update" as const, targetId: c.id, expectRev: c.rev };
    const results = await Promise.all([
      p.management.command({ ...operation, text: "one" }),
      q.management.command({ ...operation, text: "two" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: "E_CONFLICT" }]);
    expect(p.view().state).toBe("ok");
    expect(q.management.inspect(c.id)).toMatchObject({
      ok: true,
      item: { text: expect.stringMatching(/^(one|two)$/) },
    });
  });
  it("two REAL processes contend on SAME withMemoryDirLock: exactly one same-rev commit, other conflict", async () => {
    const f = fixture(),
      p = f.make();
    const c = await p.management.command(add);
    if (!c.ok || !c.rev) throw Error("create");
    const script = join(f.dir, "worker.mts");
    writeFileSync(
      script,
      `
 import {createHubMemoryProvider} from ${JSON.stringify(resolve("src/memory/scopes/hub-store.ts"))};
 import {createMemoryOpCapRegistry} from ${JSON.stringify(resolve("src/memory/scopes/op-cap.ts"))};
 const slot={effectiveStateDir:process.argv[2],uid:process.getuid()};
 const owner={incarnation:{},sid:"child",sessionEpoch:1,branchGen:0};
 const keep=setInterval(()=>{},10000);
 const provider=createHubMemoryProvider({slot:()=>slot,owner:()=>owner,capability:()=>"ok",registry:createMemoryOpCapRegistry(),trustedCommand:()=>true,
 faults:{beforeBlockWrite(){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,180);}}});
 console.log("READY");
 process.stdin.once("data",async()=>{try{const r=await provider.management.command({storageScope:"hub",authority:"user",op:"update",targetId:"general.001",expectRev:process.argv[3],text:process.argv[4]});console.log(JSON.stringify({pid:process.pid,result:r}));}finally{clearInterval(keep);process.stdin.destroy();provider.dispose();}});
 `,
    );
    const start = (body: string) => {
      const child = spawn(
        process.execPath,
        ["--import", resolve("node_modules/tsx/dist/loader.mjs"), script, f.dir, c.rev!, body],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      let readyResolve!: () => void;
      const ready = new Promise<void>((r) => {
        readyResolve = r;
      });
      child.stdout.on("data", (b) => {
        stdout += String(b);
        if (stdout.includes("READY")) readyResolve();
      });
      child.stderr.on("data", (b) => {
        stderr += String(b);
      });
      const done = new Promise<{ pid: number; result: { ok: boolean; code?: string } }>((resolveDone, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) return reject(Error(`child ${code}: ${stderr}`));
          try {
            resolveDone(JSON.parse(stdout.trim().split("\n").at(-1)!));
          } catch (err) {
            reject(err);
          }
        });
      });
      return { child, ready, done };
    };
    const a = start("process-a"),
      b = start("process-b");
    try {
      await Promise.all([a.ready, b.ready]);
      a.child.stdin.write("go");
      b.child.stdin.write("go");
      const result = await Promise.all([a.done, b.done]);
      expect(new Set(result.map((r) => r.pid)).size).toBe(2);
      expect(result.every((r) => r.pid !== process.pid)).toBe(true);
      expect(result.filter((r) => r.result.ok)).toHaveLength(1);
      expect(result.filter((r) => !r.result.ok).map((r) => r.result.code)).toEqual(["E_CONFLICT"]);
      expect(p.view()).toMatchObject({ state: "ok", items: [{ text: expect.stringMatching(/^process-[ab]$/) }] });
    } finally {
      a.child.kill("SIGKILL");
      b.child.kill("SIGKILL");
    }
  }, 15000);
  it("same queue observes block directory identity change across actual lock await", async () => {
    const f = fixture(),
      p = f.make();
    const c = await p.management.command(add);
    if (!c.ok) throw Error("create");
    const root = join(f.dir, "hub-memory"),
      identity = readProcIdentity(process.pid);
    const payload = {
      pid: process.pid,
      host: hostname(),
      token: "hold-p3c",
      at: Date.now(),
      ...(identity?.startTicks !== undefined ? { startTicks: identity.startTicks } : {}),
      ...(identity?.bootId !== undefined ? { bootId: identity.bootId } : {}),
    };
    expect(lockCreate(root, payload)).toBe(true);
    const task = p.management.command(add);
    await Promise.resolve(); // dequeue captures existing blocks inode before its lock await
    renameSync(join(root, "blocks"), join(root, "blocks-old"));
    mkdirSync(join(root, "blocks"), { mode: 0o700 });
    lockRelease(root, payload.token);
    expect(await task).toEqual({ ok: false, code: "E_NAMESPACE" });
    expect(readFileSync(join(root, "blocks-old/general.001.md"), "utf8")).toContain("original");
    expect(p.view().state).toBe("inert");
  });
});
