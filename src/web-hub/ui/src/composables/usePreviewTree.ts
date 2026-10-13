/**
 * 目录预览内联树展开 (preview-tree, 2026-10 用户需求): `PreviewDir` 的 per-visit 展开状态
 * store——每个目录行带 chevron 内联展开子列表（同一 `GET /api/preview?dir=1` 端点，服务端
 * 零改动），可多层嵌套；行名点击仍走既有「钻取」导航（PreviewHost.onDirEntry），chevron
 * 专管内联展开。
 *
 * 生命周期（需求 §6）：state 挂在 `usePreview` 的 dir handle 上，与 A3 历史栈同生同灭——
 * `open()`/`close()` 清空调用点与 `clearStack()` 相同（弹窗关闭即弃；新打开一次预览就是
 * 一次新 visit），`navigate()`/`back()` 不动它——钻取/返回都不丢既有展开（同弹窗会话内
 * per-path 缓存）。
 *
 * 客户端预算（需求 §3，渲染崩溃敏感期）——两道闸，拒绝时只置 `refusal` 轻提示，不弹窗：
 * - `PREVIEW_TREE_MAX_EXPANDED`：同时展开的目录数上限（展开第 65 个被拒）；
 * - `PREVIEW_TREE_MAX_ENTRIES`：全部已缓存子列表的条目总和上限。渲染行数 ≤ 根列表
 *   (≤1000, 服务端 entries cap) + 已展开节点的缓存条目 ≤ 1000 + 3000 = 4000 硬上界，
 *   典型远低（折叠节点的缓存不渲染）。fetch 完成后校验：超限则该 listing 不入缓存、
 *   不展开（下次展开会重新 fetch——预算拒绝不污染缓存）。
 *
 * 缓存语义：折叠只翻 `expanded` 标志，listing 留在 `nodes` 里——同弹窗会话内重新展开
 * 零请求（需求 §3「折叠不丢」）。
 */
import { reactive, ref, type Ref } from "vue";
import type { PreviewDirListing } from "@protocol/preview.js";

/** 同时展开的目录数上限（见文件头预算说明）。 */
export const PREVIEW_TREE_MAX_EXPANDED = 64;
/** 全部已缓存子列表的条目总和上限（见文件头预算说明）。 */
export const PREVIEW_TREE_MAX_ENTRIES = 3000;

export interface PreviewTreeNode {
  status: "loading" | "loaded" | "error";
  /** 已缓存的子列表（loaded 时非空；折叠不丢）。 */
  listing: PreviewDirListing | null;
  /** 失败态的错误码（原样展示，`translate="no"`，与 error 相位同策）。 */
  error: string | null;
  expanded: boolean;
}

/** 预算拒绝原因 —— PreviewDir 渲染成行内轻提示。 */
export type PreviewTreeRefusal = "dirs" | "entries" | null;

/** 取子列表的注入端口（usePreview 用 scope+transport 实现；测试直接喂 fake）。 */
export type PreviewTreeFetch = (
  path: string,
  signal: AbortSignal,
) => Promise<{ ok: true; listing: PreviewDirListing } | { ok: false; error: string }>;

export interface PreviewTreeStore {
  /** 响应式 per-path 节点表（key = 子目录的绝对路径）。 */
  readonly nodes: ReadonlyMap<string, PreviewTreeNode>;
  /** 最近一次预算拒绝；下一次 toggle/retry 清除。 */
  readonly refusal: Readonly<Ref<PreviewTreeRefusal>>;
  /**
   * 展开（首展开懒加载）/折叠切换。展开中再次 toggle = 取消（abort + 丢弃节点）；
   * 失败态 toggle = 重新 fetch；缓存命中只翻标志，零请求。
   */
  toggle(path: string): void;
  /** 失败节点的行内重试（语义同失败态 toggle，显式入口给重试按钮用）。 */
  retry(path: string): void;
  /** 丢弃全部节点并中止在途 fetch（弹窗关闭/新 visit）。 */
  clear(): void;
}

export function createPreviewTree(fetchDir: PreviewTreeFetch): PreviewTreeStore {
  const nodes = reactive(new Map<string, PreviewTreeNode>());
  const refusal = ref<PreviewTreeRefusal>(null);
  const controllers = new Map<string, AbortController>();
  // 代际守卫：clear() 之后迟到的 fetch 结果直接丢弃（abort 的 E_ABORT 也走这里，
  // 不会把已弃节点翻成 error）。
  let generation = 0;

  function expandedCount(): number {
    let n = 0;
    for (const node of nodes.values()) if (node.expanded) n++;
    return n;
  }

  function cachedEntries(): number {
    let n = 0;
    for (const node of nodes.values()) if (node.listing !== null) n += node.listing.entries.length;
    return n;
  }

  function startFetch(path: string, node: PreviewTreeNode): void {
    const gen = generation;
    const ac = new AbortController();
    controllers.set(path, ac);
    node.status = "loading";
    node.error = null;
    void fetchDir(path, ac.signal).then((out) => {
      controllers.delete(path);
      if (gen !== generation) return; // clear() 过 —— 结果作废
      if (!out.ok) {
        node.status = "error";
        node.error = out.error;
        return;
      }
      // 条目预算在 fetch 后校验（事前不知道子列表长度）：超限不入缓存、不展开。
      if (cachedEntries() + out.listing.entries.length > PREVIEW_TREE_MAX_ENTRIES) {
        nodes.delete(path);
        refusal.value = "entries";
        return;
      }
      node.status = "loaded";
      node.listing = out.listing;
      node.expanded = true;
    });
  }

  function toggle(path: string): void {
    refusal.value = null;
    const node = nodes.get(path);
    if (node !== undefined && node.expanded) {
      node.expanded = false; // 折叠：缓存保留
      return;
    }
    if (node !== undefined && node.status === "loading") {
      // 展开中再点 = 取消
      controllers.get(path)?.abort();
      controllers.delete(path);
      nodes.delete(path);
      return;
    }
    // 缓存命中（loaded 且折叠中）—— 零请求重新展开；目录数预算仍适用。
    if (node !== undefined && node.status === "loaded") {
      if (expandedCount() >= PREVIEW_TREE_MAX_EXPANDED) {
        refusal.value = "dirs";
        return;
      }
      node.expanded = true;
      return;
    }
    // 新展开 / 失败重试：先过目录数预算，再懒加载。
    if (expandedCount() >= PREVIEW_TREE_MAX_EXPANDED) {
      refusal.value = "dirs";
      return;
    }
    const fresh: PreviewTreeNode = node ?? { status: "loading", listing: null, error: null, expanded: false };
    if (node === undefined) nodes.set(path, fresh);
    // `reactive(Map)` wraps values on GET — always hand the reactive proxy to the fetch
    // closure (mutating the raw object would never trigger a re-render).
    startFetch(path, nodes.get(path)!);
  }

  function retry(path: string): void {
    const node = nodes.get(path);
    if (node === undefined || node.status !== "error") return;
    toggle(path);
  }

  function clear(): void {
    generation++;
    for (const ac of controllers.values()) ac.abort();
    controllers.clear();
    nodes.clear();
    refusal.value = null;
  }

  return { nodes, refusal, toggle, retry, clear };
}
