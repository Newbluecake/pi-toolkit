/** Actual owned flock helpers, gracefully released by stdin EOF; no signals. */
import { expect, it } from "vitest";
import { HeldDirectory } from "../../scripts/web-hub/terminal-v2-maintenance/files.js";
import { acquireRetainedLock } from "../../scripts/web-hub/terminal-v2-retained/lock.js";
import { setup } from "../terminal-v2-maintenance/helpers.js";
it("independent handles contend on the original kernel lock, then reacquire after normal close", async () => {
  const h = setup(),
    a = new HeldDirectory(h.evidenceDir),
    b = new HeldDirectory(h.evidenceDir);
  const first = await acquireRetainedLock(a, Date.now() + 5000);
  try {
    first.guard();
    await expect(acquireRetainedLock(b, Date.now() + 5000)).rejects.toThrow("E_RETAINED_LOCK_BUSY");
    first.guard();
  } finally {
    await first.release();
  }
  expect(() => first.guard()).toThrow("E_RETAINED_LOCK_LOST");
  const second = await acquireRetainedLock(b, Date.now() + 5000);
  try {
    second.guard();
    expect(b.read("maintenance.lock").bytes.toString()).toBe("pi-subagent:terminal-retained-lock:1\n");
  } finally {
    await second.release();
    await second.release();
    b.close();
    a.close();
  }
});
it("distinct installation inodes do not share a cwd-relative/global lock file", async () => {
  const h = setup(),
    a = new HeldDirectory(h.evidenceDir),
    b = new HeldDirectory(h.stateDir);
  const first = await acquireRetainedLock(a, Date.now() + 5000);
  try {
    const second = await acquireRetainedLock(b, Date.now() + 5000);
    try {
      first.guard();
      second.guard();
      expect(a.read("maintenance.lock").fingerprint.ino).not.toBe(b.read("maintenance.lock").fingerprint.ino);
    } finally {
      await second.release();
    }
  } finally {
    await first.release();
    b.close();
    a.close();
  }
});
it("invalid deadline refuses before creating lock files", async () => {
  const h = setup(),
    dir = new HeldDirectory(h.evidenceDir);
  try {
    await expect(acquireRetainedLock(dir, Date.now() - 1)).rejects.toThrow("E_RETAINED_LOCK_DEADLINE");
    expect(dir.names()).toEqual([]);
  } finally {
    dir.close();
  }
});
