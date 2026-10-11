import { describe, expect, it } from "vitest";
import { createAvatarFs } from "../../../../src/web-hub/hub/avatar/fs.js";

describe("avatar fs kernel", () => {
  it("closes an open handle that resolves after its deadline", async () => {
    let closeCount = 0;
    let resolveOpen: ((value: { close(): Promise<void> }) => void) | undefined;
    const pending = new Promise<{ close(): Promise<void> }>((resolve) => {
      resolveOpen = resolve;
    });
    const fs = createAvatarFs({
      stateDir: "/state",
      now: () => 0,
      open: (() => pending) as never,
    });
    const p = fs.openRead("/state/avatar/avatar.png", 5);
    await expect(p).rejects.toMatchObject({ ioFail: "deadline" });
    resolveOpen?.({
      close: async () => {
        closeCount += 1;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closeCount).toBe(1);
  });

  it("fsyncs the avatar directory with O_DIRECTORY and closes the fd", async () => {
    let flags = 0;
    let synced = 0;
    let closed = 0;
    const fs = createAvatarFs({
      stateDir: "/state",
      open: ((path: string, openFlags: number) => {
        expect(path).toBe("/state/avatar");
        flags = openFlags;
        return Promise.resolve({
          sync: async () => {
            synced += 1;
          },
          close: async () => {
            closed += 1;
          },
        });
      }) as never,
    });
    await fs.fsyncDir(Date.now() + 100);
    expect(flags).toBeGreaterThan(0);
    expect(synced).toBe(1);
    expect(closed).toBe(1);
  });

  it("surfaces fsync failure for the background caller to swallow", async () => {
    const fs = createAvatarFs({
      stateDir: "/state",
      open: (() =>
        Promise.resolve({
          sync: async () => {
            throw new Error("disk");
          },
          close: async () => undefined,
        })) as never,
    });
    await expect(fs.fsyncDir(Date.now() + 100)).rejects.toThrow("disk");
  });

  it("trips the one-zombie breaker before starting another operation", async () => {
    const pending = new Promise<never>(() => undefined);
    const fs = createAvatarFs({ stateDir: "/state", now: () => 0, open: (() => pending) as never });
    await expect(fs.openRead("/state/avatar/avatar.png", 1)).rejects.toMatchObject({ ioFail: "deadline" });
    await expect(fs.openRead("/state/avatar/avatar.png", 1)).rejects.toMatchObject({ ioFail: "busy" });
  });
});
