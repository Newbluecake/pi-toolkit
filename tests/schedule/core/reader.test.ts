/**
 * scheduled-reports plan r3 §7.6 (S1): the pure read-only reader — zero writes (tree snapshot +
 * static check), per-level O_NOFOLLOW (symlinked session dir / state / reports dir refused), the
 * vault double check (literal AND canonical — an ancestor symlink into a vault is caught),
 * owner / mode refusal, size caps, FIFOs never block, pinned dev/ino, report path shape.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStoreRoot, SchedFsError, sessionDirName, isSessionDirName } from "../../../src/schedule/core/paths.js";
import {
  listSessionDirs,
  readReportFile,
  readSessionState,
  readSessionStateById,
  validateStateFile,
} from "../../../src/schedule/core/reader.js";
import { emptyStateFile, SCHED_STATE_MAX_BYTES } from "../../../src/schedule/core/spec.js";
import {
  legacyReportFileOf as reportFileOf,
  addTask,
  approve,
  env,
  makeTask,
  self,
  SID,
  utc,
  type Env,
} from "./fixtures.js";
import { ensureStoreRoot, openSessionStore } from "../../../src/schedule/core/writer.js";

let E: Env;
afterEach(() => E?.cleanup());
const T8 = utc("2026-10-24T08:00:00Z");
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      out.push(`${relative(dir, p)} ${st.mode} ${st.size} ${st.mtimeMs} ${st.ino}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

async function seeded(): Promise<string> {
  E = env(T8);
  const store = E.store();
  await addTask(store, approve(makeTask()), T8);
  return join(E.storeDir, sessionDirName(SID));
}

describe("reader is read-only", () => {
  it("never writes: the whole tree is identical after reading good, corrupt and missing data", async () => {
    const dir = await seeded();
    mkdirSync(join(E.storeDir, "broken"), { mode: 0o700 });
    writeFileSync(join(E.storeDir, "broken", "state.json"), "{nope", { mode: 0o600 });
    mkdirSync(join(dir, "reports"), { mode: 0o700 });
    const rep = reportFileOf(SID, "s_aaaaaaaa@1");
    writeFileSync(join(dir, rep), "# report", { mode: 0o600 });
    const before = snapshot(E.storeDir);
    const root = resolveStoreRoot(E.storeDir);
    expect(listSessionDirs(root)).toMatchObject({ kind: "ok", dirs: [sessionDirName(SID), "broken"] });
    expect(readSessionStateById(root, SID).kind).toBe("ok");
    expect(readSessionState(root, "broken")).toMatchObject({ kind: "degraded", reason: "json" });
    expect(readSessionState(root, "absent-one").kind).toBe("absent");
    expect(readReportFile(root, sessionDirName(SID), rep)).toMatchObject({ kind: "ok", text: "# report" });
    expect(snapshot(E.storeDir)).toEqual(before);
  });

  it("static: reader.ts / paths.ts / cron.ts / recovery.ts reference no fs write primitive", () => {
    const WRITE =
      /\b(writeSync|writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|rmdirSync|mkdirSync|linkSync|symlinkSync|chmodSync|chownSync|truncateSync|ftruncateSync|copyFileSync|utimesSync|O_CREAT|O_WRONLY|O_RDWR|O_TRUNC|O_APPEND)\b/;
    for (const f of ["reader", "paths", "cron", "recovery"]) {
      const src = readFileSync(join(ROOT, `src/schedule/core/${f}.ts`), "utf8");
      expect(WRITE.exec(src)?.[0], f).toBeUndefined();
    }
  });
});

describe("path safety", () => {
  it("symlinked session dir, state.json or reports dir are refused", async () => {
    const dir = await seeded();
    const root = resolveStoreRoot(E.storeDir);
    // symlinked session directory
    symlinkSync(dir, join(E.storeDir, "alias-sess"));
    expect(readSessionState(root, "alias-sess")).toMatchObject({ kind: "degraded", reason: "symlink" });
    expect(listSessionDirs(root)).toMatchObject({ dirs: [sessionDirName(SID)] });
    // symlinked state.json
    renameSync(join(dir, "state.json"), join(dir, "real.json"));
    symlinkSync(join(dir, "real.json"), join(dir, "state.json"));
    expect(readSessionStateById(root, SID)).toMatchObject({ kind: "degraded", reason: "symlink" });
    // symlinked reports dir
    const elsewhere = mkdtempSync(join(tmpdir(), "sched-elsewhere-"));
    try {
      const rep = reportFileOf(SID, "s_aaaaaaaa@1");
      writeFileSync(join(elsewhere, rep.slice(8)), "x", { mode: 0o600 });
      symlinkSync(elsewhere, join(dir, "reports"));
      expect(readReportFile(root, sessionDirName(SID), rep)).toMatchObject({ kind: "degraded", reason: "symlink" });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("vault double check: literal path, and an ancestor symlink whose CANONICAL target is in a vault", async () => {
    E = env(T8);
    const vault = join(E.dir, "vault");
    mkdirSync(join(vault, "mnt", "state", "schedules"), { recursive: true, mode: 0o700 });
    const inVault = (p: string): boolean => p === vault || p.startsWith(`${vault}/`);
    // literal
    expect(() => resolveStoreRoot(join(vault, "mnt", "state", "schedules"), { inVault })).toThrow(SchedFsError);
    // ancestor symlink → vault: the literal path looks harmless, the canonical one is inside
    symlinkSync(join(vault, "mnt", "state"), join(E.dir, "innocent"));
    let err: unknown;
    try {
      resolveStoreRoot(join(E.dir, "innocent", "schedules"), { inVault });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchedFsError);
    expect((err as SchedFsError).reason).toBe("vault");
    // a pinned root re-checks on every read (predicate changes ⇒ degraded)
    const root = resolveStoreRoot(E.storeDir);
    let blocked = false;
    expect(readSessionStateById(root, SID, { inVault: () => blocked }).kind).toBe("absent");
    blocked = true;
    expect(readSessionStateById(root, SID, { inVault: () => blocked })).toMatchObject({
      kind: "degraded",
      reason: "vault",
    });
  });

  it("review M3: judged on the OPENED fd — an ancestor moved into a vault behind a same-named symlink (inode unchanged)", async () => {
    E = env(T8);
    const vault = join(E.dir, "vault");
    mkdirSync(join(vault, "mnt"), { recursive: true, mode: 0o700 });
    const inVault = (p: string): boolean => p === vault || p.startsWith(`${vault}/`);
    const storeDir = join(E.dir, "a", "schedules");
    const root = ensureStoreRoot(storeDir, { inVault });
    const store = openSessionStore({ root, sessionId: SID, self: self(), epoch: "e", inVault, now: () => T8 });
    await addTask(store, approve(makeTask()), T8);
    expect(readSessionStateById(root, SID, { inVault }).kind).toBe("ok");
    // same filesystem ⇒ rename keeps every inode; the literal/real path strings still look harmless
    renameSync(join(E.dir, "a"), join(vault, "mnt", "a"));
    symlinkSync(join(vault, "mnt", "a"), join(E.dir, "a"));
    expect(readSessionStateById(root, SID, { inVault })).toMatchObject({ kind: "degraded", reason: "vault" });
    expect(listSessionDirs(root, { inVault })).toMatchObject({ kind: "degraded", reason: "vault" });
    expect(await store.transact(() => ({ value: 0, write: true }))).toMatchObject({ ok: false, code: "E_DEGRADED" });
    // without a vault predicate the location change alone is still caught
    expect(readSessionStateById(root, SID)).toMatchObject({ kind: "degraded", reason: "moved" });
  });

  it("review M3: ensureStoreRoot judges before creating — an ancestor symlink into a vault creates nothing there", () => {
    E = env(T8);
    const vault = join(E.dir, "vault");
    mkdirSync(join(vault, "mnt", "x"), { recursive: true, mode: 0o700 });
    const inVault = (p: string): boolean => p === vault || p.startsWith(`${vault}/`);
    symlinkSync(join(vault, "mnt", "x"), join(E.dir, "inn"));
    let err: unknown;
    try {
      ensureStoreRoot(join(E.dir, "inn", "new", "schedules"), { inVault });
    } catch (e) {
      err = e;
    }
    expect((err as SchedFsError).reason).toBe("vault");
    expect(readdirSync(join(vault, "mnt", "x"))).toEqual([]); // pre-fix: mkdir -p ran first
    // a harmless path is created level by level, 0700
    const ok = ensureStoreRoot(join(E.dir, "p", "q", "schedules"), { inVault });
    expect(ok.real).toBe(join(E.dir, "p", "q", "schedules"));
    expect(lstatSync(join(E.dir, "p", "q")).mode & 0o777).toBe(0o700);
  });

  it("owner and mode mismatches degrade", async () => {
    const dir = await seeded();
    const root = resolveStoreRoot(E.storeDir);
    const uid = process.getuid!();
    expect(readSessionStateById(root, SID, { uid: uid + 1 })).toMatchObject({ kind: "degraded", reason: "owner" });
    chmodSync(join(dir, "state.json"), 0o666);
    expect(readSessionStateById(root, SID)).toMatchObject({ kind: "degraded", reason: "mode" });
    chmodSync(join(dir, "state.json"), 0o600);
    chmodSync(dir, 0o770);
    expect(readSessionStateById(root, SID)).toMatchObject({ kind: "degraded", reason: "mode" });
  });

  it("size cap, FIFO state.json (no hang), store dir swapped (dev/ino)", async () => {
    const dir = await seeded();
    const root = resolveStoreRoot(E.storeDir);
    writeFileSync(join(dir, "state.json"), "x".repeat(SCHED_STATE_MAX_BYTES + 1), { mode: 0o600 });
    expect(readSessionStateById(root, SID)).toMatchObject({ kind: "degraded", reason: "too-large" });
    rmSync(join(dir, "state.json"));
    execFileSync("mkfifo", ["-m", "600", join(dir, "state.json")]);
    expect(readSessionStateById(root, SID)).toMatchObject({ kind: "degraded", reason: "not-file" });
    renameSync(E.storeDir, `${E.storeDir}.old`);
    mkdirSync(E.storeDir, { mode: 0o700 });
    expect(readSessionStateById(root, SID)).toMatchObject({ kind: "degraded", reason: "moved" });
    expect(listSessionDirs(root)).toMatchObject({ kind: "degraded", reason: "moved" });
  });

  it("report path shape: only reports/<64hex>.md", async () => {
    await seeded();
    const root = resolveStoreRoot(E.storeDir);
    for (const bad of [
      "reports/../state.json",
      "state.json",
      `reports/${"a".repeat(64)}.txt`,
      `/etc/${"a".repeat(64)}.md`,
    ]) {
      expect(readReportFile(root, sessionDirName(SID), bad)).toMatchObject({ kind: "degraded", reason: "bad-path" });
    }
    expect(readReportFile(root, "../x", `reports/${"a".repeat(64)}.md`)).toMatchObject({ reason: "bad-path" });
  });
});

describe("session directory names / validation", () => {
  it("wire-shaped sids are verbatim, everything else hashes into a disjoint space", () => {
    expect(sessionDirName(SID)).toBe(SID);
    const odd = sessionDirName("../../etc");
    expect(odd).toMatch(/^_[0-9a-f]{32}$/);
    expect(isSessionDirName(odd)).toBe(true);
    expect(isSessionDirName("..")).toBe(false);
    expect(sessionDirName("_abc")).not.toBe("_abc");
  });

  it("validateStateFile rejects structural damage", () => {
    const good = emptyStateFile(SID);
    good.tasks.push(approve(makeTask()));
    expect(validateStateFile(good).ok).toBe(true);
    expect(validateStateFile(good, "other").ok).toBe(false);
    const cases: Array<(s: Record<string, unknown>) => void> = [
      (s) => (s.v = 2),
      (s) => (s.rev = -1),
      (s) => (s.tasks as unknown[]).push((s.tasks as unknown[])[0]), // duplicate id
      (s) => ((s.tasks as Record<string, unknown>[])[0]!.form = "message"), // bg present on message
      (s) => (s.pendingReports = [{ reportId: "x" }]),
      (s) => (s.occ = { s_aaaaaaaa: { defHash: "z" } }),
      (s) => (s.digest = {}),
    ];
    for (const mut of cases) {
      const s = structuredClone(good) as unknown as Record<string, unknown>;
      mut(s);
      expect(validateStateFile(s).ok).toBe(false);
    }
  });
});
