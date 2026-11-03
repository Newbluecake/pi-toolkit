/**
 * `src/quota/cost-scan.ts`（quota 面板费用折算，2026-11-03 形态 B）：增量扫描器的定向测试 —
 * 基本窗口求和 / 增量无双算 / 游标恢复 / 文件身份变化 / 兜底计价（零价 vs 无价）/ 有界 pass /
 * quota-state.json 读改写共存 / quotaWindowCost 窗口对齐。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCostScanner,
  quotaWindowCost,
  type CostScanRates,
  type CostScanner,
  type QuotaCostView,
} from "../../src/quota/cost-scan.js";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 10, 0, 0); // 2026-11-03T10:00:00Z

let workDir: string;
let sessionDir: string;
let statePath: string;
let now = NOW;
const scanners: CostScanner[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cost-scan-"));
  sessionDir = join(workDir, "sessions", "--cwd--");
  mkdirSync(sessionDir, { recursive: true });
  statePath = join(workDir, "quota-state.json");
  now = NOW;
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

function makeScanner(
  priceLookup: (provider: string, model: string) => CostScanRates | undefined = () => undefined,
  budget: { ms: number; bytes: number } = { ms: 5_000, bytes: 64 * 1024 * 1024 },
): CostScanner {
  const s = createCostScanner({
    sessionDir,
    statePath,
    priceLookup,
    now: () => now,
    budget,
    busyIntervalMs: 0,
    idleIntervalMs: 0,
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

describe("cost-scan: 基本扫描与窗口求和", () => {
  it("assistant 行的 cost.total 按 provider+hour 聚合；窗口区间外不计", async () => {
    writeFileSync(
      join(sessionDir, "a.jsonl"),
      assistantLine("kimi-coding", "k3", NOW - 1 * H, 1.5) +
        assistantLine("kimi-coding", "k3", NOW - 2 * H, 2.5) +
        assistantLine("zai", "glm-5.3", NOW - 1 * H, 0.25) +
        `${JSON.stringify({ type: "message", timestamp: new Date(NOW).toISOString(), message: { role: "user", content: [] } })}\n`,
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
