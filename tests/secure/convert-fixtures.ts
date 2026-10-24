/**
 * Shared fixtures for the V4 convert suites (convert-preflight / convert-state).
 *
 * Everything lives in private mktemp dirs: a fake $HOME with a project tree, an agent dir, the
 * `.txn` dir and the vault layout. Launcher facilities (registry, layout, gocryptfs init/mount,
 * finalize) are FAKE ports — no FUSE, no real settings file, no password. The vault "mount" is a
 * plain directory: the convert engine sees the same paths/identities it would see on a real mount.
 * The tree/sessions engines (V2/V3) and their workers run for real. Never touches ~/secure or ~/.pi.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO = join(import.meta.dirname, "..", "..");
export const CONVERT_PATH = join(REPO, "src", "secure", "bin", "convert.mjs");
export const TREE_PATH = join(REPO, "src", "secure", "bin", "tree.mjs");
/* eslint-disable @typescript-eslint/no-explicit-any -- plain-JS modules, no typings by design */
export const C: any = await import(pathToFileURL(CONVERT_PATH).href);
export const T: any = await import(pathToFileURL(TREE_PATH).href);
export const H: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "helper.mjs")).href);

/**
 * Same-uid processes this machine ALREADY has that /proc cannot inspect (non-dumpable: sd-pam, the
 * user's sshd session, ssh-agent …). Production lists them and requires a user confirmation
 * (user ruling 2026-10-24); the fixtures' injected scan — TEST-ONLY, production has no such switch —
 * ignores exactly these pre-existing pids so the suites run unattended on such a machine. Every
 * process a test spawns is still inspected; tests inject synthetic uninspectable ones on purpose.
 */
const PRE_UNREADABLE: Set<number> = await (async () => {
  const r = await C.scanOccupants(["/nonexistent-pi-secure-root"]);
  return new Set<number>(r.kind === "done" ? r.unreadablePids.map((p: any) => p.pid) : []);
})();
export async function fixtureScanOccupants(roots: string[], opts: any): Promise<any> {
  const r = await C.scanOccupants(roots, opts);
  if (r.kind !== "done") return r;
  const unreadablePids = r.unreadablePids.filter((p: any) => !PRE_UNREADABLE.has(p.pid));
  return { ...r, unreadablePids, unreadable: unreadablePids.length };
}

const TOKEN = `pi-secure-conv-${process.pid}-${Date.now().toString(36)}`;
const tmps: string[] = [];

/** mktemp dir tagged with this run's token (cleanup only removes these). */
export function mkTmp(tag = "t"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `${TOKEN}-${tag}-`)));
  tmps.push(d);
  return d;
}
export function cleanupTmps(): void {
  for (const d of tmps.splice(0)) {
    if (!d.includes(TOKEN)) continue;
    spawnSync("chmod", ["-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
}

export function script(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

/** A project tree that passes every rule (files, ro file/dir, symlinks, hardlink, empty dir). */
export function makeProject(root: string): void {
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, "rodir"));
  writeFileSync(join(root, "rodir", "x"), "x");
  chmodSync(join(root, "rodir"), 0o555);
  writeFileSync(join(root, "a.txt"), "hello\n");
  writeFileSync(join(root, "ro.txt"), "readonly", { mode: 0o444 });
  chmodSync(join(root, "ro.txt"), 0o444);
  writeFileSync(join(root, "src", "deep", "data.bin"), Buffer.alloc(300 * 1024 + 7, 9));
  linkSync(join(root, "a.txt"), join(root, "src", "hard"));
  symlinkSync("../a.txt", join(root, "src", "rel"));
  symlinkSync("/usr/bin/env", join(root, "ext-abs"));
  writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  chmodSync(join(root, "run.sh"), 0o755);
}

/** rel → {type, mode, size, sha, target, ino} (lstat only; content hashed). */
export function snapshot(root: string, withIno = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (rel: string) => {
    const p = rel ? join(root, rel) : root;
    const st = lstatSync(p);
    const e: Record<string, unknown> = { mode: (st.mode & 0o7777).toString(8) };
    if (withIno) {
      e.ino = st.ino;
      e.mtimeMs = st.mtimeMs;
    }
    if (st.isSymbolicLink()) Object.assign(e, { type: "l", target: readlinkSync(p) });
    else if (st.isDirectory()) {
      e.type = "d";
      const wasRo = (st.mode & 0o500) !== 0o500;
      if (wasRo) chmodSync(p, st.mode | 0o500);
      const names = readdirSync(p).sort();
      if (wasRo) chmodSync(p, st.mode & 0o7777);
      for (const n of names) walk(rel ? `${rel}/${n}` : n);
    } else {
      e.type = "f";
      e.size = st.size;
      const wasRo = (st.mode & 0o400) === 0;
      if (wasRo) chmodSync(p, (st.mode & 0o7777) | 0o400);
      e.sha = createHash("sha256").update(readFileSync(p)).digest("hex");
      if (wasRo) chmodSync(p, st.mode & 0o7777);
    }
    if (!withIno) delete e.mtimeMs;
    out[rel || "."] = e;
  };
  walk("");
  return out;
}

export type Env = ReturnType<typeof makeEnv>;

/**
 * A complete fake world. `opts.project` false ⇒ no project tree created.
 * Returned `run(args)` invokes cmdConvert with fresh ctx/ports bound to this world.
 */
export function makeEnv(tag: string, opts: { failAt?: string; project?: boolean } = {}) {
  const base = mkTmp(tag);
  const home = join(base, "home");
  mkdirSync(home, { mode: 0o700 });
  const src = join(home, "proj");
  if (opts.project !== false) {
    mkdirSync(src);
    makeProject(src);
  }
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  const bin = join(base, "bin");
  mkdirSync(bin);
  const getfattr = script(bin, "getfattr", "exit 0");
  const reg = new Map<string, any>();
  const world = {
    base,
    home,
    src,
    agentDir,
    bin,
    getfattr,
    reg,
    mounted: false,
    busy: false,
    promptAnswer: undefined as string | undefined,
    /** V8: forced result of the layoutPreflight port (undefined ⇒ the real helper function). */
    layoutProblem: undefined as undefined | null | { title: string; lines: string[] },
    out: [] as string[],
    err: [] as string[],
    signals: new EventEmitter(),
    onOut: undefined as undefined | ((line: string) => void),
    treeArgvOverride: undefined as undefined | ((op: string) => string[] | undefined),
    calls: [] as string[],
    env: {} as Record<string, string>,
  };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.PI_CODING_AGENT_DIR;
  delete env.ARMORY_MEMORY_ROOT;
  delete env.PI_SECURE_TEST_CONVERT_FAIL_AT;
  env.HOME = home;
  delete env.PI_SECURE_TEST_SEAMS;
  if (opts.failAt) {
    env.PI_SECURE_TEST_SEAMS = "1"; // V7 review M1: seams need the gate
    env.PI_SECURE_TEST_CONVERT_FAIL_AT = opts.failAt;
  }
  world.env = env;
  const ports = {
    registerVault: (name: string, entry: any, o: any) => {
      world.calls.push(`register ${name}`);
      if (o?.expectAbsent && reg.has(name)) throw Object.assign(new Error(`保险库 ${name} 已登记`), { code: 78 });
      reg.set(name, { ...entry, ...(o?.pending ? { pending: o.pending } : {}) });
    },
    patchVaultEntry: (name: string, guard: any, patch: any) => {
      world.calls.push(`patch ${name}`);
      const e = reg.get(name);
      if (!e) return { kind: "missing" };
      if (guard.pending !== undefined && e.pending !== guard.pending) return { kind: "mismatch", reason: "pending" };
      const n = { ...e };
      for (const k of patch.remove ?? []) delete n[k];
      Object.assign(n, patch.set ?? {});
      reg.set(name, n);
      return { kind: "ok", entry: n };
    },
    removeVaultEntry: (name: string, guard: any) => {
      world.calls.push(`remove ${name}`);
      const e = reg.get(name);
      if (!e) return { kind: "missing" };
      if (e.pending !== guard.pending) return { kind: "mismatch", reason: "pending" };
      reg.delete(name);
      return { kind: "ok" };
    },
    getVaultEntry: (name: string) => reg.get(name),
    listVaults: () => [...reg].map(([name, e]) => ({ name, ...e })),
    deriveVault: H.deriveVault,
    defaultVaultDir: H.defaultVaultDir,
    defaultVaultMnt: H.defaultVaultMnt,
    physicalPaths: H.physicalPaths,
    createLayout: (v: any) => {
      world.calls.push("createLayout");
      mkdirSync(join(v.dir, ".."), { recursive: true, mode: 0o700 });
      mkdirSync(v.dir, { mode: 0o700 });
      mkdirSync(v.cipher, { mode: 0o700 });
      mkdirSync(join(v.mnt, ".."), { recursive: true, mode: 0o700 });
      mkdirSync(v.mnt, { mode: 0o700 });
      for (const n of ["work", "state"]) writeFileSync(join(v.mnt, n), "", { mode: 0o400 });
      writeFileSync(v.lock, "", { mode: 0o600 });
      writeFileSync(v.lease, "", { mode: 0o600 });
    },
    layoutPreflight: (v: any, o: any) => {
      world.calls.push("layoutPreflight");
      return world.layoutProblem !== undefined ? world.layoutProblem : H.layoutPreflightProblems(v, o);
    },
    initCipher: async (v: any) => {
      world.calls.push("initCipher");
      writeFileSync(join(v.cipher, "gocryptfs.conf"), "{}\n", { mode: 0o400 });
      return 0;
    },
    unlockVault: async (v: any, o: any) => {
      world.calls.push(`unlock postMount=${o?.postMount}`);
      for (const n of ["work", "state"]) {
        try {
          unlinkSync(join(v.mnt, n));
        } catch {
          /* already */
        }
      }
      world.mounted = true;
      return { how: "mounted-now", realMnt: H.physicalPaths(v).realMnt };
    },
    ensureVaultDirs: H.ensureVaultDirs,
    syncProjectSettings: H.syncProjectSettings,
    probeMountState: async () => (world.mounted ? "mounted" : "absent"),
    finalizeBounded: async (v: any) => {
      world.calls.push("finalize");
      if (world.busy) return { code: 76, lines: [`${v.name}：仍有进程在保险库内`] };
      world.mounted = false;
      return { code: 0, lines: [`${v.name}：已卸载`] };
    },
    leaseState: async () => "free",
    preflight: () => ({ ok: true, problems: [] }),
    isTty: () => true,
    prompt: async () => world.promptAnswer ?? "proj",
    out: (l: string) => {
      world.out.push(l);
      world.onOut?.(l);
    },
    err: (l: string) => world.err.push(l),
  };
  const ctx = (over: Record<string, unknown> = {}) =>
    C.defaultConvertContext(env, {
      home,
      agentDir,
      memoryRoot: join(agentDir, "memory"),
      systemDirs: C.SYSTEM_DIRS.filter((d: string) => d !== "/tmp"),
      bins: { mv: "mv", sync: "sync", getfattr, flock: "flock", git: "git" },
      signals: world.signals,
      treeArgv: (op: string) => world.treeArgvOverride?.(op) ?? T.treeWorkerArgv(op),
      scanOccupants: fixtureScanOccupants,
      ...over,
    });
  const run = (args: string[], over: Record<string, unknown> = {}) =>
    C.cmdConvert(args, { ports, ctx: ctx(over) }) as Promise<number>;
  const vault = (name = "proj") => H.deriveVault(name, H.defaultVaultDir(name, home), H.defaultVaultMnt(name, home));
  const txnDir = join(home, ".local", "share", "pi-toolkit-secure", ".txn");
  return { ...world, world, ports, ctx, run, vault, txnDir };
}

/** Tree-worker argv that runs `pre` (a node snippet with `B` = backup path) before the real op. */
export function wrappedTreeArgv(dir: string, op: string, pre: string): string[] {
  const p = join(dir, `wrap-${op}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    p,
    [
      `import fs from "node:fs";`,
      `import path from "node:path";`,
      `import { workerMain } from ${JSON.stringify(pathToFileURL(TREE_PATH).href)};`,
      `const chunks = []; for await (const c of process.stdin) chunks.push(c);`,
      `const text = Buffer.concat(chunks).toString("utf8"); const spec = JSON.parse(text);`,
      `const B = spec.root ?? spec.src;`,
      pre,
      `const { Readable } = await import("node:stream");`,
      `process.exit(await workerMain(${JSON.stringify(op)}, { stdin: Readable.from([Buffer.from(text)]) }));`,
    ].join("\n"),
  );
  return [process.execPath, p];
}

export function gitInit(dir: string): void {
  const genv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...a], { env: genv, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-q", "-m", "one");
}

export function git(dir: string, ...a: string[]): string {
  const genv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const r = spawnSync("git", ["-C", dir, ...a], { env: genv, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
