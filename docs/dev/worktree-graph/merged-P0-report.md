# merged P0 协议实施报告

## 范围与交付

- 基线：`B40 = adebe2d6`；派发时 dev HEAD 为 `74f6c916`。
- 已完整阅读 `AGENTS.md`、web-hub README、worktree-diff README 和 `merged-plan.md`，按已批准的 L3 方案执行 P0。
- 直接在主仓库工作区开发；未执行 git 写操作，未碰 P1 git 层或其它并行包文件。
- 实现文件严格限于下列三个路径；本报告为用户额外明确要求的交付文件：
  - `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/worktree-graph.ts`
  - `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/version.ts`
  - `/home/bluecake/ai/pi-toolkit/tests/web-hub/protocol/worktree-graph.test.ts`
  - `/home/bluecake/ai/pi-toolkit/docs/dev/worktree-graph/merged-P0-report.md`

## 实现摘要

1. 追加 §6 指定的全部 merged 常量、类型及 `WtGraphPayload.merged` 可选槽。
2. `version.ts` 尾部追加 `WTGRAPH_MERGED_HUB_CAP = "wtgraph.merged.v1"`；不升 PROTO、不改已有 cap 数组、不在本包接入 hub。
3. 原解析流程仅追加 `merged` 白名单槽和末尾可选解析；原字段校验、旧预算和旧返回对象字段插入顺序不变。
4. 新段沿用 plain-object、own-field、非枚举键白名单及原有 catch 防护；重建输出数据，不复用输入的 merged 对象/数组。
5. `version.ts` 与测试文件对 B40 原内容的前缀比较均通过，确认只在尾部追加；协议主文件全部 diff 为插入，无删行。

## 主会话裁定的边缘语义

主会话在实施期间明确确认以下两条，已落实并分别测试：

1. `e` 为 oid 集合，同一 `e` 内重复 oid 拒绝；`eP` 只允许 `part` 上的字面量 `true`，可无 `e`；同 tip 后续条目不能带 `e`，但可带 `eP`。
2. `skipped` 固定为 `branches:[]`（依 payload.head 有/无 base），拒绝同时携带 `omitted`。

## 解析器与测试覆盖

| 规则             | 验证内容                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 可选扩展兼容     | 无 merged 的 minimal/head+shallow/empty/degraded/sha256 输出字节与旧字段顺序一致；不输出 merged:undefined、不采用继承的 merged |
| 新 envelope      | 版本、容器类型、未知键（含非枚举键）、base ⇔ head、base 等于 head.h                                                            |
| skipped          | 七种 skipped 各测有/无 head+base 的合法形状；逐种拒绝带条目；拒绝 omitted；空仓库 no-head 合法                                 |
| 条目上限         | 24、24+omitted:1、24+omitted:376 均合法；25 条拒绝；omitted 的 0/负数/小数/非数值/不安全整数拒绝                               |
| refs 一致性      | n/h 必须同本地 branch ref 匹配；不存在分支、错误 tip、remote/tag 冒充分支、重复 n 均拒绝                                       |
| kind/count       | 五种 kind 合法；eq/part/none 的 k/t 各数值域、组合关系及 t 字节推导上限；anc/unk 无 k/t/e/eP                                   |
| why/flags        | 六种 unk 原因均合法；unk 缺 why/未知 why、其它 kind 带 why 均拒绝；co/eP 字面量 true-only                                      |
| e                | 仅 part、合法 oid、commit 窗内成员、长度不大于 k、局部去重、同 tip 仅首条可带 e、同 tip v/k/t 一致                             |
| e 总预算         | 两个 tip 累计 200 个元素合法，201 个拒绝；同 tip 共享 e、eP 无 e、后续别名 eP 合法                                             |
| 字节预留         | 24 条 sha256 part、200 B 名称、全局 200 oid 构造落在 32 KiB 预留内；旧 512 KiB 总预算不变                                      |
| 时间账本         | 旧 23 / 33 ≤ 35 与新 37 / 47 ≤ 48 并存；头 6s + 尾 4s，循环 4s，不承诺任何 8s 最坏候选一定完成                                 |
| 原有数据对象约束 | merged/entry 的普通对象与 own-field 规则，null prototype 合法、非默认 prototype/未知 own key 拒绝；读取异常返回 null           |

## 额外字节差分取证

通过只读 `git show adebe2d6:src/web-hub/protocol/worktree-graph.ts` 获取真实旧解析器，在内存用项目现有 TypeScript 转译后与当前解析器比较。
覆盖 sha1/sha256 各 64 个合法旧 payload 组合（head、shallow、more、degrade、pT、UTF-8 文本及 ref/wtHead 可选字段），逐个断言旧解析成功且两者 `JSON.stringify` 完全一致。

```text
legacy differential: 128 valid sha1/sha256 payloads byte-identical to adebe2d6
append-only-ok: src/web-hub/protocol/version.ts
append-only-ok: tests/web-hub/protocol/worktree-graph.test.ts
```

## 遗留与并行工作区说明

- P0 无待解决实现问题；未执行全仓库 npm test，按本包验收范围执行协议目录测试。独立 verifier 验收与精确提交交主会话。
- `typecheck`、构建均为 exit 0，本次没有需要豁免的 P1 半成品类型错误。
- §8.3①全工作区原命令列出了 `docs/dev/traffic-merge/acceptance.md`、`src/traffic/index.ts`：均为其它并行改动，本包未触碰；P0 三个实现/测试文件均在 allowlist。
- 报告路径由用户单独明确授权，不修改仅限主会话维护的 `merged-files.txt`；报告在本次交付时为 untracked，原 `git diff` 命令不计入它。
- 预读时额外检查 `origin/dev` fixtures 比较非零；指定 B40 基线的 fixtures 比较前后均为零，本包未动任何 fixture。

## 自验命令与真实结果（尾部）

```text
$ npx vitest run tests/web-hub/protocol/worktree-graph.test.ts
Test Files  1 passed (1)
Tests       459 passed (459)
exit 0

$ npx vitest run tests/web-hub/protocol
Test Files  48 passed (48)
Tests       1976 passed | 3 skipped (1979)
exit 0

$ npm run typecheck 2>&1 | tail -3
> pi-toolkit@0.8.1 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json

exit 0（实际执行加 set -o pipefail，并 tee 全文至 /tmp/pi-toolkit-merged-P0-typecheck.log）

$ npm run build
> pi-toolkit@0.8.1 build
> tsc -p tsconfig.build.json
exit 0

$ npx prettier --check src/web-hub/protocol/worktree-graph.ts src/web-hub/protocol/version.ts tests/web-hub/protocol/worktree-graph.test.ts
Checking formatting...
All matched files use Prettier code style!
exit 0

$ git diff --name-only adebe2d6 | grep -vxF -f docs/dev/worktree-graph/merged-files.txt
docs/dev/traffic-merge/acceptance.md
src/traffic/index.ts
全工作区 grep exit 0（以上均非 P0）；P0 三文件域外命中 0。

$ git diff --quiet adebe2d6 -- tests/fixtures/ && echo fixtures-ok
fixtures-ok
exit 0

$ git diff --check -- src/web-hub/protocol/worktree-graph.ts src/web-hub/protocol/version.ts tests/web-hub/protocol/worktree-graph.test.ts
无输出，exit 0
```
