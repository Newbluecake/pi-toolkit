<!--
  Directory rows renderer (dir-plan v3.1 §0.2 A1/A3 rows + preview-tree inline expansion).
  Rendered recursively: the root instance (PreviewDir, `root`) owns the scrolling
  `.preview-dir-list` <ul role="tree">; an expanded directory row nests another instance
  inside its own <li> (<ul role="group">), so nesting depth is unbounded while the DOM stays
  one flat descendant set per list — ArrowUp/Down walk `querySelectorAll` over visible rows.

  交互分工（需求 §1 决策）：行名按钮保留既有「钻取」导航（emit navigate，宿主走
  history push）；chevron 按钮专管内联展开/折叠。展开状态/缓存在注入的 `tree` store
  （usePreview 的 per-visit handle）里——本组件无状态，钻取/返回导致的重挂载不丢展开。

  无 tree 降级（验收跟进 #16-a）：`tree === undefined`（旧 fake）时不渲染 rowwrap 包裹、
  chevron/spacer、tree 角色与状态行——`<li>` 直出 `PreviewDirRow`（其根就是
  `button.preview-dir-row` 本身），DOM 与改动前的 `li > button` 结构逐字节一致，也无
  20px chevron 空位的视觉副作用。只有 `tree` 存在时才套 `.preview-dir-rowwrap`。
  注意：只有 `type:"dir"` 的行带 chevron——symlink 指向目录与否客户端不可知，保持既有
  「点击进入、准入链裁决」行为（415 fallback 升级），不为它加内联展开。

  键盘/aria（需求 §4）：root ul role="tree"、嵌套 ul role="group"、li role="treeitem"
  （aria-expanded 仅可展开项、aria-level 标注层级）。行按钮保留原生可聚焦（不引入 roving
  tabindex——现有 Tab 循环语义不变）；ArrowRight 展开/进入首子行，ArrowLeft 折叠/回到
  父行，ArrowUp/Down 在可见行间移动。chevron 按钮 tabindex="-1"（展开对键盘用户经
  ArrowRight 可达，chevron 不翻倍 Tab 停顿），带 aria-expanded + aria-label。
-->
<script setup lang="ts">
import { computed } from "vue";
import { childPreviewPath, formatPreviewBytes } from "@logic/preview.js";
import type { PreviewDirEntry, PreviewDirEntryType } from "@protocol/preview.js";
import { formatDateTime, formatNumber, localeFor } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";
import type { PreviewTreeNode, PreviewTreeStore } from "../../composables/usePreviewTree.js";
import AppIcon from "../../icons/AppIcon.vue";
import PreviewDirRow, { type DirRowView } from "./PreviewDirRow.vue";

const props = defineProps<{
  /** The listed directory's absolute path (child keys are `childPreviewPath(parent, name)`). */
  readonly parentPath: string;
  readonly entries: readonly PreviewDirEntry[];
  /** Tree depth of THIS list's rows (1 = the dialog's root listing) — aria-level + indent. */
  readonly depth: number;
  /** Root instance only: owns `.preview-dir-list` (scroll container) + role="tree". */
  readonly root?: boolean;
  /** Inline-expansion store; undefined ⇒ no chevrons/wrappers (pre-tree byte-identical DOM). */
  readonly tree?: PreviewTreeStore | undefined;
}>();
const emit = defineEmits<{ (e: "navigate", entry: PreviewDirEntry): void }>();
const i18n = useI18n();
const { t } = i18n;

function typeLabel(type: PreviewDirEntryType): string {
  switch (type) {
    case "dir":
      return t("preview.dirTypeDir");
    case "file":
      return t("preview.dirTypeFile");
    case "symlink":
      return t("preview.dirTypeSymlink");
    default:
      return t("preview.dirTypeOther");
  }
}

interface RowView extends DirRowView {
  /** preview-tree: dirs (clickable, legally joinable) get the inline-expand chevron. */
  readonly expandable: boolean;
  /** The child's absolute path — the tree store's key; null when the join is illegal. */
  readonly childPath: string | null;
  readonly isDot: boolean;
}

const rows = computed<RowView[]>(() =>
  props.entries.map((entry): RowView => {
    const clickable = entry.type !== "other" && entry.lossy !== true;
    const childPath = entry.type === "dir" && clickable ? childPreviewPath(props.parentPath, entry.name) : null;
    return {
      entry,
      clickable,
      expandable: props.tree !== undefined && childPath !== null,
      childPath,
      isDot: entry.name.startsWith("."),
      icon: entry.type === "dir" ? "folder" : "file",
      typeLabel: typeLabel(entry.type),
      sizeLabel: entry.type === "file" ? formatPreviewBytes(entry.size) : "",
      mtimeLabel: formatDateTime(entry.mtimeMs ?? null, localeFor(i18n.lang)),
    };
  }),
);

/** Reactive lookup — `tree.nodes` is a reactive Map, so render/fns track per-key. */
function nodeOf(row: RowView): PreviewTreeNode | undefined {
  return row.childPath === null ? undefined : props.tree?.nodes.get(row.childPath);
}

function toggleRow(row: RowView): void {
  if (row.childPath !== null) props.tree?.toggle(row.childPath);
}

function retryRow(row: RowView): void {
  if (row.childPath !== null) props.tree?.retry(row.childPath);
}

/** Depth indentation: one 18px step per level, aligned with the chevron column. */
function indentStyle(depth: number): Record<string, string> {
  return { "--pdt-depth": String(depth - 1) };
}

/** Tree keyboard ops (需求 §4): arrows on a row button. Right = expand (collapsed) /
 * focus first child (expanded); Left = collapse (expanded) / focus parent row; Up/Down =
 * move across ALL visible rows (nested included — DOM order IS visual order). */
function onRowKeydown(ev: KeyboardEvent, row: RowView): void {
  const key = ev.key;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "ArrowLeft" && key !== "ArrowRight") return;
  const btn = ev.currentTarget;
  if (!(btn instanceof HTMLElement)) return;
  const node = nodeOf(row);
  if (key === "ArrowRight") {
    if (!row.expandable || row.childPath === null) return;
    ev.preventDefault();
    if (node?.expanded !== true) {
      props.tree?.toggle(row.childPath);
      return;
    }
    focusDelta(btn, 1); // already expanded → step into the first child row
    return;
  }
  if (key === "ArrowLeft") {
    if (row.expandable && node?.expanded === true) {
      ev.preventDefault();
      props.tree?.toggle(row.childPath!);
      return;
    }
    const parent = btn
      .closest("ul")
      ?.closest("li")
      ?.querySelector(":scope > .preview-dir-rowwrap > button.preview-dir-row");
    if (parent instanceof HTMLElement) {
      ev.preventDefault();
      parent.focus();
    }
    return;
  }
  ev.preventDefault();
  focusDelta(btn, key === "ArrowDown" ? 1 : -1);
}

function focusDelta(btn: HTMLElement, delta: 1 | -1): void {
  const list = btn.closest(".preview-dir-list");
  if (list === null) return;
  const all = Array.from(list.querySelectorAll<HTMLElement>("button.preview-dir-row"));
  const target = all[all.indexOf(btn) + delta];
  target?.focus();
}
</script>

<template>
  <ul
    :class="root ? 'preview-dir-list' : 'preview-dir-group'"
    :role="tree ? (root ? 'tree' : 'group') : undefined"
    :style="root ? undefined : indentStyle(depth - 1)"
  >
    <li
      v-for="row in rows"
      :key="row.entry.name"
      :class="{ 'is-dot': row.isDot }"
      :role="tree ? 'treeitem' : undefined"
      :aria-level="tree ? depth : undefined"
      :aria-expanded="tree && row.expandable ? nodeOf(row)?.expanded === true : undefined"
    >
      <!-- preview-tree: the rowwrap wrapper + chevron column exist ONLY with a tree store;
           without one the li's direct child is the row button itself (byte-identical). -->
      <div v-if="tree !== undefined" class="preview-dir-rowwrap" :style="indentStyle(depth)">
        <!-- chevron 专管内联展开；行名按钮保留钻取导航（见文件头交互分工）。 -->
        <button
          v-if="row.expandable"
          class="preview-dir-chevron"
          :class="{ 'is-expanded': nodeOf(row)?.expanded === true }"
          type="button"
          tabindex="-1"
          :aria-expanded="nodeOf(row)?.expanded === true"
          :aria-label="nodeOf(row)?.expanded === true ? t('preview.dirCollapse') : t('preview.dirExpand')"
          :title="nodeOf(row)?.expanded === true ? t('preview.dirCollapse') : t('preview.dirExpand')"
          @click.stop="toggleRow(row)"
        >
          <AppIcon name="chev-right" class="icon-sm" />
        </button>
        <span v-else class="preview-dir-chevron-spacer" aria-hidden="true"></span>
        <PreviewDirRow :row="row" @navigate="emit('navigate', $event)" @rowkeydown="onRowKeydown($event, row)" />
      </div>
      <PreviewDirRow v-else :row="row" @navigate="emit('navigate', $event)" />
      <!-- 行内展开状态：loading / error+重试 都不弹新窗（需求 §2）。 -->
      <template v-if="tree !== undefined && row.expandable">
        <div
          v-if="nodeOf(row)?.status === 'loading'"
          class="preview-dir-tree-status"
          role="status"
          :style="indentStyle(depth + 1)"
        >
          <AppIcon name="loader" class="icon-sm spin" />
          <span>{{ t("preview.dirTreeLoading") }}</span>
        </div>
        <div
          v-else-if="nodeOf(row)?.status === 'error'"
          class="preview-dir-tree-status is-error"
          role="alert"
          :style="indentStyle(depth + 1)"
        >
          <AppIcon name="alert" class="icon-sm" />
          <span
            >{{ t("preview.dirTreeError") }} <code class="md-code" translate="no">{{ nodeOf(row)?.error }}</code></span
          >
          <button class="btn btn-ghost preview-dir-tree-retry" type="button" @click="retryRow(row)">
            <AppIcon name="refresh" class="icon-sm" />
            <span>{{ t("preview.retry") }}</span>
          </button>
        </div>
        <template v-else-if="nodeOf(row)?.expanded === true && nodeOf(row)?.listing !== null">
          <div
            v-if="nodeOf(row)?.listing?.entries.length === 0"
            class="preview-dir-tree-status"
            :style="indentStyle(depth + 1)"
          >
            <span>{{ t("preview.dirEmpty") }}</span>
          </div>
          <PreviewDirRows
            v-else
            :parent-path="row.childPath!"
            :entries="nodeOf(row)!.listing!.entries"
            :depth="depth + 1"
            :tree="tree"
            @navigate="emit('navigate', $event)"
          />
          <div
            v-if="nodeOf(row)?.listing?.truncated === true"
            class="preview-dir-tree-status"
            :style="indentStyle(depth + 1)"
          >
            <span>{{
              t("preview.dirLimitEntries", {
                shown: formatNumber(nodeOf(row)?.listing?.entries.length ?? 0, localeFor(i18n.lang)),
                total: formatNumber(nodeOf(row)?.listing?.total ?? 0, localeFor(i18n.lang)),
              })
            }}</span>
          </div>
        </template>
      </template>
    </li>
  </ul>
</template>
