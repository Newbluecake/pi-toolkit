/**
 * dir-plan v3.1 §2.1 (P1a) acceptance — `hub/preview/admit.ts`'s `createFsAdmitter`.
 *
 * Coverage per the plan's P1a checklist: §2.1's renumbered steps 1–5 make ZERO fs calls on the
 * literal denylist/virtual-root rejections; U4 rows (paths outside any cwd are ADMITTED now —
 * every such row is annotated "U4"); `rp === "/"` ⇒ root-too-broad; the denylist v2 matrix
 * (§2.3 — every category, via the pure predicate AND through real admission); §2.6's
 * literal+canonical double representation (real-tmpdir symlink homes, custom
 * `PI_CODING_AGENT_DIR`, a third-party link into `.config/pi`, ctx degradation); realpath
 * layers; not-regular/unreadable; the errno mapping table; TOCTOU (HP2) incl. the
 * `procFdAvailable=false` residual; per-step slow injection ⇒ 504 within the step cap; §2.4's
 * tracker busy circuit-breaker through a real admission; the late-open recovery; and the
 * hardlink behaviour pinned per §5.3.
 *
 * Real kernel semantics wherever possible: syscalls are real (tmpdir), only timing/failures
 * are scripted through `hookedFs` — except the pure zero-fs rows and the late-open case.
 */

import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFsAdmitter,
  denyCtxOf,
  denyListHit,
  PREVIEW_DENYLIST_VERSION,
  type FsAdmitterDeps,
  type PreviewDenyContext,
  type PreviewHandle,
} from "../../../../src/web-hub/hub/preview/admit.js";
import {
  createPreviewIoTracker,
  defaultPreviewFs,
  isPreviewIoError,
  mapFsError,
  previewFsStep,
  PreviewIoError,
} from "../../../../src/web-hub/hub/preview/fs.js";
import { abortAfter, deadline, FakeHandle, hookedFs, memLog, neverAbort } from "./helpers.js";
import type { FsHooks, FsMethodName } from "./helpers.js";

const HOME = "/home/tester";
const AGENT_DIR = `${HOME}/.pi/agent`;
const CTX: PreviewDenyContext = denyCtxOf(HOME, AGENT_DIR);

function admitter(hooks?: FsHooks, over: Partial<FsAdmitterDeps> = {}) {
  const log = memLog();
  const fs = hookedFs(hooks ?? { counts: {} });
  const a = createFsAdmitter({ denyCtx: CTX, tracker: createPreviewIoTracker(), fs, log, now: Date.now, ...over });
  return { a, fs, log };
}

function errnoError(code: string): Error {
  const e = new Error(`injected ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

// scratch dirs cleaned per test
let dirs: string[] = [];
const scratch = (prefix = "wh-admit-"): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const okPath = (root: string, rel = "note.txt", content = "hello preview"): string => {
  const p = join(root, rel);
  writeFileSync(p, content);
  return p;
};

// ---------------------------------------------------------------------------
// steps 1–3: literal decisions, ZERO fs (§2.1 renumbered table)
// ---------------------------------------------------------------------------

describe("admit: steps 1–3 (literal, zero fs)", () => {
  it.each([
    ["denylist literal (.ssh segment)", { path: "/tmp/r/.ssh/config", reason: "denylist" }],
    ["denylist literal (agentDir auth.json)", { path: `${AGENT_DIR}/auth.json`, reason: "denylist" }],
    ["denylist literal (absolute /etc/shadow)", { path: "/etc/shadow", reason: "denylist" }],
    ["path under /proc", { path: "/proc/self/environ", reason: "virtual-fs" }],
    ["path under /sys", { path: "/sys/kernel/a", reason: "virtual-fs" }],
    ["path under /dev", { path: "/dev/nullx", reason: "virtual-fs" }],
  ])("%s ⇒ 403 %s, zero fs calls", async (_name, { path, reason }) => {
    const { a, fs } = admitter();
    const res = await a.admit({ path }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 403, code: "E_PREVIEW_DENIED", reason });
    expect(Object.keys(fs.counts).filter((k) => (fs.counts[k] ?? 0) > 0)).toEqual([]);
  });

  it("U4: a cwd-OUTSIDE path is no longer a literal reject — it enters admission (old 'outside' deleted)", async () => {
    // U4 2026-10-08: 准入范围放宽为 uploads/任意绝对路径；root 包含判定随 root 一起删除。
    // A real file far outside any "cwd" admits fine (the old admitter answered 403 outside
    // here, zero fs — that row is intentionally gone).
    const cwd = scratch();
    const outside = scratch("wh-admit-outside-");
    const f = okPath(outside);
    const { a, fs } = admitter();
    const res = await a.admit({ path: f }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.realpath).toBe(f);
      await res.fh.close();
    }
    expect((fs.counts.realpath ?? 0) + (fs.counts.stat ?? 0)).toBeGreaterThan(0); // really admitted
  });

  it("U4: a single-segment absolute path enters admission too (route ③ minSegments:1 partner)", async () => {
    // /etc/hostname exists on Linux and is a regular readable file — the §1.4 wire-change row
    // "GET path=/one 400 → 进入准入" ends in a real open here.
    const { a } = admitter();
    const res = await a.admit({ path: "/etc/hostname" }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) await res.fh.close();
  });

  it('rp === "/" (step 5) ⇒ 403 root-too-broad — "/" itself is the only such input', async () => {
    const { a } = admitter();
    const res = await a.admit({ path: "/" }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 403, code: "E_PREVIEW_DENIED", reason: "root-too-broad" });
  });
});

// ---------------------------------------------------------------------------
// happy path & realpath layers
// ---------------------------------------------------------------------------

describe("admit: realpath layers", () => {
  it("regular file ⇒ ok (fd open, size, realpath)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a } = admitter();
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.size).toBe(13);
      expect(res.realpath).toBe(await defaultPreviewFs().realpath(file));
      await res.fh.close();
    }
  });

  it("a symlink chain to a regular file resolves and is allowed (U4: any absolute target)", async () => {
    const holder = scratch();
    const target = okPath(scratch("wh-admit-target-"));
    const link = join(holder, "alias.txt");
    symlinkSync(target, link);
    const { a } = admitter();
    const res = await a.admit({ path: link }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.realpath).toBe(target);
      await res.fh.close();
    }
  });

  it("symlink INTO a virtual root (/proc/self/environ) ⇒ 403 virtual-fs via realpath (U4: was 'outside')", async () => {
    // U4: containment is gone, so the defence that catches this link moved from `outside`
    // (root containment) to `virtual-fs` (realpath re-check) — same 403, different reason.
    const root = scratch();
    symlinkSync("/proc/self/environ", join(root, "env"));
    const { a } = admitter();
    const res = await a.admit({ path: join(root, "env") }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, reason: "virtual-fs" });
  });

  it("a path THROUGH a symlink into /proc ⇒ 403 virtual-fs (realpath re-check, step 5)", async () => {
    const holder = scratch();
    const link = join(holder, "intoproc");
    symlinkSync("/proc/self", link);
    const { a } = admitter();
    const res = await a.admit({ path: join(link, "cmdline") }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, reason: "virtual-fs" });
  });
});

// ---------------------------------------------------------------------------
// denylist v2 — pure predicate matrix + §2.6 double representation
// ---------------------------------------------------------------------------

describe("admit: denylist v2 (§2.3/§2.6 拒绝列表)", () => {
  it("version is 2 (corpus fixture pins the same number)", () => {
    expect(PREVIEW_DENYLIST_VERSION).toBe(2);
  });

  it("context prefixes under homes[]/agentDirs[] (literal spelling)", () => {
    for (const p of [
      `${AGENT_DIR}/web-hub`,
      `${AGENT_DIR}/web-hub/uploads/x`,
      `${AGENT_DIR}/auth.json`,
      `${AGENT_DIR}/models.json`,
      `${HOME}/.config/pi`,
      `${HOME}/.config/pi/web-search.env`,
    ]) {
      expect(denyListHit(p, CTX)).toBe(true);
    }
    // segment alignment: a look-alike prefix must NOT hit
    expect(denyListHit(`${HOME}/.pi/agent/web-hub-other/f`, CTX)).toBe(false);
  });

  it("context prefixes under a CANONICAL spelling (ctx carries both representations)", () => {
    const ctx: PreviewDenyContext = {
      homes: ["/home/tester", "/mnt/real-home"],
      agentDirs: ["/home/tester/.pi/agent", "/mnt/agent-real"],
    };
    expect(denyListHit("/mnt/agent-real/auth.json", ctx)).toBe(true);
    expect(denyListHit("/mnt/agent-real/web-hub/uploads/x", ctx)).toBe(true);
    expect(denyListHit("/mnt/real-home/.config/pi/x", ctx)).toBe(true);
    // ctx WITHOUT the canonical half still catches the default-shaped spellings via twins
    const degraded: PreviewDenyContext = { homes: ["/home/tester"], agentDirs: ["/home/tester/.pi/agent"] };
    expect(denyListHit("/mnt/real-home/.pi/agent/auth.json", degraded)).toBe(true); // .pi/agent/auth.json twin
    expect(denyListHit("/mnt/real-home/.config/pi/x", degraded)).toBe(true); // .config/pi twin
  });

  it("absolute prefixes (§2.3 v2 additions)", () => {
    for (const p of [
      "/etc/shadow",
      "/etc/shadow-",
      "/etc/gshadow",
      "/etc/gshadow-",
      "/etc/sudoers",
      "/etc/sudoers.d/some-rule",
      "/etc/ssl/private/server.key",
      "/etc/NetworkManager/system-connections/wifi.nmconnection",
      "/etc/wireguard/wg0.conf",
      "/root",
      "/root/.bashrc",
      "/var/lib/sss",
      "/var/lib/sss/mc",
    ]) {
      expect(denyListHit(p, CTX)).toBe(true);
    }
    // segment alignment: /root2 is NOT /root
    expect(denyListHit("/root2/x", CTX)).toBe(false);
    expect(denyListHit("/etc/shadowplay", CTX)).toBe(false);
  });

  it("single segments (incl. the v2 .pki addition)", () => {
    for (const seg of [
      ".ssh",
      ".gnupg",
      ".aws",
      ".azure",
      ".kube",
      ".docker",
      ".password-store",
      ".mozilla",
      ".thunderbird",
      ".terraform.d",
      ".pki",
    ]) {
      expect(denyListHit(`${HOME}/proj/${seg}/x`, CTX)).toBe(true);
      // home-independent: any prefix, including another user's home (U4 makes this reachable)
      expect(denyListHit(`/home/other/proj/${seg}/x`, CTX)).toBe(true);
    }
  });

  it("consecutive segment pairs (v1 + v2 additions)", () => {
    for (const pair of [
      ".config/gcloud",
      ".config/gh",
      ".config/hub",
      ".config/google-chrome",
      ".config/chromium",
      ".config/BraveSoftware",
      ".local/share/keyrings",
      ".git/config",
      ".cargo/credentials",
      ".cargo/credentials.toml",
      ".pi/agent/web-hub",
      ".pi/agent/auth.json",
      ".pi/agent/models.json",
      ".config/pi",
      ".config/op",
      ".config/rclone",
      ".config/sops",
      ".config/age",
      ".config/github-copilot",
      ".claude/.credentials.json",
      ".codex/auth.json",
      ".local/share/password-store",
    ]) {
      expect(denyListHit(`${HOME}/x/${pair}/y`, CTX)).toBe(true);
      expect(denyListHit(`${HOME}/x/${pair}`, CTX)).toBe(true);
      expect(denyListHit(`/home/other/${pair}/y`, CTX)).toBe(true); // home-independent twin
    }
    // non-consecutive must not hit
    expect(denyListHit(`${HOME}/.config/other/gh/hosts.yml`, CTX)).toBe(false);
  });

  it("basenames (incl. v2 additions)", () => {
    for (const base of [
      ".netrc",
      ".pgpass",
      ".git-credentials",
      ".npmrc",
      ".pypirc",
      ".bash_history",
      ".zsh_history",
      ".python_history",
      ".psql_history",
      ".mysql_history",
      ".node_repl_history",
      ".lesshst",
      ".viminfo",
      ".vault-token",
      "kubeconfig",
      ".terraformrc",
    ]) {
      expect(denyListHit(`${HOME}/proj/${base}`, CTX)).toBe(true);
    }
  });

  it("basename patterns (.env*, id_* keys, v2 ssh_host_*_key / *.tfstate)", () => {
    for (const base of [
      ".env",
      ".env.local",
      ".env.production",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
      "id_dsa",
      "id_rsa.pub",
      "ssh_host_ed25519_key",
      "ssh_host_rsa_key",
      "prod.tfstate",
      "prod.tfstate.backup",
    ]) {
      expect(denyListHit(`${HOME}/p/${base}`, CTX)).toBe(true);
    }
    expect(denyListHit(`${HOME}/p/id_foo`, CTX)).toBe(false);
    expect(denyListHit(`${HOME}/p/envy`, CTX)).toBe(false);
    expect(denyListHit(`${HOME}/p/ssh_host_ed25519_key.pub.txt`, CTX)).toBe(false);
    expect(denyListHit(`${HOME}/p/prod.tfstate.bak`, CTX)).toBe(false);
  });

  it("extensions, case-insensitive", () => {
    for (const base of ["cert.pem", "cert.PEM", "k.key", "a.p12", "b.pfx", "c.kdbx"]) {
      expect(denyListHit(`${HOME}/p/${base}`, CTX)).toBe(true);
    }
    expect(denyListHit(`${HOME}/p/pemx`, CTX)).toBe(false);
    expect(denyListHit(`${HOME}/p/cert.pemap`, CTX)).toBe(false);
  });

  it("U2 matrix: home as the request area — normal file ok, secrets denied", async () => {
    const home = scratch("wh-home-");
    const okFile = join(home, "notes", "todo.md");
    mkdirSync(join(home, "notes"));
    writeFileSync(okFile, "plain");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "config"), "Host *");
    writeFileSync(join(home, ".zsh_history"), "cmd");
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "x");

    const { a, fs } = admitter();
    const good = await a.admit({ path: okFile }, deadline(8000), neverAbort());
    expect(good.ok).toBe(true);
    if (good.ok) await good.fh.close();
    expect(fs.counts.realpath ?? 0).toBe(1); // the ok case really did fs work

    for (const secret of [
      join(home, ".ssh", "config"),
      join(home, ".zsh_history"),
      join(home, ".config", "gh", "hosts.yml"),
    ]) {
      const res = await a.admit({ path: secret }, deadline(8000), neverAbort());
      expect(res).toMatchObject({ ok: false, status: 403, reason: "denylist" });
    }
  });

  it("denylist re-check on the RESOLVED path (step 5): clean literal, denylisted target", async () => {
    const root = scratch();
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "config"), "Host *");
    mkdirSync(join(root, "pub"));
    symlinkSync(join(root, ".ssh", "config"), join(root, "pub", "leak")); // literal path is clean
    const { a } = admitter();
    const res = await a.admit({ path: join(root, "pub", "leak") }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, reason: "denylist" });
  });
});

// ---------------------------------------------------------------------------
// §2.6 — real-tmpdir symlink homes / custom agentDir / degradation
// ---------------------------------------------------------------------------

describe("admit: §2.6 home/agentDir canonical forms (real tmpdir)", () => {
  it("home is a symlink: BOTH spellings of agent secrets are denied", async () => {
    const t = scratch("wh-symhome-");
    const realHome = join(t, "real-home");
    mkdirSync(join(realHome, ".pi", "agent"), { recursive: true });
    writeFileSync(join(realHome, ".pi", "agent", "auth.json"), "{}");
    symlinkSync(realHome, join(t, "home-link"));

    // ctx carries literal+canonical (resolvePreviewDenyContext's product — built by hand here)
    const ctx: PreviewDenyContext = {
      homes: [join(t, "home-link"), realHome],
      agentDirs: [join(realHome, ".pi/agent")],
    };
    const { a } = admitter({ counts: {} }, { denyCtx: ctx });

    const viaLink = await a.admit({ path: join(t, "home-link", ".pi/agent/auth.json") }, deadline(8000), neverAbort());
    expect(viaLink).toMatchObject({ ok: false, reason: "denylist" }); // literal + twin both hit
    const viaReal = await a.admit({ path: join(realHome, ".pi/agent/auth.json") }, deadline(8000), neverAbort());
    expect(viaReal).toMatchObject({ ok: false, reason: "denylist" }); // twin hits even bare
  });

  it("a THIRD-party symlink into <home>/.config/pi ⇒ realpath hit ⇒ denied", async () => {
    const t = scratch("wh-third-");
    const realHome = join(t, "real-home");
    mkdirSync(join(realHome, ".config", "pi"), { recursive: true });
    writeFileSync(join(realHome, ".config", "pi", "web-search.env"), "KEY=x");
    symlinkSync(join(realHome, ".config", "pi"), join(t, "x")); // T/x → T/real-home/.config/pi

    const { a } = admitter(); // ctx is the fixture HOME — irrelevant: the TWIN catches this
    const res = await a.admit({ path: join(t, "x", "web-search.env") }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, reason: "denylist" });
  });

  it("custom PI_CODING_AGENT_DIR (itself a symlink): auth.json denied in BOTH spellings", async () => {
    const t = scratch("wh-customagent-");
    const realAgent = join(t, "real-agent");
    mkdirSync(realAgent, { recursive: true });
    writeFileSync(join(realAgent, "auth.json"), "{}");
    const customAgent = join(t, "custom-agent");
    symlinkSync(realAgent, customAgent);

    const ctx: PreviewDenyContext = { homes: [HOME], agentDirs: [customAgent, realAgent] };
    const { a } = admitter({ counts: {} }, { denyCtx: ctx });

    const viaLiteral = await a.admit({ path: join(customAgent, "auth.json") }, deadline(8000), neverAbort());
    expect(viaLiteral).toMatchObject({ ok: false, reason: "denylist" });
    const viaCanonical = await a.admit({ path: join(realAgent, "auth.json") }, deadline(8000), neverAbort());
    expect(viaCanonical).toMatchObject({ ok: false, reason: "denylist" });
  });

  it("DEGRADED ctx (realpath failed at startup, literal-only): the §2.3 twins still hold the line", async () => {
    const t = scratch("wh-degraded-");
    const realHome = join(t, "real-home");
    mkdirSync(join(realHome, ".config", "pi"), { recursive: true });
    writeFileSync(join(realHome, ".config", "pi", "web-search.env"), "KEY=x");

    // home's realpath failed ⇒ homes carries ONLY the literal "/home/tester" — a canonical
    // request must still be denied by the home-independent `.config/pi` twin (§2.1 invariant).
    const { a } = admitter();
    const res = await a.admit(
      { path: join(realHome, ".config", "pi", "web-search.env") },
      deadline(8000),
      neverAbort(),
    );
    expect(res).toMatchObject({ ok: false, status: 403, reason: "denylist" });
  });
});

// ---------------------------------------------------------------------------
// non-regular / unreadable
// ---------------------------------------------------------------------------

describe("admit: not-regular & unreadable", () => {
  it("FIFO ⇒ 415 not-regular (O_NONBLOCK open, fstat says not a file)", async () => {
    const root = scratch();
    const fifo = join(root, "pipe");
    execSync(`mkfifo '${fifo}'`);
    const { a } = admitter();
    const res = await a.admit({ path: fifo }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 415, code: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" });
  });

  it("directory ⇒ 415 not-regular (P1a: allowDir is not implemented yet, §3.1 lands in P1b)", async () => {
    const root = scratch();
    const sub = join(root, "sub");
    mkdirSync(sub);
    const { a } = admitter();
    const res = await a.admit({ path: sub, allowDir: true }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 415, reason: "not-regular" });
  });

  it("chmod 000 ⇒ 403 unreadable", async () => {
    const root = scratch();
    const f = okPath(root, "locked.txt");
    chmodSync(f, 0o000);
    const { a } = admitter();
    const res = await a.admit({ path: f }, deadline(8000), neverAbort());
    expect(res).toMatchObject({ ok: false, status: 403, code: "E_PREVIEW_DENIED", reason: "unreadable" });
    chmodSync(f, 0o600);
  });
});

// ---------------------------------------------------------------------------
// errno mapping through admission
// ---------------------------------------------------------------------------

describe("admit: errno mapping table", () => {
  const cases: Array<[string, number, string, string | undefined]> = [
    ["ENOENT", 404, "E_NOT_FOUND", undefined],
    ["ENOTDIR", 404, "E_NOT_FOUND", undefined],
    ["EACCES", 403, "E_PREVIEW_DENIED", "unreadable"],
    ["EPERM", 403, "E_PREVIEW_DENIED", "unreadable"],
    ["EMFILE", 503, "E_BUSY", undefined],
    ["ENFILE", 503, "E_BUSY", undefined],
    ["EAGAIN", 503, "E_BUSY", undefined],
    ["EIO", 500, "E_INTERNAL", undefined],
  ];
  for (const [code, status, errCode, reason] of cases) {
    it(`${code} on realpath(path) ⇒ ${status} ${errCode}`, async () => {
      const root = scratch();
      const file = okPath(root);
      const { a } = admitter({ counts: {}, failOn: { realpath: { call: 1, err: errnoError(code) } } });
      const res = await a.admit({ path: file }, deadline(8000), neverAbort());
      expect(res).toEqual(
        reason === undefined ? { ok: false, status, code: errCode } : { ok: false, status, code: errCode, reason },
      );
    });
  }

  it("ELOOP on open ⇒ 409", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a } = admitter({ counts: {}, failOn: { open: { call: 1, err: errnoError("ELOOP") } } });
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
  });

  it("EISDIR ⇒ 415 not-regular", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a } = admitter({ counts: {}, failOn: { open: { call: 1, err: errnoError("EISDIR") } } });
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 415, code: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" });
  });

  it("fail-closed to step 4: a realpath failure NEVER reaches the open (no rp ⇒ no step 6)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a, fs } = admitter({ counts: {}, failOn: { realpath: { call: 1, err: errnoError("ENOENT") } } });
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 404, code: "E_NOT_FOUND" });
    expect(fs.counts.open ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TOCTOU (HP2) — real syscalls, mutation injected between admission steps
// ---------------------------------------------------------------------------

describe("admit: TOCTOU (HP2)", () => {
  it("inode swapped between stat and open ⇒ 409 (dev/ino mismatch)", async () => {
    const root = scratch();
    const file = okPath(root, "f.txt", "old-content-longer");
    const replacement = join(root, "new.txt");
    writeFileSync(replacement, "new content");
    const { a } = admitter({
      counts: {},
      after: {
        stat: (p) => {
          if (p === file) renameSync(replacement, file); // swap AFTER stat captured the old inode
        },
      },
    });
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
  });

  it("final segment replaced by a symlink before open ⇒ 409 (ELOOP via O_NOFOLLOW)", async () => {
    const root = scratch();
    const file = okPath(root, "f.txt", "content");
    const { a } = admitter({
      counts: {},
      after: {
        realpath: (p) => {
          if (p === file) {
            rmSync(file);
            symlinkSync("/etc/hostname", file);
          }
        },
      },
    });
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
  });

  it("middle directory replaced by a symlink to a same-inode hardlink ⇒ 409 (readlink recheck)", async () => {
    const root = scratch();
    const mid = join(root, "a");
    mkdirSync(mid);
    const file = join(mid, "f.txt");
    writeFileSync(file, "payload");
    const elsewhere = scratch();
    const twin = join(elsewhere, "f.txt");
    linkSync(file, twin); // same inode behind the substituted path
    const { a } = admitter({
      counts: {},
      after: {
        realpath: (p) => {
          if (p === file) {
            rmSync(mid, { recursive: true });
            symlinkSync(elsewhere, mid);
          }
        },
      },
    });
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
  });

  it("readlink failing ⇒ 409 + warn (fail closed)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a, log } = admitter({ counts: {}, failOn: { readlink: { call: 1, err: errnoError("EIO") } } });
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 409, code: "E_PREVIEW_CHANGED" });
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("residual (R3): with procFdAvailable=false the readlink recheck is skipped entirely", async () => {
    const root = scratch();
    const mid = join(root, "a");
    mkdirSync(mid);
    const file = join(mid, "f.txt");
    writeFileSync(file, "payload");
    const elsewhere = scratch();
    linkSync(file, join(elsewhere, "f.txt"));
    const hooks: FsHooks = {
      counts: {},
      override: { procFdAvailable: false },
      after: {
        realpath: (p) => {
          if (p === file) {
            rmSync(mid, { recursive: true });
            symlinkSync(elsewhere, mid);
          }
        },
      },
    };
    const { a, fs } = admitter(hooks);
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true); // §4.3 step 12 skipped — the documented residual, pinned
    expect(fs.counts.readlink ?? 0).toBe(0);
    if (res.ok) await res.fh.close();
  });
});

// ---------------------------------------------------------------------------
// §5.3 hardlink pin
// ---------------------------------------------------------------------------

describe("admit: hardlink (§5.3 — not in the threat model, pinned)", () => {
  it("a hardlink anywhere pointing at a file elsewhere ⇒ admitted (200 path)", async () => {
    const root = scratch();
    const outside = scratch();
    const original = join(outside, "real.txt");
    writeFileSync(original, "shared content");
    const inside = join(root, "link.txt");
    linkSync(original, inside);
    const { a } = admitter();
    const res = await a.admit({ path: inside }, deadline(8000), neverAbort());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.size).toBe(14);
      await res.fh.close();
    }
  });
});

// ---------------------------------------------------------------------------
// budgets: per-step caps, lazy initiation, late-open recovery, abort, tracker
// ---------------------------------------------------------------------------

describe("admit: budgets & step racing", () => {
  const STEP_CAP = 80;
  const SLOW = 400;

  /** admitter whose fs is real except one injected delay; `h` wraps the opened handle so
   * `fh.stat()` itself can be the slow step. */
  const slowAdmitter = (method: FsMethodName, delayHandleStat = false) => {
    const hooks: FsHooks = { counts: {}, delayMs: { [method]: SLOW } as Partial<Record<FsMethodName, number>> };
    const fs = hookedFs(hooks);
    const wrappedOpen = async (p: string, flags: number): Promise<PreviewHandle> => {
      const h = await fs.open(p, flags);
      if (!delayHandleStat) return h;
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
      return {
        fd: h.fd,
        stat: async () => {
          await sleep(SLOW);
          return h.stat();
        },
        read: (b, o, l, pos) => h.read(b, o, l, pos),
        close: () => h.close(),
      };
    };
    const a = createFsAdmitter({
      denyCtx: CTX,
      tracker: createPreviewIoTracker(),
      fs: { ...fs, open: wrappedOpen },
      log: memLog(),
      now: Date.now,
      stepCapMs: STEP_CAP,
    });
    return { a, counts: fs.counts };
  };

  it.each([
    ["realpath(path)", "realpath", false],
    ["stat(rp)", "stat", false],
    ["open", "open", false],
    ["fh.stat()", "open", true], // handle-level stat is the slow step
    ["readlink(/proc/self/fd/N)", "readlink", false],
  ] as const)("slow %s ⇒ 504 E_DEADLINE at the step cap, not the 8s total", async (_name, method, wrapStat) => {
    const root = scratch();
    const file = okPath(root);
    const { a } = slowAdmitter(method, wrapStat);
    const t0 = Date.now();
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    const elapsed = Date.now() - t0;
    expect(res).toEqual({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(elapsed).toBeLessThan(STEP_CAP * 3);
  });

  it("exhausted deadline ⇒ 504 without initiating the fs call (lazy)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a, fs } = admitter();
    const res = await a.admit({ path: file }, deadline(0), neverAbort());
    expect(res).toEqual({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(fs.counts.realpath ?? 0).toBe(0);
  });

  it("a raced-out open that resolves late is closed (迟到回收)", async () => {
    const root = scratch();
    const file = okPath(root);
    const real = defaultPreviewFs();
    const late = new Promise<PreviewHandle>((resolve) => {
      const t = setTimeout(() => resolve(new FakeHandle(Buffer.from("late"))), 300);
      t.unref();
    });
    const fs = { ...real, open: () => late, counts: {} as Record<string, number> };
    const a = createFsAdmitter({
      denyCtx: CTX,
      tracker: createPreviewIoTracker(),
      fs,
      log: memLog(),
      now: Date.now,
      stepCapMs: 60,
    });
    const t0 = Date.now();
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(Date.now() - t0).toBeLessThan(250);
    const handle = await late;
    await new Promise((r) => setTimeout(r, 20));
    expect(handle.closeCount).toBe(1);
  });

  it("abort mid-step ⇒ silent result (status 0, E_ABORT)", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a } = admitter(
      { counts: {}, delayMs: { realpath: SLOW } as Record<string, number> },
      { stepCapMs: 10_000 },
    );
    const { signal, cancel } = abortAfter(60, "client-abort");
    const res = await a.admit({ path: file }, deadline(8000), signal);
    cancel();
    expect(res).toEqual({ ok: false, status: 0, code: "E_ABORT" });
  });

  it("pre-aborted signal ⇒ E_ABORT with zero fs calls", async () => {
    const root = scratch();
    const file = okPath(root);
    const { a, fs } = admitter();
    const ctl = new AbortController();
    ctl.abort("hub-close");
    const res = await a.admit({ path: file }, deadline(8000), ctl.signal);
    expect(res).toEqual({ ok: false, status: 0, code: "E_ABORT" });
    expect(Object.keys(fs.counts).filter((k) => (fs.counts[k] ?? 0) > 0)).toEqual([]);
  });

  it("steps 7/8 (sniff sample + JPEG continuation reads) race the same cap via previewFsStep", async () => {
    const dl = deadline(8000);
    const slow = new Promise<{ bytesRead: number }>(() => undefined);
    await expect(
      previewFsStep(() => slow, dl, neverAbort(), { stepCapMs: 60, now: Date.now, tracker: createPreviewIoTracker() }),
    ).rejects.toSatisfy(isPreviewIoError);
    expect(mapFsError(new PreviewIoError("deadline", "x"))).toEqual({
      kind: "response",
      body: { status: 504, code: "E_DEADLINE" },
    });
    // and the JPEG continuation variant: same helper, still inside the shared 8s budget
    await expect(
      previewFsStep(() => slow, dl, neverAbort(), { stepCapMs: 60, now: Date.now, tracker: createPreviewIoTracker() }),
    ).rejects.toSatisfy((e: unknown) => isPreviewIoError(e) && e.ioFail === "deadline");
  });
});

// ---------------------------------------------------------------------------
// §2.4 tracker circuit-breaker through a real admission
// ---------------------------------------------------------------------------

describe("admit: §2.4 tracker busy (zombie fs 熔断)", () => {
  it("two raced-out steps trip the shared tracker ⇒ the NEXT admission answers 503 E_BUSY", async () => {
    const tracker = createPreviewIoTracker(); // §2.4 default max = 2
    const root = scratch();
    const file = okPath(root);
    const log = memLog();
    const { a } = { a: createFsAdmitter({ denyCtx: CTX, tracker, log, now: Date.now, stepCapMs: 60 }) };

    // first admission: realpath hangs past the 60ms cap ⇒ raced out ⇒ 1 zombie (settle later)
    const hangFs = { ...defaultPreviewFs(), realpath: () => new Promise<string>(() => undefined) };
    const hanging = createFsAdmitter({ denyCtx: CTX, tracker, log, now: Date.now, fs: hangFs, stepCapMs: 60 });
    const first = await hanging.admit({ path: file }, deadline(8000), neverAbort());
    expect(first).toEqual({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(tracker.zombies).toBe(1);

    // second raced-out step on the SAME tracker ⇒ zombies = 2 = max
    const second = await hanging.admit({ path: file }, deadline(8000), neverAbort());
    expect(second).toEqual({ ok: false, status: 504, code: "E_DEADLINE" });
    expect(tracker.zombies).toBe(2);

    // third admission: busy is checked BEFORE lazy ⇒ 503 E_BUSY, no new fs work
    const res = await a.admit({ path: file }, deadline(8000), neverAbort());
    expect(res).toEqual({ ok: false, status: 503, code: "E_BUSY" });
  });

  it("busy maps with Retry-After semantics via mapFsError (503, retryAfterS 1)", () => {
    const m = mapFsError(new PreviewIoError("busy", "x"));
    expect(m).toEqual({ kind: "response", body: { status: 503, code: "E_BUSY", retryAfterS: 1 } });
  });
});
