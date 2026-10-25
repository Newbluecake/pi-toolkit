/**
 * V6 — plugin side of the convert/import transaction keys (convert-plan r3 §4, §7.5 G1/G4):
 * `pending` / `relocate` ⇒ the domain judges the vault locked; `origin` joins D4's bash spellings
 * (literal / `~` / physical); `/secure status` gains a line per present key. Without the keys every
 * output is unchanged (the parity fixture pins the parse side for both implementations).
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeSecureDomain,
  resetSecureDomainForTests,
  secureConfigNsFactor,
  vaultRoots,
} from "../../src/secure/domain.js";
import { bashTouchesVault, decideToolCall, secureGuardsNeeded, vaultSpellings } from "../../src/secure/guards.js";
import { renderSecureStatus, vaultTxnLines } from "../../src/secure/command.js";
import { parseSecureConfig } from "../../src/secure/config.js";
import { makeFakeVault, type FakeVault } from "./helpers.js";

let v: FakeVault | undefined;
afterEach(() => {
  resetSecureDomainForTests();
  v?.cleanup();
  v = undefined;
});

const TXID = "00112233445566778899aabb";

function judge(fv: FakeVault, cwd: string) {
  return computeSecureDomain({
    env: {},
    cwd,
    home: fv.home,
    settingsPath: fv.settingsPath,
    readMountinfo: () => fv.mounted,
  });
}
function withEntry(fv: FakeVault, extra: Record<string, unknown>): void {
  writeFileSync(
    fv.settingsPath,
    JSON.stringify({ secure: { vaults: { acme: { dir: fv.dir, mnt: fv.mnt, ...extra } } } }),
  );
}

describe("V6 domain: unfinished transactions lock the vault", () => {
  it("pending ⇒ locked even though mounted (cwd and PI_SECURE_VAULT)", () => {
    v = makeFakeVault();
    withEntry(v, { pending: "convert:0123456789abcdef" });
    const d = judge(v, v.work);
    expect(d.kind).toBe("locked");
    if (d.kind === "locked") {
      expect(d.reason).toContain("有未完成的转换/导入（convert:0123456789abcdef）");
      expect(d.vaultName).toBe("acme");
    }
    const e = computeSecureDomain({
      env: { PI_SECURE_VAULT: "acme" },
      cwd: v.outside,
      home: v.home,
      settingsPath: v.settingsPath,
      readMountinfo: () => v!.mounted,
    });
    expect(e.kind).toBe("locked");
  });

  it("relocate ⇒ locked; no keys ⇒ secure as before", () => {
    v = makeFakeVault();
    withEntry(v, { relocate: { from: "/a/work", to: v.work, txid: TXID, phase: "pending" } });
    const d = judge(v, v.work);
    expect(d.kind).toBe("locked");
    if (d.kind === "locked") expect(d.reason).toContain("迁址未完成：先执行 pi-secure init acme --fix-settings");
    withEntry(v, { origin: join(v.outside, "proj"), backup: join(v.outside, ".proj.bak") });
    expect(judge(v, v.work).kind).toBe("secure");
  });

  it("vaultRoots carries originReal ONLY when origin is set (deep-equal shape otherwise)", () => {
    v = makeFakeVault();
    const cfg = parseSecureConfig({ secure: { vaults: { acme: { dir: v.dir, mnt: v.mnt } } } }, v.home);
    const r = vaultRoots(cfg.vaults[0]!);
    expect(Object.keys(r).sort()).toEqual(["mntReal", "root", "vault"]);
    // origin under a symlinked parent: the physical spelling resolves the PARENT only
    const realParent = join(v.tmp, "data", "ai");
    mkdirSync(realParent, { recursive: true });
    symlinkSync(join(v.tmp, "data", "ai"), join(v.tmp, "ai"));
    symlinkSync(v.work, join(realParent, "proj")); // the convert symlink itself is never followed
    const cfg2 = parseSecureConfig(
      { secure: { vaults: { acme: { dir: v.dir, mnt: v.mnt, origin: join(v.tmp, "ai", "proj") } } } },
      v.home,
    );
    expect(vaultRoots(cfg2.vaults[0]!).originReal).toBe(join(realParent, "proj"));
  });
});

describe("V6 guards: origin spellings in plain sessions (G4)", () => {
  it("no origin ⇒ spellings unchanged; origin ⇒ literal, ~, $HOME and physical forms", () => {
    v = makeFakeVault();
    const before = vaultSpellings(judge(v, v.outside).vaults[0]!, v.home);
    const origin = join(v.home, "ai", "acme");
    const realParent = join(v.tmp, "real-ai");
    mkdirSync(realParent, { recursive: true });
    symlinkSync(realParent, join(v.home, "ai"));
    symlinkSync(v.work, join(realParent, "acme"));
    withEntry(v, { origin });
    const d = judge(v, v.outside);
    expect(d.kind).toBe("plain");
    const after = vaultSpellings(d.vaults[0]!, v.home);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      origin,
      "~/ai/acme",
      "$HOME/ai/acme",
      "${HOME}/ai/acme",
      join(realParent, "acme"),
    ]);
    for (const cmd of [
      "cat ~/ai/acme/notes.md",
      `ls ${origin}`,
      "cd $HOME/ai/acme && make",
      `cat ${realParent}/acme/x`,
    ])
      expect(bashTouchesVault(cmd, d.vaults, v.home)?.vault.name, cmd).toBe("acme");
    expect(bashTouchesVault("cat ~/ai/acme-other/x", d.vaults, v.home)).toBeUndefined();
    // path tools already follow the symlink into the mount (§4 「无需改」)
    const t = decideToolCall(d, undefined, "read", { path: join(origin, "x") }, v.outside, v.home);
    expect(t?.block).toBe(true);
  });
});

describe("V6 /secure status lines", () => {
  it("vaultTxnLines: one line per present key; backup only while it exists", () => {
    v = makeFakeVault();
    const base = parseSecureConfig({ secure: { vaults: { acme: { dir: v.dir, mnt: v.mnt } } } }, v.home).vaults[0]!;
    expect(vaultTxnLines(base)).toEqual([]);
    const full = {
      ...base,
      pending: `import:${TXID}`,
      relocate: { from: "/a/work", to: "/b/work", txid: TXID, phase: "memory" },
      origin: "/h/ai/acme",
      backup: "/h/ai/.acme.bak",
    };
    expect(vaultTxnLines(full, () => true)).toEqual([
      `    pending: import:${TXID}（未完成的转换/导入，保险库不可用：pi-secure convert|import --resume|--abort acme）`,
      "    relocate: pending (memory)（迁址未完成：pi-secure init acme --fix-settings）",
      "    origin: /h/ai/acme",
      "    backup: /h/ai/.acme.bak (still present)（确认保险库内容无误后请自行删除这份明文备份）",
    ]);
    expect(vaultTxnLines(full, () => false)).toHaveLength(3);
  });

  it("renderSecureStatus appends the lines under the vault row and is unchanged without keys", () => {
    v = makeFakeVault();
    const agentDir = join(v.tmp, "agent");
    mkdirSync(agentDir, { recursive: true });
    const render = () =>
      renderSecureStatus({
        domain: judge(v!, v!.outside),
        runtimeLock: undefined,
        agentDir,
        packageRoot: "/pkg",
        env: {},
        readMountinfo: () => v!.mounted,
        existsPrivateRecord: () => false,
        existsBackup: () => true,
      });
    const plainText = render();
    withEntry(v, { origin: "/h/ai/acme", backup: "/h/ai/.acme.bak" });
    const withKeys = render();
    const lines = withKeys.split("\n");
    const row = lines.findIndex((l) => l.startsWith("  - acme："));
    expect(lines[row + 1]).toBe("    origin: /h/ai/acme");
    expect(lines[row + 2]).toBe(
      "    backup: /h/ai/.acme.bak (still present)（确认保险库内容无误后请自行删除这份明文备份）",
    );
    expect(lines.filter((_, i) => i !== row + 1 && i !== row + 2).join("\n")).toBe(plainText);
  });
});

describe("V6 review #1 — malformed transaction keys fail CLOSED (the vault stays, judged locked)", () => {
  it("valid pending + malformed backup: the vault is kept with its pending, cwd ⇒ locked", () => {
    v = makeFakeVault();
    withEntry(v, { pending: "convert:0123456789abcdef", backup: 12 });
    const d = judge(v, join(v.work, "sub"));
    expect(d.kind).toBe("locked");
    if (d.kind === "locked") expect(d.reason).toContain("事务键损坏（backup）");
    expect(d.vaults).toHaveLength(1);
    expect(d.vaults[0]!.vault.pending).toBe("convert:0123456789abcdef");
    expect(d.config.invalid).toEqual([]);
  });

  for (const [what, extra] of [
    ["origin", { origin: "relative/x" }],
    ["backup", { backup: "~" }],
    ["pending", { pending: 42 }],
    ["relocate", { relocate: { from: "/a/work" } }],
  ] as const) {
    it(`malformed ${what} alone: cwd ⇒ locked, PI_SECURE_VAULT ⇒ locked, plain session still guarded`, () => {
      v = makeFakeVault();
      withEntry(v, extra);
      const d = judge(v, v.work);
      expect(d.kind).toBe("locked");
      if (d.kind === "locked") expect(d.reason).toContain(`事务键损坏（${what}）`);
      const e = computeSecureDomain({
        env: { PI_SECURE_VAULT: "acme" },
        cwd: v.outside,
        home: v.home,
        settingsPath: v.settingsPath,
        readMountinfo: () => v!.mounted,
      });
      expect(e.kind).toBe("locked");
      // a plain session elsewhere: the vault is still in the protected set (path guards keep working)
      const p = judge(v, v.outside);
      expect(p.kind).toBe("plain");
      expect(secureGuardsNeeded(p)).toBe(true);
      expect(decideToolCall(p, undefined, "read", { path: join(v.work, "x") }, v.outside, v.home)?.block).toBe(true);
      expect(bashTouchesVault(`cat ${v.work}/x`, p.vaults, v.home)?.vault.name).toBe("acme");
      // the hub gate sees a usable registry (the vault is scanned like any other)
      expect(secureConfigNsFactor(p.config)).toBe("ok");
    });
  }

  it("/secure status shows the ! line under the vault row", () => {
    v = makeFakeVault();
    withEntry(v, { pending: "convert:0123456789abcdef", origin: 1 });
    const agentDir = join(v.tmp, "agent");
    mkdirSync(agentDir, { recursive: true });
    const text = renderSecureStatus({
      domain: judge(v, v.outside),
      runtimeLock: undefined,
      agentDir,
      packageRoot: "/pkg",
      env: {},
      readMountinfo: () => v!.mounted,
      existsPrivateRecord: () => false,
    });
    expect(text).toContain("  - acme：mounted");
    expect(text).toContain(
      "    ! 事务键损坏：origin（保险库按锁定处理；请人工核对 secure.vaults.acme 中的这些键）\n    pending: convert:0123456789abcdef",
    );
    expect(text).not.toContain("invalid (");
  });
});
