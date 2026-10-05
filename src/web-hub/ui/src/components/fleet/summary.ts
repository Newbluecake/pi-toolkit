/**
 * fleet 抽屉时代的纯函数/契约集合(fleet-drawer plan v2 §6.3 — F6):
 *
 * - `fleetActivity(row)` — 从 FleetNode.vue:37-42 抽出的共用摘要行(`streamLine || toolTrail`,
 *   clip 160),FleetTree 的行和 RunTranscript 的降级页脚(`watching:false`)共用,保证两处
 *   显示逐字一致(U11)。
 * - `buildFleetTree`/`flattenFleetTree`/`isTerminalRow` — 原 `fleet/tree.ts` 的森林折叠,原样
 *   搬迁(`tree.ts` 随浮层机制一起删除;`@logic/fleet.js` 的 `fleetTree` 仍是唯一行为来源,
 *   父节点缺失的行在那里就已经被提升为根)。
 * - `orphanRunIds(rows)` — §6.3 的孤儿标记:父 run 不在投影行内的行(被提升为根的那些)加
 *   「父 run 未列出」chip。
 * - `fleetSummary(rows)` — FleetSummaryBar 的 running/total/cost 计数(原 FleetPanel 从
 *   flatten 后的树算;计数与树的遍历顺序无关,直接对行数组求值,结果相同)。
 * - `runTranscriptAvailable(card, authMode)` — §6.3 的入口门控(第三层,纯体验;真正的强制
 *   在 hub 侧,§7.1):`card.runTranscript` 为真,且 LAN(password 模式)下还要
 *   `card.runTranscriptLan`。authMode 未知时按 loopback(token)档处理 —— UI 隐藏不承担安全
 *   职责,旧部署默认 loopback,这样旧 agent 只是少一个按钮。
 * - `FLEET_SELECT` — §6.3 点名的 provide/inject 接缝:FleetDrawer 提供,FleetTree 的
 *   `run-open` 按钮消费;没有提供者(孤立测试/只读场景)时 run 名保持纯文本。
 */
import type { ComputedRef, InjectionKey } from "vue";
import { fleetTree } from "@logic/fleet.js";
import type { FleetRowWire } from "@protocol/messages.js";
import { clip } from "../../format.js";
import type { FleetTreeNode } from "../../types.js";

/** §6.3: `streamLine || toolTrail`(clip 160)。结构型入参 —— `FleetRowWire` 没有索引签名,
 * 直接传 structurally-typed 字段最安全。 */
export function fleetActivity(row: { streamLine?: unknown; toolTrail?: unknown }): string {
  const raw = typeof row.streamLine === "string" && row.streamLine !== "" ? row.streamLine : row.toolTrail;
  return typeof raw === "string" && raw !== "" ? clip(raw, 160) : "";
}

interface MutableNode {
  row: FleetRowWire;
  depth: number;
  children: MutableNode[];
}

/** `FleetTreeNode.row` 是结构类型(避免 types.ts 硬依赖 `@protocol`);这里的行确实是
 * `FleetRowWire`。算法不变:`fleetTree` 的输出是带 depth 的先序遍历,用「depth N 的最后一个
 * 节点」栈单趟重建同一片森林。 */
export function buildFleetTree(rows: readonly FleetRowWire[]): readonly FleetTreeNode[] {
  const flat = fleetTree(rows) as ReadonlyArray<{ row: FleetRowWire; depth: number }>;
  const roots: MutableNode[] = [];
  const stack: MutableNode[] = [];
  for (const { row, depth } of flat) {
    const node: MutableNode = { row, depth, children: [] };
    stack.length = depth;
    if (depth === 0) {
      roots.push(node);
    } else {
      const parent = stack[depth - 1];
      if (parent) parent.children.push(node);
      else roots.push(node); // defensive: shouldn't happen given fleetTree's own invariants
    }
    stack[depth] = node;
  }
  return roots as unknown as readonly FleetTreeNode[];
}

/** 先序展开(与 `fleetTree` 的遍历顺序一致)——计数/测试用。 */
export function flattenFleetTree(nodes: readonly FleetTreeNode[]): readonly FleetTreeNode[] {
  const out: FleetTreeNode[] = [];
  const visit = (n: FleetTreeNode): void => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** `FleetRowWire.terminal`,从结构类型的 `FleetTreeNode.row` 上读。 */
export function isTerminalRow(row: Record<string, unknown>): boolean {
  return row.terminal === true;
}

/** §6.3:`parentRunId` 有值但父节点不在投影行内 ⇒ 该行被提升为根,标记为孤儿。 */
export function orphanRunIds(rows: readonly FleetRowWire[]): ReadonlySet<string> {
  const present = new Set(rows.map((r) => String(r.runId)));
  const out = new Set<string>();
  for (const row of rows) {
    const p = row.parentRunId;
    if (typeof p === "string" && p !== "" && !present.has(p)) out.add(String(row.runId));
  }
  return out;
}

export interface FleetSummary {
  readonly running: number;
  readonly total: number;
  readonly costUsd: number;
}

/** FleetSummaryBar 的一行摘要(running 数 · 总数 · 总成本)。 */
export function fleetSummary(rows: readonly FleetRowWire[]): FleetSummary {
  let running = 0;
  let costUsd = 0;
  for (const row of rows) {
    if (row.terminal !== true) running++;
    const c = (row as { costUsd?: unknown }).costUsd;
    if (typeof c === "number") costUsd += c;
  }
  return { running, total: rows.length, costUsd };
}

/** §6.3 的入口门控(纯体验层;hub 侧 `requireCap` 才是强制)。 */
export function runTranscriptAvailable(card: Record<string, unknown>, authMode: unknown): boolean {
  if (card.runTranscript !== true) return false;
  if (authMode === "password") return card.runTranscriptLan === true;
  return true; // token 模式(LAN 明文不由 UI 把关)或未知环境:按 loopback 档
}

/** §6.3 点名的选中接缝:FleetDrawer 提供,FleetTree 的 run-open 按钮消费。 */
export interface FleetSelect {
  /** 选中一个 run(经 `HubHandle.selectRun`;订阅/退订全部归 useHub 管,§6.4 #7)。 */
  select(runId: string): void;
  /** 该 agent 的 card 是否开放了 transcript 入口(决定 run 名渲染成按钮还是纯文本)。 */
  readonly canOpen: ComputedRef<boolean>;
}
export const FLEET_SELECT: InjectionKey<FleetSelect> = Symbol("web-hub-fleet-select");
