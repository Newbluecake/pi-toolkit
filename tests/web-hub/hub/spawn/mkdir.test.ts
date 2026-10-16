/**
 * spawn-dirmkdir unit tests — `createMkdirService` directly: the post-create MODE step
 * (user ruling 2026-10-16 「可以和终端一样是 775」) plus the fake-fs errno matrix the
 * HTTP-level acceptance (`tests/web-hub/http/api-headless-mkdir.test.ts`, real socket)
 * cannot inject. The service layer is where the ruling lives: mkdir's own mode is masked by
 * the hub daemon's 0o077 umask, so `dirMode` is applied AFTER the create via fd-pinned
 * fchmod — best-effort, never turning a created directory into an error reply.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { createPreviewIoTracker, PreviewIoError } from "../../../../src/web-hub/hub/preview/fs.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { createMkdirService, type MkdirFs, type MkdirServiceDeps } from "../../../../src/web-hub/hub/spawn/mkdir.js";
import { memLog, type MemLog } from "../helpers.js";

let tmpRoot: string | undefined;
let log: MemLog | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pwh-mkdir-unit-"));
  log = memLog();
});

afterEach(() => {
  if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
  log = undefined;
});

function baseDeps(over: Partial<MkdirServiceDeps> = {}): MkdirServiceDeps {
  if (log === undefined || tmpRoot === undefined) throw new Error("fixture missing");
  return {
    denyCtx: denyCtxOf(tmpRoot, join(tmpRoot, ".pi/agent")),
    tracker: createPreviewIoTracker(),
    log,
    now: Date.now,
    ...over,
  };
}

function deadline() {
  return createReqDeadline(Date.now, 10_000);
}

function errnoError(code: string): Error {
  const err = new Error(`fake ${code} (test)`);
  Object.defineProperty(err, "code", { value: code });
  return err;
}

/** A recording fake fs: realpath is identity, mkdir is a no-op record, chmodDir configurable. */
interface RecordedCall {
  kind: "realpath" | "mkdir" | "chmodDir";
  p: string;
  mode?: number;
}

function fakeFs(chmodDirImpl?: (p: string, mode: number) => Promise<void>): {
  fs: Partial<MkdirFs>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fs: {
      realpath: async (p) => {
        calls.push({ kind: "realpath", p });
        return p;
      },
      mkdir: async (p) => {
        calls.push({ kind: "mkdir", p });
      },
      chmodDir: chmodDirImpl
        ? async (p, mode) => {
            calls.push({ kind: "chmodDir", p, mode });
            return chmodDirImpl(p, mode);
          }
        : async (p, mode) => {
            calls.push({ kind: "chmodDir", p, mode });
          },
    },
  };
}

describe("createMkdirService — post-create mode (2026-10-16 ruling)", () => {
  it("real fs + dirMode 0o775: final mode is 0o775 even though the PROCESS umask is 0o077 (mkdir alone would leave 0o700)", async () => {
    if (tmpRoot === undefined || log === undefined) throw new Error("fixture missing");
    const parent = join(tmpRoot, "parent");
    mkdirSync(parent, { recursive: true });
    const prevUmask = process.umask(0o077); // the hub daemon's own umask (main.ts §1.3.1)
    try {
      const svc = createMkdirService(baseDeps({ dirMode: 0o775 }));
      const r = await svc.mkdir(parent, "fresh", deadline());
      expect(r).toEqual({ ok: true, path: join(parent, "fresh") });
      // THE point of the feature: the explicit fd-pinned fchmod overrides the umask-masked mkdir
      expect(statSync(join(parent, "fresh")).mode & 0o777).toBe(0o775);
      expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(0);
    } finally {
      process.umask(prevUmask);
    }
  });

  it("real fs, dirMode undefined: today's behavior exactly — the umask-masked mkdir result (0o700 under umask 0o077)", async () => {
    if (tmpRoot === undefined) throw new Error("fixture missing");
    const parent = join(tmpRoot, "parent2");
    mkdirSync(parent, { recursive: true });
    const prevUmask = process.umask(0o077);
    try {
      const svc = createMkdirService(baseDeps());
      const r = await svc.mkdir(parent, "plain", deadline());
      expect(r.ok).toBe(true);
      expect(statSync(join(parent, "plain")).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(prevUmask);
    }
  });

  it("dirMode undefined ⇒ chmodDir is NEVER called (fake fs: only realpath + mkdir)", async () => {
    const { fs, calls } = fakeFs();
    const svc = createMkdirService(baseDeps({ fs }));
    const r = await svc.mkdir("/srv/data", "no-mode", deadline());
    expect(r).toEqual({ ok: true, path: "/srv/data/no-mode" });
    expect(calls.map((c) => c.kind)).toEqual(["realpath", "mkdir"]);
  });

  it("dirMode set ⇒ chmodDir runs once with the RESOLVED child path and the exact mode", async () => {
    const { fs, calls } = fakeFs();
    const svc = createMkdirService(baseDeps({ fs, dirMode: 0o775 }));
    const r = await svc.mkdir("/srv/data/", "mode-check", deadline());
    expect(r).toEqual({ ok: true, path: "/srv/data/mode-check" });
    expect(calls).toEqual([
      { kind: "realpath", p: "/srv/data" },
      { kind: "mkdir", p: "/srv/data/mode-check" },
      { kind: "chmodDir", p: "/srv/data/mode-check", mode: 0o775 },
    ]);
  });

  it("chmodDir EPERM ⇒ still ok:true and a warn is logged (the directory stays)", async () => {
    const { fs } = fakeFs(async () => {
      throw errnoError("EPERM");
    });
    const svc = createMkdirService(baseDeps({ fs, dirMode: 0o775 }));
    const r = await svc.mkdir("/srv/data", "eperm", deadline());
    expect(r).toEqual({ ok: true, path: "/srv/data/eperm" }); // never an error reply
    const warns = log?.lines.filter((l) => l.level === "warn") ?? [];
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain("dir mode apply failed");
  });

  it("chmodDir ELOOP (symlink swap) ⇒ still ok:true + warn", async () => {
    const { fs } = fakeFs(async () => {
      throw errnoError("ELOOP");
    });
    const svc = createMkdirService(baseDeps({ fs, dirMode: 0o755 }));
    const r = await svc.mkdir("/srv/data", "eloop", deadline());
    expect(r).toEqual({ ok: true, path: "/srv/data/eloop" });
    expect(log?.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("chmodDir PreviewIoError(deadline) ⇒ still ok:true + warn (the step wrapper's own failure class)", async () => {
    const { fs } = fakeFs(async () => {
      throw new PreviewIoError("deadline", "budget exhausted (test)");
    });
    const svc = createMkdirService(baseDeps({ fs, dirMode: 0o775 }));
    const r = await svc.mkdir("/srv/data", "slow", deadline());
    expect(r).toEqual({ ok: true, path: "/srv/data/slow" });
    expect(log?.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });
});
