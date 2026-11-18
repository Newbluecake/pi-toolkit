/**
 * sysload darwin C0 contract — the S0-side verbatim copy + runtime shape check
 * (sysload darwin-plan §2.2/§3.0/§3.1-S0).
 *
 * The AUTHORITATIVE C0 declaration lives in `src/sysload/sampler.ts` (writer = S1, wrapped
 * in the marked C0 block). S0 must not import sysload — not even type-only — so this
 * file holds a byte-verbatim copy of the same block (same begin/end markers, flush-left
 * inside the template literal so the extraction command pulls identical lines) and checks
 * the LIVE host against it at runtime: key set + method arity. The three-copy consistency
 * (sampler.ts / tests/sysload/host-contract.test.ts / this file) is pinned by the acceptance
 * command C0-1 (`diff` of the three extractions); drift between S0 and S1 shows up there as
 * a red light, and any C0 change must go through the dispatcher first — never a silent edit.
 *
 * Tier 1: pure assertions over an in-memory host instance, no process/socket/clock.
 */
import { describe, expect, it } from "vitest";
import { createDarwinHost } from "../../../src/web-hub/protocol/sysload-darwin.js";

// prettier-ignore
const C0_SAMPLER_HOST_CONTRACT = `
// ── C0:BEGIN ── sampler.ts（S1 声明；S0 结构满足；零运行时 import）
export interface SamplerHostMount {
  // = MountInfoRecord 的字段集（host 解析器须填满：root:"/"、optionalFields:[]、superOptions:[]、mountId:0、majorMinor:"0:0" 占位）
  mountId: number;
  parentId: number;
  majorMinor: string;
  root: string;
  mountPoint: string;
  mountOptions: readonly string[];
  optionalFields: readonly string[];
  fstype: string;
  source: string;
  superOptions: readonly string[];
}
export interface SamplerHostReading {
  // 任一字段缺失 ⇔ 该项本拍不可用（互相独立）
  loadavg?: readonly [number, number, number];
  memAvailPct?: number; // kern.memorystatus_level，整数 0..100
  cores?: number; // hw.ncpu，正整数
}
export interface HostProcess {
  pid: number;
  comm: string;
  cpuPct: number;
  rssBytes: number;
}
/** 所有带 timeoutMs 的方法：调用方保证 timeoutMs 为有限正数；host 收到非有限/≤0 的值**不得启动进程**，直接 resolve undefined。 */
export interface SamplerHost {
  readonly kind: "darwin";
  readonly localFilesystems: ReadonlySet<string>; // 替代 mounts.ts 的 Linux LOCAL_FILESYSTEMS
  readHost(opts: { timeoutMs: number }): Promise<SamplerHostReading | undefined>; // 永不 throw/reject
  readMounts(opts: { timeoutMs: number }): Promise<string | undefined>; // 原始 mount(8) 文本 ≤1 MiB；永不 throw
  parseMounts(text: string): readonly SamplerHostMount[]; // 同步纯函数
  deviceOf(path: string): Promise<number | undefined>; // fs.stat().dev；失败 ⇒ undefined；永不 throw
  listProcesses(opts: {
    timeoutMs: number;
    maxPids: number;
  }): Promise<{ procs: readonly HostProcess[]; truncated: boolean } | undefined>;
}
export interface SamplerIo {
  readonly readFileSync?: (path: string, options?: { encoding?: "utf8"; flag?: string }) => string | Buffer;
  readonly readFile?: (path: string) => Promise<string | Buffer>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly statfs?: (path: string, options?: { bigint?: boolean }) => Promise<StatFsLike>;
  readonly host?: SamplerHost; // 追加
} // 追加
// ── C0:END ──
`;

describe("sysload darwin C0 contract copy (S0 side)", () => {
  it("holds the C0:BEGIN/END-marked block verbatim (the C0-1 diff gate extracts exactly this)", () => {
    expect(C0_SAMPLER_HOST_CONTRACT).toContain("// ── C0:BEGIN ──");
    expect(C0_SAMPLER_HOST_CONTRACT).toContain("// ── C0:END ──");
    expect(C0_SAMPLER_HOST_CONTRACT).toContain('readonly kind: "darwin";');
    expect(C0_SAMPLER_HOST_CONTRACT).toContain("readHost(opts: { timeoutMs: number })");
    expect(C0_SAMPLER_HOST_CONTRACT).toContain("listProcesses(opts: {");
    expect(C0_SAMPLER_HOST_CONTRACT).toContain("readonly host?: SamplerHost; // 追加");
  });

  it("createDarwinHost() exposes exactly the C0 SamplerHost surface (key set + method arity)", () => {
    const host = createDarwinHost();
    expect(Object.keys(host).sort()).toEqual(
      ["deviceOf", "kind", "listProcesses", "localFilesystems", "parseMounts", "readHost", "readMounts"].sort(),
    );
    expect(host.kind).toBe("darwin");
    expect(host.readHost.length).toBe(1);
    expect(host.readMounts.length).toBe(1);
    expect(host.parseMounts.length).toBe(1);
    expect(host.deviceOf.length).toBe(1);
    expect(host.listProcesses.length).toBe(1);
    expect(host.localFilesystems instanceof Set).toBe(true);
  });

  it("the C0 'invalid timeoutMs never starts anything' rule holds on the live host", async () => {
    let started = 0;
    const host = createDarwinHost({
      run: () => {
        started++;
        return Promise.reject(new Error("must never be reached"));
      },
    });
    await expect(host.readHost({ timeoutMs: 0 })).resolves.toBeUndefined();
    await expect(host.readMounts({ timeoutMs: Number.NaN })).resolves.toBeUndefined();
    await expect(host.listProcesses({ timeoutMs: -1, maxPids: 8 })).resolves.toBeUndefined();
    expect(started).toBe(0);
  });
});
