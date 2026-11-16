import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBashJobManager } from "../../src/bash/host.js";
import type { BashJobManager } from "../../src/bash/manager.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";

const gate = vi.hoisted(() => ({
  mkdir: undefined as (() => Promise<void>) | undefined,
  write: undefined as (() => Promise<void>) | undefined,
  writes: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      await gate.mkdir?.();
      return result;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      gate.writes++;
      await gate.write?.();
      return actual.writeFile(...args);
    },
  };
});

// Keep the manager's own drain immediate: this unit tests the host's bootstrap
// ownership, not job-store serialization. A real pending marker I/O is gated above.
vi.mock("../../src/bash/manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bash/manager.js")>();
  return {
    ...actual,
    createBashJobManager: (...args: Parameters<typeof actual.createBashJobManager>) => ({
      ...actual.createBashJobManager(...args),
      drain: async () => undefined,
    }),
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let root: string | undefined;
let manager: BashJobManager | undefined;
afterEach(async () => {
  gate.mkdir = undefined;
  gate.write = undefined;
  manager?.dispose();
  await manager?.drain();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  gate.writes = 0;
  manager = undefined;
  root = undefined;
});

async function build(): Promise<BashJobManager> {
  root = await mkdtemp(join(tmpdir(), "bash-host-marker-"));
  manager = buildBashJobManager(
    {} as ExtensionAPI,
    { cwd: root, sessionManager: { getSessionId: () => "marker-session" } } as ExtensionContext,
    { ...DEFAULT_SETTINGS, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir: root } },
  );
  return manager;
}

describe("host session marker lifecycle", () => {
  it("dispose during mkdir must not launch a new session-id write", async () => {
    const entered = deferred();
    const release = deferred();
    gate.mkdir = async () => {
      entered.resolve();
      await release.promise;
    };
    const m = await build();
    await entered.promise;
    m.dispose();
    release.resolve();
    await m.drain();
    // Flush the fs worker too, not just microtasks, before checking the writer.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gate.writes, "a disposed host started a new marker write").toBe(0);
  });

  it("drain waits for an in-flight marker write, including after dispose", async () => {
    const entered = deferred();
    const release = deferred();
    gate.write = async () => {
      entered.resolve();
      await release.promise;
    };
    const m = await build();
    await entered.promise;
    m.dispose();
    let drained = false;
    const draining = m.drain().then(() => {
      drained = true;
    });
    try {
      // The inner manager drain is immediate; only the blocked marker can hold it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained, "drain returned while the session-id writer was blocked").toBe(false);
    } finally {
      release.resolve();
      await draining;
    }
    expect(await readFile(join(m.dir, "session-id"), "utf8")).toBe("marker-session\n");
    expect(gate.writes).toBe(1);
  });
});
