import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSecureDomainForTests, type SecureDomain } from "../../src/secure/domain.js";
import {
  SECURE_STATUS_KEY,
  bashTouchesVault,
  decideSwitch,
  decideToolCall,
  verifySessionFacts,
  wireSecureGuards,
} from "../../src/secure/guards.js";
import type { GitRunner } from "../../src/git/run.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "./helpers.js";

let v: FakeVault | undefined;
afterEach(() => {
  resetSecureDomainForTests();
  v?.cleanup();
  v = undefined;
});

function secure(): { v: FakeVault; d: SecureDomain } {
  v = makeFakeVault();
  return { v, d: freezeDomain(v).domain };
}
function plain(): { v: FakeVault; d: SecureDomain } {
  v = makeFakeVault();
  return { v, d: freezeDomain(v, { cwd: v.outside }).domain };
}

describe("D3 containWrites (secure: write/edit must stay inside the vault)", () => {
  it("write/edit inside the vault (relative, absolute, via the mount point, new subdirs) pass", () => {
    const { v, d } = secure();
    for (const path of [
      "a.txt",
      "sub/new/dir/b.ts",
      join(v.work, "c"),
      join(v.mnt, "work", "d"),
      join(v.state, "tmp", "x"),
    ])
      for (const tool of ["write", "edit"])
        expect(decideToolCall(d, undefined, tool, { path }, v.work)).toBeUndefined();
  });

  it("write/edit outside the vault are blocked (absolute, ../ escape, ~, @-prefixed)", () => {
    const { v, d } = secure();
    for (const path of [
      join(v.outside, "x"),
      "../../../outside/y",
      "~/leak.txt",
      `@${join(v.outside, "z")}`,
      "/tmp/q",
    ]) {
      const r = decideToolCall(d, undefined, "write", { path }, v.work, v.home);
      expect(r?.block, path).toBe(true);
      expect(r?.reason).toContain("保险库外");
    }
  });

  it("a symlink inside the vault pointing outside is resolved and blocked", async () => {
    const { v, d } = secure();
    const { symlinkSync } = await import("node:fs");
    symlinkSync(v.outside, join(v.work, "escape"));
    expect(decideToolCall(d, undefined, "edit", { path: "escape/f.txt" }, v.work)?.block).toBe(true);
  });

  it("the write zone is strictly below mnt/work or mnt/state: mnt root entries and the sentinel paths are blocked", () => {
    const { v, d } = secure();
    const mnt = v.mnt;
    for (const path of [join(mnt, "new-file"), join(mnt, "work"), join(mnt, "state"), mnt, join(v.dir, "cipher", "x")])
      expect(decideToolCall(d, undefined, "write", { path }, v.work)?.block, path).toBe(true);
    expect(decideToolCall(d, undefined, "write", { path: join(mnt, "work", "ok") }, v.work)).toBeUndefined();
    expect(decideToolCall(d, undefined, "write", { path: join(mnt, "state", "tmp", "ok") }, v.work)).toBeUndefined();
  });

  it("reads and bash are not restricted by D3", () => {
    const { v, d } = secure();
    expect(decideToolCall(d, undefined, "read", { path: "/etc/hosts" }, v.work)).toBeUndefined();
    expect(decideToolCall(d, undefined, "bash", { command: "cat /etc/hosts > /tmp/x" }, v.work)).toBeUndefined();
  });
});

describe("D4 foreignAccess (plain: no tool may touch a vault)", () => {
  it("path tools on the vault dir, mount point or cipher are blocked", () => {
    const { v, d } = plain();
    for (const tool of ["read", "write", "edit", "grep", "find", "ls"])
      for (const path of [join(v.work, "a"), join(v.mnt, "a"), join(v.dir, "cipher"), v.dir]) {
        const r = decideToolCall(d, undefined, tool, { path }, v.outside, v.home);
        expect(r?.block, `${tool} ${path}`).toBe(true);
        expect(r?.reason).toContain("pi-secure run acme");
      }
  });

  it("grep/find/ls without a path default to the cwd — inside a vault mount point ⇒ blocked", () => {
    const { v, d } = plain();
    expect(decideToolCall(d, undefined, "ls", {}, v.mnt)?.block).toBe(true);
    expect(decideToolCall(d, undefined, "ls", {}, v.outside)).toBeUndefined();
  });

  it("review #3: a LEGACY vault's entry link stays in the D4 known-address set (bash + path tools)", () => {
    v = makeFakeVault({ legacy: true });
    const d = freezeDomain(v, { cwd: v.outside }).domain;
    const link = v.link!;
    // the old entry path a plain session's bash command could name — absolute, ~/, $HOME/
    const rel = link.slice(v.home.length + 1);
    for (const command of [`cat ${link}/secret.txt`, `ls ~/${rel}`, `cd "$HOME/${rel}" && ls`])
      expect(decideToolCall(d, undefined, "bash", { command }, v.outside, v.home)?.block, command).toBe(true);
    // path tools through the link (literal AND canonical spellings)
    expect(decideToolCall(d, undefined, "read", { path: join(link, "a") }, v.outside, v.home)?.block).toBe(true);
    expect(decideToolCall(d, undefined, "grep", { path: link }, v.outside, v.home)?.block).toBe(true);
    // a BROKEN link (vault unmounted, link dangling) is still caught by the literal spelling
    rmSync(join(v.mnt, "work"), { recursive: true, force: true });
    expect(decideToolCall(d, undefined, "read", { path: join(link, "a") }, v.outside, v.home)?.block).toBe(true);
  });
  it("review #3: new-layout vaults carry no legacy link spelling (no overblocking)", () => {
    v = makeFakeVault();
    const d = freezeDomain(v, { cwd: v.outside }).domain;
    expect(d.vaults[0].vault.legacyLink).toBeUndefined();
    expect(bashTouchesVault("cat ~/secure/other/x", d.vaults, v.home)).toBeUndefined();
  });
  it("paths outside every vault pass", () => {
    const { v, d } = plain();
    expect(decideToolCall(d, undefined, "read", { path: join(v.outside, "f") }, v.outside)).toBeUndefined();
    expect(decideToolCall(d, undefined, "read", { path: `${v.dir}2/x` }, v.outside)).toBeUndefined();
  });

  it("bash mentioning a vault path (absolute, ~/, $HOME/) is blocked best-effort", () => {
    const { v, d } = plain();
    const rel = v.mnt.slice(v.home.length + 1);
    for (const command of [`cat ${v.work}/a`, `ls ~/${rel}`, `cd "$HOME/${rel}" && ls`, `tar c ${v.dir}`])
      expect(decideToolCall(d, undefined, "bash", { command }, v.outside, v.home)?.block, command).toBe(true);
    expect(decideToolCall(d, undefined, "bash", { command: `ls ${v.dir}2` }, v.outside, v.home)).toBeUndefined();
    expect(bashTouchesVault("echo hi", d.vaults, v.home)).toBeUndefined();
  });

  it("plain without any configured vault never blocks", () => {
    v = makeFakeVault({ settings: {} });
    const d = freezeDomain(v, { cwd: v.outside }).domain;
    expect(decideToolCall(d, undefined, "read", { path: join(v.work, "a") }, v.outside)).toBeUndefined();
  });
});

describe("LOCKED gate", () => {
  it("frozen locked or a runtime lock blocks every tool", () => {
    v = makeFakeVault();
    const locked = freezeDomain(v, { mountinfo: v.unmounted }).domain;
    expect(decideToolCall(locked, undefined, "read", { path: "x" }, v.outside)?.reason).toContain("锁定");
    const { d } = plain();
    expect(decideToolCall(d, "因为", "custom_tool", {}, "/")?.block).toBe(true);
  });
});

describe("session_start verification (plan §2.4 step 3)", () => {
  it("secure: cwd + session file/dir inside the vault ⇒ ok; any outside ⇒ LOCKED", () => {
    const { v, d } = secure();
    const mi = () => v.mounted;
    const ok = { cwd: join(v.work, "sub"), sessionFile: join(v.sessions, "s.jsonl"), sessionDir: v.sessions };
    expect(verifySessionFacts(d, ok, mi)).toBeUndefined();
    expect(verifySessionFacts(d, { ...ok, cwd: v.outside }, mi)).toContain("-C");
    expect(verifySessionFacts(d, { ...ok, sessionDir: join(v.home, ".pi", "agent", "sessions") }, mi)).toContain(
      "会话记录目录",
    );
    expect(verifySessionFacts(d, { ...ok, sessionFile: join(v.outside, "s.jsonl") }, mi)).toContain("会话文件");
  });

  it("secure + --no-session (no file, empty dir) is exempt from file/dir checks but not from cwd/mount", () => {
    const { v, d } = secure();
    const facts = { cwd: v.work, sessionFile: undefined, sessionDir: "" };
    expect(verifySessionFacts(d, facts, () => v.mounted)).toBeUndefined();
    expect(verifySessionFacts(d, facts, () => v.unmounted)).toContain("未挂载");
    expect(verifySessionFacts(d, { ...facts, cwd: v.outside }, () => v.mounted)).toBeDefined();
  });

  it("plain: a session file/dir or cwd inside a vault ⇒ LOCKED; otherwise ok", () => {
    const { v, d } = plain();
    const base = { cwd: v.outside, sessionFile: join(v.outside, "s.jsonl"), sessionDir: v.outside };
    expect(verifySessionFacts(d, base)).toBeUndefined();
    expect(verifySessionFacts(d, { ...base, sessionFile: join(v.sessions, "s.jsonl") })).toContain(
      "pi-secure run acme",
    );
    expect(verifySessionFacts(d, { ...base, cwd: v.mnt })).toBeDefined();
  });

  it("frozen locked ⇒ always LOCKED", () => {
    v = makeFakeVault();
    const d = freezeDomain(v, { mountinfo: v.unmounted }).domain;
    expect(verifySessionFacts(d, { cwd: v.work, sessionFile: undefined, sessionDir: "" })).toContain("未挂载");
  });
});

describe("session_before_switch (cross-domain resume/import targets)", () => {
  it("locked cancels every switch (with or without a target)", () => {
    v = makeFakeVault();
    const d = freezeDomain(v, { mountinfo: v.unmounted }).domain;
    expect(decideSwitch(d, join(v.sessions, "a.jsonl"))).toContain("锁定");
    expect(decideSwitch(d, join(v.outside, "a.jsonl"))).toContain("锁定");
    expect(decideSwitch(d, undefined)).toContain("锁定");
  });

  it("secure cancels targets outside the vault, plain cancels targets inside", () => {
    const s = secure();
    expect(decideSwitch(s.d, join(s.v.sessions, "a.jsonl"))).toBeUndefined();
    expect(decideSwitch(s.d, join(s.v.outside, "a.jsonl"))).toBeDefined();
    expect(decideSwitch(s.d, undefined)).toBeUndefined(); // /new: stays in the vault sessionDir
    resetSecureDomainForTests();
    s.v.cleanup();
    const p = plain();
    expect(decideSwitch(p.d, join(p.v.sessions, "a.jsonl"))).toContain("acme");
    expect(decideSwitch(p.d, join(p.v.outside, "a.jsonl"))).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------- */

type Handler = (event: unknown, ctx: unknown) => unknown;
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    pi: {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    emit: async (event: string, payload: unknown, ctx: unknown) => {
      let last: unknown;
      for (const h of handlers.get(event) ?? []) last = await h(payload, ctx);
      return last;
    },
  };
}
function fakeCtx(cwd: string, sessionFile: string | undefined, sessionDir: string) {
  const notes: Array<[string, string | undefined]> = [];
  const status: Array<[string, string | undefined]> = [];
  return {
    notes,
    status,
    ctx: {
      cwd,
      hasUI: true,
      ui: {
        notify: (m: string, t?: string) => notes.push([m, t]),
        setStatus: (k: string, t: string | undefined) => status.push([k, t]),
      },
      sessionManager: { getSessionFile: () => sessionFile, getSessionDir: () => sessionDir },
    },
  };
}
const noGit: GitRunner = async () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "not a repo" });

describe("wireSecureGuards (pi-facing assembly)", () => {
  it("child sessions get tool_call/input/user_bash/switch guards but no session_start", () => {
    const { d } = secure();
    const f = fakePi();
    wireSecureGuards(f.pi as never, { domain: d, isChildSession: true, git: noGit });
    expect([...f.handlers.keys()].sort()).toEqual(["input", "session_before_switch", "tool_call", "user_bash"]);
  });

  it("secure session: status `secure`, no lock, D3 enforced through the tool_call handler", async () => {
    const { v, d } = secure();
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, {
      domain: d,
      isChildSession: false,
      git: noGit,
      readMountinfo: () => v.mounted,
    });
    const c = fakeCtx(v.work, join(v.sessions, "s.jsonl"), v.sessions);
    await f.emit("session_start", {}, c.ctx);
    expect(w.lockedReason()).toBeUndefined();
    expect(c.status).toEqual([[SECURE_STATUS_KEY, "secure"]]);
    expect(await f.emit("input", { text: "hi", source: "interactive" }, c.ctx)).toBeUndefined();
    expect(
      await f.emit("tool_call", { toolName: "write", input: { path: join(v.outside, "x") } }, c.ctx),
    ).toMatchObject({
      block: true,
    });
    expect(await f.emit("tool_call", { toolName: "write", input: { path: "ok.txt" } }, c.ctx)).toBeUndefined();
  });

  it("LOCKED session: input handled, every tool blocked, user_bash refused, notify + secure:locked, no shutdown", async () => {
    const { v, d } = secure();
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, {
      domain: d,
      isChildSession: false,
      git: noGit,
      readMountinfo: () => v.mounted,
    });
    const c = fakeCtx(v.outside, join(v.outside, "s.jsonl"), v.outside);
    await f.emit("session_start", {}, c.ctx);
    expect(w.lockedReason()).toBeDefined();
    expect(c.status.at(-1)).toEqual([SECURE_STATUS_KEY, "secure:locked"]);
    expect(c.notes.some(([m, t]) => t === "error" && m.includes("/quit"))).toBe(true);
    for (const source of ["interactive", "rpc", "extension"])
      expect(await f.emit("input", { text: "x", source }, c.ctx)).toEqual({ action: "handled" });
    expect(await f.emit("tool_call", { toolName: "read", input: { path: "x" } }, c.ctx)).toMatchObject({ block: true });
    const bash = (await f.emit("user_bash", { command: "ls", excludeFromContext: false, cwd: "/" }, c.ctx)) as {
      result: { exitCode: number; output: string };
    };
    expect(bash.result.exitCode).toBe(1);
    expect(bash.result.output).toContain("锁定");
  });

  it("a later consistent session_start lifts the runtime lock", async () => {
    const { v, d } = secure();
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, {
      domain: d,
      isChildSession: false,
      git: noGit,
      readMountinfo: () => v.mounted,
    });
    await f.emit("session_start", {}, fakeCtx(v.outside, undefined, "").ctx);
    expect(w.lockedReason()).toBeDefined();
    await f.emit("session_start", {}, fakeCtx(v.work, undefined, "").ctx);
    expect(w.lockedReason()).toBeUndefined();
  });

  it("--no-session secure session is not locked", async () => {
    const { v, d } = secure();
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, {
      domain: d,
      isChildSession: false,
      git: noGit,
      readMountinfo: () => v.mounted,
    });
    await f.emit("session_start", {}, fakeCtx(v.work, undefined, "").ctx);
    expect(w.lockedReason()).toBeUndefined();
  });

  it("security review #1: unmounted mid-session ⇒ mnt-root and sentinel writes blocked, session turns LOCKED, input refused", async () => {
    const { v, d } = secure();
    const { rmSync, writeFileSync } = await import("node:fs");
    let mountinfo = v.mounted;
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, {
      domain: d,
      isChildSession: false,
      git: noGit,
      readMountinfo: () => mountinfo,
    });
    const c = fakeCtx(v.work, join(v.sessions, "s.jsonl"), v.sessions);
    await f.emit("session_start", {}, c.ctx);
    expect(w.lockedReason()).toBeUndefined();
    // `pi-secure lock` from another terminal: mountinfo loses the line, mnt/work + mnt/state become sentinels again
    mountinfo = v.unmounted;
    rmSync(join(v.mnt, "work"), { recursive: true, force: true });
    rmSync(join(v.mnt, "state"), { recursive: true, force: true });
    writeFileSync(join(v.mnt, "work"), "", { mode: 0o400 });
    writeFileSync(join(v.mnt, "state"), "", { mode: 0o400 });
    for (const path of [join(v.mnt, "new-file"), join(v.mnt, "work")]) {
      const r = (await f.emit("tool_call", { toolName: "write", input: { path } }, c.ctx)) as { block?: boolean };
      expect(r?.block, path).toBe(true);
    }
    expect(w.lockedReason()).toContain("未挂载");
    expect(c.status.at(-1)).toEqual([SECURE_STATUS_KEY, "secure:locked"]);
    expect(await f.emit("input", { text: "go on", source: "interactive" }, c.ctx)).toEqual({ action: "handled" });
    expect(await f.emit("tool_call", { toolName: "read", input: { path: "x" } }, c.ctx)).toMatchObject({ block: true });
  });

  it("security review #1: an unmount noticed first by input locks before the turn starts", async () => {
    const { v, d } = secure();
    let mountinfo = v.mounted;
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, {
      domain: d,
      isChildSession: false,
      git: noGit,
      readMountinfo: () => mountinfo,
    });
    const c = fakeCtx(v.work, undefined, "");
    await f.emit("session_start", {}, c.ctx);
    mountinfo = v.unmounted;
    expect(await f.emit("input", { text: "hi", source: "rpc" }, c.ctx)).toEqual({ action: "handled" });
    expect(w.lockedReason()).toBeDefined();
  });

  it("child sessions re-verify the mount too (no session_start there)", async () => {
    const { v, d } = secure();
    let mountinfo = v.mounted;
    const f = fakePi();
    wireSecureGuards(f.pi as never, { domain: d, isChildSession: true, git: noGit, readMountinfo: () => mountinfo });
    const c = fakeCtx(v.work, undefined, "");
    expect(await f.emit("tool_call", { toolName: "write", input: { path: "a.txt" } }, c.ctx)).toBeUndefined();
    mountinfo = v.unmounted;
    expect(await f.emit("tool_call", { toolName: "write", input: { path: "a.txt" } }, c.ctx)).toMatchObject({
      block: true,
    });
  });

  it("locked process: session_before_switch is always cancelled", async () => {
    v = makeFakeVault();
    const d = freezeDomain(v, { mountinfo: v.unmounted }).domain;
    const f = fakePi();
    wireSecureGuards(f.pi as never, { domain: d, isChildSession: false, git: noGit });
    const c = fakeCtx(v.outside, undefined, "");
    expect(await f.emit("session_before_switch", { reason: "new" }, c.ctx)).toEqual({ cancel: true });
  });

  it("plain process with a broken secure section: status `secure:invalid`, nothing blocked", async () => {
    v = makeFakeVault();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(v.settingsPath, "{corrupt");
    const d = freezeDomain(v, { cwd: v.outside }).domain;
    const f = fakePi();
    wireSecureGuards(f.pi as never, { domain: d, isChildSession: false, git: noGit });
    const c = fakeCtx(v.outside, undefined, "");
    await f.emit("session_start", {}, c.ctx);
    expect(c.status).toEqual([[SECURE_STATUS_KEY, "secure:invalid"]]);
    expect(await f.emit("input", { text: "x", source: "interactive" }, c.ctx)).toBeUndefined();
  });

  it("session_before_switch cancels a cross-domain target with a notice", async () => {
    const { v, d } = secure();
    const f = fakePi();
    wireSecureGuards(f.pi as never, { domain: d, isChildSession: false, git: noGit });
    const c = fakeCtx(v.work, undefined, "");
    expect(
      await f.emit("session_before_switch", { reason: "resume", targetSessionFile: join(v.outside, "o.jsonl") }, c.ctx),
    ).toEqual({ cancel: true });
    expect(c.notes.length).toBe(1);
  });

  it("R9: warns once when git's common dir lies outside the vault (bounded git call)", async () => {
    const { v, d } = secure();
    mkdirSync(join(v.outside, ".git"), { recursive: true });
    const git = vi.fn<GitRunner>(async () => ({
      code: 0,
      stdout: `${join(v.outside, ".git")}\n`,
      stdoutCapped: false,
      stderr: "",
    }));
    const f = fakePi();
    wireSecureGuards(f.pi as never, { domain: d, isChildSession: false, git, readMountinfo: () => v.mounted });
    const c = fakeCtx(v.work, undefined, "");
    await f.emit("session_start", {}, c.ctx);
    await vi.waitFor(() => expect(c.notes.some(([m, t]) => t === "warning" && m.includes("common-dir"))).toBe(true));
    expect(git).toHaveBeenCalledWith(["rev-parse", "--git-common-dir"], expect.objectContaining({ timeoutMs: 3_000 }));
  });

  it("no warning when the common dir is inside the vault", async () => {
    const { v, d } = secure();
    const git: GitRunner = async () => ({ code: 0, stdout: ".git\n", stdoutCapped: false, stderr: "" });
    const f = fakePi();
    wireSecureGuards(f.pi as never, { domain: d, isChildSession: false, git, readMountinfo: () => v.mounted });
    const c = fakeCtx(v.work, undefined, "");
    await f.emit("session_start", {}, c.ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.notes).toEqual([]);
  });
});

// ── private-plan §6.1 (N3): D4 pins for /proc/<pid>/root-style vault access ─────────────────
//
// A same-uid process can reach a private mount through `/proc/<pid>/root/<vault>/…` (KNOWN
// residual R20 — the vault CONTENT stays readable that way). What D4 must still guarantee in a
// PLAIN session: naming that spelling through a path tool or bash text is blocked. The mechanism
// is realpath resolution (canonicalPath follows the symlink chain exactly like /proc/<pid>/root),
// pinned here with a real directory symlink standing in for the proc root.

describe("D4 vs /proc/<pid>/root spellings (private-plan §6.1)", () => {
  it("read/grep through a /proc-root-style symlink into the vault is blocked (realpath resolution)", () => {
    const { v, d } = plain();
    // a directory symlink standing in for /proc/<pid>/root → resolves through to the vault
    const fakeRoot = join(v.tmp, "fakeroot");
    symlinkSync(v.home, fakeRoot);
    const through = join(fakeRoot, "secure", "acme", "work", "secret.txt");
    for (const tool of ["read", "grep", "ls", "find"]) {
      const r = decideToolCall(d, undefined, tool, { path: through }, v.outside, v.home);
      expect(r?.block, tool).toBe(true);
      expect(r?.reason).toContain("acme");
    }
    // same spelling WITHOUT the indirection stays blocked too (absolute path form)
    expect(decideToolCall(d, undefined, "read", { path: join(v.mnt, "work", "x") }, v.outside, v.home)?.block).toBe(
      true,
    );
  });

  it("bash text naming the /proc-root spelling is caught by the substring scan", () => {
    const { v, d } = plain();
    const home = v.home;
    const cmd = `cat /proc/1234/root${join(home, "secure", "acme", "work", "secret.txt")} > /tmp/leak`;
    const r = decideToolCall(d, undefined, "bash", { command: cmd }, v.outside, v.home);
    expect(r?.block).toBe(true);
    expect(bashTouchesVault(cmd, d.vaults, v.home)?.vault.name).toBe("acme");
  });
});

/* ---------------------------------------------------------------------------------------- */

describe("recheckForWrite (web-hub-cmd-history plan §4.3/§5.4 M1, A1 — read-only pre-write query)", () => {
  it("secure + mounted ⇒ undefined (writable); a vanished mount enters LOCKED and returns the reason", async () => {
    const { v, d } = secure();
    let mountinfo = v.mounted;
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, {
      domain: d,
      isChildSession: false,
      git: noGit,
      readMountinfo: () => mountinfo,
    });
    const c = fakeCtx(v.work, join(v.sessions, "s.jsonl"), v.sessions);
    await f.emit("session_start", {}, c.ctx);
    expect(w.recheckForWrite(c.ctx)).toBeUndefined();
    // `pi-secure lock` from another terminal — the recorder's write would land on a plaintext dir
    mountinfo = v.unmounted;
    const reason = w.recheckForWrite(c.ctx);
    expect(reason).toContain("未挂载");
    expect(w.lockedReason()).toBe(reason); // LOCKED actually flipped — same as tool_call/input
    expect(c.status.at(-1)).toEqual([SECURE_STATUS_KEY, "secure:locked"]);
  });

  it("plain-with-vaults domain ⇒ no mount recheck at all, stays writable", () => {
    const { d } = plain();
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, { domain: d, isChildSession: true, git: noGit });
    expect(w.recheckForWrite(undefined)).toBeUndefined();
  });

  it("no ctx ⇒ NO recheck, just the current verdict (never throws, never fabricates)", async () => {
    const { v, d } = secure();
    let mountinfo = v.mounted;
    const f = fakePi();
    const w = wireSecureGuards(f.pi as never, {
      domain: d,
      isChildSession: false,
      git: noGit,
      readMountinfo: () => mountinfo,
    });
    const c = fakeCtx(v.work, undefined, "");
    await f.emit("session_start", {}, c.ctx);
    mountinfo = v.unmounted;
    // without a ctx there is nothing to notify — the query only reports the CURRENT verdict
    expect(w.recheckForWrite(undefined)).toBeUndefined();
    // a real tool_call (which does carry a ctx) flips LOCKED; from then on even a ctx-less
    // query sees it
    await f.emit("tool_call", { toolName: "read", input: { path: "x" } }, c.ctx);
    expect(w.recheckForWrite(undefined)).toContain("未挂载");
    void v;
  });
});
