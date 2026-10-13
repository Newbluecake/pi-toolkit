/**
 * web-hub-privacy plan v2.1 (P1 测试锚点): the hub-side privacy store
 * (`hub/privacy/store.ts`) — atomic write (0600, tmp+rename), write-through semantics (disk
 * first, memory second, failure rejects and leaves memory untouched), E_LIMIT at 4096
 * (拒绝而非淘汰), corrupt/unreadable file ⇒ renamed to .bak + empty start + degraded flag +
 * WARN log, and no-op writes never touching the disk.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPrivacyStore,
  PRIVACY_FILE_NAME,
  PRIVACY_MAX_ENTRIES,
  PrivacyStoreError,
  type PrivacyFs,
  type PrivacyStore,
} from "../../../../src/web-hub/hub/privacy/store.js";
import { captureLog, type LogLine } from "../../http/helpers.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pwh-privacy-store-"));
  tmps.push(d);
  return d;
}

function fileOf(dir: string): string {
  return join(dir, PRIVACY_FILE_NAME);
}

async function loaded(
  dir: string,
  opts: { fs?: PrivacyFs; onChange?: (l: readonly string[]) => void } = {},
): Promise<{
  store: PrivacyStore;
  log: { lines: LogLine[] };
}> {
  const log = captureLog();
  const store = createPrivacyStore({
    stateDir: dir,
    log,
    ...(opts.fs === undefined ? {} : { fs: opts.fs }),
    ...(opts.onChange === undefined ? {} : { onChange: opts.onChange }),
  });
  await store.load();
  return { store, log };
}

describe("hub/privacy/store — load", () => {
  it("missing file ⇒ empty set, not degraded, no file created (normal first run)", async () => {
    const dir = tmp();
    const { store } = await loaded(dir);
    expect(store.locked()).toEqual([]);
    expect(store.degraded).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("round-trip: marks persist across store instances (hub restart keeps the locks)", async () => {
    const dir = tmp();
    const a = (await loaded(dir)).store;
    await a.setLocked("sess-a", true);
    await a.setLocked("sess-b", true);
    await a.setLocked("sess-a", false);
    const b = (await loaded(dir)).store;
    expect(b.locked()).toEqual(["sess-b"]);
    expect(b.degraded).toBe(false);
  });

  it("corrupt JSON ⇒ renamed to .bak, empty set, degraded, WARN logged (never throws)", async () => {
    const dir = tmp();
    writeFileSync(fileOf(dir), "{ not json", { mode: 0o600 });
    const { store, log } = await loaded(dir);
    expect(store.locked()).toEqual([]);
    expect(store.degraded).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([`${PRIVACY_FILE_NAME}.bak`]);
    expect(readFileSync(join(dir, `${PRIVACY_FILE_NAME}.bak`), "utf8")).toBe("{ not json");
    expect(log.lines.some((l) => l.level === "warn" && l.msg.includes("corrupt"))).toBe(true);
  });

  it("bad shape (version ≠ 1 / non-true entry) ⇒ same .bak + empty + degraded path", async () => {
    const dir = tmp();
    writeFileSync(fileOf(dir), JSON.stringify({ version: 2, locked: {} }), { mode: 0o600 });
    const { store } = await loaded(dir);
    expect(store.degraded).toBe(true);
    expect(store.locked()).toEqual([]);
    expect(readdirSync(dir)).toEqual([`${PRIVACY_FILE_NAME}.bak`]);
  });

  it("unreadable file (readFile rejects, not ENOENT) ⇒ empty set + degraded + WARN", async () => {
    const dir = tmp();
    writeFileSync(fileOf(dir), JSON.stringify({ version: 1, locked: { "sess-a": true } }));
    const fs: PrivacyFs = {
      readFile: async () => {
        throw Object.assign(new Error("nope"), { code: "EACCES" });
      },
      writeFileAtomic: async () => {},
      rename: async () => {},
    };
    const { store, log } = await loaded(dir, { fs });
    expect(store.locked()).toEqual([]);
    expect(store.degraded).toBe(true);
    expect(log.lines.some((l) => l.level === "warn" && l.msg.includes("unreadable"))).toBe(true);
  });
});

describe("hub/privacy/store — mutations (write-through: disk first, memory second)", () => {
  it("lock writes the file atomically (0600) BEFORE memory changes; onChange sees the new set", async () => {
    const dir = tmp();
    const seen: string[][] = [];
    const { store } = await loaded(dir, { onChange: (l) => seen.push([...l]) });
    await store.setLocked("sess-1", true);
    expect(store.isLocked("sess-1")).toBe(true);
    expect(seen).toEqual([["sess-1"]]);
    const st = statSync(fileOf(dir));
    expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(fileOf(dir), "utf8"))).toEqual({ version: 1, locked: { "sess-1": true } });
    // no tmp litter
    expect(readdirSync(dir)).toEqual([PRIVACY_FILE_NAME]);
  });

  it("unlock rewrites and drops the entry; a no-op mutation never touches the disk", async () => {
    const dir = tmp();
    const writes: string[] = [];
    const real = await import("node:fs/promises");
    const fs: PrivacyFs = {
      readFile: (p) => real.readFile(p),
      writeFileAtomic: async (p, bytes) => {
        writes.push(new TextDecoder().decode(bytes));
        const handle = await real.open(p, "w", 0o600);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
      },
      rename: (a, b) => real.rename(a, b),
    };
    const { store } = await loaded(dir, { fs });
    await store.setLocked("sess-1", true);
    await store.setLocked("sess-1", true); // no-op
    await store.setLocked("sess-2", false); // no-op (not present)
    expect(writes).toHaveLength(1);
    await store.setLocked("sess-1", false);
    expect(writes).toHaveLength(2);
    expect(store.locked()).toEqual([]);
    expect(JSON.parse(readFileSync(fileOf(dir), "utf8"))).toEqual({ version: 1, locked: {} });
  });

  it("write failure rejects the whole operation and leaves memory AND disk untouched", async () => {
    const dir = tmp();
    const { store } = await loaded(dir);
    await store.setLocked("sess-good", true);
    const fs: PrivacyFs = {
      readFile: (p) => import("node:fs/promises").then((m) => m.readFile(p)),
      writeFileAtomic: async () => {
        throw new Error("disk full");
      },
      rename: (a, b) => import("node:fs/promises").then((m) => m.rename(a, b)),
    };
    // swap the fs seam via a fresh store over the same file (load sees the good write)
    const { store: failing } = await loaded(dir, { fs });
    expect(failing.locked()).toEqual(["sess-good"]);
    await expect(failing.setLocked("sess-bad", true)).rejects.toBeInstanceOf(PrivacyStoreError);
    expect(failing.locked()).toEqual(["sess-good"]); // memory unchanged
    expect(JSON.parse(readFileSync(fileOf(dir), "utf8"))).toEqual({ version: 1, locked: { "sess-good": true } });
  });

  it("E_LIMIT: a NEW sessionId beyond 4096 rejects with 409 E_LIMIT; removals still work", async () => {
    const dir = tmp();
    const locked: Record<string, true> = {};
    for (let i = 0; i < PRIVACY_MAX_ENTRIES; i++) locked[`sess-${i}`] = true;
    writeFileSync(fileOf(dir), JSON.stringify({ version: 1, locked }), { mode: 0o600 });
    const { store } = await loaded(dir);
    expect(store.locked()).toHaveLength(PRIVACY_MAX_ENTRIES);
    const err = await store.setLocked("sess-overflow", true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrivacyStoreError);
    expect((err as PrivacyStoreError).status).toBe(409);
    expect((err as PrivacyStoreError).code).toBe("E_LIMIT");
    expect(store.isLocked("sess-overflow")).toBe(false);
    // re-marking an EXISTING id is a no-op, not a limit hit
    await store.setLocked("sess-0", true);
    // and removal is never limited
    await store.setLocked("sess-0", false);
    expect(store.isLocked("sess-0")).toBe(false);
  });

  it("concurrent mutations serialize (last write wins, no interleaved file states)", async () => {
    const dir = tmp();
    const { store } = await loaded(dir);
    await Promise.all([
      store.setLocked("a", true),
      store.setLocked("b", true),
      store.setLocked("a", false),
      store.setLocked("c", true),
    ]);
    expect(store.locked()).toEqual(["b", "c"]);
    const b = (await loaded(dir)).store;
    expect(b.locked()).toEqual(["b", "c"]);
  });

  it("close() drains the pending write chain", async () => {
    const dir = tmp();
    const { store } = await loaded(dir);
    const p = store.setLocked("a", true);
    await store.close();
    await p;
    expect(JSON.parse(readFileSync(fileOf(dir), "utf8"))).toEqual({ version: 1, locked: { a: true } });
  });
});
