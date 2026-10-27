# AFU web 包 · 交付报告（#72 alias-force-default r2）

范围：`alias-force-default-plan.md` §10 AFU 行 + §7「web ChannelsDialog」行 + §5.2-6（web chip）。
基线 `feat/alias-72` 9ce5abc7（dev + AF0 契约）。只动 web UI；hub/agent/协议零改动，`tests/fixtures/` 未动。

## 改动

| 文件                                                      | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/components/detail/ChannelsDialog.vue` | force 路径：`--take` 预览被 online/recent 拒绝且 hub caps ∋ `xs.alias.v2` 时，在回显下方渲染危险按钮「强制抢占…」（`btn-danger`，`.alias-force-row`）。点击执行 `alias <名> --force`，用**未改动的** `parseTakeConfirm` 从该命令自身输出解析 token，复用现有确认框（预览文本含对方目录/在线状态/是否自动认领 + 5 分钟倒计时），执行仍发 `--take=<token>`（token 记住 mode=force）。force 被拒（如 unnotifiable）只显示回显、不再出现按钮；输入框改离被拒别名时按钮消失，改回再现。`aliasV2` computed + `TAKE_REJECT_FORCE_RE` + `takeRejected`/`forceOffer` 状态；`onAliasTake`/`onAliasForce` 共用 `previewTakeover()`。头部注释补 AFU 段。 |
| `src/web-hub/ui/src/components/agents/agentCardModel.ts`  | 新增 UI 镜像常量 `XS_ALIAS_V2_CAP = "xs.alias.v2"`（沿用 XS_CHANNEL_CAP/XS_ALIAS_CAP 的本地镜像先例，UI bundle 不引 protocol/xs.ts）；`aliasSuggestions` 的 cwd 末段候选在 hub caps ∋ v2 时改用 `deriveAliasFromDirName`（chip ≡ auto：`My Project` → `my-project`；保留名/id-like 不出候选），无 v2 时保持原样（raw basename）。                                                                                                                                                                                                                                                                                                            |
| `src/web-hub/ui/src/i18n/alias-extra.ts`                  | 新增 2 条 lazy alias 键（zh/en 对齐）：`force`（强制抢占… / Force take…）、`forceAria`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/web-hub/ui/alias-ui.test.ts`                       | 新增 4 个用例：cwd chip ≡ derive（v2 才有 sanitized 候选、无 v2 不变、保留前缀两边都不出）；force 全链路（拒绝回显 → 按钮 → `--force` → 确认框显示 force 预览 → `--take=<token>`）；无 v2 时拒绝回显无按钮；offer 跟随输入框 + force 被拒只显示回显。既有「holder online」用例加断言「无 force 按钮」。                                                                                                                                                                                                                                                                                                                                      |

## 与方案的偏差

1. **i18n 落点**：方案文件域写 `ui/src/i18n/{zh,en}/detail.ts`，但 alias 命名空间的全部键都在 lazy 的 `i18n/alias-extra.ts`（ALU 的结构：`registerAliasExtra()` 合并进 `MESSAGES.<lang>.alias`，zh/en parity 由测试钉住）。新键放进 alias-extra.ts，detail.ts 未动。
2. **cwd chip 落点**：方案文件域只列 ChannelsDialog.vue，但推荐 chip 的候选计算在共享模型 `components/agents/agentCardModel.ts` 的 `aliasSuggestions`（§1 S16 的正文也指向它）。改动落在那里。
3. **chip derive 按 v2 门控**：§5.2-6 未明说门控，但 §10 AFU 冻结列是硬条件「无 v2 时 UI 字节不变」。auto 只在 v2 hub 存在，chip ≡ auto 的一致性也只在 v2 下有意义，因此 derive 仅在 caps ∋ v2 时启用；v1/无 cap 下 chip 行为逐字节不变。
4. **force offer 的检测**：web 端用组件内正则 `TAKE_REJECT_FORCE_RE` 匹配 agent 侧两条固定拒句（`aliasErrorText` 的 TAKE{online|recent}：「持有者仍在线，不能抢占」「持有者离线不足 10 分钟」）。AF4 会给这两条拒绝追加 `--force` 提示行，前缀不变，正则保持兼容。这与现有 `parseTakeConfirm` 匹配固定中文行的先例一致。

## 给后续包的接口要点（AFW/AF4/AF6 用）

- **hub caps**：UI 只读 `hub.caps`；AF2 在 `assembly-channels.ts` 追加 `xs.alias.v2` 后本包全部功能自动点亮，UI 侧无需再改。
- **依赖 AF4 的 agent 侧契约**（web force 链路成立的前提）：
  - `/fabric alias <名> --force` 预览输出最后一行必须是现有固定行（`XS_ALIAS_TAKE_CONFIRM_RE`，`确认抢占请执行：/fabric alias <名> --take=<token>（5 分钟内有效）`），正文含对方目录/在线状态/是否自动认领；
  - 执行仍走 `--take=<token>`；
  - TAKE{online|recent} 的拒绝文案保持「持有者仍在线，不能抢占。」「持有者离线不足 10 分钟，暂不能抢占。」这两句前缀（UI 正则匹配），其后追加 force 提示行不受影响；
  - `unnotifiable` 等 force 拒绝正常回显即可，UI 不做特殊处理。
- `useTrackedCommand`/`parseTakeConfirm`/协议层零改动；`webCommandPolicy.fabric=confirm` 下 force 的预览与执行各弹一次通用 `CommandConfirm`（composable 既有行为）。
- 真机验收（AF6 §7 增补）前无法在浏览器点亮该路径——hub 尚未声明 v2 cap，当前线上 UI 与 v0.10.1 逐字节一致（由门控保证 + 既有测试断言）。

## 自验

| 命令                                                                                                                                                                                                          | 结果                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `npm run typecheck`（TS7 ×2 + vue-tsc）                                                                                                                                                                       | 通过                                  |
| `npx vitest run tests/web-hub/ui --maxWorkers=2`                                                                                                                                                              | 268 文件 / 5912 通过 / 1 skip（既有） |
| `npm run build:web`                                                                                                                                                                                           | 通过（28.8s）                         |
| `npm run check:web`                                                                                                                                                                                           | 通过（86 files，各预算内）            |
| `npx vitest run tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-alias.test.ts tests/integration/fabric-xs-alias-wiring.test.ts tests/conformance/fabric-xs.test.ts --maxWorkers=2` | 4 文件 / 34 通过                      |
| `npm run format:check`                                                                                                                                                                                        | 通过                                  |
| `git diff --quiet 9ce5abc7 -- tests/fixtures/`                                                                                                                                                                | 干净                                  |

## 提交

- `495d5919` feat(web-hub): alias force-take button and cwd-derived suggestion chip in ChannelsDialog (#72 AFU)
- （本报告为最后一个提交）
