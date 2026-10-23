/**
 * P0 gate of `docs/dev/data-encryption/plan.md` (§6 C1–C5): pins the real-world facts the
 * `pi-secure` launcher relies on. Self-gating — no env switch: skipped when gocryptfs /
 * fusermount3 / flock / script(1) / a usable /dev/fuse are missing (C4/C5 only need pi).
 *
 *  C1  `gocryptfs -init` and mount read the password from a TTY (script(1) pty), init prints the
 *      master key once, wrong password exits 12, mountinfo is `fuse.gocryptfs` with the cipherdir
 *      as source, `flock -o` keeps the daemon from inheriting mount.lock
 *  C2  `-nonempty` mounts over the sentinel dir; after umount `mkdir -p mnt/state/x` is ENOTDIR
 *  C3  umount needs no write permission on the mount root; cwd inside the mount ⇒ EBUSY
 *  C4  pi's `dist/cli/args.js` `parseArgs` result shape (what the launcher's argument audit uses)
 *  C5  real pi (`--no-extensions`, print mode, empty credentials ⇒ zero model requests): with
 *      `--session-dir`, `--fork` / `--name` write ONLY inside the session dir
 *
 * C1–C3 run `scripts/dev/secure-probe.sh` (private mktemp dir, TEST-ONLY fake password, bounded
 * by timeout, always unmounts + cleans up) and assert its per-check output. Never uses a real
 * password. Re-run (`npm run test:conformance`) before any pi / gocryptfs upgrade.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const PROBE = join(REPO_ROOT, "scripts", "dev", "secure-probe.sh");

function which(bin: string): string | undefined {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function fuseUsable(): boolean {
  try {
    const r = spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]);
    return r.status === 0;
  } catch {
    return false;
  }
}

const HAVE_FUSE_STACK =
  process.platform === "linux" &&
  ["gocryptfs", "fusermount3", "flock", "script", "timeout"].every((b) => which(b) !== undefined) &&
  fuseUsable();

/** Every pi install we can find: the devDependency and the `pi` on PATH (deduped by realpath). */
function piPackageDirs(): string[] {
  const dirs = new Set<string>();
  const dev = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent");
  if (existsSync(join(dev, "dist/cli/args.js"))) dirs.add(realpathSync(dev));
  const bin = which("pi");
  if (bin) {
    try {
      let d = realpathSync(bin);
      for (let i = 0; i < 6; i++) {
        d = join(d, "..");
        if (existsSync(join(d, "package.json")) && existsSync(join(d, "dist/cli/args.js"))) {
          dirs.add(d);
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...dirs];
}

describe.skipIf(!HAVE_FUSE_STACK)(
  "secure-gocryptfs conformance C1–C3 — real gocryptfs via scripts/dev/secure-probe.sh",
  () => {
    let out = "";
    let status: number | null = null;
    let leftover: string[] = [];

    beforeAll(() => {
      const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("secure-probe.")));
      const r = spawnSync("bash", [PROBE], {
        encoding: "utf8",
        timeout: 170_000,
        env: { ...process.env, TMPDIR: tmpdir() },
      });
      status = r.status;
      out = `${r.stdout}\n${r.stderr}`;
      leftover = readdirSync(tmpdir()).filter((n) => n.startsWith("secure-probe.") && !before.has(n));
    }, 180_000);

    const lines = (prefix: string): string[] => out.split("\n").filter((l) => l.includes(` ${prefix} `));
    const group = (prefix: string, minPass: number): void => {
      const ls = lines(prefix);
      expect(
        ls.filter((l) => l.startsWith("FAIL")),
        out,
      ).toEqual([]);
      expect(ls.filter((l) => l.startsWith("PASS")).length, out).toBeGreaterThanOrEqual(minPass);
    };

    it("probe ran to completion with every check passing, and cleaned up its scratch dir", () => {
      expect(status, out).toBe(0);
      expect(out).toContain("0 failure(s)");
      expect(leftover).toEqual([]);
    });
    it("C1: TTY init/mount prompts, master key banner, exit 12 on wrong password, mountinfo fstype/source, flock -o", () => {
      group("C1", 15);
      expect(out).toContain("C1 flock -o: lock is free after mount");
      expect(out).toContain("C1 wrong password via TTY (script -e propagates): exit (got '12'");
      expect(out).toContain("misc flock WITHOUT -o: daemon keeps the lock");
    });
    it("C2: -nonempty over sentinels; unmounted mkdir/write fail with ENOTDIR; exit 10 without -nonempty", () => {
      group("C2", 7);
      expect(out).toContain("C2 mkdir -p mnt/state/x -> ENOTDIR");
    });
    it("C3: unmount needs no write permission on the mount root; cwd inside the mount ⇒ EBUSY", () => {
      group("C3", 5);
      expect(out).toContain("C3 cwd inside mount: umount EBUSY");
    });
  },
);

describe.skipIf(piPackageDirs().length === 0)("secure-gocryptfs conformance C4 — pi parseArgs result shape", () => {
  for (const pkg of piPackageDirs()) {
    it(`C4: parseArgs shape the launcher audit depends on (${pkg})`, async () => {
      const mod = (await import(pathToFileURL(join(pkg, "dist/cli/args.js")).href)) as {
        parseArgs: (a: string[]) => Record<string, unknown> & { unknownFlags: Map<string, unknown> };
      };
      const p = mod.parseArgs;
      // value-consuming flags land in their own fields
      const a = p([
        "--fork",
        "F",
        "--session",
        "S",
        "--session-dir",
        "D",
        "--name",
        "N",
        "--export",
        "E",
        "-e",
        "X1",
        "-e",
        "X2",
        "@f1",
        "msg",
      ]);
      expect(a.fork).toBe("F");
      expect(a.session).toBe("S");
      expect(a.sessionDir).toBe("D");
      expect(a.name).toBe("N");
      expect(a.export).toBe("E");
      expect(a.extensions).toEqual(["X1", "X2"]);
      expect(a.fileArgs).toEqual(["f1"]);
      expect(a.messages).toEqual(["msg"]);
      expect(a.unknownFlags).toBeInstanceOf(Map);
      expect(Array.isArray(a.diagnostics)).toBe(true);
      // boolean flags
      expect(p(["--no-extensions"]).noExtensions).toBe(true);
      expect(p(["-ne"]).noExtensions).toBe(true);
      expect(p(["--no-session"]).noSession).toBe(true);
      // absent flags stay ABSENT (the audit tests field presence, not truthiness)
      const bare = p(["hello"]);
      for (const k of ["fork", "session", "sessionDir", "export", "extensions", "noExtensions", "noSession"]) {
        expect(Object.hasOwn(bare, k), k).toBe(false);
      }
      // `--session-dir ""` is PRESENT (empty string) although pi's main.js treats "" as unset
      const empty = p(["--session-dir", ""]);
      expect(Object.hasOwn(empty, "sessionDir")).toBe(true);
      expect(empty.sessionDir).toBe("");
      // a dangling value-flag at the end is NOT consumed: it falls to unknownFlags (launcher must reject these too)
      for (const f of ["--session-dir", "--fork", "--session"]) {
        const d = p([f]);
        expect(Object.hasOwn(d, f.slice(2) === "session-dir" ? "sessionDir" : f.slice(2)), f).toBe(false);
        expect(d.unknownFlags.has(f.slice(2)), f).toBe(true);
      }
      // `--` boundary: everything after is a message / @file, never a flag
      const after = p(["--", "--fork", "x", "@g"]);
      expect(after.messages).toEqual(["--fork", "x"]);
      expect(after.fileArgs).toEqual(["g"]);
      expect(Object.hasOwn(after, "fork")).toBe(false);
    });
  }
});

describe.skipIf(piPackageDirs().length === 0)(
  "secure-gocryptfs conformance C5 — real pi writes sessions only inside --session-dir",
  () => {
    const scratch: string[] = [];
    afterAll(() => {
      for (const d of scratch) rmSync(d, { recursive: true, force: true });
    });

    function runPi(
      pkg: string,
      root: string,
      cwd: string,
      args: string[],
    ): Promise<{ code: number | null; text: string }> {
      return new Promise((resolve) => {
        // Minimal env on purpose: no provider credentials ⇒ pi stops at "No API key" with ZERO model requests.
        const child = spawn(process.execPath, [join(pkg, "dist/cli.js"), "--no-extensions", ...args], {
          cwd,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: join(root, "home"),
            PI_CODING_AGENT_DIR: join(root, "agent"),
            PI_OFFLINE: "1",
            LANG: "C.UTF-8",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (d: Buffer) => (text += d.toString()));
        child.stderr.on("data", (d: Buffer) => (text += d.toString()));
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        timer.unref();
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, text });
        });
      });
    }

    const jsonls = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    function walkJsonl(dir: string, acc: string[] = []): string[] {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walkJsonl(p, acc);
        else if (e.name.endsWith(".jsonl")) acc.push(p);
      }
      return acc;
    }

    for (const pkg of piPackageDirs()) {
      it(`C5: --session-dir + --fork/--name write inside sessionDir only (${pkg})`, async () => {
        const root = mkdtempSync(join(tmpdir(), "secure-c5-"));
        scratch.push(root);
        for (const d of ["home", "agent", "sd", "cwd", "src"]) mkdirSync(join(root, d));
        const src = join(root, "src", "source.jsonl");
        writeFileSync(
          src,
          [
            '{"type":"session","version":3,"id":"11111111-1111-4111-8111-111111111111","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
            '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello-c5","timestamp":1}}',
            "",
          ].join("\n"),
        );
        const sd = join(root, "sd");
        const cwd = join(root, "cwd");

        const r = await runPi(pkg, root, cwd, ["--session-dir", sd, "--fork", src, "--name", "c5-name", "-p", "hi"]);
        // No credentials ⇒ pi must have stopped before any request. (If the message changes the fork assertions below still hold.)
        expect(r.text).toMatch(/No API key|No models available/i);
        const forks = jsonls(sd);
        expect(forks).toHaveLength(1);
        const body = readFileSync(join(sd, forks[0]!), "utf8");
        expect(body).toContain("hello-c5"); // whole source copied INTO sessionDir
        expect(body).toContain('"parentSession"');
        expect(body).toContain('"name":"c5-name"'); // --name appended inside the fork
        // nothing session-shaped anywhere else: not in cwd, not in the agent dir, source untouched
        expect(walkJsonl(cwd)).toEqual([]);
        expect(walkJsonl(join(root, "agent"))).toEqual([]);
        expect(walkJsonl(join(root, "home"))).toEqual([]);
        expect(readFileSync(src, "utf8")).not.toContain("c5-name");

        // --name on an existing session in sessionDir appends in place (no copy elsewhere)
        const before = readFileSync(join(sd, forks[0]!), "utf8");
        const r2 = await runPi(pkg, root, cwd, [
          "--session-dir",
          sd,
          "--session",
          join(sd, forks[0]!),
          "--name",
          "c5-second",
          "-p",
          "hi",
        ]);
        expect(r2.text).toMatch(/No API key|No models available/i);
        expect(jsonls(sd)).toEqual(forks);
        const after = readFileSync(join(sd, forks[0]!), "utf8");
        expect(after.startsWith(before)).toBe(true);
        expect(after).toContain('"name":"c5-second"');
        expect(walkJsonl(cwd)).toEqual([]);

        // --no-session writes nothing, anywhere
        const sd2 = join(root, "sd2");
        mkdirSync(sd2);
        await runPi(pkg, root, cwd, ["--session-dir", sd2, "--no-session", "-p", "hi"]);
        expect(walkJsonl(sd2)).toEqual([]);
        expect(walkJsonl(cwd)).toEqual([]);
      }, 150_000);
    }
  },
);
