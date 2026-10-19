import { describe, expect, it, vi, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialResolver, droidCliLoginPresent, ENV_FALLBACK } from "../../src/quota/credentials.js";

// 安全红线回归护栏：整个测试文件模块图里的 node:child_process 都被换成
// spy —— credentials.ts 若（现在或将来）真去 exec 命令型 key，这里立刻爆红。
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

function makeResolver(credential: unknown, env: Record<string, string | undefined> = {}, warn?: (m: string) => void) {
  return createCredentialResolver({
    readCredential: () => credential,
    env,
    ...(warn === undefined ? {} : { warn }),
  });
}

describe("ENV_FALLBACK", () => {
  it("maps every provider id to its fallback variable (zai shares one)", () => {
    expect(ENV_FALLBACK).toEqual({
      "zai-coding-cn": "ZAI_API_KEY",
      zai: "ZAI_API_KEY",
      "kimi-coding": "KIMI_CODING_API_KEY",
      // P7（D3 拍板）：droid 两池只用 FACTORY_API_KEY（与 droid 子进程同一把 key）。
      "droid-standard": "FACTORY_API_KEY",
      "droid-core": "FACTORY_API_KEY",
    });
  });
});

describe("createCredentialResolver", () => {
  it("resolves a plain api_key credential", () => {
    expect(makeResolver({ type: "api_key", key: "sk-x" })("zai-coding-cn")).toBe("sk-x");
  });

  it("returns undefined for oauth credentials (not supported this phase)", () => {
    const warnings: string[] = [];
    const resolve = makeResolver({ type: "oauth", refresh: "r", access: "a", expires: 1 }, {}, (m) => warnings.push(m));
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(warnings).toHaveLength(1); // miss → 一次 WARN
  });

  it("falls back to process.env[ENV_FALLBACK[id]] when the key is missing", () => {
    expect(makeResolver({ type: "api_key" }, { ZAI_API_KEY: "env-key" })("zai-coding-cn")).toBe("env-key");
    expect(makeResolver(undefined, { KIMI_CODING_API_KEY: "kimi-env" })("kimi-coding")).toBe("kimi-env");
  });

  it("resolves a $VAR template via a single-layer env lookup", () => {
    expect(makeResolver({ type: "api_key", key: "$MY_KEY" }, { MY_KEY: "resolved" })("zai")).toBe("resolved");
    expect(makeResolver({ type: "api_key", key: "${MY_KEY}" }, { MY_KEY: "resolved2" })("zai")).toBe("resolved2");
    // 查不到模板变量 → 视为 key 不可用 → 走 ENV_FALLBACK 回退
    expect(makeResolver({ type: "api_key", key: "$MISSING" }, { ZAI_API_KEY: "fallback" })("zai")).toBe("fallback");
  });

  it("gives up on command-shaped keys without ever executing anything (security red line)", () => {
    expect(
      makeResolver({ type: "api_key", key: "!op read api.key" }, { ZAI_API_KEY: "fallback" })("zai-coding-cn"),
    ).toBe("fallback");
    // 纯命令型（无 env 回退可用）→ undefined
    expect(makeResolver({ type: "api_key", key: "!cat ~/.secret" })("zai-coding-cn")).toBeUndefined();
    // 含空格的 shell 形态同样放弃
    expect(makeResolver({ type: "api_key", key: "echo sk-123" })("zai")).toBeUndefined();
    // 绝不 exec：四个入口零调用
    expect(childProcess.execSync).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("returns undefined without throwing when readCredential throws", () => {
    const resolve = createCredentialResolver({
      readCredential: () => {
        throw new Error("auth.json unreadable");
      },
      env: {},
    });
    expect(() => resolve("zai")).not.toThrow();
    expect(resolve("zai")).toBeUndefined();
  });

  it("warns exactly once per provider on repeated misses", () => {
    const warnings: string[] = [];
    const resolve = makeResolver(undefined, {}, (m) => warnings.push(m));
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("kimi-coding");
    // 不同 provider 各自一次
    expect(resolve("zai")).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it("droid: both pool ids fall back to FACTORY_API_KEY and warn once under the merged 'droid' key", () => {
    // P7（quota-plan r2 §3，D3）：droid-standard / droid-core 共享 FACTORY_API_KEY。
    const resolve = makeResolver(undefined, { FACTORY_API_KEY: "factory-env-key" });
    expect(resolve("droid-standard")).toBe("factory-env-key");
    expect(resolve("droid-core")).toBe("factory-env-key");

    // 两个 id 只告警一次（warnKey 合并），文案里的 provider 名写 `droid`；
    // kimi/zai 的键与文案不受影响。
    const warnings: string[] = [];
    const missing = createCredentialResolver({
      readCredential: () => undefined,
      env: {},
      warn: (m) => warnings.push(m),
      droidCliLogin: () => false, // ~/.factory 不存在 ⇒ 保留 WARN
    });
    expect(missing("droid-standard")).toBeUndefined();
    expect(missing("droid-core")).toBeUndefined();
    expect(missing("droid-standard")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"droid"');
    expect(warnings[0]).toContain("FACTORY_API_KEY");
    expect(warnings[0]).not.toContain("droid-standard");
  });
});

describe("droid CLI login state (2026-10-19 ruling: no WARN when ~/.factory exists)", () => {
  it("suppresses the WARN when the droid CLI has its own login state (~/.factory present)", () => {
    const warnings: string[] = [];
    const resolve = createCredentialResolver({
      readCredential: () => undefined,
      env: {},
      warn: (m) => warnings.push(m),
      droidCliLogin: () => true,
    });
    expect(resolve("droid-standard")).toBeUndefined();
    expect(resolve("droid-core")).toBeUndefined();
    expect(resolve("droid-standard")).toBeUndefined();
    expect(warnings).toHaveLength(0); // 无 WARN——余额探测不可用只走状态面
    // 状态面：凭据缺失标记如实置位（HUD/status 据此显示「余额探测不可用」）。
    expect(resolve.droidKeyMissing()).toBe(true);
  });

  it("keeps the WARN when ~/.factory does NOT exist (droid not set up at all)", () => {
    const warnings: string[] = [];
    const resolve = createCredentialResolver({
      readCredential: () => undefined,
      env: {},
      warn: (m) => warnings.push(m),
      droidCliLogin: () => false,
    });
    expect(resolve("droid-standard")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"droid"');
    expect(resolve.droidKeyMissing()).toBe(true); // WARN 与状态标记不互斥
  });

  it("warns again if the CLI login state disappears later (checked fresh on every miss)", () => {
    const warnings: string[] = [];
    let loggedIn = true;
    const resolve = createCredentialResolver({
      readCredential: () => undefined,
      env: {},
      warn: (m) => warnings.push(m),
      droidCliLogin: () => loggedIn,
    });
    expect(resolve("droid-standard")).toBeUndefined();
    expect(warnings).toHaveLength(0);
    loggedIn = false; // ~/.factory 后来被删 ⇒ 回到 WARN 路径（仍只打一次）
    expect(resolve("droid-standard")).toBeUndefined();
    expect(resolve("droid-core")).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("a later credential hit clears droidKeyMissing", () => {
    let key: string | undefined = undefined;
    const resolve = createCredentialResolver({
      readCredential: () => undefined,
      env: {
        get FACTORY_API_KEY() {
          return key;
        },
      } as Record<string, string | undefined>,
      droidCliLogin: () => true,
    });
    expect(resolve("droid-standard")).toBeUndefined();
    expect(resolve.droidKeyMissing()).toBe(true);
    key = "fk-later";
    expect(resolve("droid-standard")).toBe("fk-later");
    expect(resolve.droidKeyMissing()).toBe(false);
  });

  it("a throwing droidCliLogin stub is treated as 'not logged in' (WARN path, never throws)", () => {
    const warnings: string[] = [];
    const resolve = createCredentialResolver({
      readCredential: () => undefined,
      env: {},
      warn: (m) => warnings.push(m),
      droidCliLogin: () => {
        throw new Error("fs broken");
      },
    });
    expect(() => resolve("droid-core")).not.toThrow();
    expect(resolve("droid-core")).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("kimi/zai warnings are untouched by the droid CLI login state", () => {
    const warnings: string[] = [];
    const resolve = createCredentialResolver({
      readCredential: () => undefined,
      env: {},
      warn: (m) => warnings.push(m),
      droidCliLogin: () => true, // droid 已登录也不影响 kimi/zai 的 WARN
    });
    expect(resolve("kimi-coding")).toBeUndefined();
    expect(resolve("zai")).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"kimi-coding"');
    expect(warnings[1]).toContain('"zai"');
    // kimi/zai 的 miss 不置 droid 标记。
    expect(resolve.droidKeyMissing()).toBe(false);
  });

  it("droidKeyMissing starts false and only tracks droid pool misses", () => {
    const resolve = makeResolver(undefined, {});
    expect(resolve.droidKeyMissing()).toBe(false);
    expect(resolve("zai-coding-cn")).toBeUndefined();
    expect(resolve.droidKeyMissing()).toBe(false);
  });
});

describe("droidCliLoginPresent (default probe)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fakeHome(withFactory: boolean): string {
    const home = mkdtempSync(join(tmpdir(), "pi-quota-home-"));
    dirs.push(home);
    if (withFactory) mkdirSync(join(home, ".factory"));
    vi.stubEnv("HOME", home); // os.homedir() 在 POSIX 上每次读 $HOME
    return home;
  }

  it("true when ~/.factory exists, false when it does not, never throws", () => {
    fakeHome(true);
    expect(droidCliLoginPresent()).toBe(true);
    fakeHome(false);
    expect(droidCliLoginPresent()).toBe(false);
  });
});
