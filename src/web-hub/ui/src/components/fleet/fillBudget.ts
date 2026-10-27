/**
 * fleet 抽屉「填满高度」预算(2026-10-28 用户需求:「agents 和 bash 内容应该通过调配显示数量
 * 把整个高度填满」)—— 纯函数,无任何 DOM/Vue 依赖,测量与接入都在 `drawer/FleetDrawer.vue`。
 *
 * 模型:`.tree-scroll` 的 clientHeight H 是可用高度;抽屉内容分两块 —— agent 树(顶层
 * 已结束行是可控项)与 bash 分组(已结束行是可控项)。每块的「必显」内容:
 * - agent 块:所有默认可见的运行中/等待中行(任意深度)+ 嵌套层按旧折叠规则(≤5 全显,
 *   否则 3)露出的已结束行 + 「另有 N 个」省略行 + 已归档折叠头(这些高度经 `agentExtraPx`
 *   实测传入);
 * - bash 块:组标题 `.bj-sum` + 运行中/staged 行(+ 归档折叠头/omitted 标记,经
 *   `bashHeaderPx` 实测传入)。
 *
 * 分配(2026-10-28 验收打回后重写,作废「必显超半才压缩」的旧规则):
 * 0. 地板:每块的地板 = 必显 + min(3, 已有结束行数) 行高 —— 地板是硬保证,不再只在
 *    「必显超半」时才出场(旧规则漏算下限占用,验收随机输入 5.7% 溢出)。
 * 1. 地板超高:floorA + floorB ≥ H ⇒ 两块都取地板,放任滚动(规格允许的唯一滚动情形)。
 * 2. 否则先各给到地板,再按 50/50 目标分:每块上限 max(H/2, floor);一方地板超半时另一方
 *    让到 H − 该地板(因地板和 < H,让完后仍 ≥ 自身地板),总高 ≤ H 恒成立。
 * 3. 余量互让:一块填不满自己那份(行数用尽)⇒ 剩余高度让给另一块(A→B 再 B→A 各一轮收敛)。
 * 4. 取整尾差回收:按行高向下取整后两块各剩不足一行的尾差,可能凑出一行却没人拿 —— 轮流
 *    补给还能再放一行的块,直到谁都放不下。性质:「只要还有被藏的行,总高 + 该块行高 > H」。
 * 5. 折叠按钮预留(不动点迭代):结果里某块仍有被藏行时会渲染「显示已完成的 N 个」按钮,
 *    该按钮本身占高 —— 预留集合从空开始,每轮把「上一轮结果里被折叠的块」并入预留重算,
 *    直到收敛(≤3 轮:预留只增不减,最多两块)。必须迭代而非只算两轮:给 B 预留可能把
 *    本不折叠的 A 压成折叠(验收性质测试抓出的真实溢出)。收敛后仍可能多预留(预留了却
 *    不再折叠 —— 只是略保守,绝不溢出);按钮未测到高时调用方用行高估计(验收 #4)。
 * 6. 用户覆盖(FillOverrides,2026-10-28 验收 #3):手动折叠 bash 组 ⇒ bash 块只占标题高,
 *    余量全给 agents;某块点开「显示已完成」⇒ 该块全显,剩余空间给另一块(可能滚动,
 *    用户操作为准)。
 *
 * 某块不存在时它的行高不是前置条件(验收 #1:只有 bash 没有 agent 行时也能出预算);
 * 该块份额整块让给另一块。测量不可用(clientHeight 为 0,或存在内容的块测不到行高 ——
 * happy-dom/jsdom)返回 null,调用方回退到旧固定 3/5 行为,现有测试字节不变。
 */
import type { FleetTreeNode } from "../../types.js";
import { isTerminalRow } from "./summary.js";

/** 每块已结束行的可见下限 —— 与 FleetTree 旧 TERMINAL_FOLD_MAX 相同。 */
export const FILL_MIN_ROWS = 3;

/** 嵌套层(depth ≥1)沿用的旧折叠规则,预算不接管子层。 */
const LEGACY_FOLD_FEW = 5;
const LEGACY_FOLD_MAX = 3;

export interface FillMeasure {
  /** `.tree-scroll` 的 clientHeight(取 clientHeight 而非 scrollHeight —— 不随内容变化,
   *  预算 → 内容高度 → 可用高度 之间因此没有反馈环)。 */
  readonly heightPx: number;
  /** 实测一条 agent 行高(offsetHeight;0 = 未测到/无行)。 */
  readonly agentRowPx: number;
  /** 实测一条 bash 行高(0 = 未测到;bash 块有行但测不到 ⇒ 整体回退 null)。 */
  readonly bashRowPx: number;
  /** agent 块的必显附加高度:`.fleet-omitted` 省略行 + 已归档折叠头的实测高度合计。 */
  readonly agentExtraPx: number;
  /** bash 块的必显头部高度:`.bj-sum` 组标题 + 归档折叠头/omitted 标记的实测高度合计。 */
  readonly bashHeaderPx: number;
  /** 「显示已完成的 N 个」按钮高(agent 块;未测到时调用方已用行高估计,不为 0)。 */
  readonly agentFoldPx: number;
  /** 同上的 bash 块折叠按钮高(单独测量、单独缓存,2026-10-28 验收 #4)。 */
  readonly bashFoldPx: number;
}

export interface FillCounts {
  /** agent 块必显行数:默认可见的非终态行(任意深度)+ 嵌套层按旧规则露出的终态行。
   *  顶层终态行不在内 —— 它是预算控制对象。 */
  readonly agentFixedRows: number;
  /** 顶层(depth 0)终态行数。 */
  readonly agentTerminalTop: number;
  /** bash 块必显行数(live = running/staged;未归档)。 */
  readonly bashMustRows: number;
  /** bash 块终态行数(未归档)。 */
  readonly bashTerminalRows: number;
}

/** 用户手动操作覆盖(2026-10-28 验收 #3:手动操作优先,余量随之重分)。 */
export interface FillOverrides {
  /** 用户手动折叠了 bash 组:bash 块只占组标题高,余量全部让给 agents。 */
  readonly bashCollapsed?: boolean;
  /** 用户点开了 agent 顶层「显示已完成的 N 个」:agent 块全显,剩余空间给 bash。 */
  readonly agentShowAll?: boolean;
  /** 用户点开了 bash 的「显示已完成的 N 个」:bash 块全显,剩余空间给 agents。 */
  readonly bashShowAll?: boolean;
}

export interface FillBudget {
  /** 顶层可见已结束 agent 行数(0..agentTerminalTop)。 */
  readonly agentTerminal: number;
  /** 可见已结束 bash 行数(0..bashTerminalRows)。 */
  readonly bashTerminal: number;
}

/**
 * agent 块的必显行数(见 FillCounts.agentFixedRows)。可见性按默认状态:`<details>` 在
 * depth < 3 时默认展开,更深的子树默认收起、不计高;用户手动折叠/展开造成的偏差属已知
 * 近似(见 docs/dev/web-hub/fleet-fill-budget.md)。
 */
export function fixedAgentRowCount(nodes: readonly FleetTreeNode[], depth: number = 0): number {
  let live = 0;
  let terminal = 0;
  let nested = 0;
  for (const node of nodes) {
    if (isTerminalRow(node.row)) terminal++;
    else live++;
    if (node.children.length > 0 && depth < 3) nested += fixedAgentRowCount(node.children, depth + 1);
  }
  // depth 0 的终态行由预算控制,不算必显;嵌套层沿用旧规则:≤5 全显,否则只显 3 条。
  const terminalShown = depth === 0 ? 0 : terminal <= LEGACY_FOLD_FEW ? terminal : Math.min(LEGACY_FOLD_MAX, terminal);
  return live + terminalShown + nested;
}

/** 顶层终态行数(FillCounts.agentTerminalTop)。 */
export function topTerminalRowCount(nodes: readonly FleetTreeNode[]): number {
  let n = 0;
  for (const node of nodes) if (isTerminalRow(node.row)) n++;
  return n;
}

export function computeFillBudget(m: FillMeasure, c: FillCounts, o: FillOverrides = {}): FillBudget | null {
  const H = m.heightPx;
  if (!Number.isFinite(H) || H <= 0) return null;
  const bashActive = c.bashMustRows + c.bashTerminalRows > 0;
  const agentHasRows = c.agentFixedRows + c.agentTerminalTop > 0;
  const agentActive = agentHasRows || m.agentExtraPx > 0;
  // 验收 #1:行高前置条件只约束「存在且有行」的那一块;不存在的块不应卡住另一块的预算。
  if (agentHasRows && !(m.agentRowPx > 0)) return null;
  if (bashActive && !(m.bashRowPx > 0)) return null;
  if (!agentActive && !bashActive) return { agentTerminal: 0, bashTerminal: 0 };

  const ra = agentHasRows ? m.agentRowPx : 1;
  const rb = bashActive ? m.bashRowPx : 1;
  const minA = Math.min(FILL_MIN_ROWS, c.agentTerminalTop);
  const minB = Math.min(FILL_MIN_ROWS, c.bashTerminalRows);

  const capRow = (avail: number, must: number, row: number, total: number, min: number): number => {
    if (total <= min) return total;
    const fit = Math.floor((avail - must) / row);
    return Math.min(total, Math.max(min, fit));
  };

  /** 单轮分配:reserveA/reserveB = 是否把折叠按钮高度计入该块必显(不动点迭代,见文件头 §5)。 */
  function pass(reserveA: boolean, reserveB: boolean): FillBudget {
    const mustA = c.agentFixedRows * ra + m.agentExtraPx + (reserveA ? m.agentFoldPx : 0);
    const mustB = bashActive ? m.bashHeaderPx + c.bashMustRows * rb + (reserveB ? m.bashFoldPx : 0) : 0;
    const floorA = mustA + minA * ra;
    const floorB = bashActive ? mustB + minB * rb : 0;

    // 用户覆盖(文件头 §6)优先于一切自动分配:用户操作为准。
    const bashCollapsed = o.bashCollapsed === true && bashActive && o.bashShowAll !== true;
    if (bashCollapsed) {
      // bash 块只占组标题高;agents 拿剩余全部(地板都放不下时保地板,放任滚动)。
      const availA = Math.max(H - m.bashHeaderPx, floorA);
      const shownA = o.agentShowAll === true ? c.agentTerminalTop : capRow(availA, mustA, ra, c.agentTerminalTop, minA);
      return { agentTerminal: shownA, bashTerminal: minB };
    }
    const wantAllA = o.agentShowAll === true && agentActive;
    const wantAllB = o.bashShowAll === true && bashActive;
    if (wantAllA || wantAllB) {
      // 点了「显示已完成」的块全显,剩余空间给另一块(仍保其地板;不够 ⇒ 滚动,用户操作为准)。
      const shownA = wantAllA ? c.agentTerminalTop : 0;
      const shownB = wantAllB ? c.bashTerminalRows : 0;
      const usedA = wantAllA ? mustA + shownA * ra : 0;
      const usedB = wantAllB ? mustB + shownB * rb : 0;
      return {
        agentTerminal: wantAllA ? shownA : capRow(Math.max(H - usedB, floorA), mustA, ra, c.agentTerminalTop, minA),
        bashTerminal: wantAllB ? shownB : capRow(Math.max(H - usedA, floorB), mustB, rb, c.bashTerminalRows, minB),
      };
    }

    // §1 地板超高:两块都守地板,放任滚动(规格允许的唯一滚动情形)。
    if (floorA + floorB >= H) return { agentTerminal: minA, bashTerminal: minB };

    // §2 各到地板后按 50/50 目标分:每块上限 max(H/2, floor);一方地板超半 ⇒ 另一方让到
    // H − 该地板(让完后仍 ≥ 自身地板,因为 floorA + floorB < H),总高 ≤ H 恒成立。
    let availA = Math.max(H / 2, floorA);
    let availB = Math.max(H / 2, floorB);
    if (!agentActive) {
      availA = 0;
      availB = H; // 验收 #1:块不存在 ⇒ 另一块拿整高
    } else if (!bashActive) {
      availA = H;
      availB = 0;
    } else if (availA + availB > H) {
      // 和 > H ⟹ 恰好一方地板超半(两方都 ≤ H/2 ⇒ 和 = H):超半方拿自己的地板,另一方拿剩余。
      if (floorA >= floorB) availB = H - availA;
      else availA = H - availB;
    }

    let shownA = capRow(availA, mustA, ra, c.agentTerminalTop, minA);
    let shownB = capRow(availB, mustB, rb, c.bashTerminalRows, minB);
    // §3 余量互让:填不满自己那份(行数用尽)的块把剩余高度让给对方;A→B 再 B→A 各一轮收敛。
    if (agentActive && shownA === c.agentTerminalTop) availB += Math.max(0, availA - (mustA + shownA * ra));
    shownB = capRow(availB, mustB, rb, c.bashTerminalRows, minB);
    if (bashActive && shownB === c.bashTerminalRows) availA += Math.max(0, availB - (mustB + shownB * rb));
    shownA = capRow(availA, mustA, ra, c.agentTerminalTop, minA);

    // §4 取整尾差回收:轮流把凑得出一行的尾差补给还有被藏行的块,直到谁都放不下。
    // 性质:返回时 任一还有被藏行的块 X 满足 总高 + X 行高 > H(性质测试钉)。
    let total = mustA + shownA * ra + mustB + shownB * rb;
    for (;;) {
      let grew = false;
      if (shownA < c.agentTerminalTop && total + ra <= H) {
        shownA++;
        total += ra;
        grew = true;
      }
      if (shownB < c.bashTerminalRows && total + rb <= H) {
        shownB++;
        total += rb;
        grew = true;
      }
      if (!grew) break;
    }
    return { agentTerminal: shownA, bashTerminal: shownB };
  }

  // §5 不动点迭代:预留集合只增不减 ⇒ 至多 3 轮收敛;收敛判据是本轮折叠集合 ⊆ 预留集合
  // (凡最终折叠的块都已预留 ⇒ 渲染高度不超过计算高度,不会溢出)。
  let reserveA = false;
  let reserveB = false;
  let result: FillBudget | null = null;
  for (let i = 0; i < 3; i++) {
    const r = pass(reserveA, reserveB);
    result = r;
    const foldA = r.agentTerminal < c.agentTerminalTop;
    const foldB = r.bashTerminal < c.bashTerminalRows;
    if ((!foldA || reserveA) && (!foldB || reserveB)) break;
    reserveA = reserveA || foldA;
    reserveB = reserveB || foldB;
  }
  // §5b 对账(验收性质测试抓出的第二处浪费):预留集合可能与最终折叠集合振荡(给 A 预留后
  // A 反而全显 ⇒ 幻影预留占着高度,另一块却藏行)。按最终折叠集合算「渲染口径」总高再补一轮
  // 尾差回收 —— 只增行不改折叠方向:填满的块按钮消失只会更省,绝不溢出。
  let shownA = result!.agentTerminal;
  let shownB = result!.bashTerminal;
  for (;;) {
    const usedA = c.agentFixedRows * ra + m.agentExtraPx + (shownA < c.agentTerminalTop ? m.agentFoldPx : 0);
    const usedB = bashActive
      ? m.bashHeaderPx + c.bashMustRows * rb + (shownB < c.bashTerminalRows ? m.bashFoldPx : 0)
      : 0;
    let total = usedA + shownA * ra + usedB + shownB * rb;
    let grew = false;
    if (shownA < c.agentTerminalTop && total + ra <= H) {
      shownA++;
      total += ra;
      grew = true;
    }
    if (shownB < c.bashTerminalRows && total + rb <= H) {
      shownB++;
      grew = true;
    }
    if (!grew) break;
  }
  return { agentTerminal: shownA, bashTerminal: shownB };
}
