// @vitest-environment happy-dom
/**
 * fleet-fill-budget(2026-10-28 用户需求:「agents 和 bash 内容应该通过调配显示数量把整个高度
 * 填满」;docs/dev/web-hub/fleet-fill-budget.md)—— 四层用例:
 *
 * 1. `computeFillBudget` 纯函数:地板(必显 + min(3))优先 + 50/50 目标 + 余量互让 + 取整尾差
 *    回收 + 用户覆盖(bash 折叠 / 「显示已完成」)+ 折叠按钮两阶段预留 + 测量为 0 回退 null;
 *    含 2026-10-28 验收打回复现用例与固定种子 LCG 性质测试(不能用 Math.random,仓库有扫描)。
 * 2. `fixedAgentRowCount`:顶层终态行不算必显、嵌套层按旧 3/5 规则、depth≥3 默认收起不计。
 * 3. 组件接入:FleetTree 根层级吃 `terminalBudget`(子层不受影响)+ 用户点开「显示已完成」
 *    回传 emit;FleetBashJobs 的 `fill`/`fillReady` 模式(预算 null ⇒ 与不传 fill 完全一致)。
 * 4. FleetDrawer 测量与接线:mock offsetHeight/clientHeight(happy-dom 的 ResizeObserver
 *    永不触发,恰好等价「无 RO」环境),覆盖回退一致、预算下发、只有 bash、折叠 bash 重分。
 */
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeFillBudget,
  fixedAgentRowCount,
  topTerminalRowCount,
  FILL_MIN_ROWS,
  type FillCounts,
  type FillMeasure,
} from "../../../src/web-hub/ui/src/components/fleet/fillBudget.js";
import FleetTree from "../../../src/web-hub/ui/src/components/fleet/FleetTree.vue";
import FleetBashJobs from "../../../src/web-hub/ui/src/components/fleet/FleetBashJobs.vue";
import FleetDrawer from "../../../src/web-hub/ui/src/components/drawer/FleetDrawer.vue";
import { buildFleetTree } from "../../../src/web-hub/ui/src/components/fleet/summary.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { HubHandle } from "../../../src/web-hub/ui/src/types.js";
import type { FleetRowWire } from "../../../src/web-hub/protocol/messages.js";
import type { BashJobRowWire, BashJobsWire } from "../../../src/web-hub/protocol/messages.js";

const M = (over: Partial<FillMeasure> = {}): FillMeasure => ({
  heightPx: 1000,
  agentRowPx: 20,
  bashRowPx: 20,
  agentExtraPx: 0,
  bashHeaderPx: 32,
  agentFoldPx: 0,
  bashFoldPx: 0,
  ...over,
});
const C = (over: Partial<FillCounts> = {}): FillCounts => ({
  agentFixedRows: 0,
  agentTerminalTop: 0,
  bashMustRows: 0,
  bashTerminalRows: 0,
  ...over,
});

describe("computeFillBudget — 回退与空态", () => {
  it("测量不可用(clientHeight/行高为 0)⇒ null(调用方回退旧 3/5)", () => {
    expect(computeFillBudget(M({ heightPx: 0 }), C({ agentTerminalTop: 9 }))).toBeNull();
    expect(computeFillBudget(M({ heightPx: -5 }), C({ agentTerminalTop: 9 }))).toBeNull();
    expect(computeFillBudget(M({ agentRowPx: 0 }), C({ agentTerminalTop: 9 }))).toBeNull();
    // bash 块有行却测不到 bash 行高 ⇒ 整体回退
    expect(computeFillBudget(M({ bashRowPx: 0 }), C({ bashTerminalRows: 4 }))).toBeNull();
    // bash 块不存在时 bashRowPx=0 合法,不回退
    expect(computeFillBudget(M({ bashRowPx: 0 }), C({ agentTerminalTop: 4 }))).not.toBeNull();
  });

  it("验收 #1:只有 bash、没有 agent 行 ⇒ agent 行高不是前置条件,bash 拿整高", () => {
    const r = computeFillBudget(M({ heightPx: 400, agentRowPx: 0 }), C({ bashTerminalRows: 100 }));
    expect(r).not.toBeNull();
    expect(r?.bashTerminal).toBe(18); // floor((400-32)/20)
    expect(r?.agentTerminal).toBe(0);
  });

  it("两块都无内容 ⇒ 全 0", () => {
    expect(computeFillBudget(M(), C())).toEqual({ agentTerminal: 0, bashTerminal: 0 });
  });
});

describe("computeFillBudget — 50/50 半高分(2026-10-28 用户拍板)", () => {
  it("两块都装得下 ⇒ 全显示(余量无处可让,底部留白属正常)", () => {
    const r = computeFillBudget(M({ heightPx: 1000 }), C({ agentTerminalTop: 4, bashTerminalRows: 6 }));
    expect(r).toEqual({ agentTerminal: 4, bashTerminal: 6 });
  });

  it("高不够时各吃自己那一半:agent 一半 200px ⇒ 10 行;bash 扣 32px 标题后 ⇒ 8 行", () => {
    const r = computeFillBudget(M({ heightPx: 400 }), C({ agentTerminalTop: 100, bashTerminalRows: 100 }));
    expect(r?.agentTerminal).toBe(10); // floor(200/20)
    expect(r?.bashTerminal).toBe(8); // floor((200-32)/20)
  });

  it("只有一块 ⇒ 另一块拿整高", () => {
    const onlyAgents = computeFillBudget(M({ heightPx: 400 }), C({ agentTerminalTop: 100 }));
    expect(onlyAgents?.agentTerminal).toBe(20); // floor(400/20)
    const onlyBash = computeFillBudget(M({ heightPx: 400 }), C({ bashTerminalRows: 100 }));
    expect(onlyBash?.bashTerminal).toBe(18); // floor((400-32)/20)
  });

  it("折叠按钮高度两阶段预留:会折叠的块把按钮高计入必显重算", () => {
    // 同「半高分」用例,但 foldPx=20:agent 第一阶段 10 行 < 100 ⇒ 第二阶段 mustA=20 ⇒ 9 行
    const r = computeFillBudget(
      M({ heightPx: 400, agentFoldPx: 20, bashFoldPx: 20 }),
      C({ agentTerminalTop: 100, bashTerminalRows: 100 }),
    );
    expect(r?.agentTerminal).toBe(9); // floor((200-20)/20)
    expect(r?.bashTerminal).toBe(7); // floor((200-32-20)/20)
  });
});

describe("computeFillBudget — 地板优先(2026-10-28 验收 #2 重写)", () => {
  it("验收 #2 复现:必显够半但 必显+下限 超半 ⇒ bash 让到 H − agent 地板,总高 ≤ H", () => {
    // H=400,行高 20:agent 必显 8 行(160)+ 下限 3 ⇒ 地板 220 > H/2;bash 地板 32+60=92。
    // 旧算法给 {3,10}=420 溢出;新算法 availB=H−220=180 ⇒ bash 7 行,总高 392 ≤ 400。
    const r = computeFillBudget(
      M({ heightPx: 400 }),
      C({ agentFixedRows: 8, agentTerminalTop: 9, bashTerminalRows: 12 }),
    );
    expect(r?.agentTerminal).toBe(3); // 地板:min(3,9)
    expect(r?.bashTerminal).toBe(7); // floor((180-32)/20)
    // 总高 = 160+3*20 + 32+7*20 = 392 ≤ 400
  });

  it("高度极小 ⇒ 两块各保 min(3) 条下限(地板超高,放任滚动)", () => {
    const r = computeFillBudget(M({ heightPx: 120 }), C({ agentTerminalTop: 50, bashTerminalRows: 50 }));
    expect(r?.agentTerminal).toBe(FILL_MIN_ROWS);
    expect(r?.bashTerminal).toBe(FILL_MIN_ROWS);
  });

  it("不足 3 行的块按下限的自然上界处理(本身就没那么多行)", () => {
    const r = computeFillBudget(M({ heightPx: 120 }), C({ agentTerminalTop: 2, bashTerminalRows: 1 }));
    expect(r?.agentTerminal).toBe(2);
    expect(r?.bashTerminal).toBe(1);
  });

  it("agent 地板超高(必显 15 行 + 下限 ≥ H)⇒ 两块都守地板", () => {
    // mustA=300,minA=3 ⇒ floorA=360;floorB=92;452 ≥ 400 ⇒ 滚动,各取下限
    const r = computeFillBudget(
      M({ heightPx: 400 }),
      C({ agentFixedRows: 15, agentTerminalTop: 20, bashTerminalRows: 20 }),
    );
    expect(r?.agentTerminal).toBe(FILL_MIN_ROWS);
    expect(r?.bashTerminal).toBe(FILL_MIN_ROWS);
  });

  it("bash 地板超半 ⇒ bash 守地板,agent 拿剩余(不再被压到下限)", () => {
    // bashMust=10 ⇒ mustB=232,floorB=292 > H/2;floorA=60;352 < 400 ⇒ availA=H−292=108
    const r = computeFillBudget(
      M({ heightPx: 400 }),
      C({ agentTerminalTop: 20, bashMustRows: 10, bashTerminalRows: 20 }),
    );
    expect(r?.bashTerminal).toBe(FILL_MIN_ROWS); // 地板 292 恰好装 232+3*20
    expect(r?.agentTerminal).toBe(5); // floor(108/20)
  });
});

describe("computeFillBudget — 余量互让", () => {
  it("agent 块填不满自己那一半 ⇒ 余量让给 bash", () => {
    // H=1000:agent 只有 2 条已结束(用 40px),余 460px 让给 bash ⇒ bash avail=960
    const r = computeFillBudget(M({ heightPx: 1000 }), C({ agentTerminalTop: 2, bashTerminalRows: 100 }));
    expect(r?.agentTerminal).toBe(2);
    expect(r?.bashTerminal).toBe(46); // floor((960-32)/20)
  });

  it("bash 块填不满 ⇒ 余量让给 agent", () => {
    const r = computeFillBudget(M({ heightPx: 1000 }), C({ agentTerminalTop: 100, bashTerminalRows: 1 }));
    // bash 用 32+20=52,余 448 ⇒ agent avail=948 ⇒ floor(948/20)=47
    expect(r?.agentTerminal).toBe(47);
    expect(r?.bashTerminal).toBe(1);
  });
});

describe("computeFillBudget — 用户覆盖(2026-10-28 验收 #3)", () => {
  it("用户折叠 bash ⇒ bash 只占标题高,余量全部给 agents", () => {
    const r = computeFillBudget(M({ heightPx: 400 }), C({ agentTerminalTop: 100, bashTerminalRows: 100 }), {
      bashCollapsed: true,
    });
    expect(r?.agentTerminal).toBe(18); // floor((400-32)/20)
    expect(r?.bashTerminal).toBe(FILL_MIN_ROWS); // 组已收起,配额仅占位
  });

  it("用户点开 agent 顶层「显示已完成」⇒ agents 全显,剩余空间给 bash", () => {
    const r = computeFillBudget(M({ heightPx: 400 }), C({ agentTerminalTop: 12, bashTerminalRows: 100 }), {
      agentShowAll: true,
    });
    expect(r?.agentTerminal).toBe(12); // 全显,用 240
    expect(r?.bashTerminal).toBe(6); // floor((160-32)/20)
  });

  it("用户点开 bash「显示已完成」⇒ bash 全显,剩余空间给 agents", () => {
    const r = computeFillBudget(M({ heightPx: 400 }), C({ agentTerminalTop: 100, bashTerminalRows: 5 }), {
      bashShowAll: true,
    });
    expect(r?.bashTerminal).toBe(5); // 全显,用 32+100=132
    expect(r?.agentTerminal).toBe(13); // floor(268/20)
  });

  it("agents 全显超过可用高 ⇒ bash 保地板,放任滚动(用户操作为准)", () => {
    const r = computeFillBudget(M({ heightPx: 400 }), C({ agentTerminalTop: 30, bashTerminalRows: 100 }), {
      agentShowAll: true,
    });
    expect(r?.agentTerminal).toBe(30); // 用 600 > 400
    expect(r?.bashTerminal).toBe(FILL_MIN_ROWS); // 地板 92
  });
});

// ---------------------------------------------------------------------------
// 性质测试(验收 #2):固定种子 LCG(仓库禁 Math.random),10 万组随机输入钉不变式
// ---------------------------------------------------------------------------
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x100000000;
  };
}

describe("computeFillBudget — 性质(固定种子 LCG × 100k)", () => {
  it("不变式:总高 ≤ max(H, 地板和) ∧ 每块 ≥ min(3) ∧ 不浪费(有藏行 ⇒ 总高+一行 > H)", () => {
    const rand = makeLcg(0x5eed2026);
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    let nullCount = 0;
    for (let i = 0; i < 100_000; i++) {
      const m = M({
        heightPx: int(0, 2000),
        agentRowPx: int(0, 60),
        bashRowPx: int(0, 60),
        agentExtraPx: int(0, 150),
        bashHeaderPx: int(0, 80),
        agentFoldPx: int(0, 40),
        bashFoldPx: int(0, 40),
      });
      const c = C({
        agentFixedRows: int(0, 40),
        agentTerminalTop: int(0, 60),
        bashMustRows: int(0, 20),
        bashTerminalRows: int(0, 60),
      });
      const r = computeFillBudget(m, c);
      const agentHasRows = c.agentFixedRows + c.agentTerminalTop > 0;
      const bashActive = c.bashMustRows + c.bashTerminalRows > 0;
      if (r === null) {
        // 回退只允许发生在:H 非正,或存在内容的块测不到行高
        const ok = !(m.heightPx > 0) || (agentHasRows && !(m.agentRowPx > 0)) || (bashActive && !(m.bashRowPx > 0));
        expect(ok, `null without cause: ${JSON.stringify({ m, c })}`).toBe(true);
        nullCount++;
        continue;
      }
      // 每块 shown 在 [min(3, 行数), 行数] 内
      const minA = Math.min(FILL_MIN_ROWS, c.agentTerminalTop);
      const minB = Math.min(FILL_MIN_ROWS, c.bashTerminalRows);
      expect(r.agentTerminal).toBeGreaterThanOrEqual(minA);
      expect(r.agentTerminal).toBeLessThanOrEqual(c.agentTerminalTop);
      expect(r.bashTerminal).toBeGreaterThanOrEqual(minB);
      expect(r.bashTerminal).toBeLessThanOrEqual(c.bashTerminalRows);
      // 还原渲染总高(折叠按钮只在还有被藏行时渲染,与实现的两阶段预留一致):
      // reserve ⟺ 最终 still folds(第一阶段 fold ⟹ 第二阶段仍 fold,预留只增必显)。
      const ra = agentHasRows ? m.agentRowPx : 1;
      const rb = bashActive ? m.bashRowPx : 1;
      const mustA = c.agentFixedRows * ra + m.agentExtraPx + (r.agentTerminal < c.agentTerminalTop ? m.agentFoldPx : 0);
      const mustB = bashActive
        ? m.bashHeaderPx + c.bashMustRows * rb + (r.bashTerminal < c.bashTerminalRows ? m.bashFoldPx : 0)
        : 0;
      const floorA = mustA + minA * ra;
      const floorB = bashActive ? mustB + minB * rb : 0;
      const total = mustA + r.agentTerminal * ra + mustB + r.bashTerminal * rb;
      // 总高 ≤ max(H, 地板和)(地板超高 ⇒ 放任滚动)
      expect(total, `overflow: ${JSON.stringify({ m, c, r, total })}`).toBeLessThanOrEqual(
        Math.max(m.heightPx, floorA + floorB) + 1e-9,
      );
      // 不浪费:只要某块还有被藏的行,总高 + 该块一行的高度 > H
      if (r.agentTerminal < c.agentTerminalTop) {
        expect(total + ra, `waste A: ${JSON.stringify({ m, c, r, total })}`).toBeGreaterThan(m.heightPx);
      }
      if (r.bashTerminal < c.bashTerminalRows) {
        expect(total + rb, `waste B: ${JSON.stringify({ m, c, r, total })}`).toBeGreaterThan(m.heightPx);
      }
    }
    expect(nullCount).toBeGreaterThan(0); // 确认回退分支也被打到
  });
});

// ---------------------------------------------------------------------------
// fixedAgentRowCount / topTerminalRowCount(纯树形统计)
// ---------------------------------------------------------------------------
function agentRow(runId: string, extra: Record<string, unknown> = {}): FleetRowWire {
  return {
    runId,
    label: runId,
    type: "general",
    status: "running",
    phaseLabel: "working",
    elapsedMs: 1000,
    phaseMs: 0,
    highlight: "none",
    terminal: false,
    ...extra,
  } as FleetRowWire;
}
const done = (runId: string, extra: Record<string, unknown> = {}): FleetRowWire =>
  agentRow(runId, { status: "completed", phaseLabel: "done", terminal: true, ...extra });

describe("fixedAgentRowCount / topTerminalRowCount", () => {
  it("顶层终态行不算必显(它们是预算控制对象);非终态行算", () => {
    const nodes = buildFleetTree([agentRow("a"), agentRow("b"), done("c"), done("d"), done("e")]);
    expect(fixedAgentRowCount(nodes)).toBe(2);
    expect(topTerminalRowCount(nodes)).toBe(3);
  });

  it("嵌套层按旧规则:≤5 条已结束全显 ⇒ 全计入必显", () => {
    const nodes = buildFleetTree([
      agentRow("root"),
      agentRow("c1", { parentRunId: "root" }),
      done("c2", { parentRunId: "root" }),
      done("c3", { parentRunId: "root" }),
    ]);
    expect(fixedAgentRowCount(nodes)).toBe(4); // root + c1 + c2 + c3
    expect(topTerminalRowCount(nodes)).toBe(0); // 顶层没有终态行
  });

  it("嵌套层 >5 条已结束 ⇒ 只按旧规则的 3 条计入", () => {
    const rows: FleetRowWire[] = [agentRow("root")];
    for (let i = 0; i < 7; i++) rows.push(done(`t${i}`, { parentRunId: "root" }));
    const nodes = buildFleetTree(rows);
    expect(fixedAgentRowCount(nodes)).toBe(1 + 3);
  });

  it("depth ≥3 的子树默认收起 ⇒ 不计入必显", () => {
    // d0 root → d1 a → d2 b → d3 c(可见)→ c 的孩子 d(所在层 depth=4 的列表由 depth=3 的
    // details 包裹,默认收起)⇒ d 不计。
    const nodes = buildFleetTree([
      agentRow("root"),
      agentRow("a", { parentRunId: "root" }),
      agentRow("b", { parentRunId: "a" }),
      agentRow("c", { parentRunId: "b" }),
      agentRow("d", { parentRunId: "c" }),
    ]);
    expect(fixedAgentRowCount(nodes)).toBe(4); // root/a/b/c,d 不收
  });
});

// ---------------------------------------------------------------------------
// 组件接入:FleetTree 的 terminalBudget(仅 depth 0)+ 用户「显示已完成」回传
// ---------------------------------------------------------------------------
describe("FleetTree — terminalBudget 配额(仅根层级)", () => {
  const flat = (terminalN: number, liveN = 1): FleetRowWire[] => {
    const rows: FleetRowWire[] = [];
    for (let i = 0; i < liveN; i++) rows.push(agentRow(`live-${i}`));
    for (let i = 0; i < terminalN; i++) rows.push(done(`done-${i}`));
    return rows;
  };

  it("给定预算 ⇒ 顶层已结束行按预算显示,其余进「Show N Finished Runs」", async () => {
    const wrapper = mount(FleetTree, {
      props: { nodes: buildFleetTree(flat(7)), now: 0, terminalBudget: 4 },
    });
    expect(wrapper.findAll(".tree > li").length).toBe(1 + 4);
    const more = wrapper.get(".run-more");
    expect(more.text()).toContain("Show 3 Finished Runs");
    await more.trigger("click"); // 用户操作为准:点开后不再受预算限制
    expect(wrapper.findAll(".tree > li").length).toBe(1 + 7);
    expect(wrapper.find(".run-more").exists()).toBe(false);
  });

  it("验收 #3:根层级点开「显示已完成」⇒ emit show-all-terminal(供抽屉重分);子层不 emit", async () => {
    const root = mount(FleetTree, {
      props: { nodes: buildFleetTree(flat(7)), now: 0, terminalBudget: 4 },
    });
    await root.get(".run-more").trigger("click");
    expect(root.emitted("show-all-terminal")?.length).toBe(1);

    const nestedRows: FleetRowWire[] = [agentRow("root")];
    for (let i = 0; i < 7; i++) nestedRows.push(done(`t${i}`, { parentRunId: "root" }));
    const nested = mount(FleetTree, { props: { nodes: buildFleetTree(nestedRows), now: 0 } });
    await nested.get(".run-more").trigger("click"); // 子层(depth 1)的折叠钮
    expect(nested.emitted("show-all-terminal") ?? []).toEqual([]);
  });

  it("预算 ≥ 已结束行数 ⇒ 全显示、无折叠按钮", () => {
    const wrapper = mount(FleetTree, {
      props: { nodes: buildFleetTree(flat(4)), now: 0, terminalBudget: 10 },
    });
    expect(wrapper.findAll(".tree > li").length).toBe(1 + 4);
    expect(wrapper.find(".run-more").exists()).toBe(false);
  });

  it("不给预算 ⇒ 旧 3/5 行为(>5 显 3,≤5 全显)", () => {
    const many = mount(FleetTree, { props: { nodes: buildFleetTree(flat(7)), now: 0 } });
    expect(many.findAll(".tree > li").length).toBe(1 + 3);
    expect(many.get(".run-more").text()).toContain("Show 4 Finished Runs");
    const few = mount(FleetTree, { props: { nodes: buildFleetTree(flat(4)), now: 0 } });
    expect(few.findAll(".tree > li").length).toBe(1 + 4);
    expect(few.find(".run-more").exists()).toBe(false);
  });

  it("预算不接管子层:嵌套层仍按旧 3/5 折叠", () => {
    const rows: FleetRowWire[] = [agentRow("root")];
    for (let i = 0; i < 7; i++) rows.push(done(`t${i}`, { parentRunId: "root" }));
    const wrapper = mount(FleetTree, {
      props: { nodes: buildFleetTree(rows), now: 0, terminalBudget: 1 },
    });
    // 顶层只有 1 条运行中(root),预算是 1 但顶层没有已结束行;子层 7 条已结束按旧规则显 3
    // (`.tree > li` 会同时命中嵌套的 ul.tree,4 = 顶层 1 + 子层 3)
    expect(wrapper.findAll(".tree > li").length).toBe(1 + 3);
    expect(wrapper.text()).toContain("Show 4 Finished Runs");
  });
});

// ---------------------------------------------------------------------------
// 组件接入:FleetBashJobs 的 fill / fillReady / terminalBudget
// ---------------------------------------------------------------------------
const SAMPLED_AT = 1_700_000_000_000;
const bashRow = (over: Partial<BashJobRowWire> = {}): BashJobRowWire => ({
  id: "job-aaaa1111",
  cmd: "sleep 60",
  status: "running",
  exitCode: null,
  createdAt: SAMPLED_AT - 5_000,
  elapsedMs: 5_000,
  logBytes: 0,
  ...over,
});
const bashDone = (id: string): BashJobRowWire =>
  bashRow({ id, status: "completed", exitCode: 0, endedAt: SAMPLED_AT - 1_000, elapsedMs: 4_000 });
const bashWire = (rows: BashJobRowWire[]): BashJobsWire => ({
  rows,
  total: rows.length,
  running: rows.filter((r) => r.status === "running" || r.status === "staged").length,
  failed: 0,
  sampledAt: SAMPLED_AT,
});

describe("FleetBashJobs — fill 模式 + terminalBudget", () => {
  it("按预算裁断已结束行,运行中行不受裁断;其余进「Show N Finished Runs」", async () => {
    const wrapper = mount(FleetBashJobs, {
      props: {
        jobs: bashWire([
          bashRow({ id: "job-live" }),
          bashDone("job-d1"),
          bashDone("job-d2"),
          bashDone("job-d3"),
          bashDone("job-d4"),
        ]),
        now: SAMPLED_AT,
        fill: true,
        terminalBudget: 2,
      },
    });
    expect(wrapper.findAll(".bj-item").length).toBe(1 + 2);
    const more = wrapper.get(".bj-fill-more .run-more");
    expect(more.text()).toContain("Show 2 Finished Runs");
    await more.trigger("click"); // 用户点「显示已完成」⇒ 不再裁断
    expect(wrapper.findAll(".bj-item").length).toBe(1 + 4);
    expect(wrapper.find(".bj-fill-more").exists()).toBe(false);
  });

  it("验收 #3:用户开合组标题 ⇒ emit update:open;点「显示已完成」⇒ emit show-all-terminal", async () => {
    const wrapper = mount(FleetBashJobs, {
      props: {
        jobs: bashWire([bashDone("job-d1"), bashDone("job-d2")]),
        now: SAMPLED_AT,
        fill: true,
        terminalBudget: 1,
      },
    });
    await wrapper.get(".bj-sum").trigger("click"); // 折叠
    expect(wrapper.emitted("update:open")).toEqual([[false]]);
    await wrapper.get(".bj-sum").trigger("click"); // 重新展开
    expect(wrapper.emitted("update:open")).toEqual([[false], [true]]);
    await wrapper.get(".bj-fill-more .run-more").trigger("click");
    expect(wrapper.emitted("show-all-terminal")?.length).toBe(1);
  });

  it("fill 模式初始恒展开(供测量);预算为 0 且无运行中 ⇒ 预算到达后收起", async () => {
    const wrapper = mount(FleetBashJobs, {
      props: {
        jobs: bashWire([bashDone("job-d1"), bashDone("job-d2")]),
        now: SAMPLED_AT,
        fill: true,
        terminalBudget: 0,
      },
    });
    expect(wrapper.find(".bj-list").exists()).toBe(false); // 预算建议:容不下 1 条 ⇒ 收起
    await wrapper.get(".bj-sum").trigger("click"); // 用户手动展开 ⇒ 以用户操作为准
    expect(wrapper.find(".bj-list").exists()).toBe(true);
    // 展开后按预算 0 裁断:全部进折叠按钮
    expect(wrapper.findAll(".bj-item").length).toBe(0);
    expect(wrapper.get(".bj-fill-more .run-more").text()).toContain("Show 2 Finished Runs");
  });

  it("fill 但首轮测量未完成(fillReady 未传)⇒ 展开且显示全部行(等测量)", () => {
    const rows: BashJobRowWire[] = [];
    for (let i = 0; i < 8; i++) rows.push(bashDone(`job-d${i}`));
    const wrapper = mount(FleetBashJobs, { props: { jobs: bashWire(rows), now: SAMPLED_AT, fill: true } });
    expect(wrapper.find(".bj-list").exists()).toBe(true);
    expect(wrapper.findAll(".bj-item").length).toBe(8);
    expect(wrapper.find(".bj-fill-more").exists()).toBe(false);
  });

  it("验收 #1:fill + fillReady 但预算仍是 undefined(测量失败)⇒ 与不传 fill 完全一致", async () => {
    const rows: BashJobRowWire[] = [];
    for (let i = 0; i < 8; i++) rows.push(bashDone(`job-d${i}`));
    const legacy = mount(FleetBashJobs, { props: { jobs: bashWire(rows), now: SAMPLED_AT } });
    const fallback = mount(FleetBashJobs, {
      props: { jobs: bashWire(rows), now: SAMPLED_AT, fill: true, fillReady: true },
    });
    await nextTick();
    // 旧默认:>5 全终态 ⇒ 收起;回退路径必须一致
    expect(legacy.find(".bj-list").exists()).toBe(false);
    expect(fallback.find(".bj-list").exists()).toBe(false);
    expect(fallback.find("section.fleet-bash").html()).toBe(legacy.find("section.fleet-bash").html());
    await fallback.get(".bj-sum").trigger("click"); // 展开后同样无裁断、无折叠按钮
    expect(fallback.findAll(".bj-item").length).toBe(8);
    expect(fallback.find(".bj-fill-more").exists()).toBe(false);
  });

  it("无 fill 无预算 ⇒ 旧行为字节不变(>5 全终态默认收起,展开后全显、无裁断按钮)", async () => {
    const rows: BashJobRowWire[] = [];
    for (let i = 0; i < 8; i++) rows.push(bashDone(`job-d${i}`));
    const wrapper = mount(FleetBashJobs, { props: { jobs: bashWire(rows), now: SAMPLED_AT } });
    expect(wrapper.find(".bj-list").exists()).toBe(false); // 旧默认:收起
    await wrapper.get(".bj-sum").trigger("click");
    expect(wrapper.findAll(".bj-item").length).toBe(8);
    expect(wrapper.find(".bj-fill-more").exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FleetDrawer 测量与接线(验收 #6):mock offsetHeight/clientHeight;happy-dom 自带的
// ResizeObserver 永不触发,天然覆盖「无 RO ⇒ 不活,只在挂载/行数变化/用户操作时重算」。
// ---------------------------------------------------------------------------
const mounted: Array<ReturnType<typeof mount>> = [];
const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (origOffsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", origOffsetHeight);
  if (origClientHeight !== undefined) Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
  document.body.innerHTML = "";
});

function fakeHub(): HubHandle {
  return {
    state: ref({ control: true }) as HubHandle["state"],
    selectRun: vi.fn(),
    pageRun: vi.fn(),
    dispatch: vi.fn(),
  } as unknown as HubHandle;
}

function drawerAgent(fleetRows: FleetRowWire[], bashRows: BashJobRowWire[] | undefined): Record<string, unknown> {
  return {
    key: "A",
    card: { control: true, state: "live", runTranscript: true },
    down: false,
    prompts: [],
    fleet: fleetRows,
    items: [],
    uid: 0,
    lastSeq: 0,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
    dialogs: { epoch: "e1", open: [], closed: [] },
    pendingCtl: [],
    runSel: null,
    runTx: null,
    ...(bashRows !== undefined && bashRows.length > 0 ? { status: { bashJobs: bashWire(bashRows) } } : {}),
  };
}

function mountDrawer(agent: Record<string, unknown>) {
  const wrapper = mount(FleetDrawer, {
    props: { agent, now: SAMPLED_AT, mode: "overlay", open: true },
    attachTo: document.body,
    global: { provide: { [HUB_CTX as symbol]: fakeHub() } },
  });
  mounted.push(wrapper);
  return wrapper;
}

/** 行高/标题高/折叠按钮高的假布局:tree-scroll 400,行 20,bj-sum 32。 */
function stubLayout(): void {
  const offset = function (this: HTMLElement): number {
    const cl = this.classList;
    if (cl.contains("run")) return 20;
    if (cl.contains("bj-row")) return 20;
    if (cl.contains("bj-sum")) return 32;
    if (cl.contains("run-more")) return 20;
    return 0;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: offset });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("tree-scroll") ? 400 : 0;
    },
  });
}

const flatFleet = (terminalN: number, liveN = 1): FleetRowWire[] => {
  const rows: FleetRowWire[] = [];
  for (let i = 0; i < liveN; i++) rows.push(agentRow(`live-${i}`));
  for (let i = 0; i < terminalN; i++) rows.push(done(`done-${i}`));
  return rows;
};
const doneBash = (n: number): BashJobRowWire[] => Array.from({ length: n }, (_, i) => bashDone(`job-d${i}`));
const drawerEl = () => document.querySelector<HTMLElement>("#fleet-drawer")!;
const settle = async (): Promise<void> => {
  await nextTick();
  await nextTick();
  await nextTick();
};

describe("FleetDrawer — 测量与接线(验收 #6)", () => {
  it("测量全为 0 ⇒ 预算 null ⇒ 两块渲染与不传预算完全一致(旧 3/5 + 默认折叠)", async () => {
    // happy-dom 默认 offsetHeight/clientHeight 全 0,正好就是「测量不可用」环境
    mountDrawer(drawerAgent(flatFleet(7), doneBash(8)));
    await settle();
    // agent 树:旧 3/5(7 条已结束 ⇒ 显 3)
    expect(drawerEl().querySelectorAll(".tree > li").length).toBe(1 + 3);
    expect(drawerEl().querySelector(".tree-scroll > .run-more")?.textContent).toContain("Show 4 Finished Runs");
    // bash 组:与不传 fill 一致 —— >5 全终态默认收起(验收 #1 的旧行为),无裁断按钮
    expect(drawerEl().querySelector(".bj-list")).toBeNull();
    expect(drawerEl().querySelector(".fleet-bash")!.getAttribute("data-open")).toBe("false");
    await drawerEl().querySelector<HTMLElement>(".bj-sum")!.click();
    await settle();
    expect(drawerEl().querySelectorAll(".bj-item").length).toBe(8);
    expect(drawerEl().querySelector(".bj-fill-more")).toBeNull();
  });

  it("正常测量 ⇒ 预算正确传到两个子组件(H=400,折叠按钮预留 20:agent 8 行,bash 7 行)", async () => {
    stubLayout();
    // agent:1 运行中 + 30 已结束 ⇒ mustA=20+预留 20,availA=200 ⇒ 8 行;bash 同理 ⇒ 7 行
    mountDrawer(drawerAgent(flatFleet(30), doneBash(30)));
    await settle();
    expect(drawerEl().querySelectorAll(".tree > li").length).toBe(1 + 8);
    expect(drawerEl().querySelector(".tree-scroll > .run-more")?.textContent).toContain("Show 22 Finished Runs");
    const bash = drawerEl().querySelector(".fleet-bash")!;
    expect(bash.getAttribute("data-open")).toBe("true"); // 预算容得下 ≥1 条 ⇒ 展开
    expect(bash.querySelectorAll(".bj-item").length).toBe(7);
    expect(bash.querySelector(".bj-fill-more .run-more")?.textContent).toContain("Show 23 Finished Runs");
  });

  it("验收 #1:只有 bash、没有 agent 行 ⇒ bash 拿整高(18 行),不再永久展开全显", async () => {
    stubLayout();
    mountDrawer(drawerAgent([], doneBash(30)));
    await settle();
    const bash = drawerEl().querySelector(".fleet-bash")!;
    expect(bash.getAttribute("data-open")).not.toBeNull();
    expect(bash.querySelectorAll(".bj-item").length).toBe(17); // floor((400-32-预留 20)/20)
    expect(bash.querySelector(".bj-fill-more .run-more")?.textContent).toContain("Show 13 Finished Runs");
  });

  it("验收 #3:用户折叠 bash 组 ⇒ bash 只占标题高,余量让给 agents(8 ⇒ 16 行)", async () => {
    stubLayout();
    mountDrawer(drawerAgent(flatFleet(30), doneBash(30)));
    await settle();
    expect(drawerEl().querySelectorAll(".tree > li").length).toBe(1 + 8);
    await drawerEl().querySelector<HTMLElement>(".bj-sum")!.click(); // 用户折叠 bash
    await settle();
    expect(drawerEl().querySelector(".bj-list")).toBeNull(); // 组已收起
    // bash 块只剩 32px 标题:agent avail=368 ⇒ floor((368-20-预留 20)/20)=16
    expect(drawerEl().querySelectorAll(".tree > li").length).toBe(1 + 16);
    expect(drawerEl().querySelector(".tree-scroll > .run-more")?.textContent).toContain("Show 14 Finished Runs");
    await drawerEl().querySelector<HTMLElement>(".bj-sum")!.click(); // 再展开 ⇒ 回到 50/50
    await settle();
    expect(drawerEl().querySelectorAll(".tree > li").length).toBe(1 + 8);
    expect(drawerEl().querySelectorAll(".bj-item").length).toBe(7);
  });

  it("验收 #3:用户点开 agent「显示已完成」⇒ agents 全显,bash 压到地板", async () => {
    stubLayout();
    mountDrawer(drawerAgent(flatFleet(30), doneBash(30)));
    await settle();
    await drawerEl().querySelector<HTMLElement>(".tree-scroll > .run-more")!.click();
    await settle();
    expect(drawerEl().querySelectorAll(".tree > li").length).toBe(1 + 30); // 全显
    expect(drawerEl().querySelector(".tree-scroll > .run-more")).toBeNull();
    // agents 用 20+600=620 > 400 ⇒ bash 保地板(32+3 行)
    expect(drawerEl().querySelectorAll(".bj-item").length).toBe(3);
    expect(drawerEl().querySelector(".bj-fill-more .run-more")?.textContent).toContain("Show 27 Finished Runs");
  });
});
