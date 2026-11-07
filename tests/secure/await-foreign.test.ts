/**
 * test-speed D14 — `awaitNoForeignGocryptfs` (private-real-harness): a window that ends with foreign
 * fuse.gocryptfs mounts throws (no silent skip), each file waits only once, transient mounts recover,
 * mounts under `mine/` are not foreign. Pure injection + fake clock; nothing is mounted.
 */
import { describe, expect, it } from "vitest";
import { awaitNoForeignGocryptfs } from "./private-real-harness.js";

const line = (mnt: string) => `55 29 0:50 / ${mnt} rw,nosuid - fuse.gocryptfs gocryptfs rw`;

function rig(table: () => string) {
  let t = 0;
  let sleeps = 0;
  return {
    memo: {} as { timedOut?: string },
    readMountinfo: table,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps++;
      t += ms;
    },
    sleeps: () => sleeps,
    clock: () => t,
  };
}

describe("awaitNoForeignGocryptfs (D14)", () => {
  it("persistent foreign mount: waits the window once, throws listing it; the second call throws at once", async () => {
    const r = rig(() => `${line("/mnt/other")}\n`);
    await expect(awaitNoForeignGocryptfs({}, "/scratch", r)).rejects.toThrow(
      /foreign fuse\.gocryptfs[\s\S]*\/mnt\/other/,
    );
    expect(r.clock()).toBeGreaterThanOrEqual(60_000);
    const slept = r.sleeps();
    const at = r.clock();
    await expect(awaitNoForeignGocryptfs({}, "/scratch", r)).rejects.toThrow(/\/mnt\/other/);
    expect(r.sleeps()).toBe(slept); // no second wait
    expect(r.clock()).toBe(at);
  });

  it("transient foreign mount that disappears inside the window: returns, sets no memory", async () => {
    let calls = 0;
    const r = rig(() => (++calls <= 3 ? `${line("/mnt/other")}\n` : "\n"));
    await expect(awaitNoForeignGocryptfs({}, "/scratch", r)).resolves.toBeUndefined();
    expect(r.sleeps()).toBe(3);
    expect(r.memo.timedOut).toBeUndefined();
    await expect(awaitNoForeignGocryptfs({}, "/scratch", r)).resolves.toBeUndefined();
  });

  it("mounts under the `mine` prefix are not foreign; a sibling with the same textual prefix is", async () => {
    const mine = rig(() => `${line("/scratch/a/mnt")}\n`);
    await expect(awaitNoForeignGocryptfs({}, "/scratch", mine)).resolves.toBeUndefined();
    expect(mine.sleeps()).toBe(0);
    const sibling = rig(() => `${line("/scratch2/mnt")}\n`);
    await expect(awaitNoForeignGocryptfs({}, "/scratch", sibling)).rejects.toThrow(/scratch2/);
  });

  it("non-gocryptfs mounts are ignored", async () => {
    const r = rig(() => "1 2 0:3 / /tmp rw - tmpfs tmpfs rw\n");
    await expect(awaitNoForeignGocryptfs({}, "/scratch", r)).resolves.toBeUndefined();
  });
});
