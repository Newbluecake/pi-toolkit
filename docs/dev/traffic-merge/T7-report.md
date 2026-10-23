# traffic 合并 T7 报告：文档与验收

> 依据：`docs/dev/traffic-merge/plan.md` r3 §10 T7 行、§8.4、§11；行为以 T1–T6 各报告为准。
> 基线：dev `979faab9`（T1–T6 已全部提交，最新 traffic 提交 `88871ab1`）。**本次没有 commit**（遵守纪律）。
> 拟用提交标题：`docs(traffic): document the merged recorder and add the acceptance checklist`。

## 1. 改动文件清单

| 文件                                         | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                  | ① 开头「absorbs seven」→ **eight**，补 `src/traffic/`（默认 off 零面、主会话 activate 末尾注册 / 子会话 pre-guard 只挂录制钩子、认领协议让位外部包、secure 双保险、keepalive/warming 共存、网页默认 127.0.0.1），注册位置总结句补 traffic「跨 guard」；② Repository layout 新增 `src/traffic/` 段（置于 `src/secure/` 之后，风格与相邻段一致：路径/票据/账本预算/改写/网页加固/开关与注册位置/拍板①⑥/认领/secure/共存/测试门）；③ Conventions 的 peer 升级清单追加 `tests/conformance/traffic.test.ts` 与 `traffic-coexist.test.ts` 两文件及它们钉住的前提清单（T6 §5 建议文案按 AGENTS.md 行文改写）。 |
| `README.md`（中文）                          | 模块总览 +1 行（锚点 `#流量录制traffic`）、命令表 + `/record`、配置总开关 jsonc + `"traffic": { "enabled": false }`、新增「## 流量录制（traffic）」一节：功能与票据/白名单（Codex 只录不改写）、四个配置键表（含非 live 与固定库路径说明）、数据范围（拍板①：默认录子 agent 含 consult/`/goal`/workflow；拍板⑥：toolkit 内部请求结构上不录；keepalive 否决与 warming 暂停的共存行为）、LAN 风险（`0.0.0.0` 明文 HTTP 可嗅探）、「从独立 pi-traffic-record 迁移」7 步 + 保留外部包时的让位说明（参照 plan §2.4 / T3-report §2–§3）。                                                                     |
| `README.en.md`                               | 平行英文版：模块行、`/record` 命令行、配置键、`## Traffic recording (traffic)` 一节（同上内容压缩；迁移步骤链接中文 README 锚点 `#从独立-pi-traffic-record-迁移`）。                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/dev/data-encryption/plan.md`           | 末尾追加「修订记录：traffic 已并入 pi-toolkit（traffic-merge T7）」：secure 域双保险（`applySecureDomainOverrides` 两入口强制 `traffic.enabled=false` + `persist()` 闸口/各判定点复查；toolkit `package.json` 声明同形 `piSecure`）⇒ R10 对内置 traffic 不再成立；D5/§2.6 的外部包适配说明保留（未声明 `piSecure` 的旧版照旧警告；认领协议保证活动录制器恰为 1）；迁移指向 README。                                                                                                                                                                                                                     |
| `.github/workflows/ci.yml`                   | `web-min-node` job（Node 22.12.0）在 build:web 之后**新增一步** `Traffic node:sqlite smoke on the minimum Node`（`node scripts/traffic/node-floor-smoke.mjs`）。其余 CI 步骤零改动。                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scripts/traffic/node-floor-smoke.mjs`（新） | node:sqlite 真实 roundtrip 冒烟（任务口径）：`process.getBuiltinModule("node:sqlite")` → 不可用且未带 flag 时自动补 `--experimental-sqlite` 重跑一次（execArgv 守卫防循环）→ 建临时库写读一条 → 校验 → 删除临时目录；任何失败非 0 退出。纯 node 内建零依赖，实测 <1s。                                                                                                                                                                                                                                                                                                                                  |
| `docs/dev/traffic-merge/acceptance.md`（新） | 真机验收清单 V1–V13：plan §11 原文逐条展开为「操作 → 预期 → 取证」三列表（worktree-diff acceptance 风格），并入各报告观察点——V2 让位提示（本机外部包仍在 settings，正好可复现，T3 §3）、V5 追加 warming 改写暂停 + `/record off→on` 恢复与 Codex 白名单外行为（T2b §13.1 / T6 §3）、V11 WAL 增长（`-wal` >2 MiB 后 `checkpointsDeferred` 运行时 checkpoint 停止）与关库 >64 MiB 警告、`PI_TRAFFIC_PERF_GATE=1` 独立门（`npm run test:traffic-gate`）+ 大会话 payload 复测（T2b §6.2/§6.4/§13）；通用前置含取证工具与结果记录表。                                                                        |
| `docs/dev/traffic-merge/plan.md`             | ① §8.4 CI 时长**实测回填**（见 §3）；② 末尾追加「修订记录（T7）」11 条 plan↔实现差异表（见 §4，均已按「以实现为准」落档）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 2. AGENTS.md 补充内容的依据

- 注册位置：T3-report §2（主会话 activate 末尾、wireTopicSwitch 之后 = 最后一个 wiring，排在 cache-ttl 后录最终 payload；子会话 pre-guard、`wireChildSession` 之后，只挂 7 个录制钩子）。
- 认领协议：T3-report §3 / plan §2.4（单向让位、`getCommands()` 权威复核、`enabled=false` 永不发布）。
- secure：T3-report §1（`applySecureDomainOverrides` 两入口）+ T2a/T2b（persist 闸口复查）。
- 共存：T5-report §3（`ping off:traffic-rewrite`、进程级镜像标记、warming stop）+ T2b §13.1（warming 观测 ⇒ 改写暂停 fail closed）。
- 网页默认 127.0.0.1：拍板② / T4 §2。
- peer 升级清单两文件与前提清单：T6-report §5（其建议文案按 AGENTS.md 现有行文与英文风格改写，未逐字照抄）。

## 3. §8.4 CI 时长实测（回填进 plan.md）

| 项                                                                                 | 实测                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx vitest run tests/traffic tests/integration/traffic-lifecycle-process.test.ts` | **32 文件 / 391 例全绿，17.65s**（本机 16 核，fork 池 8 worker；`tests/traffic/**` 31 文件 + lifecycle-process 1 文件）                                                  |
| 最长单文件                                                                         | `db-contention.test.ts` ≈17s（常规模式计时断言关闭，负载本身不变；T2b §11）                                                                                              |
| 对全量（~210s，vitest.config.ts 注释口径）的影响                                   | fork 池下 ≈2%，未超 5% 阈值 ⇒ #8/#10 不标 `slow` 组                                                                                                                      |
| conformance（T6 实测）                                                             | `traffic.test.ts` ≈99s、`traffic-coexist.test.ts` ≈52s 单文件；`npm run test:conformance` 全组 27 文件 122s                                                              |
| node-floor 冒烟                                                                    | 实测 <1s（本机 22.22.1 直跑；22.12 走 flag 重跑路径）                                                                                                                    |
| **修正**                                                                           | plan 原「conformance 不进 `npm test`」与实现不符：`vitest.config.ts` include 未排除 `tests/conformance`，两文件实际随 `npm test` / CI Test 步骤运行（已记入修订记录 #2） |

## 4. plan 与实现差异修订记录（已落档 plan.md 末尾，11 条）

概要（详见 plan.md「修订记录（T7）」表）：① §7.3 keepalive 否决只在共享 `onTick` 一处（child.ts 零改动，拦 capture 被作者裁定有害）；② §8.4 conformance 实际进 `npm test`；③ §3.1 node-floor 冒烟按任务口径简化为 sqlite roundtrip（off 零面断言由 wiring / lifecycle 真子进程测试承担）；④ §3.2 flush tick 用 ref 的 `setImmediate`；⑤ §3.2 硬门改 `PI_TRAFFIC_PERF_GATE=1` 独立断言；⑥ §3.2 checkpoint 改现场 stat ≤2 MiB 判据 + 关库 >64 MiB 告警；⑦ `/record off` 不退役 wrapper + 会话槽去重重复宿主副本；⑧ 状态变更 API token 只认头；⑨ `web/` 布局部分迁移、vendor 未动、原仓库 docs 未拷入；⑩ Codex 维持白名单外（CT8/CT9 裁定）；⑪ pi 1.3 不回写 warming 最终裁定 ⇒ 任何 decision 记「可能放行」+ 改写暂停。

## 5. 自验输出

```
$ node scripts/traffic/node-floor-smoke.mjs
[traffic] node-floor-smoke OK — node v22.22.1, node:sqlite roundtrip (/tmp/traffic-node-floor-<rand>/traffic.db)
（stderr 另有一行 ExperimentalWarning——首次显式 DB 访问打印一次，方案 §13-8 预期行为）  exit=0

$ npx prettier --check scripts/traffic/node-floor-smoke.mjs .github/workflows/ci.yml AGENTS.md README.md README.en.md \
    docs/dev/data-encryption/plan.md docs/dev/traffic-merge/acceptance.md docs/dev/traffic-merge/plan.md
All matched files use Prettier code style!        （README×2 / acceptance / plan 首轮 --write 归一后过）

$ npx tsc --noEmit -p tsconfig.json
（无输出，exit 0）

$ npx vitest run tests/traffic tests/integration/traffic-lifecycle-process.test.ts     # §8.4 回填的实测，顺带回归
 Test Files  32 passed (32) · Tests  391 passed (391) · Duration 17.65s
```

未跑全量 `npm test`（任务纪律）；traffic 相关套件与 typecheck 全绿，其余文件域均为文档/CI/脚本，不影响测试面。

## 6. 遗留问题

1. **原仓库 docs 未拷入**：plan §9.3 要求把源仓库 `docs/dev/{page-vue,traffic-rewrite}` 原样拷入 `docs/dev/traffic/`（§10 T7 行广义含文档），但本次 T7 任务口径的文件域限定为「traffic-merge 与 data-encryption 修订段」，未包含该拷贝——已在修订记录 #9 落档，建议单独 chore 包（或与 T8 墓碑版一并）处理。
2. **`docs/guide/migration.md`（从独立插件迁移指南）未加 traffic 条目**：`docs/guide/` 不在 T7 文件域；README（中英）已含完整迁移步骤，指南补条留给后续 docs 包。
3. **CI 22.12 分支未真机复现**：node-floor 冒烟的 `--experimental-sqlite` 重跑路径只能在 22.5–22.12 上触发，本机仅 22.22.1；execArgv 守卫保证不循环，flag 不存在时 node 以非 0 退出。待 push 后首个 CI run 在 22.12.0 runner 上确认（该步骤无需 npm deps，失败面极小）。
4. **真机验收 V1–V13 尚未执行**：`acceptance.md` 是清单本身；执行（tmux，含 V11 真机性能仲裁与 V2 双顺序）归用户/主会话，结果回填 acceptance.md 的记录表。
5. AGENTS.md 的「17,000+ tests」表述未改（仍为真，traffic 并入后只多不少）；如需精确数字留给下次统一更新。
