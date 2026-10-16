// web-resume plan §4 "Open discipline (P1)": a regular file swapped for a FIFO with no writer
// before the open is rejected and the call RETURNS (every test carries a hard 2 s timeout — a
// hang fails it); a symlinked char device is rejected by O_NOFOLLOW, a hard path to a device
// node by the regular-file check; the fd count is back to baseline after every failure path.

import { closeSync, constants, readdirSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  openSessionNoFollow,
  openSessionNoFollowAsync,
  SESSION_READ_FLAGS,
} from "../../src/session-nav/session-head.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "session-nav-open-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fdCount(): number {
  return readdirSync("/proc/self/fd").length;
}

describe("open discipline — flags", () => {
  test("SESSION_READ_FLAGS is O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY", () => {
    expect(SESSION_READ_FLAGS).toBe(
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0),
    );
  });
});

describe("open discipline — rejection paths (2 s hard timeout each)", () => {
  test("a FIFO with no writer is rejected and the call returns", { timeout: 2_000 }, async () => {
    const fifo = join(root, "swapped.jsonl");
    execSync(`mkfifo '${fifo}'`);
    expect(openSessionNoFollow(fifo)).toBeUndefined();
    await expect(openSessionNoFollowAsync(fifo)).resolves.toBeUndefined();
  });

  test("a symlink to a char device is rejected by O_NOFOLLOW", { timeout: 2_000 }, async () => {
    const link = join(root, "link.jsonl");
    await symlink("/dev/null", link, "file");
    expect(openSessionNoFollow(link)).toBeUndefined();
    await expect(openSessionNoFollowAsync(link)).resolves.toBeUndefined();
  });

  test("a hard path to a device node is rejected by the regular-file check", { timeout: 2_000 }, async () => {
    expect(openSessionNoFollow("/dev/null")).toBeUndefined();
    await expect(openSessionNoFollowAsync("/dev/null")).resolves.toBeUndefined();
  });

  test("a missing file is rejected without throwing", { timeout: 2_000 }, async () => {
    expect(openSessionNoFollow(join(root, "gone.jsonl"))).toBeUndefined();
    await expect(openSessionNoFollowAsync(join(root, "gone.jsonl"))).resolves.toBeUndefined();
  });

  test("a directory is rejected (non-regular)", { timeout: 2_000 }, async () => {
    expect(openSessionNoFollow(root)).toBeUndefined();
    await expect(openSessionNoFollowAsync(root)).resolves.toBeUndefined();
  });

  test("the fd count never grows across every failure path", { timeout: 2_000 }, async () => {
    const fifo = join(root, "f.jsonl");
    execSync(`mkfifo '${fifo}'`);
    const link = join(root, "l.jsonl");
    await symlink("/dev/null", link, "file");
    const good = join(root, "good.jsonl");
    await writeFile(good, "x");

    const before = fdCount();
    expect(openSessionNoFollow(fifo)).toBeUndefined();
    expect(openSessionNoFollow(link)).toBeUndefined();
    expect(openSessionNoFollow("/dev/null")).toBeUndefined();
    expect(openSessionNoFollow(join(root, "gone.jsonl"))).toBeUndefined();
    expect(openSessionNoFollow(root)).toBeUndefined();
    expect(await openSessionNoFollowAsync(fifo)).toBeUndefined();
    expect(await openSessionNoFollowAsync(link)).toBeUndefined();
    expect(await openSessionNoFollowAsync("/dev/null")).toBeUndefined();

    // A successful open hands the fd to the caller (closed here) and also leaks nothing. A short
    // settle first: fs/promises closes are microtask-async, so the sync baseline may transiently
    // be one higher — the invariant under test is NO GROWTH.
    const opened = openSessionNoFollow(good);
    expect(opened).toBeDefined();
    expect(opened!.fact.size).toBe(1);
    closeSync(opened!.fd);
    await new Promise((r) => setTimeout(r, 10));
    expect(fdCount()).toBeLessThanOrEqual(before);
  });

  test("a regular session file opens with identity facts", { timeout: 2_000 }, async () => {
    const path = join(root, "s.jsonl");
    await writeFile(path, "hello");
    const opened = await openSessionNoFollowAsync(path);
    expect(opened).toBeDefined();
    expect(opened!.fact.path).toBe(path);
    expect(opened!.fact.size).toBe(5);
    expect(opened!.fact.dev).toBeGreaterThan(0);
    await opened!.handle.close();
  });
});
