/**
 * scheduled-reports plan r3 §4.5a 崩溃语义 / §14 故障注入 (S1): a real child process SIGKILLs itself
 * at each writer point of an auto claim. Outcomes may only be: T undecided (later swept as missed)
 * or a non-terminal run (later recovered as unknown) — never a silent loss; a dead holder's lock and
 * temp files never wedge the next transaction.
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recoverRuns, sweep } from "../../../src/schedule/core/claim.js";
import { sessionDirName } from "../../../src/schedule/core/paths.js";
import { gcSessionReports } from "../../../src/schedule/core/writer.js";
import { addTask, approve, env, makeTask, readOk, self, SID, type Env } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHILD = join(ROOT, "tests/schedule/core/fixtures/crash-child.ts");

let E: Env;
afterEach(() => E?.cleanup());

async function prepare() {
  // Keep the child well inside T's tolerance window (start-up ~1 s) and never before T (an early
  // claim is refused): late in a minute, wait for the next one.
  if (Date.now() % 60_000 > 40_000) await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 50));
  const now = Date.now();
  E = env(now - 120_000);
  const store = E.store();
  const t = approve(makeTask({ when: { kind: "cron", expr: "* * * * *", tz: "UTC" } }));
  await addTask(store, t, now - 120_000);
  const T = Math.floor(now / 60_000) * 60_000;
  // decide everything before T so the child's claim is the only open question
  await store.transact((d) => {
    d.occ[t.id]!.decidedThrough = T - 60_000;
    return { value: 0, write: true };
  });
  const rev = readOk(store).rev;
  return { store, t, T, rev, dir: join(E.storeDir, sessionDirName(SID)) };
}

async function run(point: string) {
  const p = await prepare();
  const res = spawnSync(process.execPath, ["--import", "tsx", CHILD, E.storeDir, SID, p.t.id, String(p.T), point], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ...p, res };
}

describe("fault injection (real SIGKILL)", () => {
  it("killed while holding the lock (before any write): T stays undecided ⇒ swept as missed later", async () => {
    const { store, t, T, rev, res, dir } = await run("lock-held");
    expect(res.signal).toBe("SIGKILL");
    expect(readdirSync(dir)).toContain(".lock");
    expect(readOk(store).rev).toBe(rev);
    E.clock.t = T + 60_001;
    const r = await sweep(store);
    expect(r).toMatchObject({ kind: "swept", missed: [expect.objectContaining({ to: T, count: 1 })] }); // dead lock broken
    expect(readOk(store).occ[t.id]).toMatchObject({ decidedThrough: T, firedTotal: 0 });
  }, 40_000);

  it("killed after the temp was written, before rename: old file intact, temp ignored and reaped", async () => {
    const { store, rev, res, dir, T } = await run("tmp-written");
    expect(res.signal).toBe("SIGKILL");
    expect(readdirSync(dir).some((n) => n.startsWith(".state.json.") && n.endsWith(".tmp"))).toBe(true);
    expect(readOk(store).rev).toBe(rev);
    expect(readOk(store).runs).toEqual([]);
    const gc = await gcSessionReports(store, T + 2 * 3_600_000);
    expect(gc).toMatchObject({ ok: true });
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  }, 40_000);

  it("killed right after the rename: the run exists (non-terminal) and recovery turns it into unknown(crash)", async () => {
    const { store, t, T, rev, res } = await run("renamed");
    expect(res.signal).toBe("SIGKILL");
    const s = readOk(store);
    expect(s.rev).toBe(rev + 1);
    expect(s.occ[t.id]).toMatchObject({ decidedThrough: T, firedTotal: 1 });
    expect(s.runs[0]).toMatchObject({ state: "dispatching" });
    const r = await recoverRuns(store, self());
    expect(r).toMatchObject({ runs: [{ to: "unknown", reason: "crash" }] });
  }, 40_000);

  it("control: without a fault the child fires normally", async () => {
    const { store, res } = await run("none");
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ kind: "fired" });
    expect(readOk(store).runs).toHaveLength(1);
  }, 40_000);

  it("review B1: 8 processes race for one T (one SIGKILLed while holding the lock, stale lock content planted) ⇒ fired exactly once", async () => {
    const { store, t, T, dir } = await prepare();
    // Stale holder content from a long-dead process: with the kernel lock it is plain bytes.
    writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: 999_999, start: 1, host: "x", epoch: "dead", at: 0 }));
    const spawnChild = (mode: string) =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((resolve) => {
        const c = spawn(process.execPath, ["--import", "tsx", CHILD, E.storeDir, SID, t.id, String(T), mode], {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        c.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
        c.once("exit", (code, signal) => resolve({ code, signal, out }));
        victims.set(c, () => out);
      });
    const victims = new Map<ReturnType<typeof spawn>, () => string>();
    // The victim takes the kernel lock FIRST and blocks there (deterministic: it cannot exit before the kill);
    // the 7 racers start while it holds the lock, then it is SIGKILLed with the lock still held.
    const victimDone = spawnChild("lock-hold-wait");
    const victim = [...victims.keys()][0]!;
    for (let i = 0; i < 600 && !victims.get(victim)!().includes("HELD"); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(victims.get(victim)!()).toContain("HELD");
    const racers = Array.from({ length: 7 }, () => spawnChild("none"));
    await new Promise((r) => setTimeout(r, 300)); // the racers are now queued behind the dead-to-be holder
    victim.kill("SIGKILL");
    const children = [victimDone, ...racers];
    const results = await Promise.all(children);
    const outcomes = results.filter((r) => r.code === 0).map((r) => JSON.parse(r.out) as { kind: string });
    expect(results[0]!.signal).toBe("SIGKILL");
    expect(outcomes).toHaveLength(7);
    expect(outcomes.filter((o) => o.kind === "fired")).toHaveLength(1);
    const s = readOk(store);
    expect(s.runs).toHaveLength(1);
    expect(s.occ[t.id]).toMatchObject({ decidedThrough: T, firedTotal: 1 });
  }, 60_000);
});
