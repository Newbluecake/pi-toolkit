/**
 * LP migration tests (plan §1.3.5): `XDG_SOCKET_DIR_POLICY` / `TMP_SOCKET_DIR_POLICY`
 * enforcement in `ensurePrivateDir`, and `verifyBoundSocket`'s hygiene checks on a
 * bound socket + its containing directory. `tests/web-hub/protocol/paths.test.ts`
 * (W1) keeps covering `STATE_DIR_POLICY` and the pure `resolveHubPaths` policy
 * selection — this file only exercises the enforcement LP fills in.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod as realChmod, lstat as realLstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import {
  TMP_SOCKET_DIR_POLICY,
  XDG_SOCKET_DIR_POLICY,
  ensurePrivateDir,
  identityEquals,
  verifyBoundSocket,
} from "../../../src/web-hub/protocol/paths.js";

const isRoot = process.getuid?.() === 0;
const realUid = process.getuid?.() ?? 0;

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "webhub-priv-")));
}

/** A sticky-bit parent dir (mimics `/tmp`) that `TMP_SOCKET_DIR_POLICY` requires. */
function stickyParent(): string {
  const p = tmp();
  chmodSync(p, 0o1777);
  return p;
}

describe("ensurePrivateDir: XDG_SOCKET_DIR_POLICY (check-only, never create/repair)", () => {
  it("accepts a pre-existing 0700 dir owned by us", async () => {
    const dir = join(tmp(), "run");
    mkdirSync(dir, { mode: 0o700 });
    const id = await ensurePrivateDir(dir, XDG_SOCKET_DIR_POLICY);
    expect(id.dev).toBeTypeOf("number");
    expect(id.ino).toBeGreaterThan(0);
  });

  it("accepts a dir whose owner bits are wider than 0700 as long as group/other are empty", async () => {
    const dir = join(tmp(), "run2");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700); // owner rwx only — sanity: 0o700 & 0o077 === 0
    await expect(ensurePrivateDir(dir, XDG_SOCKET_DIR_POLICY)).resolves.toBeDefined();
  });

  it("never creates the directory (create:false): a missing dir is PrivateDirError('io'), not auto-mkdir'd", async () => {
    const dir = join(tmp(), "missing");
    await expect(ensurePrivateDir(dir, XDG_SOCKET_DIR_POLICY)).rejects.toMatchObject({ reason: "io" });
  });

  it("rejects a symlinked dir even if the target is owned by us and private (allowOwnedSymlink:false)", async () => {
    const target = join(tmp(), "real");
    mkdirSync(target, { mode: 0o700 });
    const link = join(tmp(), "link");
    symlinkSync(target, link);
    await expect(ensurePrivateDir(link, XDG_SOCKET_DIR_POLICY)).rejects.toMatchObject({ reason: "symlink" });
  });

  it("rejects a wider mode without repairing it (repairMode:false)", async () => {
    const dir = join(tmp(), "wide");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await expect(ensurePrivateDir(dir, XDG_SOCKET_DIR_POLICY)).rejects.toMatchObject({ reason: "mode" });
    expect((await import("node:fs")).statSync(dir).mode & 0o777).toBe(0o755); // untouched
  });

  it("injected getuid mismatch ⇒ owner-mismatch without touching chmod (no root needed)", async () => {
    const dir = join(tmp(), "owner");
    mkdirSync(dir, { mode: 0o700 });
    let chmodCalls = 0;
    const chmod: typeof realChmod = async (...args) => {
      chmodCalls++;
      return realChmod(...(args as Parameters<typeof realChmod>));
    };
    await expect(
      ensurePrivateDir(dir, XDG_SOCKET_DIR_POLICY, { getuid: () => realUid + 1, chmod }),
    ).rejects.toMatchObject({ reason: "owner-mismatch" });
    expect(chmodCalls).toBe(0);
  });

  it.skipIf(!isRoot)("real owner mismatch (root only) ⇒ owner-mismatch", async () => {
    const dir = join(tmp(), "owner-real");
    mkdirSync(dir, { mode: 0o700 });
    chownSync(dir, 1, 1);
    try {
      await expect(ensurePrivateDir(dir, XDG_SOCKET_DIR_POLICY)).rejects.toMatchObject({ reason: "owner-mismatch" });
    } finally {
      chownSync(dir, realUid, process.getgid?.() ?? 0);
    }
  });
});

describe("ensurePrivateDir: TMP_SOCKET_DIR_POLICY (/tmp fallback: create/repair under a sticky parent)", () => {
  it("creates a fresh 0700 dir under a sticky parent", async () => {
    const parent = stickyParent();
    const dir = join(parent, "pi-webhub-1234");
    const id = await ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY);
    expect((await import("node:fs")).statSync(dir).mode & 0o777).toBe(0o700);
    expect(id.ino).toBeGreaterThan(0);
  });

  it("repairs a wider mode in place (repairMode:true)", async () => {
    const parent = stickyParent();
    const dir = join(parent, "pi-webhub-1234");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY);
    expect((await import("node:fs")).statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("repairing a wider mode also fires the onWarn channel (review fix, §1.3.1 'chmod 0700 + warn')", async () => {
    const parent = stickyParent();
    const dir = join(parent, "pi-webhub-1234");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const warnings: Array<{ dir: string; detail: string }> = [];
    await ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY, {
      onWarn: (d, detail) => warnings.push({ dir: d, detail }),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.dir).toBe(dir);
    expect(warnings[0]!.detail).toContain("755");
    expect(warnings[0]!.detail).toContain("0700");
  });

  it("a dir already at 0700 is a no-op and never fires onWarn", async () => {
    const parent = stickyParent();
    const dir = join(parent, "pi-webhub-1234");
    await ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY); // creates fresh at 0700
    let warned = false;
    await ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY, { onWarn: () => (warned = true) });
    expect(warned).toBe(false);
  });

  it("onWarn is optional — omitting it repairs silently (byte-identical to pre-fix behavior)", async () => {
    const parent = stickyParent();
    const dir = join(parent, "pi-webhub-1234");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await expect(ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY)).resolves.toBeDefined();
    expect((await import("node:fs")).statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("is idempotent", async () => {
    const parent = stickyParent();
    const dir = join(parent, "pi-webhub-1234");
    await ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY);
    await ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY);
    expect((await import("node:fs")).statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rejects a parent without the sticky bit", async () => {
    const parent = tmp(); // 0700, not sticky
    const dir = join(parent, "pi-webhub-1234");
    await expect(ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY)).rejects.toMatchObject({ reason: "parent-not-sticky" });
  });

  it("rejects a symlinked entry (allowOwnedSymlink:false), even under a sticky parent", async () => {
    const parent = stickyParent();
    const target = join(parent, "real");
    mkdirSync(target, { mode: 0o700 });
    const link = join(parent, "pi-webhub-1234");
    symlinkSync(target, link);
    await expect(ensurePrivateDir(link, TMP_SOCKET_DIR_POLICY)).rejects.toMatchObject({ reason: "symlink" });
  });

  it("injected getuid mismatch on an already-created entry ⇒ owner-mismatch without chmod", async () => {
    const parent = stickyParent();
    const dir = join(parent, "pi-webhub-1234");
    mkdirSync(dir, { mode: 0o700 });
    let chmodCalls = 0;
    const chmod: typeof realChmod = async (...args) => {
      chmodCalls++;
      return realChmod(...(args as Parameters<typeof realChmod>));
    };
    await expect(
      ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY, { getuid: () => realUid + 1, chmod }),
    ).rejects.toMatchObject({ reason: "owner-mismatch" });
    expect(chmodCalls).toBe(0);
  });

  it("EEXIST race on mkdir re-lstats once instead of failing", async () => {
    const parent = stickyParent();
    const dir = join(parent, "pi-webhub-1234");
    let calls = 0;
    const mkdir = async () => {
      calls++;
      mkdirSync(dir, { mode: 0o700 }); // simulate a concurrent winner
      const err: NodeJS.ErrnoException = new Error("EEXIST");
      err.code = "EEXIST";
      throw err;
    };
    const id = await ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY, { mkdir });
    expect(calls).toBe(1);
    expect(id.ino).toBeGreaterThan(0);
  });
});

describe("verifyBoundSocket", () => {
  function listen(sockPath: string): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(sockPath, () => resolve(server));
    });
  }

  it("accepts a real bound socket in a private dir and returns its identity", async () => {
    const dir = tmp();
    chmodSync(dir, 0o700);
    const sockPath = join(dir, "hub.sock");
    const server = await listen(sockPath);
    try {
      const dirBefore = await realLstat(dir);
      const id = await verifyBoundSocket(sockPath, { dev: dirBefore.dev, ino: dirBefore.ino });
      expect(id.socket.ino).toBeGreaterThan(0);
      expect(id.dir).toEqual({ dev: dirBefore.dev, ino: dirBefore.ino });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("rejects when the socket path is a symlink", async () => {
    const dir = tmp();
    const target = join(dir, "target");
    writeFileSync(target, "x");
    const link = join(dir, "hub.sock");
    symlinkSync(target, link);
    await expect(verifyBoundSocket(link, { dev: 0, ino: 0 })).rejects.toMatchObject({ reason: "symlink" });
  });

  it("rejects when the path is not a socket at all", async () => {
    const dir = tmp();
    const p = join(dir, "hub.sock");
    writeFileSync(p, "not a socket");
    await expect(verifyBoundSocket(p, { dev: 0, ino: 0 })).rejects.toMatchObject({ reason: "not-directory" });
  });

  it("propagates ENOENT as-is when the socket is missing (no PrivateDirError wrapper)", async () => {
    const dir = tmp();
    const p = join(dir, "hub.sock");
    await expect(verifyBoundSocket(p, { dev: 0, ino: 0 })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects when the socket is owned by a different uid (injected getuid)", async () => {
    const dir = tmp();
    const sockPath = join(dir, "hub.sock");
    const server = await listen(sockPath);
    try {
      await expect(
        verifyBoundSocket(sockPath, { dev: 0, ino: 0 }, { getuid: () => realUid + 1 }),
      ).rejects.toMatchObject({
        reason: "owner-mismatch",
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("rejects when the containing directory is a symlink", async () => {
    const base = tmp();
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const sockPath = join(real, "hub.sock");
    const server = await listen(sockPath);
    const linkedDir = join(base, "linked");
    try {
      symlinkSync(real, linkedDir);
      await expect(verifyBoundSocket(join(linkedDir, "hub.sock"), { dev: 0, ino: 0 })).rejects.toMatchObject({
        reason: "symlink",
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does NOT throw for a bare dirBefore identity mismatch — it returns the freshly observed identity", async () => {
    // This is the load-bearing design decision documented in the file header: a directory
    // swapped for another one that still passes every hygiene check is not itself a thrown
    // failure — it is the caller's job (bind-site TOCTOU check, or the fence's own comparison
    // against `identity.dir`) to notice the returned `.dir` differs from what it expected.
    const dir = tmp();
    chmodSync(dir, 0o700);
    const sockPath = join(dir, "hub.sock");
    const server = await listen(sockPath);
    try {
      const bogusDirBefore = { dev: 0, ino: 999_999_999 }; // deliberately wrong
      const id = await verifyBoundSocket(sockPath, bogusDirBefore);
      expect(id.dir).not.toEqual(bogusDirBefore);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("identityEquals (review fix, §1.3.5 contract)", () => {
  it("true iff both dev and ino match", () => {
    expect(identityEquals({ dev: 1, ino: 2 }, { dev: 1, ino: 2 })).toBe(true);
    expect(identityEquals({ dev: 1, ino: 2 }, { dev: 1, ino: 3 })).toBe(false);
    expect(identityEquals({ dev: 1, ino: 2 }, { dev: 9, ino: 2 })).toBe(false);
  });
});

describe("verifyBoundSocket call-site contract: every production caller must diff via identityEquals", () => {
  // Review fix (§1.3.5): `verifyBoundSocket` deliberately never compares its own return value
  // against a caller-supplied reference (see that function's "Contract" doc). This is a source
  // scan over every production `.ts` file (excluding this module's own definition and any
  // *.test.ts) enumerating every call site of `verifyBoundSocket(` and asserting the same file
  // also imports and uses the shared `identityEquals` comparison helper — so a future call site
  // added without wiring the comparison in fails this test instead of silently shipping a
  // TOCTOU/fence hole.
  it("every file that calls verifyBoundSocket( also imports and uses identityEquals(", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const srcRoot = joinPath(import.meta.dirname, "..", "..", "..", "src", "web-hub");

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const p = joinPath(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p);
      }
      return out;
    }

    const files = walk(srcRoot);
    const callers: string[] = [];
    for (const file of files) {
      if (file.endsWith(joinPath("protocol", "paths.ts"))) continue; // the definition itself
      const text = readFileSync(file, "utf8");
      // Match real calls, not the doc-comment mentions of the name (those don't have a `(`
      // immediately after in call position within this codebase's prose style) — look for the
      // literal call syntax `verifyBoundSocket(`.
      if (/\bverifyBoundSocket\(/.test(text)) {
        callers.push(file);
        expect(text, `${file} calls verifyBoundSocket( but never imports identityEquals`).toMatch(/\bidentityEquals\b/);
      }
    }
    // Sanity: this scan must actually have found the known production call site(s) — an empty
    // result would make the assertions above vacuously true.
    expect(callers.some((f) => f.endsWith(joinPath("hub", "singleton.ts")))).toBe(true);
  });
});
