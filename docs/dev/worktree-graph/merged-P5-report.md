# P5 UI 组件实施报告（merged-plan r3 §7.3–§7.5，2026-10-25）

## 改动文件

| 文件                                                    | 内容                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/components/graph/WorktreeGraph.vue` | 接入 P3 `gitGraphMerged.ts`：`showMerged` ref(false)（F3 不记忆）、`mview`/`mergedFold` 驱动过滤后的 `graphCommits`（layout/fold/行数全部改吃过滤结果）；`.gg-merged-bar` 开关（`aria-pressed`，`wouldHide>0` 才渲染）；`.gg-mbadge` 徽章（分支芯片后、`+n` 前，mobile 不渲染）；`tr.is-landed` + sr-only `srLanded`；脚注追加 `· {n} merged hidden` / `· merged ? {m\|skipped}` / `· fold off` |
| `src/web-hub/ui/src/components/graph/GraphLanes.vue`    | 新增可选 prop `landed: readonly boolean[]`（按行）：该行圆点与从该行出发的 route/stub/foldstub 改用 `var(--gg-lane-landed)`；颜色字符串在 computed 里组装，landed 全 false 时输出与基线逐字节相同                                                                                                                                                                                               |
| `src/web-hub/ui/src/styles/tokens.css`                  | 三主题块各追加 `--gg-lane-landed`（light `#566772` / dark×2 `#93a3aa`），实色                                                                                                                                                                                                                                                                                                                   |
| `src/web-hub/ui/src/styles/graph.css`                   | `tr.is-landed .gg-sub`（置于 `tr.is-merge .gg-sub` 之前、无 opacity）；`.gg-merged-bar`/`.gg-merged-toggle`/`.gg-mbadge`；顺手修正文件头过时注释（SVG 无 ring，当前行=单元格底色、其它 worktree HEAD=`.gg-wtbadge`，§7.4）                                                                                                                                                                      |
| `src/web-hub/ui/src/i18n/{en,zh}/graph.ts`              | 新增 11 键：`mergedShow`/`mergedHide`/`mergedBadge`/`mergedBadgePart`/`mergedTitle`/`mergedTitlePart`/`mergedTitlePartial`/`srLanded`/`footMergedHidden`/`footMergedUnknown`/`footFoldOff`；zh 徽章「已合入」「部分已合入 {k}/{t}」，脚注两语言均英文 token                                                                                                                                     |
| `tests/web-hub/ui/worktree-graph.test.ts`               | 新 describe「merged branches §7.3–§7.5」10 例 + source-scan 1 例 + i18n 键清单追加 11 键                                                                                                                                                                                                                                                                                                        |
| `tests/web-hub/ui/graph-tokens-contrast.test.ts`        | §7.4 对比度合成测试（点直接 ≥3:1；route 按 .85 与 --c-surface 合成后 ≥3:1，三主题）                                                                                                                                                                                                                                                                                                             |
| `tests/web-hub/ui/graph-panel.test.ts`                  | main-chunk 守卫正则扩为 `gitGraph(?:Merged)?`（§8.1 P5 行）                                                                                                                                                                                                                                                                                                                                     |

另：`docs/dev/worktree-graph/merged-preview.html`（上一步交付的静态预览，用户已确认外观）。

## 测试覆盖对照 §8.1 P5 行

- §7.5 三条 + 「全部 none + degraded」DOM 逐字节不变：baseline vs all-none / all-anc / all-none+refsOmitted 三例 `html()` 全等，且无 `fold off` ✓
- 默认隐藏；开关往返精确文案「显示已合入的 2 个分支」⇄「隐藏已合入的 2 个分支」、脚注 `· 2 merged hidden` 往返 ✓
- 徽章与 tooltip 中英文案（zh 含「忽略空白差异」「可能计为未合入」；en `merged`/`merged 1/2`）；`eP` 追加「（窗内逐提交标记不完整）」✓
- ≤480px 无徽章（展开后亦无，且只剩 HEAD 芯片）✓
- `fold off` 仅在 targets 被阻止时出现（refsOmitted + eq targets ⇒ 8 行全保留 + 脚注 `fold off`；全部 none + degraded ⇒ 无）✓
- §7.4 对比度合成（实测：light 点 5.87 / route 4.19，dark 点 6.62 / route 5.16，均 ≥3:1）、source-scan（无 opacity、规则顺序）、几何（点 cx/cy/r、route d、逐行 padding 与基线全等；折叠视图 cy=过滤后注入中心）✓
- landed 着色计数钉住：展开 4 个 landed 圆点（f1/f2/f3 + part 的 e=f5）+ 4 个 `tr.is-landed` + sr「已合入 HEAD（补丁等价）」✓

## 自验

```
npx vitest run tests/web-hub/ui --maxWorkers=4   # 267 文件 / 5863 测试全过
npm run typecheck                                 # tsc + tsc(typecheck) + vue-tsc 全过
timeout 600 npm run build:web                     # ✓ built in 26.86s
timeout 300 npm run check:web                     # ✓ OK（首屏 360900/524288，lazy 83962/131072，CSS 37139/65536）
npx prettier --check <9 个改动文件>               # --write 后全过
git diff --quiet HEAD -- tests/fixtures/          # fixtures-ok
```

## §8.4 预算增量（基线 = `git archive HEAD` → /tmp/p5-base + 软链 node_modules，已删除）

| 项                             | 基线 gzip | 施工 gzip | 增量         |
| ------------------------------ | --------- | --------- | ------------ |
| 首屏 JS（index-\*.js）         | 358,128 B | 358,671 B | **+543 B**   |
| lazy JS（WorktreeGraph-\*.js） | 7,398 B   | 9,015 B   | **+1,617 B** |
| CSS（唯一 CSS 资产）           | 37,021 B  | 37,144 B  | **+123 B**   |

均远低于 `check-ui-dist.ts` 现有预算，未触碰任何预算。

## 方案读不到的决策 / 与预览的偏差（需用户知悉）

1. **fold off 状态下不渲染开关**：P3 已提交的 `foldMerged` 在 `foldBlocked` 时返回 `wouldHide: []`，而 §7.3 规定工具行仅在 `wouldHide.length > 0` 时渲染 ⇒ 被阻止折叠时只有脚注 `· fold off`，没有「点了也没用」的开关。预览场景 7 画了开关，实现与测试按 P3 代码行为钉住（更合理的 UX）；若要开关仍在需改 P3。
2. **en 开关文案**方案未逐字固定，取 `Show {n} merged branches` / `Hide {n} merged branches`。
3. **徽章配色未新增令牌**：用既有 `--c-sunken` 底 + `--c-text-2` 字（与预览里的 `#e8edf0/#43535c` 几乎相同），避免对比度测试面扩大。
4. **landed 令牌取值** `#566772`（light）/ `#93a3aa`（dark），实测对比度见上。
5. tooltip 的 `{head}` 取 `payload.head.b`（分支名），缺省 `HEAD`。
