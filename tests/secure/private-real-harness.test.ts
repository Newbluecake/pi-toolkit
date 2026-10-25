/**
 * N4 security review #1/#2: the real-suite harness only ever signals processes that are provably
 * its own (run token in /proc/<pid>/environ, same uid, started after the harness, starttime
 * stable) and never a recycled pid / pgid. Uses plain `sleep`/`node` children only — no FUSE.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealHarness, RUN_VAR, alive, procStart, sleep, until } from "./private-real-harness.js";

const kids: ChildProcess[] = [];
afterEach(() => {
  for (const c of kids.splice(0)) c.kill("SIGKILL");
});
function child(args: string[], opts: Parameters<typeof spawn>[2] = {}): { pid: number; start: number } {
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", ...args], { stdio: "ignore", ...opts });
  kids.push(c);
  return { pid: c.pid!, start: procStart(c.pid!)! };
}

describe.skipIf(process.platform !== "linux")("private-real-harness ownership-gated cleanup", () => {
  it("an unrelated process mentioning the scratch dir (argv + cwd, no token) is reported, never signalled", async () => {
    const T = new RealHarness();
    const d = T.tmp("ps-n4-own-");
    const decoy = child([join(d, "marker")], { cwd: d });
    const mine = child([], { env: T.env() });
    await until(() => procStart(decoy.pid) !== undefined && procStart(mine.pid) !== undefined, 2_000, "spawned");
    await sleep(100);
    expect(T.owned(decoy.pid)).toBeUndefined();
    expect(T.owned(mine.pid)).toEqual(mine);
    T.cleanup();
    await until(() => !alive(mine), 3_000, "own child killed");
    expect(alive(decoy)).toBe(true);
    expect(T.reports.join("\n")).toContain(`pid ${decoy.pid} `);
  });

  it("the token alone is not enough: a process started before the harness, or with another token, is not ours", async () => {
    const early = child([], { env: { ...process.env, [RUN_VAR]: "x" } });
    await sleep(50);
    const T = new RealHarness({ runStart: early.start + 1 });
    const sameTokenButEarly = child([], { env: T.env() });
    expect(T.owned(early.pid)).toBeUndefined(); // wrong token
    // started after runStart ⇒ ours; then pretend the harness started later than it did
    expect(T.owned(sameTokenButEarly.pid)).toEqual(sameTokenButEarly);
    const later = new RealHarness({ runStart: sameTokenButEarly.start + 1_000_000 });
    expect(later.owned(sameTokenButEarly.pid)).toBeUndefined();
  });

  it("recycled identities: a stale group entry (wrong starttime / not a leader) and a stale tracked pid get ZERO signals", async () => {
    const sent: Array<[number, string]> = [];
    const T = new RealHarness({ signal: (pid, sig) => void sent.push([pid, sig]) });
    // a live group leader that is NOT the one we recorded (starttime differs ⇒ recycled pid)
    const leader = child([], { detached: true, env: T.env() });
    T.groups.push({ pid: leader.pid, start: leader.start + 1 });
    // a live process with the right starttime but which is not a group leader
    const member = child([], { env: T.env() });
    T.groups.push({ pid: member.pid, start: member.start });
    // a tracked identity whose pid is now someone else (starttime mismatch)
    T.tracked.push({ pid: leader.pid, start: leader.start - 1 });
    expect(T.killGroup({ pid: leader.pid, start: leader.start + 1 })).toBe(false);
    expect(T.killGroup({ pid: member.pid, start: member.start })).toBe(false);
    expect(T.killOwned({ pid: leader.pid, start: leader.start - 1 })).toBe(false);
    expect(sent).toEqual([]);
    // the real identity is signalled exactly once, group-wide only while it still is that leader
    expect(T.killGroup(leader)).toBe(true);
    expect(sent).toEqual([[-leader.pid, "SIGKILL"]]);
  });
});
