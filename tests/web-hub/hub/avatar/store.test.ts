import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AVATAR_DELETE_STEP_CAPS,
  AVATAR_PENDING_CEILING_MS,
  AVATAR_PUT_STEP_CAPS,
  AVATAR_STORE_MIN_MS,
  AVATAR_TOTAL_MS,
} from "../../../../src/web-hub/protocol/avatar.js";
import { createPreviewIoTracker } from "../../../../src/web-hub/hub/preview/fs.js";
import { createAvatarStore, type AvatarStore } from "../../../../src/web-hub/hub/avatar/store.js";
import type { AvatarFs, AvatarHandle } from "../../../../src/web-hub/hub/avatar/fs.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { createHash } from "node:crypto";

function handle(): AvatarHandle {
  return {
    stat: async () => ({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      uid: process.getuid?.() ?? 0,
      mode: 0o600,
      nlink: 1,
      size: 0,
    }),
    read: async () => 0,
    write: async (b) => b.length,
    datasync: async () => undefined,
    close: async () => undefined,
  };
}
interface FakeFsOptions {
  dirResults?: Array<{ dev: number; ino: number }>;
  openTemp?: () => Promise<AvatarHandle>;
  renameTemp?: () => Promise<void>;
  unlinkAvatar?: () => Promise<void>;
  fsyncDir?: () => Promise<void>;
  readHandle?: AvatarHandle;
}
function fakeFs(
  dirResults: Array<{ dev: number; ino: number }>,
  calls: string[],
  options: FakeFsOptions = {},
): AvatarFs {
  let next = 0;
  return {
    tracker: createPreviewIoTracker(1),
    ensureDir: async () => ({ dev: 1, ino: 1 }),
    lstatDir: async () => {
      calls.push("lstat");
      return dirResults[Math.min(next++, dirResults.length - 1)]!;
    },
    openRead: async () => {
      if (options.readHandle !== undefined) return options.readHandle;
      const e = Object.assign(new Error(), { code: "ENOENT" });
      throw e;
    },
    openTemp: async () => {
      calls.push("open");
      const h = options.openTemp === undefined ? handle() : await options.openTemp();
      return {
        ...h,
        write: async (bytes: Uint8Array, position?: number) => {
          calls.push("write");
          return h.write(bytes, position);
        },
        datasync: async () => {
          calls.push("datasync");
          return h.datasync();
        },
      };
    },
    renameTemp: async () => {
      calls.push("rename");
      if (options.renameTemp !== undefined) return options.renameTemp();
    },
    unlinkTemp: async () => {
      calls.push("unlink-temp");
    },
    unlinkAvatar: async () => {
      calls.push("unlink-avatar");
      if (options.unlinkAvatar !== undefined) return options.unlinkAvatar();
    },
    fsyncDir: async () => {
      await options.fsyncDir?.();
    },
  };
}
function readyStore(
  fs: AvatarFs,
  onChange: (change: unknown) => void = () => {},
  now: () => number = Date.now,
  audit: (record: unknown) => void = () => {},
): AvatarStore {
  return createAvatarStore({ stateDir: "/state", fs, onChange, now, audit });
}
function deadlineWithRemaining(values: number[]): Parameters<AvatarStore["put"]>[2] {
  return {
    at: Date.now() + 100_000,
    remaining: () => values.shift() ?? 100_000,
    expired: () => false,
  };
}
function image(): { bytes: Uint8Array; v: string } {
  const bytes = new Uint8Array(
    readFileSync(new URL("../../../fixtures/web-hub-avatar/chrome-canvas.png", import.meta.url)),
  );
  return { bytes, v: createHash("sha256").update(bytes).digest("hex") };
}

describe("avatar store", () => {
  it("does not rename or unlink a tmp when the pre-commit directory identity changes", async () => {
    const calls: string[] = [];
    const s = readyStore(
      fakeFs(
        [
          { dev: 1, ino: 1 },
          { dev: 2, ino: 2 },
        ],
        calls,
      ),
    );
    await s.load();
    calls.length = 0;
    const bytes = new Uint8Array(
      readFileSync(new URL("../../../fixtures/web-hub-avatar/chrome-canvas.png", import.meta.url)),
    );
    const v = createHash("sha256").update(bytes).digest("hex");
    await expect(s.put(bytes, v, createReqDeadline(Date.now, AVATAR_TOTAL_MS))).rejects.toMatchObject({
      code: "E_BUSY",
    });
    expect(calls).toContain("open");
    expect(calls).not.toContain("rename");
    expect(calls).not.toContain("unlink-temp");
  });

  it("rejects a first-step identity mismatch before opening tmp", async () => {
    const calls: string[] = [];
    const s = readyStore(fakeFs([{ dev: 2, ino: 2 }], calls));
    await s.load();
    calls.length = 0;
    const { bytes, v } = image();
    await expect(s.put(bytes, v, createReqDeadline(Date.now, AVATAR_TOTAL_MS))).rejects.toMatchObject({
      code: "E_BUSY",
    });
    expect(calls).toEqual(["lstat"]);
    expect(calls).not.toContain("open");
    expect(calls).not.toContain("unlink-temp");
  });

  it("fences a late load after close: no memory, publish, or audit, only fd reclaim", async () => {
    let resolveRead: (() => void) | undefined;
    let closeCount = 0;
    const lateHandle: AvatarHandle = {
      ...handle(),
      read: async () =>
        new Promise<number>((resolve) => {
          resolveRead = () => resolve(0);
        }),
      close: async () => {
        closeCount += 1;
      },
    };
    const changes: unknown[] = [];
    const audits: unknown[] = [];
    const s = readyStore(
      fakeFs([{ dev: 1, ino: 1 }], [], { readHandle: lateHandle }),
      (change) => changes.push(change),
      Date.now,
      (record) => audits.push(record),
    );
    const loading = s.load();
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolveRead).toBeDefined();
    const close = s.close();
    resolveRead?.();
    await close;
    await loading;
    expect(s.state).toBe("closing");
    expect(s.snapshot().memory).toBeUndefined();
    expect(changes).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(closeCount).toBe(1);
  });

  it("fences a late pending rename after close: no reconcile publish or audit", async () => {
    let resolveRename: (() => void) | undefined;
    const changes: unknown[] = [];
    const audits: unknown[] = [];
    const calls: string[] = [];
    const s = readyStore(
      fakeFs([{ dev: 1, ino: 1 }], calls, {
        renameTemp: () =>
          new Promise<void>((resolve) => {
            resolveRename = resolve;
          }),
      }),
      (change) => changes.push(change),
      Date.now,
      (record) => audits.push(record),
    );
    await s.load();
    changes.length = 0;
    audits.length = 0;
    const { bytes, v } = image();
    const put = s.put(bytes, v, createReqDeadline(Date.now, AVATAR_TOTAL_MS)).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await expect(put).resolves.toMatchObject({ code: "E_DEADLINE", extra: { effect: "unknown" } });
    const close = s.close();
    resolveRename?.();
    await close;
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.snapshot().memory).toBeUndefined();
    expect(changes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("fences close-during-writing before commit and returns unknown, not a false 200", async () => {
    let resolveWrite: (() => void) | undefined;
    const changes: unknown[] = [];
    const audits: unknown[] = [];
    const writingHandle: AvatarHandle = {
      ...handle(),
      write: async () =>
        new Promise<number>((resolve) => {
          resolveWrite = () => resolve(1);
        }),
    };
    const calls: string[] = [];
    const s = readyStore(
      fakeFs([{ dev: 1, ino: 1 }], calls, { openTemp: async () => writingHandle }),
      (change) => changes.push(change),
      Date.now,
      (record) => audits.push(record),
    );
    await s.load();
    changes.length = 0;
    audits.length = 0;
    const { bytes, v } = image();
    const put = s.put(bytes, v, createReqDeadline(Date.now, AVATAR_TOTAL_MS)).catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolveWrite).toBeDefined();
    const close = s.close();
    resolveWrite?.();
    await close;
    await expect(put).resolves.toMatchObject({ code: "E_DEADLINE", extra: { effect: "unknown" } });
    expect(calls).not.toContain("rename");
    expect(s.snapshot().memory).toBeUndefined();
    expect(changes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("keeps a disabled store disabled when a pending commit settles", async () => {
    let resolveRename: (() => void) | undefined;
    let now = 0;
    const calls: string[] = [];
    const audits: unknown[] = [];
    const changes: unknown[] = [];
    const s = readyStore(
      fakeFs(
        [
          { dev: 1, ino: 1 },
          { dev: 1, ino: 1 },
        ],
        calls,
        {
          renameTemp: () =>
            new Promise<void>((resolve) => {
              resolveRename = resolve;
            }),
        },
      ),
      (change) => changes.push(change),
      () => now,
      (record) => audits.push(record),
    );
    await s.load();
    const { bytes, v } = image();
    const put = s
      .put(
        bytes,
        v,
        createReqDeadline(() => now, AVATAR_TOTAL_MS),
      )
      .catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await expect(put).resolves.toMatchObject({ code: "E_DEADLINE", extra: { effect: "unknown" } });
    now = AVATAR_PENDING_CEILING_MS + 1;
    expect(s.snapshot().state).toBe("disabled");
    const beforeChanges = changes.length;
    const beforeAudits = audits.length;
    resolveRename?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.state).toBe("disabled");
    expect(changes.length).toBe(beforeChanges + 1);
    expect(audits.length).toBe(beforeAudits + 1);
  });

  it("enforces every PUT suffix budget before starting that step", async () => {
    const { bytes, v } = image();
    for (let target = 0; target < AVATAR_PUT_STEP_CAPS.length; target += 1) {
      const calls: string[] = [];
      const s = readyStore(
        fakeFs(
          [
            { dev: 1, ino: 1 },
            { dev: 1, ino: 1 },
          ],
          calls,
        ),
      );
      await s.load();
      calls.length = 0;
      const values = [
        ...Array.from({ length: target }, () => 100_000),
        AVATAR_PUT_STEP_CAPS.slice(target).reduce((a, b) => a + b, 0) - 1,
      ];
      await expect(s.put(bytes, v, deadlineWithRemaining(values))).rejects.toMatchObject({
        code: "E_DEADLINE",
        extra: { effect: "none" },
      });
      const expected = ["lstat", "open", "write", "datasync", "lstat", "rename"].slice(0, target);
      expect(calls.filter((call) => call !== "unlink-temp")).toEqual(expected);
    }
  });

  it("enforces every DELETE suffix budget and never unlinks on D1 mismatch", async () => {
    for (let target = 0; target < AVATAR_DELETE_STEP_CAPS.length; target += 1) {
      const calls: string[] = [];
      const s = readyStore(fakeFs([{ dev: 1, ino: 1 }], calls));
      await s.load();
      calls.length = 0;
      const values = [
        ...Array.from({ length: target }, () => 100_000),
        AVATAR_DELETE_STEP_CAPS.slice(target).reduce((a, b) => a + b, 0) - 1,
      ];
      await expect(s.remove(deadlineWithRemaining(values))).rejects.toMatchObject({
        code: "E_DEADLINE",
        extra: { effect: "none" },
      });
      expect(calls).toEqual(target === 0 ? [] : ["lstat"]);
    }
    const mismatchCalls: string[] = [];
    const mismatch = readyStore(fakeFs([{ dev: 2, ino: 2 }], mismatchCalls));
    await mismatch.load();
    mismatchCalls.length = 0;
    await expect(mismatch.remove(createReqDeadline(Date.now, AVATAR_TOTAL_MS))).rejects.toMatchObject({
      code: "E_BUSY",
    });
    expect(mismatchCalls).toEqual(["lstat"]);
  });

  it("maps EEXIST to tmp-exists without retrying or unlinking", async () => {
    const calls: string[] = [];
    const s = readyStore(
      fakeFs([{ dev: 1, ino: 1 }], calls, {
        openTemp: async () => {
          throw Object.assign(new Error(), { code: "EEXIST" });
        },
      }),
    );
    await s.load();
    calls.length = 0;
    const { bytes, v } = image();
    await expect(s.put(bytes, v, createReqDeadline(Date.now, AVATAR_TOTAL_MS))).rejects.toMatchObject({
      code: "E_BUSY",
      extra: { reason: "tmp-exists" },
    });
    expect(calls).toEqual(["lstat", "open"]);
  });

  it("does not change a successful PUT when background directory fsync fails", async () => {
    const calls: string[] = [];
    const changes: unknown[] = [];
    const s = readyStore(
      fakeFs([{ dev: 1, ino: 1 }], calls, {
        fsyncDir: async () => {
          calls.push("fsync");
          throw new Error("disk");
        },
      }),
      (change) => changes.push(change),
    );
    await s.load();
    const { bytes, v } = image();
    await expect(s.put(bytes, v, createReqDeadline(Date.now, AVATAR_TOTAL_MS))).resolves.toMatchObject({
      info: { gen: 2 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toContain("fsync");
    expect(s.gen).toBe(2);
    expect(changes).toHaveLength(2);
  });

  it("supports idempotent DELETE and reconciles a timed-out unlink once", async () => {
    const enoentCalls: string[] = [];
    const enoent = readyStore(
      fakeFs([{ dev: 1, ino: 1 }], enoentCalls, {
        unlinkAvatar: async () => {
          throw Object.assign(new Error(), { code: "ENOENT" });
        },
      }),
    );
    await enoent.load();
    enoentCalls.length = 0;
    await expect(enoent.remove(createReqDeadline(Date.now, AVATAR_TOTAL_MS))).resolves.toMatchObject({
      info: { gen: 2 },
    });
    expect(enoentCalls).toEqual(["lstat", "unlink-avatar"]);

    let resolveUnlink: (() => void) | undefined;
    const calls: string[] = [];
    const audits: unknown[] = [];
    const changes: unknown[] = [];
    const pending = readyStore(
      fakeFs([{ dev: 1, ino: 1 }], calls, {
        unlinkAvatar: () =>
          new Promise<void>((resolve) => {
            resolveUnlink = resolve;
          }),
      }),
      (change) => changes.push(change),
      Date.now,
      (record) => audits.push(record),
    );
    await pending.load();
    const remove = pending.remove(createReqDeadline(Date.now, AVATAR_TOTAL_MS)).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await expect(remove).resolves.toMatchObject({ code: "E_DEADLINE", extra: { effect: "unknown" } });
    const beforeChanges = changes.length;
    resolveUnlink?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(changes.length).toBe(beforeChanges + 1);
    expect(audits.filter((r) => (r as { phase?: string }).phase === "reconcile")).toHaveLength(1);
  });

  it("deduplicates by the complete digest without changing generation", async () => {
    const calls: string[] = [];
    const changes: unknown[] = [];
    const fs = fakeFs(
      [
        { dev: 1, ino: 1 },
        { dev: 1, ino: 1 },
        { dev: 1, ino: 1 },
      ],
      calls,
    );
    const s = readyStore(fs, (change) => changes.push(change));
    await s.load();
    const bytes = new Uint8Array(
      readFileSync(new URL("../../../fixtures/web-hub-avatar/chrome-canvas.png", import.meta.url)),
    );
    const v = createHash("sha256").update(bytes).digest("hex");
    // The fake store has no persisted avatar, so this exercises the API's digest path through a
    // real write; the second call is then a true dedup hit.
    await s.put(bytes, v, createReqDeadline(Date.now, AVATAR_TOTAL_MS));
    const gen = s.gen;
    const result = await s.put(bytes, v, createReqDeadline(Date.now, AVATAR_TOTAL_MS));
    expect(result.dedup).toBe(true);
    expect(s.gen).toBe(gen);
    expect(changes.length).toBe(2);
  });
});
