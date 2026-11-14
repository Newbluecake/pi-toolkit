import { constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createRetainedSessionGuard,
  defaultRetainedSessionFs,
  bindingDigest,
  clampProofSpanMs,
  isSessionGuard,
  isPiLazyBasename,
  type SessionBinding,
} from "../../../../src/web-hub/hub/spawn/retained-session.js";
import { planSessionArgv, type RestoreSessionFs } from "../../../../src/web-hub/hub/spawn/restore-plan.js";
import { retainedFake } from "./retained-fake.js";

const binding: SessionBinding = {
  spawnId: "sp-retained",
  cwd: "/w/proj",
  sessionId: "sess-old",
  sessionFile: "/home/u/.pi/agent/sessions/--w-proj--/2026_sess-old.jsonl",
};
const head = JSON.stringify({ type: "session", version: 3, id: binding.sessionId, cwd: binding.cwd }) + "\n";

// Every FS touch is either a fake ledger operation or confined to our owned temporary tree.
describe("retained session provenance and independent read leases", () => {
  it("capture is metadata-only; each directory open is nofollow; tokens bind factory+tuple+revision", () => {
    const f = retainedFake();
    f.files.set(binding.sessionFile, { head });
    const result = f.guard.capture(binding, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(f.reads()).toHaveLength(0);
    expect(f.nofollow()).toBe(true);
    expect(f.fds.size).toBe(0);
    expect(result.value.baseline.chain).toHaveLength(7);
    expect(f.guard.matches(result.value, binding, 3)).toBe(true);
    expect(f.guard.matches(result.value, binding, 4)).toBe(false);
    expect(f.guard.matches(result.value, { ...binding, spawnId: "other" }, 3)).toBe(false);
    expect(retainedFake().guard.matches(result.value, binding, 3)).toBe(false);
    expect(f.guard.matches(JSON.parse(JSON.stringify(result.value)), binding, 3)).toBe(false);
    expect(f.ledger.filter((e) => e.op === "open").map((e) => e.path)).toEqual([
      "/",
      "/home",
      "/home/u",
      "/home/u/.pi",
      "/home/u/.pi/agent",
      "/home/u/.pi/agent/sessions",
      "/home/u/.pi/agent/sessions/--w-proj--",
    ]);
  });

  it("D7 gets a verified fd reader that expires synchronously; no path reader reopening", () => {
    const f = retainedFake();
    f.files.set(binding.sessionFile, { head });
    const captured = f.guard.capture(binding, 1);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    let expired: RestoreSessionFs | undefined;
    const result = f.guard.withRead(binding, 1, captured.value.baseline, (fs) => {
      expired = fs;
      expect(() => fs.readHeadSync("/other.jsonl", 100)).toThrow();
      return planSessionArgv(binding, fs, 1000);
    });
    expect(result).toEqual({ ok: true, value: { ok: true, tail: ["--session", binding.sessionFile] } });
    expect(f.reads()).toHaveLength(1);
    expect(f.fds.size).toBe(0);
    expect(() => expired!.readHeadSync(binding.sessionFile, 20)).toThrow("lease-expired");
    expect(f.guard.withRead(binding, 1, captured.value.baseline, () => Promise.resolve(1)).ok).toBe(false);
    expect(f.fds.size).toBe(0);
  });

  it.each([
    "/",
    "/home",
    "/home/u/.pi/agent",
    "/home/u/.pi/agent/sessions",
    "/home/u/.pi/agent/sessions/--w-proj--",
    binding.sessionFile,
  ])("expected identity replacement %s rejects before any content", (path) => {
    const f = retainedFake();
    f.files.set(binding.sessionFile, { head });
    const captured = f.guard.capture(binding, 1);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    f.inodes.set(path, 9000);
    f.ledger.length = 0;
    expect(
      f.guard.withRead(binding, 1, captured.value.baseline, (fs) => fs.readHeadSync(binding.sessionFile, 10)).ok,
    ).toBe(false);
    expect(f.reads()).toHaveLength(0);
    expect(f.fds.size).toBe(0);
    const next = f.ledger.findIndex((e) => e.path === path && e.op === "fstat");
    if (path !== binding.sessionFile) expect(f.ledger.slice(next + 1).every((e) => e.op === "close")).toBe(true);
  });

  it.each(["symlink", "owner", "nlink", "directory"] as const)("leaf %s is not safe metadata; content=0", (fault) => {
    const f = retainedFake();
    f.files.set(binding.sessionFile, { head });
    f.bad.set(binding.sessionFile, fault);
    expect(f.guard.capture(binding, 1).ok).toBe(false);
    expect(f.reads()).toHaveLength(0);
    expect(f.fds.size).toBe(0);
  });

  it("missing leaf is different from missing parent; old leaf evidence survives absence", () => {
    const f = retainedFake();
    const missing = f.guard.capture(binding, 1);
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.leafPresent).toBe(false);
    expect(missing.value.baseline.file).toBeUndefined();
    expect(f.guard.withRead(binding, 1, missing.value.baseline, (fs) => planSessionArgv(binding, fs, 1000))).toEqual({
      ok: true,
      value: { ok: true, tail: ["--session-id", binding.sessionId] },
    });
    f.files.set(binding.sessionFile, { head });
    const present = f.guard.capture(binding, 2, missing.value.baseline);
    expect(present.ok).toBe(true);
    if (!present.ok) return;
    f.files.delete(binding.sessionFile);
    const gone = f.guard.withRead(binding, 3, present.value.baseline, (fs) =>
      planSessionArgv({ ...binding, sessionPersisted: true }, fs, 1000),
    );
    expect(gone).toMatchObject({ ok: true, value: { ok: false, failure: "session-missing" } });
    const metadata = f.guard.capture(binding, 3, present.value.baseline);
    expect(metadata.ok && metadata.value.baseline.file).toEqual(present.value.baseline.file);
    f.bad.set("/home/u/.pi/agent/sessions", "missing");
    expect(f.guard.capture(binding, 4).ok).toBe(false);
    expect(f.reads()).toHaveLength(0);
    expect(f.fds.size).toBe(0);
  });

  it.each([
    "/custom/2026_sess-old.jsonl",
    "/home/u/.pi/agent/sessions/--w-proj--evil/x.jsonl",
    "/home/u/.pi/agent/sessions/--w-proj--/nested/x.jsonl",
    "/home/u/.pi/agent/sessions/--w-proj--/../x.jsonl",
    "/home/u/.pi/agent//sessions/--w-proj--/x.jsonl",
    "/home/u/.pi/agent/sessions/--w-proj--/" + "x".repeat(1024) + ".jsonl",
  ])("lexical external/ambiguous candidate rejected without FS: %s", (sessionFile) => {
    const f = retainedFake();
    expect(f.guard.capture({ ...binding, sessionFile }, 1).ok).toBe(false);
    expect(f.ledger).toEqual([]);
  });

  it("runtime proof is not persistent JSON authorization: digest and exact chain length are required", () => {
    const f = retainedFake(),
      result = f.guard.capture(binding, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = result.value.baseline;
    expect(isSessionGuard({ kind: "default-tree-v1", baseline: base }, binding)).toBe(true);
    for (const altered of [
      { ...base, bindingDigest: "a".repeat(64) },
      { ...base, chain: base.chain.slice(1) },
      { ...base, chain: [...base.chain, { dev: 1, ino: 1 }] },
      { ...base, file: { dev: Infinity, ino: 1 } },
    ]) {
      expect(isSessionGuard({ kind: "default-tree-v1", baseline: altered }, binding)).toBe(false);
      expect(f.guard.withRead(binding, 0, altered, () => 1).ok).toBe(false);
    }
    expect(isSessionGuard({ kind: "default-tree-v1", lazyIntent: { attempt: 1 } })).toBe(true);
    for (const attempt of [-1, 0, 4, 1.5, Infinity])
      expect(isSessionGuard({ kind: "default-tree-v1", lazyIntent: { attempt } })).toBe(false);
    expect(bindingDigest(binding)).not.toBe(bindingDigest({ ...binding, sessionId: "other" }));
  });

  it("one slow open exhausts the TOTAL monotonic budget, only close may follow; next candidate never starts", () => {
    const f = retainedFake();
    let mono = 0;
    const guard = createRetainedSessionGuard({
      agentDir: "/home/u/.pi/agent",
      uid: 1000,
      fs: f.fs,
      monoNow: () => mono,
    });
    f.setOnOp((op) => {
      if (op === "open") mono += 21;
    });
    const work = guard.budget();
    expect(guard.capture(binding, 1, undefined, work).ok).toBe(false);
    expect(f.ledger.map((e) => e.op)).toEqual(["open", "close"]);
    expect(f.fds.size).toBe(0);
    expect(guard.available(work)).toBe(false);
    expect(guard.capture({ ...binding, spawnId: "next" }, 1, undefined, work).ok).toBe(false);
    expect(f.ledger).toHaveLength(2);
  });

  it("operation and segment bounds check BEFORE starting the next syscall; zero budget is zero FS", () => {
    const f = retainedFake();
    for (const work of [{ ...f.guard.budget(), opsLeft: 0 }, f.guard.budget(0)]) {
      expect(f.guard.capture(binding, 1, undefined, work).ok).toBe(false);
      expect(f.ledger).toEqual([]);
    }
    const work = { ...f.guard.budget(), opsLeft: 1 };
    expect(f.guard.capture(binding, 1, undefined, work).ok).toBe(false);
    expect(f.ledger.map((e) => e.op)).toEqual(["open", "close"]);
    f.ledger.length = 0;
    expect(f.guard.capture(binding, 1, undefined, { ...f.guard.budget(), segmentsLeft: 0 }).ok).toBe(false);
    expect(f.ledger.map((e) => e.op)).toEqual(["open", "fstat", "close"]);
    expect(f.fds.size).toBe(0);
    expect(clampProofSpanMs(Infinity)).toBe(0);
    expect(clampProofSpanMs(NaN)).toBe(0);
    expect(clampProofSpanMs(-20)).toBe(0);
    expect(clampProofSpanMs(1e9)).toBe(20);
    expect(clampProofSpanMs(0.5)).toBe(0.5);
  });

  it("128 path segments is inclusive; the 129th is refused before opening root", () => {
    const f = retainedFake();
    const agentDir = "/" + Array.from({ length: 126 }, () => "a").join("/");
    const guard = createRetainedSessionGuard({ agentDir, uid: 1000, fs: f.fs, monoNow: () => 0 });
    const b = { ...binding, sessionFile: `${agentDir}/sessions/--w-proj--/x.jsonl` };
    const work = guard.budget();
    expect(guard.capture(b, 1, undefined, work).ok).toBe(true);
    expect(work.segmentsLeft).toBe(0);
    expect(f.fds.size).toBe(0);
    f.ledger.length = 0;
    const tooDeep = createRetainedSessionGuard({ agentDir: `${agentDir}/b`, uid: 1000, fs: f.fs });
    expect(tooDeep.capture({ ...b, sessionFile: `${agentDir}/b/sessions/--w-proj--/x.jsonl` }, 1).ok).toBe(false);
    expect(f.ledger).toEqual([]);
  });

  it("all fds close on callback/read/fstat failure; close failure does not skip other owned fds", () => {
    for (const op of ["read", "fstat", "close", "callback"]) {
      const f = retainedFake();
      f.files.set(binding.sessionFile, { head });
      f.setOnOp((name) => {
        if (name === op) throw Error("injected");
      });
      const result = f.guard.withRead(binding, 1, undefined, (fs) => {
        if (op === "callback") throw Error("callback");
        return fs.readHeadSync(binding.sessionFile, 100);
      });
      if (op === "close") {
        expect(f.ledger.filter((e) => e.op === "close")).toHaveLength(8);
      } else {
        expect(result.ok).toBe(false);
        expect(f.fds.size).toBe(0);
      }
    }
  });

  it("pi timestamp basename roundtrip is exact, not a general suffix permit", () => {
    expect(isPiLazyBasename("/x/2026-11-14T13-22-33-123Z_sess-old.jsonl", "sess-old")).toBe(true);
    for (const stamp of [
      "2026",
      "2026-13-14T13-22-33-123Z",
      "2026-02-30T13-22-33-123Z",
      "2026-11-14T25-22-33-123Z",
      "2026-11-14T13-22-33-123Z_evil",
    ])
      expect(isPiLazyBasename(`/x/${stamp}_sess-old.jsonl`, "sess-old")).toBe(false);
  });

  it.each(["ancestor", "agentDir", "sessions", "cwd", "leaf"])(
    "production nofollow default rejects static %s alias without reading marker",
    (layer) => {
      const root = mkdtempSync(join(tmpdir(), "rs-"));
      try {
        const agentDir = join(root, "ancestor", "agent"),
          sessionDir = join(agentDir, "sessions", "--w-proj--"),
          file = join(sessionDir, "x.jsonl");
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(file, head);
        const target = join(root, "target");
        mkdirSync(target);
        writeFileSync(join(target, "marker.jsonl"), "PRIVATE-MARKER");
        const alias =
          layer === "ancestor"
            ? join(root, "ancestor")
            : layer === "agentDir"
              ? agentDir
              : layer === "sessions"
                ? join(agentDir, "sessions")
                : layer === "cwd"
                  ? sessionDir
                  : file;
        rmSync(alias, { recursive: true });
        symlinkSync(layer === "leaf" ? join(target, "marker.jsonl") : target, alias);
        const base = defaultRetainedSessionFs();
        let reads = 0;
        const guard = createRetainedSessionGuard({
          agentDir,
          uid: process.getuid!(),
          fs: {
            ...base,
            readSync(...args) {
              reads++;
              return base.readSync(...args);
            },
          },
        });
        const b = { ...binding, sessionFile: file };
        expect(guard.capture(b, 1).ok).toBe(false);
        expect(guard.withRead(b, 1, undefined, (fs) => fs.readHeadSync(file, 100)).ok).toBe(false);
        expect(reads).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("production default factory captures and reads an owned normal temporary tree", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-"));
    try {
      const agentDir = join(root, "agent"),
        parent = join(agentDir, "sessions", "--w-proj--"),
        file = join(parent, "x.jsonl");
      mkdirSync(parent, { recursive: true });
      writeFileSync(file, head);
      const guard = createRetainedSessionGuard({ agentDir, uid: process.getuid!() });
      const b = { ...binding, sessionFile: file },
        proof = guard.capture(b, 0);
      expect(proof.ok).toBe(true);
      if (!proof.ok) return;
      expect(guard.withRead(b, 0, proof.value.baseline, (fs) => fs.readHeadSync(file, 4096))).toEqual({
        ok: true,
        value: head,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
