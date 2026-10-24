/**
 * V6 — wiring of convert / export / import into the launcher (convert-plan r3/r3.1 §8.1 V6 row,
 * §3.4, §3.5, §4, §7.5). Three blocks:
 *  - unit: helper exports (ports, refusals, status lines, private relocation entry with fakes);
 *  - cli: the real bash entry with a private mktemp HOME (no gocryptfs needed — every case is decided
 *    before any mount);
 *  - real: a private vault relocated through `init --fix-settings` in the private setup mode (real
 *    gocryptfs + real unshare, fake passfile password; self-gated, shared gocryptfs test lock).
 * Nothing touches the user's ~/secure or ~/.pi: HOME is a temp dir for every child.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";
import { RealHarness, globalMounted, leaseFree, lookInside, realSkipReason } from "./private-real-harness.js";

const REPO = join(import.meta.dirname, "..", "..");
const BIN = join(REPO, "src", "secure", "bin", "pi-secure");
const HELPER = join(REPO, "src", "secure", "bin", "helper.mjs");
/* eslint-disable @typescript-eslint/no-explicit-any -- plain-JS modules, no typings by design */
const H: any = await import(pathToFileURL(HELPER).href);
const C: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "convert.mjs")).href);
const A: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "archive.mjs")).href);
/* eslint-enable @typescript-eslint/no-explicit-any */

const scratch: string[] = [];
function tmp(prefix = "ps-v6-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
});

function home(settings?: unknown): string {
  const h = join(tmp(), "home");
  mkdirSync(join(h, ".pi", "agent"), { recursive: true, mode: 0o700 });
  if (settings !== undefined) writeFileSync(join(h, ".pi", "agent", "pi-subagent.json"), JSON.stringify(settings));
  return h;
}
const settingsOf = (h: string) => JSON.parse(readFileSync(join(h, ".pi", "agent", "pi-subagent.json"), "utf8"));

function launcher(h: string, args: string[], { cwd = "/", extraEnv = {} as Record<string, string> } = {}) {
  const nodeBin = join(dirname(h), "nodebin");
  if (!existsSync(nodeBin)) {
    mkdirSync(nodeBin);
    symlinkSync(process.execPath, join(nodeBin, "node"));
  }
  const r = spawnSync(BIN, args, {
    cwd,
    env: {
      HOME: h,
      LANG: "C.UTF-8",
      TMPDIR: tmpdir(),
      ...extraEnv,
      PATH: `${nodeBin}:${extraEnv.PATH ?? "/usr/bin:/bin"}`,
    },
    encoding: "utf8",
    input: "",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const TXID = "00112233445566778899aabb";
const vaultObj = (extra: Record<string, unknown> = {}) => ({
  ...H.deriveVault("acme", "/h/.local/share/pi-toolkit-secure/acme", "/h/secure/acme"),
  ...extra,
});

// ─────────────────────────────────────────── unit ───────────────────────────────────────────

describe("V6 unit — USAGE, refusals, ports", () => {
  it("helper's convert usage lines are CONVERT_USAGE verbatim (indented), and USAGE lists export/import", () => {
    expect(H.CONVERT_USAGE_LINES).toBe(
      C.CONVERT_USAGE.split("\n")
        .map((l: string) => `  ${l}`)
        .join("\n"),
    );
    const r = spawnSync(process.execPath, [HELPER, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const l of [
      ...H.CONVERT_USAGE_LINES.split("\n"),
      "  pi-secure export <名字> <文件.tar>",
      "  pi-secure import <文件.tar> <名字> [--path <挂载点>] [--verify-password]",
      "  pi-secure import --resume <名字>",
      "  pi-secure import --abort  <名字>",
    ])
      expect(r.stdout).toContain(`${l}\n`);
    // the pre-V6 lines are still first and unchanged
    expect(
      r.stdout.startsWith("用法：\n  pi-secure init <name> [--path <挂载点>] [--private] [--fix-settings]\n"),
    ).toBe(true);
  });

  it("refuseUnfinished: pending ⇒ 76 (§3.5 text), relocate ⇒ 78 unless allowed, nothing ⇒ no throw", () => {
    const home0 = home();
    const ru = (v: unknown, o: Record<string, unknown> = {}) => H.refuseUnfinished(v, { home: home0, ...o });
    expect(() => ru(vaultObj())).not.toThrow();
    const conv = (() => {
      try {
        ru(vaultObj({ pending: "convert:0123456789abcdef" }));
      } catch (e) {
        return e as { code: number; message: string };
      }
    })();
    expect(conv?.code).toBe(76);
    expect(conv?.message).toBe(
      "保险库 acme 有未完成的转换（0123456789abcdef）：pi-secure convert --resume|--abort acme",
    );
    try {
      ru(vaultObj({ pending: `import:${TXID}` }), { allowRelocate: true });
      expect.unreachable();
    } catch (e) {
      expect((e as { code: number }).code).toBe(76);
      expect((e as Error).message).toContain(`未完成的导入（${TXID}）：pi-secure import --resume|--abort acme`);
    }
    const rel = { from: "/a/work", to: "/b/work", txid: TXID, phase: "pending" };
    try {
      ru(vaultObj({ relocate: rel }));
      expect.unreachable();
    } catch (e) {
      expect((e as { code: number }).code).toBe(78);
      expect((e as Error).message).toBe("保险库 acme 迁址未完成：pi-secure init acme --fix-settings 继续");
    }
    expect(() => ru(vaultObj({ relocate: rel }), { allowRelocate: true })).not.toThrow();
  });

  it("txnVaultLines: no keys ⇒ no line; each key ⇒ its line; backup only while it exists", () => {
    expect(H.txnVaultLines(vaultObj())).toEqual([]);
    const lines = H.txnVaultLines(
      vaultObj({
        pending: "convert:0123456789abcdef",
        relocate: { from: "/a/work", to: "/b/work", txid: TXID, phase: "memory" },
        origin: "/h/ai/acme",
        backup: "/h/ai/.acme.bak",
      }),
      { exists: (p: string) => p === "/h/ai/.acme.bak", quote: C.shellQuote },
    );
    expect(lines).toEqual([
      "  pending: convert:0123456789abcdef · 保险库 acme 有未完成的转换（0123456789abcdef）：pi-secure convert --resume|--abort acme",
      "  relocate: pending (memory) · /a/work → /b/work · pi-secure init acme --fix-settings",
      "  origin: /h/ai/acme",
      "  backup: /h/ai/.acme.bak (still present) · 确认保险库内容无误后自行删除：chmod -R u+w -- '/h/ai/.acme.bak' && rm -rf -- '/h/ai/.acme.bak'",
    ]);
    expect(H.txnVaultLines(vaultObj({ backup: "/h/gone" }), { exists: () => false })).toEqual([]);
    // without a quoter the line never carries a command
    expect(H.txnVaultLines(vaultObj({ backup: "/h/b" }), { exists: () => true })).toEqual([
      "  backup: /h/b (still present) · 确认保险库内容无误后自行删除",
    ]);
  });

  it("listAbortedLeftovers: only <name>.aborted-<hex> DIRECTORIES next to dir/mnt parents; name filter", () => {
    const h = home();
    const share = join(h, ".local", "share", "pi-toolkit-secure");
    const sec = join(h, "secure");
    const custom = join(h, "elsewhere");
    for (const d of [share, sec, custom]) mkdirSync(d, { recursive: true, mode: 0o700 });
    mkdirSync(join(share, "acme.aborted-0123456789abcdef"));
    mkdirSync(join(sec, "acme.aborted-0123456789abcdef"));
    mkdirSync(join(sec, "beta.aborted-deadbeef"));
    mkdirSync(join(custom, "gamma.aborted-cafebabe"));
    mkdirSync(join(sec, "acme.aborted-NOTHEX"));
    writeFileSync(join(sec, "acme.aborted-feedface"), ""); // a file, not a leftover dir
    symlinkSync(join(sec, "beta.aborted-deadbeef"), join(sec, "zeta.aborted-abcdef01")); // never followed
    mkdirSync(join(sec, "acme")); // a mount point: listed by name only, never entered
    expect(H.listAbortedLeftovers(h, [])).toEqual([
      join(share, "acme.aborted-0123456789abcdef"),
      join(sec, "acme.aborted-0123456789abcdef"),
      join(sec, "beta.aborted-deadbeef"),
    ]);
    // a registered vault's custom mnt parent is searched too
    expect(H.listAbortedLeftovers(h, [{ dir: join(share, "gamma"), mnt: join(custom, "gamma") }])).toContain(
      join(custom, "gamma.aborted-cafebabe"),
    );
    expect(H.listAbortedLeftovers(h, [], { only: "beta" })).toEqual([join(sec, "beta.aborted-deadbeef")]);
  });

  it("getVaultEntryRaw: absent ⇒ undefined, raw deep copy incl. txn keys, broken file throws 78", () => {
    expect(H.getVaultEntryRaw("acme", home())).toBeUndefined();
    const entry = { dir: "/d", mnt: "/m", pending: "convert:0123456789abcdef", future: { x: 1 } };
    const h = home({ secure: { vaults: { acme: entry } } });
    const got = H.getVaultEntryRaw("acme", h);
    expect(got).toEqual(entry);
    got.future.x = 2;
    expect(H.getVaultEntryRaw("acme", h).future.x).toBe(1);
    expect(H.getVaultEntryRaw("other", h)).toBeUndefined();
    expect(H.getVaultEntryRaw("acme", home({ other: 1 }))).toBeUndefined();
    const bad = home();
    writeFileSync(join(bad, ".pi", "agent", "pi-subagent.json"), "{not json");
    expect(() => H.getVaultEntryRaw("acme", bad)).toThrow(expect.objectContaining({ code: 78 }));
    expect(() => H.getVaultEntryRaw("acme", home({ secure: { vaults: [] } }))).toThrow(
      expect.objectContaining({ code: 78 }),
    );
  });

  it("leaseStateOf: missing/malformed lease ⇒ unknown; idle ⇒ free; flock held ⇒ held", async () => {
    const d = tmp();
    const v = H.deriveVault("acme", d, join(d, "mnt"));
    expect(await H.leaseStateOf(v)).toBe("unknown");
    writeFileSync(v.lease, "", { mode: 0o644 });
    chmodSync(v.lease, 0o644);
    expect(await H.leaseStateOf(v)).toBe("unknown"); // not 0600
    chmodSync(v.lease, 0o600);
    expect(await H.leaseStateOf(v)).toBe("free");
    const holder = spawn("flock", ["-x", v.lease, "sleep", "5"], { stdio: "ignore" });
    const pid = holder.pid!;
    try {
      let s = "";
      for (let i = 0; i < 50 && s !== "held"; i++) {
        s = await H.leaseStateOf(v);
        if (s !== "held") await new Promise((r) => setTimeout(r, 50));
      }
      expect(s).toBe("held");
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });

  it("launcherPorts carries every port convert.mjs documents (V4-report §1) as a function", () => {
    const p = H.launcherPorts(home());
    for (const k of [
      "registerVault",
      "patchVaultEntry",
      "removeVaultEntry",
      "getVaultEntry",
      "listVaults",
      "deriveVault",
      "defaultVaultDir",
      "defaultVaultMnt",
      "physicalPaths",
      "createLayout",
      "layoutPreflight",
      "initCipher",
      "unlockVault",
      "ensureVaultDirs",
      "syncProjectSettings",
      "probeMountState",
      "finalizeBounded",
      "leaseState",
      "preflight",
      "isTty",
      "prompt",
      "out",
      "err",
    ])
      expect(typeof p[k], k).toBe("function");
    expect(p.unlockVault).toBe(H.V0_PORTS.unlockVault);
    expect(p.listVaults()).toEqual([]);
  });

  it("origCwdFrom: only an absolute PI_SECURE_ORIG_CWD counts", () => {
    expect(H.origCwdFrom({ PI_SECURE_ORIG_CWD: "/a/b/../c" }, "/fb")).toBe("/a/c");
    expect(H.origCwdFrom({ PI_SECURE_ORIG_CWD: "" }, "/fb")).toBe("/fb");
    expect(H.origCwdFrom({ PI_SECURE_ORIG_CWD: "rel" }, "/fb")).toBe("/fb");
    expect(H.origCwdFrom({}, undefined)).toBeUndefined();
  });
});

describe("V6 unit — private relocation entry (setup mode) with fakes", () => {
  const relFor = (v: { mnt: string }) => ({
    from: "/old/secure/acme/work",
    to: join(H.physicalPaths(v).realMnt, "work"),
    txid: TXID,
    phase: "pending",
  });
  function world(over: Record<string, unknown> = {}) {
    const d = tmp();
    const base = H.deriveVault("acme", join(d, "dir"), join(d, "mnt"));
    const v = { ...base, private: true, relocate: relFor(base), ...over };
    const calls: unknown[][] = [];
    const deps = {
      probeMountState: async () => "absent",
      vaultInstanceView: async () => ({ state: "none" }),
      requireTty: () => calls.push(["tty"]),
      patchVaultEntry: (...a: unknown[]) => {
        calls.push(["patch", ...a]);
        return { kind: "ok" };
      },
      runPrivate: async (...a: unknown[]) => {
        calls.push(["runPrivate", ...a]);
        return 0;
      },
      relocateVault: async (o: unknown) => {
        calls.push(["relocateVault", o]);
        return { code: 0 };
      },
      out: () => {},
      err: () => {},
    };
    return { v, d, calls, deps };
  }

  it("normal vault ⇒ V5 relocateVault (nothing else)", async () => {
    const { v, deps, calls } = world({ private: undefined });
    expect(await H.fixSettingsRelocate(v, "/h", deps)).toBe(0);
    expect(calls).toEqual([["relocateVault", { name: "acme", home: "/h" }]]);
  });

  it("private: marks sessions → setup-mode runPrivate bound to the txid → synced → removes the marker", async () => {
    const { v, deps, calls } = world();
    expect(await H.fixSettingsRelocate(v, "/h", deps)).toBe(0);
    const guard = { relocateTxid: TXID };
    expect(calls).toEqual([
      ["tty"],
      ["patch", "acme", guard, { set: { relocate: { ...v.relocate, phase: "sessions" } } }, { home: "/h" }],
      ["runPrivate", v, { mode: "setup", relocateTxid: TXID }],
      ["patch", "acme", guard, { set: { relocate: { ...v.relocate, phase: "synced" } } }, { home: "/h" }],
      ["patch", "acme", guard, { remove: ["relocate"] }, { home: "/h" }],
    ]);
  });

  it("private: a failed setup run keeps the marker (exit passed through)", async () => {
    const { v, deps, calls } = world();
    deps.runPrivate = async () => 77;
    expect(await H.fixSettingsRelocate(v, "/h", deps)).toBe(77);
    expect(calls.filter((c) => c[0] === "patch")).toHaveLength(1); // only the "sessions" mark
  });

  it("private refusals happen before anything moves: mounted 76, live instance 76, to≠work 78, no TTY", async () => {
    for (const [over, depOver, code] of [
      [{}, { probeMountState: async () => "mounted" }, 76],
      [{}, { probeMountState: async () => "hung" }, 76],
      [{}, { vaultInstanceView: async () => ({ state: "session" }) }, 76],
      [{}, { vaultInstanceView: async () => ({ state: "unknown" }) }, 76],
      [{ relocate: { from: "/a/work", to: "/elsewhere/work", txid: TXID, phase: "pending" } }, {}, 78],
      [
        {},
        {
          requireTty: () => {
            throw Object.assign(new Error("no tty"), { code: 2 });
          },
        },
        2,
      ],
    ] as const) {
      const { v, deps, calls } = world(over);
      Object.assign(deps, depOver);
      await expect(H.fixSettingsRelocate(v, "/h", deps)).rejects.toMatchObject({ code });
      expect(calls.filter((c) => c[0] === "patch" || c[0] === "runPrivate")).toEqual([]);
    }
  });

  it("relocateInNs re-checks txid / pending / to and maps step failures; the abort hook lives only during the run", async () => {
    const d = tmp();
    const base = H.deriveVault("acme", join(d, "dir"), join(d, "mnt"));
    const realMnt = H.physicalPaths(base).realMnt;
    const rel = { from: "/old/work", to: join(realMnt, "work"), txid: TXID, phase: "sessions" };
    const S: { onRelocAbort?: () => void } = {};
    expect(await H.relocateInNs({ ...base, relocate: rel }, "ffffffff", realMnt, S)).toMatchObject({
      ok: false,
      code: 78,
    });
    expect(
      await H.relocateInNs({ ...base, relocate: rel, pending: "convert:0123456789abcdef" }, TXID, realMnt, S),
    ).toMatchObject({ ok: false, code: 78 });
    expect(await H.relocateInNs({ ...base }, TXID, realMnt, S)).toMatchObject({ ok: false, code: 78 });
    expect(await H.relocateInNs({ ...base, relocate: rel }, TXID, "/other/mnt", S)).toMatchObject({
      ok: false,
      code: 78,
    });
    let seen: unknown;
    const ok = await H.relocateInNs({ ...base, relocate: rel }, TXID, realMnt, S, {
      runSteps: async (o: { warnings: string[]; signal: AbortSignal; rel: unknown; realMnt: string }) => {
        seen = { rel: o.rel, realMnt: o.realMnt, hook: typeof S.onRelocAbort };
        o.warnings.push("w1");
        S.onRelocAbort?.();
        expect(o.signal.aborted).toBe(true);
      },
    });
    expect(ok).toEqual({ ok: true, notes: ["w1"] });
    expect(seen).toEqual({ rel, realMnt, hook: "function" });
    expect(S.onRelocAbort).toBeUndefined();
    const bad = await H.relocateInNs({ ...base, relocate: rel }, TXID, realMnt, S, {
      runSteps: async (o: { warnings: string[] }) => {
        o.warnings.push("before");
        throw new H.CliError(75, "会话迁址停滞");
      },
    });
    expect(bad).toEqual({ ok: false, code: 75, message: "会话迁址停滞", notes: ["before"] });
  });

  it("archive.runRelocateSteps: phase order and payloads (fake worker port)", async () => {
    const d = tmp();
    const v = H.deriveVault("acme", join(d, "dir"), join(d, "mnt"));
    const rel = { from: "/old/secure/acme/work", to: "/new/secure/acme/work", txid: TXID, phase: "pending" };
    const seq: string[] = [];
    const warnings: string[] = [];
    const r = await A.runRelocateSteps(
      { v, rel, realMnt: "/new/secure/acme", home: "/h", onPhase: (p: string) => seq.push(`phase:${p}`), warnings },
      {
        now: () => new Date(5),
        runWorker: async (op: string, payload: Record<string, unknown>) => {
          seq.push(`op:${op}`);
          if (op === "relocate-sessions") {
            expect(payload).toEqual({
              realMnt: "/new/secure/acme",
              mountCheck: true,
              rules: {
                from: rel.from,
                to: rel.to,
                fromSessionsDir: "/old/secure/acme/state/sessions/default",
                toSessionsDir: "/new/secure/acme/state/sessions/default",
              },
            });
            return { kind: "ok", result: { n: 1 } };
          }
          if (op === "relocate-memory")
            return { kind: "ok", result: { reason: "target-exists", fromSlug: "a", toSlug: "b" } };
          if (op === "relocate-settings") {
            expect(payload).toMatchObject({ want: v.sessionDir, home: "/h", now: 5, mountCheck: true });
            return { kind: "ok", result: { kind: "fixed", backup: "/x.bak" } };
          }
          return { kind: "ok", result: null };
        },
      },
    );
    expect(seq).toEqual([
      "phase:sessions",
      "op:relocate-sessions",
      "phase:memory",
      "op:relocate-memory",
      "phase:settings",
      "op:relocate-settings",
      "op:sync",
      "phase:synced",
    ]);
    expect(r.warnings).toBe(warnings);
    expect(warnings).toEqual([
      "memory 目标目录 state/memory/b 已存在，未合并（state/memory/a 保留）",
      "已备份原项目设置到 /x.bak",
    ]);
  });
});

// ─────────────────────────────────────────── cli ───────────────────────────────────────────

const CLI_OK = process.platform === "linux" && spawnSync("sh", ["-c", "command -v flock"]).status === 0;

describe.runIf(CLI_OK)("V6 cli — refusals through the real bash entry (decided before any mount)", () => {
  const rel = { from: "/old/secure/acme/work", to: "/new/secure/acme/work", txid: TXID, phase: "pending" };
  it("unlock / run / run --private / init --fix-settings refuse pending (76); unlock / run refuse relocate (78)", () => {
    const hp = home({ secure: { vaults: { acme: { pending: "convert:0123456789abcdef" } } } });
    for (const args of [
      ["unlock", "acme"],
      ["unlock", "acme", "--global"],
      ["run", "acme"],
      ["run", "acme", "--private"],
      ["init", "acme", "--fix-settings"],
    ]) {
      const r = launcher(hp, args);
      expect(r.code, args.join(" ") + r.err).toBe(76);
      expect(r.err).toBe(
        "pi-secure: 保险库 acme 有未完成的转换（0123456789abcdef）：pi-secure convert --resume|--abort acme\n",
      );
      expect(r.out).toBe("");
    }
    const hr = home({ secure: { vaults: { acme: { relocate: rel } } } });
    for (const args of [
      ["unlock", "acme"],
      ["run", "acme"],
      ["run", "acme", "--no-private"],
    ]) {
      const r = launcher(hr, args);
      expect(r.code, args.join(" ") + r.err).toBe(78);
      expect(r.err).toBe("pi-secure: 保险库 acme 迁址未完成：pi-secure init acme --fix-settings 继续\n");
    }
    // the settings were never written
    expect(settingsOf(hp).secure.vaults.acme).toEqual({ pending: "convert:0123456789abcdef" });
    expect(settingsOf(hr).secure.vaults.acme).toEqual({ relocate: rel });
  });

  it("private --fix-settings with relocate: to ≠ work ⇒ 78 before anything; non-TTY ⇒ 2, marker untouched", () => {
    const h1 = home({ secure: { vaults: { acme: { private: true, relocate: rel } } } });
    const a = launcher(h1, ["init", "acme", "--fix-settings"]);
    expect(a.code, a.err).toBe(78);
    expect(a.err).toContain("迁址目标 /new/secure/acme/work 与保险库当前工作目录");
    const h2 = home();
    const to2 = join(h2, "secure", "acme", "work"); // the derived default work (parent missing ⇒ literal)
    const entry = { private: true, relocate: { ...rel, to: to2 } };
    writeFileSync(
      join(h2, ".pi", "agent", "pi-subagent.json"),
      JSON.stringify({ secure: { vaults: { acme: entry } } }),
    );
    const b = launcher(h2, ["init", "acme", "--fix-settings"]);
    expect(b.code, b.err).toBe(2);
    expect(b.err).toMatch(/需要在终端里输入口令/);
    expect(settingsOf(h2).secure.vaults.acme).toEqual(entry);
  });

  it("status: the txn lines are APPENDED only — removing them yields the keyless output byte-for-byte", () => {
    const keyless = { dir: "/nonexist/v6/acme", mnt: "/nonexist/v6/m/acme" };
    const h0 = home({ secure: { vaults: { acme: keyless } } });
    const base = launcher(h0, ["status"]);
    expect(base.code, base.err).toBe(0);
    const backup = join(dirname(h0), "acme.backup");
    mkdirSync(backup);
    const h1 = home({
      secure: {
        vaults: {
          acme: {
            ...keyless,
            pending: `import:${TXID}`,
            relocate: { ...rel, phase: "settings" },
            origin: "/home/u/ai/acme",
            backup,
          },
        },
      },
    });
    const withKeys = launcher(h1, ["status"]);
    expect(withKeys.code, withKeys.err).toBe(0);
    const added = [
      `  pending: import:${TXID} · 保险库 acme 有未完成的导入（${TXID}）：pi-secure import --resume|--abort acme`,
      "  relocate: pending (settings) · /old/secure/acme/work → /new/secure/acme/work · pi-secure init acme --fix-settings",
      "  origin: /home/u/ai/acme",
      `  backup: ${backup} (still present) · 确认保险库内容无误后自行删除：chmod -R u+w -- ${C.shellQuote(backup)} && rm -rf -- ${C.shellQuote(backup)}`,
    ];
    for (const l of added) expect(withKeys.out).toContain(`${l}\n`);
    const norm = (t: string, h: string) => t.split(h).join("<H>");
    expect(
      norm(
        withKeys.out
          .split("\n")
          .filter((l) => !added.includes(l))
          .join("\n"),
        h1,
      ),
    ).toBe(norm(base.out, h0));
    // backup gone ⇒ its line disappears
    rmSync(backup, { recursive: true });
    expect(launcher(h1, ["status"]).out).not.toContain("  backup: ");
  });

  it("status: interrupted convert / import state files and .aborted-<txid> leftovers (filtered by name)", () => {
    const h = home({ secure: { vaults: {} } });
    const txn = join(h, ".local", "share", "pi-toolkit-secure", ".txn");
    C.ensureTxnDir(txn);
    const par = join(dirname(h), "proj");
    C.writeState(txn, {
      v: 1,
      txid: "0123456789abcdef",
      name: "acme",
      phase: "backed-up",
      origin: join(par, "acme"),
      originReal: join(par, "acme"),
      backup: join(par, ".acme.pi-secure-backup"),
      vault: { dir: join(h, ".local/share/pi-toolkit-secure/acme"), mnt: join(h, "secure/acme") },
      ids: { originParent: { dev: "1", ino: "2" }, origin: { dev: "1", ino: "3" } },
      createdAt: new Date(0).toISOString(),
    });
    writeFileSync(join(txn, "convert-beta.json"), "{broken", { mode: 0o600 });
    writeFileSync(join(txn, "import-gamma.json"), "{broken", { mode: 0o600 });
    mkdirSync(join(h, "secure", "delta.aborted-0123456789abcdef"), { recursive: true });
    const r = launcher(h, ["status"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("convert acme: interrupted (backed-up) · --resume|--abort\n");
    expect(r.out).toContain("convert beta: interrupted (invalid) · --resume|--abort\n");
    expect(r.out).toMatch(/^import gamma: state file unreadable \(.+\) · 人工检查 .+import-gamma\.json$/m);
    expect(r.out).toContain(
      `aborted: ${join(h, "secure", "delta.aborted-0123456789abcdef")} · 回滚留下的副本（内含本次拷贝的密文或数据），核对后可自行删除\n`,
    );
    // the block sits right before the warn lines
    const lines = r.out.trimEnd().split("\n");
    expect(lines.findIndex((l) => l.startsWith("warn: "))).toBeGreaterThan(
      lines.findIndex((l) => l.startsWith("aborted: ")),
    );
    // status <name> keeps only that name's lines
    const one = launcher(h, ["status", "acme"]);
    expect(one.out).toContain("convert acme: interrupted (backed-up)");
    expect(one.out).not.toMatch(/convert beta|import gamma|delta\.aborted/);
    // an empty .txn and no leftovers ⇒ nothing extra
    const h2 = home({ secure: { vaults: {} } });
    C.ensureTxnDir(join(h2, ".local", "share", "pi-toolkit-secure", ".txn"));
    expect(launcher(h2, ["status"]).out).not.toMatch(/^(convert|import|aborted)[ :]/m);
  });

  it("dispatch: convert / export / import reach their engines; argv errors are usage (2)", () => {
    const h = home({ secure: { vaults: {} } });
    const c = launcher(h, ["convert"]);
    expect(c.code).toBe(2);
    const ca = launcher(h, ["convert", "--abort", "nosuch"]);
    expect(ca.code).not.toBe(0);
    expect(ca.err).toMatch(/pi-secure convert：/);
    for (const args of [
      ["export"],
      ["export", "a"],
      ["export", "a", "b", "c"],
      ["import", "a"],
      ["import", "--abort"],
    ]) {
      const r = launcher(h, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toMatch(/用法：/);
    }
    const e = launcher(h, ["export", "nosuch", "/tmp/x.tar"]);
    expect(e.code).toBe(66);
    const ia = launcher(h, ["import", "--abort", "nosuch"]);
    expect([1, 66, 78]).toContain(ia.code); // archive's own answer (no state file to abort)
    expect(ia.out + ia.err).not.toMatch(/用法：/);
  });

  it("relative export path resolves against the user's cwd (launcher hands it over, then drops it)", () => {
    const h = home({ secure: { vaults: { acme: {} } } });
    const cwd = tmp("ps-v6-cwd-");
    writeFileSync(join(cwd, "exists.tar"), "x");
    const r = launcher(h, ["export", "acme", "exists.tar"], { cwd });
    expect(r.code, r.err).toBe(78);
    expect(r.err).toContain(`目标文件 ${join(cwd, "exists.tar")} 已存在——不覆盖`);
    // a stale variable from the caller's environment is overwritten by the launcher's own value
    const r2 = launcher(h, ["export", "acme", "exists.tar"], { cwd, extraEnv: { PI_SECURE_ORIG_CWD: "/" } });
    expect(r2.err).toContain(join(cwd, "exists.tar"));
  });
});

// ─────────────────────────────────────────── real ───────────────────────────────────────────

const REAL_SKIP = realSkipReason();

describe.skipIf(REAL_SKIP !== "")(
  "V6 real — private vault relocation in the setup mode (real gocryptfs + unshare)",
  () => {
    let release: (() => void) | undefined;
    const T = new RealHarness();
    beforeAll(async () => {
      release = await acquireGocryptfsTestLock();
    }, 250_000);
    afterAll(() => {
      T.cleanup();
      release?.();
    });

    it("init --fix-settings on a private vault with relocate: sessions/memory/sessionDir rewritten inside the ns, marker cleared, unmounted", async () => {
      const e = T.setup();
      const from = "/old/place/acme/work";
      const realWork = join(e.mnt, "work"); // temp HOME has no symlinked ancestors under mkdtemp
      const realTo = join(H.physicalPaths(H.deriveVault("acme", e.dir, e.mnt)).realMnt, "work");
      expect(realTo).toBe(realWork);
      const fromSlug = from.replace(/\//g, "-");
      const toSlug = realTo.replace(/\//g, "-");
      lookInside(e, (root) => {
        mkdirSync(join(root, "work", ".pi"), { recursive: true });
        writeFileSync(join(root, "work", ".pi", "settings.json"), JSON.stringify({ sessionDir: "/old/place/x" }));
        mkdirSync(join(root, "state", "sessions", "default"), { recursive: true });
        mkdirSync(join(root, "state", "memory", fromSlug), { recursive: true });
        writeFileSync(join(root, "state", "memory", fromSlug, "core.md"), "m\n");
        writeFileSync(
          join(root, "state", "sessions", "default", "s1.jsonl"),
          JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "t", cwd: `${from}/sub` }) +
            "\n" +
            JSON.stringify({ type: "message", text: from }) +
            "\n",
        );
      });
      const sf = join(e.h, ".pi", "agent", "pi-subagent.json");
      const rel = { from, to: realTo, txid: TXID, phase: "pending" };
      writeFileSync(sf, JSON.stringify({ secure: { vaults: { acme: { private: true, relocate: rel } } } }));
      // refused while unlock/run would open it
      expect(launcher(e.h, ["run", "acme"]).code).toBe(78);

      const f = await T.tty(e, "init acme --fix-settings", {}, { killAfterMs: 150_000 });
      expect(f.code, f.text).toBe(0);
      expect(f.text).toContain("在私有命名空间内迁址");
      expect(f.text).toContain("迁址完成");
      expect(settingsOf(e.h).secure.vaults.acme).toEqual({ private: true });
      expect(globalMounted(e.mnt)).toBe(false);
      expect(leaseFree(e)).toBe(true);
      expect(existsSync(join(e.dir, "private.json"))).toBe(false);
      lookInside(e, (root) => {
        const lines = readFileSync(join(root, "state", "sessions", "default", "s1.jsonl"), "utf8").split("\n");
        expect(JSON.parse(lines[0]!).cwd).toBe(`${realTo}/sub`);
        expect(JSON.parse(lines[1]!).text).toBe(from); // only the header is rewritten
        expect(existsSync(join(root, "state", "memory", toSlug, "core.md"))).toBe(true);
        expect(existsSync(join(root, "state", "memory", fromSlug))).toBe(false);
        expect(JSON.parse(readFileSync(join(root, "work", ".pi", "settings.json"), "utf8")).sessionDir).toBe(
          join(e.mnt, "state", "sessions", "default"),
        );
      });
    }, 240_000);

    it("refuses (76) while the vault is mounted elsewhere, without touching the marker", async () => {
      const e = T.setup();
      const realTo = join(H.physicalPaths(H.deriveVault("acme", e.dir, e.mnt)).realMnt, "work");
      const entry = { private: true, relocate: { from: "/old/acme/work", to: realTo, txid: TXID, phase: "pending" } };
      writeFileSync(
        join(e.h, ".pi", "agent", "pi-subagent.json"),
        JSON.stringify({ secure: { vaults: { acme: entry } } }),
      );
      // a global test-side mount right on the vault's mount point (fake passfile)
      const m = spawnSync(
        "gocryptfs",
        ["-q", "-nonempty", "-passfile", join(e.r, "pf"), "--", join(e.dir, "cipher"), e.mnt],
        {
          env: e.env,
        },
      );
      expect(m.status, String(m.stderr)).toBe(0);
      try {
        const f = await T.tty(e, "init acme --fix-settings", {}, { killAfterMs: 60_000 });
        expect(f.code, f.text).toBe(76);
        expect(f.text).toContain("私有库迁址要求未挂载");
        expect(settingsOf(e.h).secure.vaults.acme).toEqual(entry);
      } finally {
        spawnSync("fusermount3", ["-u", e.mnt]);
      }
    }, 120_000);
  },
);

// ───────────────────────────── security review V6 (#1–#4) ─────────────────────────────

describe("V6 review #1 — malformed transaction keys keep the vault and lock it (helper side)", () => {
  it("parse: each key independently; the vault is never dropped", () => {
    const cfg = H.parseSecureConfig(
      { secure: { vaults: { acme: { dir: "/d", mnt: "/m", pending: "convert:0123456789abcdef", backup: 12 } } } },
      "/h",
      { legacyMntDir: () => false },
    );
    expect(cfg.invalid).toEqual([]);
    expect(cfg.vaults[0]).toMatchObject({ name: "acme", pending: "convert:0123456789abcdef", txnInvalid: ["backup"] });
    expect(cfg.vaults[0].backup).toBeUndefined();
  });

  it("refuseUnfinished / innerMountTxnGate refuse txnInvalid with 78 (even with a matching token)", () => {
    const h = home();
    const v = vaultObj({ pending: "convert:0123456789abcdef", txnInvalid: ["backup"] });
    for (const f of [
      () => H.refuseUnfinished(v, { home: h }),
      () => H.refuseUnfinished(v, { home: h, allowRelocate: true }),
      () => H.innerMountTxnGate(v, "convert:0123456789abcdef", { home: h }),
    ])
      expect(f).toThrow(
        expect.objectContaining({ code: 78, message: expect.stringContaining("事务键损坏（backup）") }),
      );
  });

  it("cli: unlock / run / init refuse 78; status keeps the vault row and adds the ! line; lock is not refused", () => {
    const entry = { dir: "/nonexist/v6r/acme", mnt: "/nonexist/v6r/m/acme", origin: 5 };
    const h = home({ secure: { vaults: { acme: entry } } });
    for (const args of [
      ["unlock", "acme"],
      ["run", "acme"],
      ["init", "acme"],
      ["init", "acme", "--fix-settings"],
    ]) {
      const r = launcher(h, args);
      expect(r.code, args.join(" ") + r.err).toBe(78);
      expect(r.err).toContain("保险库 acme 的事务键损坏（origin），按锁定处理");
    }
    const st = launcher(h, ["status"]);
    expect(st.code, st.err).toBe(0);
    expect(st.out).toMatch(/^acme: locked {2}layout missing {2}mnt \/nonexist\/v6r\/m\/acme$/m);
    expect(st.out).toContain("  ! 保险库 acme 的事务键损坏（origin），按锁定处理");
    expect(st.out).not.toMatch(/secure\.vaults\.acme invalid/);
    expect(launcher(h, ["lock", "acme"]).err).not.toContain("事务键损坏");
    expect(settingsOf(h).secure.vaults.acme).toEqual(entry);
  });
});

describe("V6 review #2 — plain init never overwrites an unfinished transaction", () => {
  it("import staging (pending registered, <dir> not yet created) ⇒ init 76, nothing created, entry unchanged", () => {
    const h = home();
    const dir = join(h, ".local", "share", "pi-toolkit-secure", "acme");
    const mnt = join(h, "secure", "acme");
    const entry = { dir, mnt, pending: `import:${TXID}` };
    writeFileSync(join(h, ".pi", "agent", "pi-subagent.json"), JSON.stringify({ secure: { vaults: { acme: entry } } }));
    mkdirSync(join(dirname(dir), `.acme.import-${TXID}`), { recursive: true, mode: 0o700 }); // the staging dir
    const r = launcher(h, ["init", "acme"]);
    expect(r.code, r.err).toBe(76);
    expect(r.err).toBe(`pi-secure: 保险库 acme 有未完成的导入（${TXID}）：pi-secure import --resume|--abort acme\n`);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(mnt)).toBe(false);
    expect(settingsOf(h).secure.vaults.acme).toEqual(entry);
  });

  it("convert claimed before its layout (state file + pending) ⇒ init 76; a state file alone ⇒ 76 too", () => {
    const h = home({ secure: { vaults: { acme: { pending: "convert:0123456789abcdef" } } } });
    const txn = join(h, ".local", "share", "pi-toolkit-secure", ".txn");
    mkdirSync(txn, { recursive: true, mode: 0o700 });
    writeFileSync(join(txn, "convert-acme.json"), "{}", { mode: 0o600 });
    const a = launcher(h, ["init", "acme"]);
    expect(a.code, a.err).toBe(76);
    expect(settingsOf(h).secure.vaults.acme).toEqual({ pending: "convert:0123456789abcdef" });
    // claimed phase: the state file exists before the registration is written
    const h2 = home({ secure: { vaults: {} } });
    const txn2 = join(h2, ".local", "share", "pi-toolkit-secure", ".txn");
    mkdirSync(txn2, { recursive: true, mode: 0o700 });
    writeFileSync(join(txn2, "convert-acme.json"), "{}", { mode: 0o600 });
    const b = launcher(h2, ["init", "acme"]);
    expect(b.code, b.err).toBe(76);
    expect(b.err).toContain(`有未完成的转换状态文件（${join(txn2, "convert-acme.json")}）`);
    expect(existsSync(join(h2, "secure", "acme"))).toBe(false);
    expect(settingsOf(h2).secure.vaults).toEqual({});
  });

  it("registerVault CAS: expectAbsent loses to an earlier claim; expectEntry loses to a changed entry; nothing written", () => {
    const h = home({ secure: { vaults: {} } });
    const sf = join(h, ".pi", "agent", "pi-subagent.json");
    // the import claims first (inside the settings lock) …
    H.registerVault("acme", { dir: "/d", mnt: "/m" }, { home: h, expectAbsent: true, pending: `import:${TXID}` });
    const after = readFileSync(sf, "utf8");
    // … then init, which had read "unregistered", tries its own claim
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/m" }, { home: h, expectAbsent: true })).toThrow(
      /expectAbsent/,
    );
    // init that had read a stale entry: the entry changed since ⇒ CAS fails
    expect(() =>
      H.registerVault("acme", { dir: "/d", mnt: "/m" }, { home: h, expectEntry: { dir: "/d", mnt: "/m" } }),
    ).toThrow(/CAS 失败/);
    expect(readFileSync(sf, "utf8")).toBe(after);
    // the matching CAS succeeds (key order does not matter)
    H.registerVault(
      "acme",
      { dir: "/d2", mnt: "/m2" },
      { home: h, expectEntry: { pending: `import:${TXID}`, mnt: "/m", dir: "/d" } },
    );
    expect(settingsOf(h).secure.vaults.acme).toEqual({ dir: "/d2", mnt: "/m2" });
  });

  it("lost claim after createLayout: the skeleton is RENAMED aside (never deleted); identity / parent swaps leave everything", async () => {
    const h = home({ secure: { vaults: {} } });
    const v = H.deriveVault("acme", H.defaultVaultDir("acme", h), H.defaultVaultMnt("acme", h));
    const fixed = { now: new Date(2026, 9, 24, 13, 5, 9), rand: () => 0xbeef };
    const sfx = ".init-failed-20261024-130509-beef";
    // 1) the plain case: both halves move to siblings, contents untouched
    H.createLayout(v, { home: h });
    const ids = H.initSkeletonIds(v);
    const r1 = await H.setAsideInitSkeleton(v, ids, fixed);
    expect(r1.kept).toEqual([]);
    expect(r1.moved).toEqual([
      { from: v.dir, to: `${v.dir}${sfx}` },
      { from: v.mnt, to: `${v.mnt}${sfx}` },
    ]);
    expect(existsSync(v.dir) || existsSync(v.mnt)).toBe(false);
    expect(readdirSync(`${v.dir}${sfx}`).sort()).toEqual(["cipher", "mount.lease", "mount.lock"]);
    expect(readdirSync(`${v.mnt}${sfx}`).sort()).toEqual(["state", "work"]);
    // 2) target name already taken ⇒ that path stays exactly where it is (nothing replaced)
    H.createLayout(v, { home: h });
    const ids2 = H.initSkeletonIds(v);
    const r2 = await H.setAsideInitSkeleton(v, ids2, fixed);
    expect(r2.moved).toEqual([]);
    expect(r2.kept.map((k: { path: string }) => k.path)).toEqual([v.dir, v.mnt]);
    expect(readdirSync(v.dir).sort()).toEqual(["cipher", "mount.lease", "mount.lock"]);
    rmSync(`${v.dir}${sfx}`, { recursive: true });
    rmSync(`${v.mnt}${sfx}`, { recursive: true });
    // 3) after the check-time recording, <dir> is swapped for a foreign directory with data and
    //    <mnt>'s parent for a symlink to an outside dir: nothing of either is moved or deleted
    const outside = join(dirname(h), "outside");
    mkdirSync(join(outside, "acme"), { recursive: true });
    writeFileSync(join(outside, "acme", "precious"), "keep");
    // keep the recorded <dir> inode alive (renamed, not removed): a freed inode number can be handed
    // straight to the "foreign" directory below, which would then match the recorded identity
    renameSync(v.dir, `${v.dir}.recorded`);
    mkdirSync(join(v.dir, "cipher"), { recursive: true });
    writeFileSync(join(v.dir, "cipher", "gocryptfs.conf"), "{}");
    writeFileSync(join(v.dir, "mount.lock"), "other");
    const realSecure = join(dirname(h), "secure-real");
    renameSync(dirname(v.mnt), realSecure);
    symlinkSync(outside, dirname(v.mnt));
    const r3 = await H.setAsideInitSkeleton(v, ids2, fixed);
    expect(r3.moved).toEqual([]);
    expect(r3.kept.map((k: { path: string }) => k.path)).toEqual([v.dir, v.mnt]);
    expect(readFileSync(join(v.dir, "mount.lock"), "utf8")).toBe("other");
    expect(existsSync(join(v.dir, "cipher", "gocryptfs.conf"))).toBe(true);
    expect(readFileSync(join(outside, "acme", "precious"), "utf8")).toBe("keep");
    expect(readdirSync(outside).sort()).toEqual(["acme"]);
    expect(readdirSync(join(realSecure, "acme")).sort()).toEqual(["state", "work"]); // the real mnt untouched
    // 4) a skeleton whose content changed after the recording (same dir identity): moved WHOLE, nothing dropped
    rmSync(dirname(v.mnt));
    renameSync(realSecure, dirname(v.mnt));
    rmSync(v.dir, { recursive: true });
    rmSync(v.mnt, { recursive: true });
    H.createLayout(v, { home: h });
    const ids4 = H.initSkeletonIds(v);
    writeFileSync(join(v.mnt, "late-file"), "racer data");
    const r4 = await H.setAsideInitSkeleton(v, ids4, { ...fixed, rand: () => 0xcafe });
    expect(r4.moved.map((m: { from: string }) => m.from)).toEqual([v.dir, v.mnt]);
    expect(readFileSync(join(`${v.mnt}.init-failed-20261024-130509-cafe`, "late-file"), "utf8")).toBe("racer data");
  });

  it("init deletes only through removeInitVault's tombstone primitive; the claim-loss path still only renames (source pin)", () => {
    // V6 round 2 ruling 「init 不删任何东西」, narrowed by the init-cleanup ruling (2026-10-24):
    // cmdInit itself never unlinks/rmdirs; the lost-claim path renames aside; the ONLY deletes of
    // init's objects are removeOwnObject's unlink/rmdir of an identity-checked tombstone through a
    // pinned parent fd — never rmSync, never a recursive delete, never an absolute path.
    const src = readFileSync(HELPER, "utf8");
    expect(src).not.toMatch(/removeInitSkeleton/);
    const body = src.slice(
      src.indexOf("async function cmdInit("),
      src.indexOf("\nexport async function describeVault("),
    );
    expect(body).toContain("setAsideInitSkeleton(v, made)");
    expect(body).not.toMatch(/unlinkSync|rmSync|rmdirSync/);
    const fn = src.slice(src.indexOf("export async function setAsideInitSkeleton("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toMatch(/unlinkSync|rmSync|rmdirSync/);
    const block = src.slice(
      src.indexOf("// ───────────────────── init cleanup"),
      src.indexOf("export function createLayout("),
    );
    expect(block).not.toMatch(/rmSync|recursive: *true/);
    const deletes = block.match(/\b(unlinkSync|rmdirSync)\([^;]*;/g) ?? [];
    expect(deletes).toEqual(["rmdirSync(fdp(pfd, tomb));", "unlinkSync(fdp(pfd, tomb));"]);
    expect(block).toContain("const fdp = (fd, name) => `/proc/self/fd/${fd}/${name}`;");
    const roo = block.slice(block.indexOf("async function removeOwnObject("));
    expect(roo.slice(0, roo.indexOf("\n}\n"))).toContain(
      "T.renameNoReplace({ parent, from: name, to: tomb, expect, expectParent })",
    );
  });
});

describe("V6 review #3 — the inner __mount entry runs the transaction gate itself", () => {
  it("innerMountTxnGate: marker needs the CURRENT token; a token without a marker is refused", () => {
    const h = home();
    const rel = { from: "/a/work", to: "/b/work", txid: TXID, phase: "pending" };
    const g = (v: unknown, t?: string) => () => H.innerMountTxnGate(v, t, { home: h });
    expect(g(vaultObj())).not.toThrow();
    expect(g(vaultObj({ pending: "convert:0123456789abcdef" }), "convert:0123456789abcdef")).not.toThrow();
    expect(g(vaultObj({ relocate: rel }), TXID)).not.toThrow();
    expect(g(vaultObj({ pending: "convert:0123456789abcdef" }))).toThrow(expect.objectContaining({ code: 76 }));
    expect(g(vaultObj({ pending: "convert:0123456789abcdef" }), "convert:ffffffffffffffff")).toThrow(
      expect.objectContaining({ code: 76, message: expect.stringContaining("事务凭证与当前登记不符") }),
    );
    expect(g(vaultObj({ relocate: rel }))).toThrow(expect.objectContaining({ code: 78 }));
    expect(g(vaultObj(), "convert:0123456789abcdef")).toThrow(expect.objectContaining({ code: 76 }));
    const txn = join(h, ".local", "share", "pi-toolkit-secure", ".txn");
    mkdirSync(txn, { recursive: true, mode: 0o700 });
    writeFileSync(join(txn, "import-acme.json"), "{}", { mode: 0o600 });
    expect(g(vaultObj())).toThrow(expect.objectContaining({ code: 76, message: expect.stringContaining("状态文件") }));
  });

  it("cli: `pi-secure __mount <name>` on pending / relocate / state-file vaults is refused before any password prompt", () => {
    const binDir = join(tmp(), "fakebin");
    mkdirSync(binDir);
    const log = join(binDir, "calls.log");
    writeFileSync(
      join(binDir, "gocryptfs"),
      `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "gocryptfs 1.8.0; go-fuse 2.0.3"; exit 0; fi\necho "gocryptfs $*" >> "${log}"\nexit 12\n`,
      { mode: 0o755 },
    );
    const rel = { from: "/a/work", to: "/b/work", txid: TXID, phase: "pending" };
    for (const [entry, code, needle] of [
      [{ pending: "convert:0123456789abcdef" }, 76, "有未完成的转换（0123456789abcdef）"],
      [{ relocate: rel }, 78, "迁址未完成"],
      [{ backup: 3 }, 78, "事务键损坏（backup）"],
    ] as const) {
      const h = home({ secure: { vaults: { acme: entry } } });
      const r = launcher(h, ["__mount", "acme"], { extraEnv: { PATH: `${binDir}:/usr/bin:/bin` } });
      expect(r.code, r.err).toBe(code);
      expect(r.err).toContain(needle);
      expect(settingsOf(h).secure.vaults.acme).toEqual(entry);
    }
    const hs = home({ secure: { vaults: { acme: {} } } });
    const txn = join(hs, ".local", "share", "pi-toolkit-secure", ".txn");
    mkdirSync(txn, { recursive: true, mode: 0o700 });
    writeFileSync(join(txn, "convert-acme.json"), "{}", { mode: 0o600 });
    expect(launcher(hs, ["__mount", "acme"], { extraEnv: { PATH: `${binDir}:/usr/bin:/bin` } }).code).toBe(76);
    // a wrong / stray token and malformed inner argv
    const hp = home({ secure: { vaults: { acme: { pending: "convert:0123456789abcdef" } } } });
    expect(launcher(hp, ["__mount", "acme", "--txn", "convert:ffffffffffffffff"]).code).toBe(76);
    expect(launcher(hp, ["__mount", "acme", "--bogus"]).code).toBe(2);
    expect(existsSync(log)).toBe(false); // gocryptfs never ran
  });
});

describe("V6 review #4 — the printed backup cleanup command is shell-safe", () => {
  const nasty = [
    "/h/ai/.x'$(printf MARK)'y.pi-secure-backup",
    "/h/ai/O'Reilly backup",
    "/h/ai/a\nb; touch MARK",
    "/h/ai/`touch MARK`$HOME",
  ];
  it("txnVaultLines quotes with convert.mjs shellQuote; sh parses each quoted path back to ONE identical argument", () => {
    const d = tmp();
    for (const p of nasty) {
      const [line] = H.txnVaultLines(vaultObj({ backup: p }), { exists: () => true, quote: C.shellQuote });
      expect(line).toBe(
        `  backup: ${p} (still present) · 确认保险库内容无误后自行删除：chmod -R u+w -- ${C.shellQuote(p)} && rm -rf -- ${C.shellQuote(p)}`,
      );
      // parse only (never the chmod/rm): `set --` + printf of the argument count and value
      const r = spawnSync("sh", ["-c", `set -- ${C.shellQuote(p)}; printf '%s\\n%s' "$#" "$1"`], {
        cwd: d,
        encoding: "utf8",
      });
      expect(r.stdout).toBe(`1\n${p}`);
    }
    expect(existsSync(join(d, "MARK"))).toBe(false);
  });

  it("cli status prints the quoted command for a real backup dir named with ' and $( )", () => {
    const h = home();
    const backup = join(dirname(h), "x'$(printf MARK)'y.pi-secure-backup");
    mkdirSync(backup);
    writeFileSync(
      join(h, ".pi", "agent", "pi-subagent.json"),
      JSON.stringify({ secure: { vaults: { acme: { dir: "/nonexist/q/acme", mnt: "/nonexist/q/m", backup } } } }),
    );
    const r = launcher(h, ["status"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`chmod -R u+w -- ${C.shellQuote(backup)} && rm -rf -- ${C.shellQuote(backup)}\n`);
    expect(r.out).not.toContain(`-- '${backup}'`);
  });
});
