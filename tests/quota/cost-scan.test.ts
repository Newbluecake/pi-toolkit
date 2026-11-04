/**
 * `src/quota/cost-scan.ts`（quota 面板费用折算，2026-11-03 形态 B；同日拍板改全项目扫描）的定向测试 —
 * 基本窗口求和 / 增量无双算 / 游标恢复 / 文件身份变化 / 兜底计价（零价 vs 无价）/ 有界 pass /
 * quota-state.json 读改写共存 / quotaWindowCost 窗口对齐 / 多目录枚举分帧 / 跨目录公平轮转 /
 * 稳态轻量探测（目录 mtime + 活跃文件 + 滚动补枚举）/ 淘汰优先级与「无重复扫描」防抖动。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fs/promises 走 vi.mock 整体替换 + 透传原实现（同 demotion.test.ts 的纪律：node:* 的 ESM
// 命名空间属性不可 configure，vi.spyOn 会抛 "Cannot redefine property"）。仅包一层 readFile，
// 供 loadState 重试语义测试注入一次性读取失败；其余导出（lstat/readdir/rename…）原样透传。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
  };
});
import {
  createCostScanner,
  quotaWindowCost,
  type CostScanRates,
  type CostScanner,
  type CostScannerOptions,
  type QuotaCostView,
} from "../../src/quota/cost-scan.js";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 10, 0, 0); // 2026-11-03T10:00:00Z

let workDir: string;
let sessionsRoot: string;
let sessionDir: string;
let statePath: string;
let now = NOW;
const scanners: CostScanner[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cost-scan-"));
  sessionsRoot = join(workDir, "sessions");
  sessionDir = join(sessionsRoot, "--cwd--");
  mkdirSync(sessionDir, { recursive: true });
  statePath = join(workDir, "quota-state.json");
  now = NOW;
  vi.mocked(readFile).mockClear();
});

afterEach(() => {
  for (const s of scanners.splice(0)) s.dispose();
  rmSync(workDir, { recursive: true, force: true });
});

/** assistant 行：costTotal 缺省 ⇒ usage 无 cost 键（走兜底计价通道）。 */
function assistantLine(
  provider: string,
  model: string,
  tsMs: number,
  costTotal?: number,
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {},
): string {
  const usage: Record<string, unknown> = {
    input: tokens.input ?? 1_000,
    output: tokens.output ?? 500,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
  };
  if (costTotal !== undefined) usage["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal };
  return `${JSON.stringify({
    type: "message",
    id: "x",
    timestamp: new Date(tsMs).toISOString(),
    message: { role: "assistant", provider, model, timestamp: tsMs, usage, stopReason: "stop" },
  })}\n`;
}

function userLine(tsMs: number): string {
  return `${JSON.stringify({ type: "message", timestamp: new Date(tsMs).toISOString(), message: { role: "user", content: [] } })}\n`;
}

function makeScanner(
  priceLookup: (provider: string, model: string) => CostScanRates | undefined = () => undefined,
  budget: { ms: number; bytes: number } = { ms: 5_000, bytes: 64 * 1024 * 1024 },
  extra: Partial<CostScannerOptions> = {},
): CostScanner {
  const s = createCostScanner({
    sessionsRoot,
    statePath,
    priceLookup,
    now: () => now,
    budget,
    busyIntervalMs: 0,
    idleIntervalMs: 0,
    ...extra,
  });
  scanners.push(s);
  return s;
}

/** 反复 advance 直到 complete（有界 pass 收敛；最多 200 轮防御死循环）。 */
async function scanToComplete(s: CostScanner): Promise<QuotaCostView> {
  for (let i = 0; i < 200; i++) {
    await s.advance();
    const v = s.view();
    if (v.complete) return v;
  }
  throw new Error("scanner did not converge");
}

/** 建一个项目目录（sessionsRoot 下一层）。 */
function projectDir(name: string): string {
  const dir = join(sessionsRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("cost-scan: 基本扫描与窗口求和", () => {
  it("assistant 行的 cost.total 按 provider+hour 聚合；窗口区间外不计", async () => {
    writeFileSync(
      join(sessionDir, "a.jsonl"),
      assistantLine("kimi-coding", "k3", NOW - 1 * H, 1.5) +
        assistantLine("kimi-coding", "k3", NOW - 2 * H, 2.5) +
        assistantLine("zai", "glm-5.3", NOW - 1 * H, 0.25) +
        userLine(NOW),
    );
    const s = makeScanner();
    const view = await scanToComplete(s);
    // 近 3h 区间：kimi 两行都在
    expect(view.costInWindow("kimi-coding", NOW - 3 * H, NOW)).toEqual({ usd: 4, unpriced: false });
    // 近 90min：两行都收（相交规则：$2.5 所在 hour bucket [NOW−2h,NOW−1h) 与窗口相交）
    const r = view.costInWindow("kimi-coding", NOW - 90 * 60_000, NOW);
    expect(r?.usd).toBeCloseTo(4, 10);
    // 近 30min：只有 $1.5 的 bucket [NOW−1h,NOW) 相交
    expect(view.costInWindow("kimi-coding", NOW - 30 * 60_000, NOW)?.usd).toBeCloseTo(1.5, 10);
    expect(view.costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBeCloseTo(0.25, 10);
    expect(view.costInWindow("opencode-go", NOW - 3 * H, NOW)).toBeUndefined(); // 无数据 ⇒ undefined
  });

  it("增量追加不重扫旧字节（无双算）", async () => {
    const file = join(sessionDir, "b.jsonl");
    writeFileSync(file, assistantLine("kimi-coding", "k3", NOW - H, 1));
    const s = makeScanner();
    await scanToComplete(s);
    expect(s.view().costInWindow("kimi-coding", NOW - 3 * H, NOW)?.usd).toBe(1);
    appendFileSync(file, assistantLine("kimi-coding", "k3", NOW - 30 * 60_000, 2));
    now += 60_000;
    const view = await scanToComplete(s);
    expect(view.costInWindow("kimi-coding", NOW - 4 * H, NOW + H)?.usd).toBe(3); // 1+2，不是 1+1+2
  });

  it("游标持久化：新 scanner 零预算即 complete 且数据还在（quota-state.json costScan 组）", async () => {
    writeFileSync(join(sessionDir, "c.jsonl"), assistantLine("zai", "glm-5.3", NOW - H, 0.75));
    await scanToComplete(makeScanner());
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(persisted["costScan"]).toBeDefined();
    // 第二个 scanner：预算 0 ⇒ 任何扫描都读不到字节，只能靠持久化游标/bucket。
    const s2 = makeScanner(() => undefined, { ms: 0, bytes: 0 });
    const view = await scanToComplete(s2);
    expect(view.complete).toBe(true);
    expect(view.costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(0.75);
  });

  it("读改写纪律：保留同文件 demotions/baselines 组", async () => {
    writeFileSync(join(sessionDir, "d.jsonl"), assistantLine("kimi-coding", "k3", NOW - H, 1));
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, demotions: { "kimi-coding": { until: 1 } } }, null, 2)}\n`,
    );
    await scanToComplete(makeScanner());
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(persisted["demotions"]).toEqual({ "kimi-coding": { until: 1 } });
    expect(persisted["version"]).toBe(1);
    expect(persisted["costScan"]).toBeDefined();
  });

  it("文件收缩（重写为更短内容）⇒ 旧 bucket 随条目丢弃重扫，不双算", async () => {
    const file = join(sessionDir, "e.jsonl");
    writeFileSync(
      file,
      assistantLine("kimi-coding", "k3", NOW - H, 5) + assistantLine("kimi-coding", "k3", NOW - H, 5),
    );
    await scanToComplete(makeScanner());
    const s = makeScanner();
    await s.advance(); // 加载持久化状态
    writeFileSync(file, assistantLine("kimi-coding", "k3", NOW - H, 1)); // 更短 ⇒ shrink ⇒ 从 0 重扫
    const view = await scanToComplete(s);
    expect(view.costInWindow("kimi-coding", NOW - 3 * H, NOW)?.usd).toBe(1); // 不是 5+5+1
  });
});

describe("cost-scan: 全项目多目录扫描", () => {
  it("多个项目目录的用量都计入；sessions root 直属文件忽略", async () => {
    const projB = projectDir("--other--");
    writeFileSync(join(sessionDir, "a.jsonl"), assistantLine("kimi-coding", "k3", NOW - H, 1));
    writeFileSync(join(projB, "b.jsonl"), assistantLine("kimi-coding", "k3", NOW - H, 2));
    writeFileSync(join(sessionsRoot, "stray.jsonl"), assistantLine("kimi-coding", "k3", NOW - H, 100)); // root 直属 ⇒ 忽略
    const view = await scanToComplete(makeScanner());
    expect(view.complete).toBe(true);
    expect(view.totalFiles).toBe(2);
    expect(view.scannedFiles).toBe(2);
    expect(view.costInWindow("kimi-coding", NOW - 3 * H, NOW)?.usd).toBe(3); // 1+2，不含 stray 的 100
  });

  it("旧版单目录状态（dir=项目目录）⇒ root 不匹配视为空态全量重扫", async () => {
    writeFileSync(join(sessionDir, "l.jsonl"), assistantLine("zai", "g", NOW - H, 3));
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, costScan: { version: 1, dir: sessionDir, cursor: "", files: {} } })}\n`,
    );
    const view = await scanToComplete(makeScanner());
    expect(view.complete).toBe(true);
    expect(view.costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(3);
  });

  it("目录枚举分帧：enumStatsPerPass 极小 ⇒ 多 pass 推进，totalFiles 先是下界，最终收敛", async () => {
    for (let d = 0; d < 3; d++) {
      const dir = projectDir(`--p${d}--`);
      for (let f = 0; f < 2; f++) {
        writeFileSync(join(dir, `f${f}.jsonl`), assistantLine("zai", "g", NOW - H, 1));
      }
    }
    const s = makeScanner(() => undefined, { ms: 5_000, bytes: 64 * 1024 * 1024 }, { enumStatsPerPass: 2 });
    await s.advance();
    expect(s.view().complete).toBe(false);
    expect(s.view().totalFiles).toBeLessThan(6); // 枚举未扫完 ⇒ 下界
    const view = await scanToComplete(s);
    expect(view.totalFiles).toBe(6);
    expect(view.costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(6);
  });

  it("lane② 跨目录轮转：单 pass 字节预算只够一个文件 ⇒ 每 pass 恰好推进一个文件（不饿死）", async () => {
    // 3 目录 × 1 文件，mtime 全部置旧 ⇒ lane① 跳过，全靠 lane② 轮转。
    const content = assistantLine("zai", "g", NOW - 100 * H, 1);
    const bytes = Buffer.byteLength(content, "utf8");
    for (let d = 0; d < 3; d++) {
      const dir = projectDir(`--rr${d}--`);
      const f = join(dir, "x.jsonl");
      writeFileSync(f, content);
      const old = new Date(Date.now() - 100 * H);
      utimesSync(f, old, old);
    }
    const s = makeScanner(() => undefined, { ms: 5_000, bytes });
    await s.advance();
    expect(s.view().scannedFiles).toBe(1); // 每 pass 恰好一个文件 ⇒ 轮转推进
    await s.advance();
    expect(s.view().scannedFiles).toBe(2);
    await s.advance();
    expect(s.view().scannedFiles).toBe(3);
    const view = await scanToComplete(s);
    expect(view.costInWindow("zai", NOW - 101 * H, NOW)?.usd).toBe(3);
  });

  it("稳态轻量探测：新增文件经目录 mtime 探测同 pass 发现（不靠滚动补枚举）", async () => {
    // 5 个目录 ⇒ 滚动补枚举单 pass 只覆盖 3 个，够不着 --d2--；能发现只能靠 dir mtime 探测。
    for (let d = 0; d < 4; d++) {
      writeFileSync(join(projectDir(`--d${d}--`), "x.jsonl"), assistantLine("zai", "g", NOW - H, 1));
    }
    const s = makeScanner();
    await scanToComplete(s);
    writeFileSync(join(sessionsRoot, "--d2--", "new.jsonl"), assistantLine("zai", "g", NOW - H, 4));
    // dir mtime 粒度可能只有秒级/同毫秒 ⇒ 显式 bump 到确定不同的值。
    const bump = new Date(Date.now() + 60_000);
    utimesSync(join(sessionsRoot, "--d2--"), bump, bump);
    await s.advance();
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(8); // 4×1 + 4
    expect(s.view().totalFiles).toBe(5);
  });

  it("稳态自愈：沉睡文件（缓存 mtime 旧）被 append ⇒ 滚动补枚举发现（探测/近期通道都够不着）", async () => {
    // --d3-- 在排序后的第 5 位（idx4），滚动每 pass 3 个 ⇒ 第 1 个稳态 pass 够不着，第 2 个才发现。
    for (let d = 0; d < 4; d++) {
      writeFileSync(join(projectDir(`--d${d}--`), "x.jsonl"), assistantLine("zai", "g", NOW - H, 1));
    }
    const dormant = join(sessionsRoot, "--d3--", "x.jsonl");
    const old = new Date(Date.now() - 10 * 24 * H); // 缓存 mtime 旧 ⇒ 不在 48h 活跃抽 stat 范围
    utimesSync(dormant, old, old);
    const s = makeScanner();
    await scanToComplete(s);
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(4);
    appendFileSync(dormant, assistantLine("zai", "g", NOW - 30 * 60_000, 10)); // append 不动目录 mtime
    await s.advance(); // roll idx0-2：够不着 --d3--
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(4);
    await scanToComplete(s); // roll idx3-4：重新枚举 --d3-- ⇒ 发现增长 ⇒ 同 pass lane① 扫增量
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(14);
  });
});

describe("cost-scan: 兜底计价（零价 vs 无价）", () => {
  it("cost.total 缺失 ⇒ token×目录价；目录价全零 ⇒ priced 0；无价 ⇒ unpriced 标记", async () => {
    writeFileSync(
      join(sessionDir, "f.jsonl"),
      assistantLine("kimi-coding", "priced", NOW - H, undefined, { input: 1_000_000, output: 500_000 }) + // $2*1 + $4*0.5 = $4
        assistantLine("kimi-coding", "zero", NOW - H, undefined, { input: 9_000_000 }) + // 零价 ⇒ +$0
        assistantLine("kimi-coding", "mystery", NOW - H), // 无价 ⇒ unpriced
    );
    const rates: Record<string, CostScanRates | undefined> = {
      priced: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
      zero: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      mystery: undefined,
    };
    const s = makeScanner((_p, model) => rates[model]);
    const view = await scanToComplete(s);
    const r = view.costInWindow("kimi-coding", NOW - 3 * H, NOW);
    expect(r?.usd).toBeCloseTo(4, 10);
    expect(r?.unpriced).toBe(true); // mystery 无价 ⇒ 下界标记
  });

  it("全部可价（含零价）⇒ unpriced=false；cost.total=0 是权威值不走兜底", async () => {
    writeFileSync(
      join(sessionDir, "g.jsonl"),
      assistantLine("zai", "zero", NOW - H, undefined, { input: 5_000_000 }) +
        assistantLine("zai", "anything", NOW - 2 * H, 0), // cost.total=0 权威 ⇒ 不查目录价
    );
    const s = makeScanner(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
    const view = await scanToComplete(s);
    expect(view.costInWindow("zai", NOW - 3 * H, NOW)).toEqual({ usd: 0, unpriced: false });
  });
});

describe("cost-scan: 有界 pass 与 quotaWindowCost 窗口对齐", () => {
  it("字节预算极小 ⇒ 多 pass 收敛；中途 complete=false", async () => {
    // 造 8 个文件 × 数行，预算一次只能读 ~200B。
    for (let i = 0; i < 8; i++) {
      writeFileSync(
        join(sessionDir, `h${i}.jsonl`),
        assistantLine("kimi-coding", "k3", NOW - H, 0.5) + assistantLine("kimi-coding", "k3", NOW - 2 * H, 0.5),
      );
    }
    const s = makeScanner(() => undefined, { ms: 5_000, bytes: 1_200 });
    await s.advance();
    expect(s.view().complete).toBe(false);
    const view = await scanToComplete(s);
    expect(view.costInWindow("kimi-coding", NOW - 3 * H, NOW)?.usd).toBeCloseTo(8, 10); // 8 文件 × $1
  });

  it("quotaWindowCost：起点 = resetAt − 时长（5h/7d/30d）；resetAt 缺失 ⇒ undefined", async () => {
    // 在 resetAt 前 4h（5h 窗口内）与 前 6h（5h 窗口外）各放 $1。
    const resetAt = NOW + H;
    writeFileSync(
      join(sessionDir, "i.jsonl"),
      assistantLine("kimi-coding", "k3", resetAt - 4 * H, 1) + assistantLine("kimi-coding", "k3", resetAt - 6 * H, 1),
    );
    const view = await scanToComplete(makeScanner());
    const w5 = quotaWindowCost(view, "kimi-coding", "5h", resetAt);
    expect(w5?.usd).toBeCloseTo(1, 10); // 只有窗口内那行（hour bucket 相交规则下 6h 前的 bucket 不相交）
    const wWeek = quotaWindowCost(view, "kimi-coding", "week", resetAt);
    expect(wWeek?.usd).toBeCloseTo(2, 10); // 7d 窗口两行都收
    expect(quotaWindowCost(view, "kimi-coding", "5h", undefined)).toBeUndefined();
    expect(quotaWindowCost(undefined, "kimi-coding", "5h", resetAt)).toBeUndefined();
    expect(quotaWindowCost(view, "droid-standard", "month", resetAt)).toBeUndefined(); // 外部 provider 无 JSONL 数据
  });
});

describe("cost-scan: 无重复扫描与淘汰防抖动（硬要求）", () => {
  it("收敛后重复 pass 零重读；append 只读增量字节（readBytes 证据）", async () => {
    const file = join(sessionDir, "m.jsonl");
    const c1 = assistantLine("zai", "g", NOW - H, 1);
    writeFileSync(file, c1);
    const s = makeScanner();
    const view = await scanToComplete(s);
    const total = Buffer.byteLength(c1, "utf8");
    expect(view.readBytes).toBe(total); // 全量恰好读一遍
    await s.advance();
    await s.advance();
    expect(s.view().readBytes).toBe(total); // 稳态 pass 零重读（无反复扫描）
    const c2 = assistantLine("zai", "g", NOW - 30 * 60_000, 2);
    appendFileSync(file, c2);
    await s.advance();
    expect(s.view().readBytes).toBe(total + Buffer.byteLength(c2, "utf8")); // 只读追加部分
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(3);
  });

  it("状态超限：先淘汰桶空最旧条目（费用历史优先保留）；被淘汰文件本进程不再重扫", async () => {
    // 桶空旧文件（只有 user 行 ⇒ 无 bucket）+ 新费用文件。
    const emptyFile = join(sessionDir, "empty.jsonl");
    const emptyContent = userLine(NOW - H) + userLine(NOW - H);
    writeFileSync(emptyFile, emptyContent);
    const oldDate = new Date(Date.now() - 30 * 24 * H);
    utimesSync(emptyFile, oldDate, oldDate);
    const costFile = join(sessionDir, "cost.jsonl");
    const costContent = assistantLine("zai", "g", NOW - H, 7);
    writeFileSync(costFile, costContent);

    // 先用宽松上限落盘，实测两条目总大小 S2 ⇒ 第二个 scanner 用 S2−10 作上限：
    // 放得下任意单条目、放不下两条目（与绝对路径长度/数字位宽无关，不脆弱）。
    await scanToComplete(makeScanner());
    const s2 = Buffer.byteLength(readFileSync(statePath, "utf8"), "utf8");

    const s = makeScanner(() => undefined, { ms: 5_000, bytes: 64 * 1024 * 1024 }, { stateMaxBytes: s2 - 10 });
    appendFileSync(costFile, assistantLine("zai", "g", NOW - 30 * 60_000, 0)); // 触发 dirty flush（淘汰只发生在落盘）
    await s.advance();
    const readAfterEvict = s.view().readBytes; // 只读了 append 的增量
    // 淘汰顺序：桶空最旧（empty.jsonl）先走 ⇒ 落盘只剩 cost.jsonl 的条目（费用历史保留）。
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      costScan: { files: Record<string, unknown> };
    };
    expect(Object.keys(persisted.costScan.files)).toEqual([costFile]);
    expect(Buffer.byteLength(readFileSync(statePath, "utf8"), "utf8")).toBeLessThanOrEqual(s2 - 10);
    await s.advance(); // complete 在 flush 前计算 ⇒ 下一个 pass 才反映 evictedPaths
    expect(s.view().complete).toBe(false); // 容量紧急 ⇒ complete:false（与 TRACKED_FILES_MAX 语义一致）
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(7); // 费用数据不因淘汰丢失
    // 防抖动：被淘汰的 empty.jsonl 本进程不再重扫——多 pass 后 readBytes 不回头涨，
    // 即使它继续被 append（=「淘汰→重扫→再淘汰」环路被切断）。
    appendFileSync(emptyFile, userLine(NOW - 10 * 60_000));
    await s.advance();
    await s.advance();
    expect(s.view().readBytes).toBe(readAfterEvict);
  });
});

describe("cost-scan: loadState 重试语义（EACCES 恢复、ENOENT 空态）", () => {
  it("首次 advance 读失败（EACCES）不置 loaded；第二次读成功恢复持久化 costInWindow", async () => {
    // 预写一个带 bucket 的 costScan 组，指向磁盘上已不存在的文件：只有加载持久化状态
    // 才能恢复费用历史（重扫无从发现该文件）。首次加载注入一次性 EACCES，验证下个 pass 重试。
    const goneFile = join(sessionDir, "gone.jsonl");
    const hour = String(Math.floor((NOW - H) / H));
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        costScan: {
          version: 1,
          dir: resolve(sessionsRoot),
          cursor: "",
          files: {
            [goneFile]: {
              dev: 1,
              ino: 2,
              size: 10,
              mtimeMs: NOW,
              scannedTo: 10,
              buckets: { zai: { [hour]: [5, 0] } },
            },
          },
        },
      })}\n`,
    );
    const s = makeScanner();
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied, open 'quota-state.json'"), { code: "EACCES" }),
    );
    await s.advance(); // 首次读失败 ⇒ 空态（gone.jsonl 不在磁盘 ⇒ 重扫也拿不到费用）
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)).toBeUndefined();
    await s.advance(); // 读恢复 ⇒ 加载持久化 bucket
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)).toEqual({ usd: 5, unpriced: false });
  });

  it("首次读 ENOENT ⇒ 空态即 loaded，稳态 pass 不再重读状态文件", async () => {
    writeFileSync(join(sessionDir, "e.jsonl"), assistantLine("zai", "g", NOW - H, 1));
    const s = makeScanner();
    await scanToComplete(s);
    expect(s.view().costInWindow("zai", NOW - 3 * H, NOW)?.usd).toBe(1);
    const callsAfterComplete = vi.mocked(readFile).mock.calls.length;
    await s.advance();
    await s.advance();
    // ENOENT 后 loaded=true：后续 pass 不再为加载重读状态文件（稳态 dirty=false 也不 flush）。
    expect(vi.mocked(readFile).mock.calls.length).toBe(callsAfterComplete);
  });
});
