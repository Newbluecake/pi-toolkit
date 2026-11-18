import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeQuiet, darwinPathBackend, openDirPath, readFileAt, SchedFsError } from "../../src/schedule/core/paths.js";
import {
  ensureStoreRoot,
  openSessionStore,
  reportInventory,
  writeReportLocked,
} from "../../src/schedule/core/writer.js";

const key = Symbol.for("pi-subagent:sched-fd-paths:v1");
const size = () => ((globalThis as any)[key]?.map.size ?? 0) as number;
function fdCount(): number | undefined {
  const path = existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
  try {
    return readdirSync(path).length;
  } catch {
    return undefined;
  }
}

it("D4 concurrent directory replacement: bounded outcomes and resources (U1-U6 remain uncovered)", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sched-darwin-race-")));
  const outside = join(base, "outside");
  mkdirSync(outside, { mode: 0o700 });
  const root = ensureStoreRoot(join(base, "store"), { backend: darwinPathBackend });
  const store = openSessionStore({
    root,
    sessionId: "race",
    self: { pid: process.pid, start: 1, host: "fixture", boot: "fixture" },
    epoch: "race",
    acquire: () => "held",
  });
  expect(await store.transact(() => ({ value: true, write: true }))).toMatchObject({ ok: true, wrote: true });
  const name = "a".repeat(64) + ".md";
  expect(
    await writeReportLocked(store, { reportFile: "reports/" + name, data: Buffer.from("initial"), now: Date.now() }),
  ).toMatchObject({ ok: true, value: { written: true } });
  const baseline = size();
  const descriptors = fdCount();
  const session = join(root.real, "race");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const fs=require('node:fs'); const path=require('node:path');
    const session=process.argv[1], outside=process.argv[2];
    let turns=0; let stopped=false; let sessionMode=false; let interference=0;
    process.on('message',m=>{if(m==='session'){sessionMode=true;process.send({session:true});}else stopped=true;});
    function step(){
      if(stopped){process.send({turns},()=>process.exit(0));return;}
      const target=sessionMode ? session : path.join(session,'reports');
      const parked=target+'-parked';
      try { fs.renameSync(target,parked); fs.symlinkSync(outside,target); fs.unlinkSync(target); fs.renameSync(parked,target); turns++; }
      catch(e){
        if(!['ENOENT','EEXIST','ENOTEMPTY'].includes(e.code)){process.send({error:String(e)},()=>process.exit(1));return;}
        // A writer may create reports in the gap; restore our parked directory before the next turn.
        if(fs.existsSync(parked)){
          let restored=false;
          for(let attempt=0;attempt<100 && !restored;attempt++){
            try {fs.renameSync(target,target+'-interference-'+interference++);} catch(e){if(e.code!=='ENOENT') throw e;}
            try {fs.renameSync(parked,target);restored=true;} catch(e){if(!['EEXIST','ENOTEMPTY','ENOTDIR'].includes(e.code)) throw e;}
          }
          if(!restored) throw new Error('restoration budget exhausted');
        }
        turns++;
      }
      setImmediate(step);
    }
    process.send({ready:true}); step();
  `,
      session,
      outside,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (b) => {
    stderr += String(b);
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  let turns = 0;
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (m: any) => {
      if (m.error) {
        stderr += m.error;
        reject(new Error(m.error));
      }
      if (m.ready) resolve();
      if (m.turns !== undefined) turns = m.turns;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`replacement child exited ${code}: ${stderr}`));
    });
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 55_000);
  deadline.unref();
  let succeeded = 0,
    refused = 0;
  try {
    await Promise.race([
      ready,
      exit.then((code) => {
        throw new Error(`replacement child exited before ready: ${code}: ${stderr}`);
      }),
    ]);
    for (let i = 0; i < 2000; i++) {
      if (child.exitCode !== null) throw new Error(`replacement child exited: ${child.exitCode}: ${stderr}`);
      const began = performance.now();
      const result = await writeReportLocked(store, {
        reportFile: "reports/" + name,
        data: Buffer.from("race"),
        now: Date.now(),
      });
      if (result.ok) succeeded++;
      else {
        expect(result.code).toBe("E_DEGRADED");
        refused++;
      }
      const scan = await store.transact((_draft, ctx) => {
        if (ctx.dirFd === undefined) return { value: false, write: false };
        const inv = reportInventory(ctx.dirFd);
        readFileAt(ctx.dirFd, "state.json", 256 * 1024);
        return { value: inv.complete, write: false };
      });
      if (!scan.ok) expect(scan.code).toBe("E_DEGRADED");
      expect(performance.now() - began).toBeLessThan(5000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const switched = new Promise<void>((resolve) =>
      child.on("message", (m: any) => {
        if (m.session) resolve();
      }),
    );
    child.send("session");
    await Promise.race([
      switched,
      exit.then((code) => {
        throw new Error(`replacement child exited before session phase: ${code}: ${stderr}`);
      }),
    ]);
    let sessionReads = 0,
      sessionRefusals = 0;
    for (let i = 0; i < 2000; i++) {
      if (child.exitCode !== null) throw new Error(`replacement child exited: ${child.exitCode}: ${stderr}`);
      const began = performance.now();
      let fd: number | undefined;
      try {
        fd = openDirPath(session, { backend: darwinPathBackend }).fd;
        expect(JSON.parse(readFileAt(fd, "state.json", 256 * 1024).bytes.toString()).sessionId).toBe("race");
        sessionReads++;
      } catch (err) {
        expect(err).toBeInstanceOf(SchedFsError);
        expect(["moved", "symlink", "missing", "io"]).toContain((err as SchedFsError).reason);
        sessionRefusals++;
      } finally {
        closeQuiet(fd);
      }
      expect(performance.now() - began).toBeLessThan(5000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    child.send("stop");
    expect(await exit).toBe(0);
    expect(turns).toBeGreaterThan(0);
    const touches = readdirSync(outside, { recursive: true }).length;
    console.log(
      JSON.stringify({
        platform: process.platform,
        reportRounds: 2000,
        sessionRounds: 2000,
        succeeded,
        refused,
        sessionReads,
        sessionRefusals,
        replacements: turns,
        outsideEntries: touches,
        uncovered: "U1-U6",
      }),
    );
    // This run must leave no external entries; U1-U6 still prevent a general zero-touch guarantee.
    expect(touches).toBe(0);
    expect(size()).toBe(baseline);
    expect(fdCount()).toBe(descriptors);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
    rmSync(base, { recursive: true, force: true });
  }
}, 60_000);
