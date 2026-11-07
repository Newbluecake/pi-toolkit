# B3′ · README 收口 — 交付报告

> #25 包 B3′（docs 收口）。文件域仅 `docs/dev/jev-reflex/README.md` + 本报告。基线 dev `884184a2`，无 git 写操作，未触碰 #34 在途文件。

## 1. 做了什么

在 README「离线回测与草案（#25）」章内（上线流程摘要之后）新增小节 **「回测实现口径（B1–B5 交付报告中被 root 接受的裁定，B3′ 同步）」**（标题 L70，首段 L72 说明两种接受方式），共 18 条（L74–91），每条「是什么 + 为什么」，不复制报告长文。未改动既有不变式（R-I12/R-I13/R-I14）、威胁模型及任何其它段落——通读六份报告后未发现与不变式冲突的口径，无需上报 root。

## 2. 同步清单（来源 → README 落点行号）

| #   | 来源（报告 + 段落）                                                                                                              | README 行 |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | B1-report §3 D1（fence active ⇒ lenient）                                                                                        | 74        |
| 2   | B1-report §3 其余实现口径（fence 轮开启时快照、malformed ⇒ lenient，`corpus.ts`）                                                | 75        |
| 3   | B1-report §3 D2（replay 用理想 TUI 事实）                                                                                        | 76        |
| 4   | B1-report §3 D3（CorrectionFact 只受 since 下界）                                                                                | 77        |
| 5   | B1-report §3 D4 / §3.1（升序喂入调用约定；B3-report §1 调用约定 1 已遵守）                                                       | 78        |
| 6   | B2-report §3 D1/D12 + §6.2（token 化口径、`ClusterOptions.jaccard` 可注入）                                                      | 79        |
| 7   | B2-report §1 步骤 3（modal toolCount 0 簇需人工 `--assign`，TOOLLESS 不自动标注）                                                | 80        |
| 8   | B3-report §2（任一 stamp/父链变化 ⇒ 整体重扫，比文件级保守）                                                                     | 81        |
| 9   | B3-report §2 + §6.3（normalizeVersion = normalizeInput 源码哈希；外部常量变化须手动升 cacheV）                                   | 82        |
| 10  | B3-report §2（manifestHash 不一致 / 任一 turnKey 缺失 ⇒ 过期回归、只走实时，`orchestrate.ts` `every` 语义）                      | 83        |
| 11  | B3-report §2（未冻结批次留出失败：`show` 拒绝并提示 freeze，`review`/`report` 过滤、聚合 suspect 仍计入，`reflex-backtest.mjs`） | 84        |
| 12  | B3-report §2（首次 revision firstSeenAt 取真实 now；首跑前历史只作训练/回归）                                                    | 85        |
| 13  | B3-report §4 / `reflex-backtest.mjs`（secure exit 3；`generate` 要求 `scanComplete`）                                            | 86        |
| 14  | B4-report §2.1（目录 ENOENT ⇒ 空结果非 failure）                                                                                 | 87        |
| 15  | B4-report §2.2（`<agentDir>/reflex` 与 `drafts` 必须 0700）                                                                      | 88        |
| 16  | B5-report §3（`LiveEvidenceRow` 本地交叉类型扩展）                                                                               | 89        |
| 17  | B5-report §3（`port@0 missing` ⇒ undetermined，绝不借旧版成功）                                                                  | 90        |
| 18  | B5-report §3 + B3-report §1 调用约定 2（review 不全 / misfire / 无效批次即使实时足够也拒绝）                                     | 91        |

小节标题在 README 第 70 行；第 62 行（受理确证度）末尾追加一句「离线回测中 `inFlight` 恒可推导、从不产生」的澄清（验收修订第 6 条）。

## 3. 门禁

```sh
$ npx prettier --check docs/dev/jev-reflex/README.md docs/dev/jev-reflex/B3prime-report.md
All matched files use Prettier code style!
```

## 4. 遗留

无。首次交付的「B3 §2 五项默认做法 root 未逐条书面裁定」一条已按验收修订更正：B1 D1–D4 由 root 通过 steer 明确接受；B2 §3、B3 §2、B5 的默认做法由 root 审阅 finding 后接受并据此派发下游——README L72 与本节口径一致。

## 5. 验收修订轮（2026-11-05，DeepSeek Flash 有条件通过后）

1. README L70–72：小节首句如实区分两种接受方式（steer 明确裁定 vs 审阅 finding 后接受）。
2. README L83（原 82）：turnKeys 口径改为「当前窗口未覆盖全部 turnKeys（任一缺失即过期）」，对齐 `orchestrate.ts:342` 的 `every`。
3. README L80（原 79）：`toolCount===0` 改为「簇的众数（modal）toolCount 为 0」（`draft-gen.ts:176-185`）。
4. README L84（原 83）：分写 `show` 拒绝并提示 freeze / `review`、`report` 静默过滤且聚合 suspect 仍计入（`reflex-backtest.mjs:365/384/419`）。
5. 新增两条口径：L75 fence 轮开启时快照 + malformed ⇒ lenient（B1 §3 其余口径）；L86 secure exit 3 + `generate` 要求 `scanComplete`（`reflex-backtest.mjs:194-195/345`）。
6. README L62：追加「离线回测中 `inFlight` 恒可推导、从不产生」澄清。

修订后自验：`npx prettier --check docs/dev/jev-reflex/README.md docs/dev/jev-reflex/B3prime-report.md` 全过。仅改上述两文件，无 git 写操作。
