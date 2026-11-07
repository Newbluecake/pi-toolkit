/**
 * #28 — `pi-secure unlock/lock` when an ancestor of <dir> is a symlink (~/.local/share → /data/share),
 * against REAL gocryptfs (docs/dev/secure-symlink/plan.md §3.2).
 *
 * Plain-mode only: the gate is PLAIN_SKIP (linux + gocryptfs/fusermount3/flock/script + /dev/fuse), NOT
 * realSkipReason() (which also demands unprivileged userns). Regression for: gocryptfs was handed the
 * lexical cipher path, wrote it as the mountinfo source, and the physical-path verdict read the own
 * mount as foreign ⇒ rollback refused, lease wedged. Counter-case pins that the verdict stayed strict.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";
import {
  HELPER,
  PW,
  RealHarness,
  awaitNoForeignGocryptfs,
  leaseFree,
  plain,
  until,
  which,
  type Env,
} from "./private-real-harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(pathToFileURL(HELPER).href);

const PLAIN_SKIP =
  process.platform !== "linux"
    ? "not linux"
    : ["gocryptfs", "fusermount3", "flock", "script"].some((b) => !which(b))
      ? "missing gocryptfs/fusermount3/flock/script"
      : spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status !== 0
        ? "/dev/fuse unusable"
        : "";

const T = new RealHarness();

/** Exact mountinfo rows (parsed, octal-decoded) whose mount point is `mnt`. */
const rowsAt = (mnt: string) =>
  H.parseMountinfo(readFileSync("/proc/self/mountinfo", "utf8")).filter(
    (r: { mountPoint: string }) => r.mountPoint === mnt,
  );

describe.skipIf(PLAIN_SKIP !== "")(
  `#28 symlinked <dir> ancestor, real gocryptfs${PLAIN_SKIP ? ` (skipped: ${PLAIN_SKIP})` : ""}`,
  () => {
    let release: (() => void) | undefined;
    beforeAll(async () => {
      release = await acquireGocryptfsTestLock();
    }, 250_000);
    afterAll(() => release?.());
    afterEach(() => T.cleanup());

    async function symlinked(ctx: { skip: () => void }): Promise<Env> {
      const e = T.setup([], { root: realpathSync(tmpdir()), prefix: "ps-sym28-" });
      expect(realpathSync(e.r)).toBe(e.r);
      const share = join(e.h, ".local", "share");
      const target = join(e.r, "data-share");
      renameSync(share, target);
      symlinkSync(target, share);
      expect(realpathSync(e.dir)).not.toBe(e.dir);
      await awaitNoForeignGocryptfs(ctx, e.r);
      return e;
    }

    it("positive: unlock → mounted → lock twice; source is the physical cipher; lease released", async (ctx) => {
      const e = await symlinked(ctx);
      const physical = join(realpathSync(e.dir), "cipher");
      for (let round = 1; round <= 2; round++) {
        const u = await T.tty(e, "unlock acme");
        expect(u.code, `round ${round}: ${u.text}`).toBe(0);
        expect(u.text).toContain("已解锁");
        expect(u.text).not.toMatch(/foreign|未能撤销/);
        const rows = rowsAt(e.mnt);
        const last = rows[rows.length - 1];
        expect(last?.fsType).toBe("fuse.gocryptfs");
        expect(last?.source).toBe(physical);
        expect(last?.source).not.toBe(join(e.dir, "cipher"));
        const st = plain(e, "status acme");
        expect(st.text).toMatch(/mounted/);
        const l = plain(e, "lock acme");
        expect(l.code, l.text).toBe(0);
        expect(rowsAt(e.mnt)).toHaveLength(0);
        await until(() => leaseFree(e), 5_000, "lease released");
      }
    }, 120_000);

    it("negative: a FOREIGN gocryptfs mount at <mnt> stays foreign — status says so, lock refuses to touch it", async (ctx) => {
      const e = await symlinked(ctx);
      const other = join(e.r, "other-cipher");
      const mk = spawnSync("mkdir", ["-m", "700", other]);
      expect(mk.status).toBe(0);
      const init = spawnSync("gocryptfs", ["-init", "-q", "-scryptn", "10", "-passfile", join(e.r, "pf"), "--", other]);
      expect(init.status, String(init.stderr)).toBe(0);
      const mount = spawnSync("gocryptfs", ["-q", "-nonempty", "-passfile", join(e.r, "pf"), "--", other, e.mnt], {
        encoding: "utf8",
      });
      expect(mount.status, mount.stderr).toBe(0);
      try {
        const rows = rowsAt(e.mnt);
        expect(rows[rows.length - 1]?.source).toBe(other);
        const st = plain(e, "status acme");
        expect(st.text).toMatch(/foreign/);
        const l = plain(e, "lock acme");
        expect(l.code, l.text).toBe(1);
        expect(l.text).toContain("不动它");
        expect(rowsAt(e.mnt).length).toBeGreaterThan(0);
      } finally {
        spawnSync("fusermount3", ["-u", e.mnt]);
      }
      expect(rowsAt(e.mnt)).toHaveLength(0);
      void PW;
    }, 120_000);
  },
);
