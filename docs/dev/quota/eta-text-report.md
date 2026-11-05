# quota 注入文案去 eta + 5h 关闭规则 3b · 交付报告（2026-11-05）

任务来源：主会话 L1 快车道派发，用户拍板 2026-11-05（不再开问）。两条：

1. 注入给模型的 `[quota 预警]` / `[quota 提示]` / `[quota 严重]` 文案**不再出现预测耗尽时间**；
2. **5h 窗口关闭规则 3b**（forecast-before-reset），与 month 相同；3a、百分比阈值、week 的 3b、Web/HUD 显示、L1 阈值全部不动。

## 改动文件

| 文件                          | 改动                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/quota/render.ts`         | `buildQuotaWarnText` / `buildQuotaSoftText` / `quotaBlockHead`（L3 首行）删除「，按当前速率…后耗尽」「，早于窗口重置（…）」「，预计 …内耗尽」子句；resetAt 已知时保留「（窗口 X 重置）」。随之移除不再被引用的私有助手 `liveEtaMs`。软化正文「按当前速率可能在窗口重置前用完，留意即可」不是具体时间，按拍板保留。                                                 |
| `src/quota/ladder.ts`         | `DEFAULT_THRESHOLDS_BY_WINDOW["5h"]` 增加 `forecastBeforeReset: false`（与 month 相同）+ 注释；`DEFAULT_THRESHOLDS` 文档注释更新（数字仍同 5h 条目，但**不携带**该开关——保留给直调 `windowLevel` 的规则 3b 单元测试，运行时开关以 BY_WINDOW 为准）；规则 3b 分支注释「month 窗口，D10」→「month/5h 窗口」。                                                        |
| `src/quota/service.ts`        | `thresholds()` 原来硬编码 `scope === "month"` 才带 `forecastBeforeReset:false`（若不改这里，只改 ladder 默认值**不会**影响 service 运行时路径）；改为跟随 `DEFAULT_THRESHOLDS_BY_WINDOW[scope].forecastBeforeReset`——开关单一来源在 ladder，month+5h 一处定义。                                                                                                    |
| `tests/quota/render.test.ts`  | 4 处文案断言按新语义更新（L2 模板、forecast-raise 无 resetAt、L3 模板、合并 L3 regex）；新增 describe `injected copy carries no burn-rate exhaustion time (2026-11-05)`：warn/soft/block 三段首行逐行断言不含「后耗尽」「早于窗口重置」「内耗尽」「按当前速率约」，并钉住新首行格式与保留的软化正文。                                                              |
| `tests/quota/ladder.test.ts`  | 默认值钉测更新（5h 条目 `toEqual` 增补 `forecastBeforeReset:false`）；新增「5h default keeps 3b off」：40%（< L1）外推 1h 耗尽且早于重置 ⇒ 5h 不抬级（L0/none）、week 同形状仍抬 L2（forecast-before-reset）、3a（ETA<l3EtaMs ⇒ L3）在 5h 照常生效；`providerVerdict` 按窗口解析对照用例从「5h keeps it」改为「week keeps it」（保留「一窗关一窗开」的对照语义）。 |
| `tests/quota/service.test.ts` | 新增 service 路径测试「5h windows no longer raise forecast-before-reset (2026-11-05); week still does」：同一 provider 双窗（5h+week）40%→50%/10min ⇒ eta 50min（≥l3EtaMs、早于 reset 2h），5h ⇒ L0/under-pace 不抬级，week ⇒ L2/forecast-before-reset；month 用例旁过期注释「a 5h/week window would be raised」→「a week window would be raised」。               |
| `docs/dev/quota/README.md`    | src/quota 条目补两句：3b 对 5h+month 默认关（开关源=ladder，settings 只覆盖百分比/l3EtaMs，用户改阈值不会重开；week 仍开、3a 保留）；注入文案不再携带预测耗尽时间（删除的子句列表 + 保留项 + Web/HUD 不变）。                                                                                                                                                      |

文案对照（示例）：

- 旧：`[quota 预警] zai 5h 已用 78%（阈值 75%），按当前速率约 41 分钟后耗尽，早于窗口重置（02:11）。`
- 新：`[quota 预警] zai 5h 已用 78%（阈值 75%）（窗口 02:11 重置）。`
- 旧：`[quota 严重] … 5h 已用 93%，预计 18 分钟内耗尽（窗口 02:11 重置）。`
- 新：`[quota 严重] … 5h 已用 93%（窗口 02:11 重置）。`
- `[quota 提示]`：删「，按当前速率约 X 后耗尽」，正文保留句不变。

## 设置层核查（结论：settings.ts 无需改动）

`parseQuotaSettings` / `parseQuotaWindowThresholds` 产出的 `windows[scope]` 只携带 `l1/l2/l3Percent`（+全局 `l3EtaMs`），**不存在** forecastBeforeReset 设置键——用户覆盖阈值（窗口级或 legacy 扁平）不可能把 5h 的 3b 重新打开；service.thresholds() 现在从 ladder 默认表读开关，默认必然生效。

## Frozen artifacts 核查（结论：无 golden 受影响）

- `tests/fixtures/quota-kimi-zai-golden.json`（A 级）：录制场景全部不带 eta 子句（zaiL2 预警文本本就是「（阈值 75%）（窗口 13:00 重置）」无 eta 形态，字节不变）；`forecast-before-reset` 判例是 **week** 窗口（week 的 3b 不关）、`forecast-eta` 判例走 3a（不受开关影响）。测试实跑逐字节通过。
- `tests/fixtures/web-hub-ui/quota-legacy-golden.json`（B 级）：Web 卡片「约 3h 后耗尽」为 Web UI 文案，拍板明确不动；golden 测试实跑通过。
- `git diff --quiet HEAD -- tests/fixtures/` ⇒ 干净（FIXTURES-CLEAN）。

## 自验（真实输出摘录，全文 tee 于 /tmp/eta-*.log）

| 命令                                                                     | 结果                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/quota tests/hud tests/web-hub/ui tests/governance` | **Test Files 310 passed (310)，Tests 6798 passed (6798)**，EXIT=0（含 kimi-zai golden、quota-legacy golden、governance/bundle-parity 全绿；stderr 中 happy-dom iframe/DOMException 为该套件常态噪音，非失败） |
| `rg -n "后耗尽\|早于窗口重置" src/quota`                                 | 仅 2 处命中，均为 render.ts:374-375 **注释**（记录拍板内容本身），无运行时文案                                                                                                                                |
| `rg -n "内耗尽" src/quota`                                               | 0 命中（L3 的「预计…内耗尽」已删）                                                                                                                                                                            |
| `rg -n "按当前速率" src/quota`                                           | 仅软化正文保留句（render.ts:429，拍板允许）+ 注释                                                                                                                                                             |
| `npm run typecheck`                                                      | EXIT=0（tsc ×2 + vue-tsc 全过）                                                                                                                                                                               |
| `npx prettier --check <7 个改动文件>`                                    | 初次 3 文件 warn（我新增代码的换行），`prettier --write` 后 **All matched files use Prettier code style!**，EXIT=0；重跑 tests/quota 19 文件/505 测试仍全绿                                                   |
| `git diff --quiet HEAD -- tests/fixtures/`                               | 干净，EXIT=0                                                                                                                                                                                                  |

未跑 secure / 全量 `npm test`（按任务约束；主仓可能正在跑含 secure 的门禁）。

## 遗留 / 说明

1. `formatEta` / `etaSpanText`（render.ts 纯格式化助手）保留：`formatEta` 仍是导出 API 且有自己的单测，但 src 内已无调用方。如需清理属后续独立小改动（会连带删一个 describe），本任务按最小改动保留。
2. 工作区存在**他人未提交改动**（`src/web-hub/hub/log.ts`、`tests/web-hub/hub/idle.test.ts`、`docs/dev/web-hub/README.md`、未跟踪 `docs/dev/reload-quit/`、`docs/dev/secure-symlink/`），与本任务无关，未触碰。本任务禁止 git 写操作，未做任何 commit/stash。
3. 测试中的历史叙事注释（如 service.test.ts 异常防护 describe 引用旧文案「不足 1 分钟内耗尽」、render.test.ts 降位地板 describe 的旧 bug 复述）描述的是 2026-09 的历史现场，非现行为，按原样保留。
