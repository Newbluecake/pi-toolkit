# #23 P-C（跨层闭环 + 文档 + 合流门禁）交付报告

> 依据：`docs/dev/web-update-stuck/plan.md`（r3）§3 P-C；P-A（59425ad2）与 P-B（b84cdb72）已合入。
> 自验时间 2026-11-05 12:40–12:49（Asia/Shanghai）。全程未做任何 git 写操作。

## 1 改动文件（绝对路径）

| 文件（绝对路径）                                                                              | 改动                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/tests/integration/web-hub-outdated-reload-loop.test.ts`（新建） | 跨层闭环测试（8 用例）：真实 `wireWebHub` 捕获的 hello → 真实 registry + 真 command router + 真 hub HTTP/SSE → UI `reduce` + `useOutdatedReload` → 协调器 |
| `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/README.md`                                     | 新增两节「Registry epoch 刷新与 epoch.up.v1（#23 P-B）」「Outdated reload 状态机（#23 P-A/P-C）」+ 目录两行（+68 行）                                     |
| `/home/bluecake/ai/pi-toolkit/docs/dev/web-update-stuck/PC-report.md`                         | 本报告                                                                                                                                                    |

冻结面未动：`src/**` 全部（含 `src/fabric/xs/**`、`src/web-hub/agent/{index,xs}.ts`——#20 包在途）、
`tests/fixtures/**`（`git diff --quiet HEAD -- tests/fixtures/` exit 0）、`ui/src/logic/*.js`、`useHub.ts`、
`hub/http.ts`、`protocol/**`、文件域外 `.vue`。

## 2 闭环测试设计（plan §3 P-C 第 1 条逐项）

**真实层（零手写帧）**：

- **hello 捕获**：`captureHello(settings)` 用 `tests/web-hub/agent/helpers.ts` 的 `fakeNet`/`fakePi`/`fakeCtx`
  驱动真实 `wireWebHub`（`session_start` → socket → connect → hello 落进 FakeSocket）。正例
  `steerRecall:false`（caps 尾部恰一个 `epoch.up.v1`）；对照组的老 agent hello = 同一条真实帧去掉
  `epoch.up.v1`（pre-#23 wire 形状，两个 cap 都没有）。
- **hub 侧**：`tests/web-hub/http/helpers.ts` 的 `fakeDeps` 装配真 `createRegistry`（注入可推进时钟 +
  `hubVersion`）+ 真 `createCommandRouter` + 真 `createHttpFrontend`，真实 login/`/api/events`。
- **UI 侧**：自维护 SSE 连接**逐字累积响应原文**并解析成 `{event,data,id}`，按序喂真实 `reduce`；真实
  `useOutdatedReload`（注入手动计时器表 + 与 hub 同一座墙钟的 `now`）。
- **send 方向也跨层**：composable 的 `runCommand` POST 真实 `/api/cmd`（CSRF/Origin/cookie 同
  `security.test.ts` 口径，响应经 `control.js` 真实 `outcomeFromHttp` 映射）→ 真 command router → 真
  `registry.request` → conn 收到 cmd 帧 → 测试替 agent 回 `cmd_result{ok}`（=「命令被接受」）。

**8 个用例**：

| #   | 用例                          | 钉住                                                                                                                                                                                                                                                 |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 真实 wiring hello 前提        | steerRecall:false ⇒ 尾部恰一个 `epoch.up.v1`、无 `hold.v1`、含 `cmd.v1`/`command.v1`；默认配置不含新 cap、含 `hold.v1`                                                                                                                               |
| 2   | 正例（epoch.up.v1）           | epoch 变化 reclaim（`reclaimed:true`）⇒ SSE `agent_up`（新 epoch+新版本+`outdated:false`）⇒ reduce ⇒ 版本到位即 **done**；send 只发 1 次（D7）                                                                                                       |
| 3   | 正例（hold.v1，Y7.2 路径）    | 默认配置 hello 同样闭环到 done（用户要求的「有 hold.v1 ⇒ done」对照）                                                                                                                                                                                |
| 4   | 对照组（老 caps）             | 先 `/api/subscribe` 让 gap 真到达；reclaim 后到达的帧里 **0 个 agent_up、有 gap**；UI 停 awaiting ⇒ 90s 生效计时 ⇒ **E_TIMEOUT**（老 agent 残留行为显式入测）                                                                                        |
| 5   | 时间窗                        | `onClose(false)` → `advance(10_001)` ⇒ `agent_stale` ⇒ **E_OFFLINE**（计时器全清）；窗口内（+20s）同 key reclaim（stale 分支必发 `agent_up`）⇒ failed 收敛 **done**（慢 reload：先 E_OFFLINE 再自动 done，plan §4）                                  |
| 6   | reap 后 (a) 同进程同 identity | `advance` 合计 60s+ ⇒ `agent_down{reaped}` ⇒ E_OFFLINE；`register()` 实际返回 **同 key**（`reclaimed:false`，不预设）⇒ 新注册路径发 `agent_up` ⇒ 版本到位即 **done**（D6 同 key 收敛）                                                               |
| 7   | reap 后 (b) 新进程新 identity | `register()` 返回**新 key**（实际值断言）⇒ 旧请求保持 **E_OFFLINE**（不跨 key 追认），新 key **idle**；send 仍只 1 次                                                                                                                                |
| 8   | 原始 bug 复现                 | 命令被接受（真实 /api/cmd + cmd_result ok）⇒ awaiting（90s 生效计时在飞）⇒ `bye{quit}`+`onClose(true)` ⇒ 立即 `agent_down` ⇒ **立即 E_OFFLINE**、计时器清空；之后时钟 +120s、显式触发 90s/60s 计时器（无残留）不改写结果、不自动重发 —— **不再空等** |

## 3 README 更新（plan §3 P-C 第 2 条）

- **Registry 一节**：epoch 刷新条件（`epochChanged && prevPhase!=="stale" && (hold.v1 ∨ epoch.up.v1)`）、
  先 agent_up 后 gap / stale 只发一次 / 同 epoch 静默、两 cap 互补（hold.v1 默认 vs epoch.up.v1 尾部
  追加、agent 面专属、hub 两个 cap 面不含）、默认 hello 不得出现（五份 A 级 golden）、compat golden 的
  录制/拒绝覆盖/比对规则（s1/s2 逐字节、s3 老 hub 存证）、门禁文件清单。
- **Outdated reload 一节**：状态机与有界截止（D1 总预算 30min 绝对截止 + 各相结算映射 + 入口兑底）、
  D2 send 上界 60s、D3 attempt token、D4/D5 下线判据与判定顺序、`E_OFFLINE`/`E_SEND_UNKNOWN` 语义、
  D6/D8 不跨 key 追认 + 时间窗 + restore 导航照常、D7 不自动重试、D9/D10 结果展示四入口、RC3/down 卡
  chip 归 #24、#25 transport 残留、门禁文件清单（含本包闭环测试）。

## 4 自验（真实输出；全量日志 tee 至 /tmp，未截断）

| 门禁                                                                                                     | 结果                                                                                                                                 | 日志                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| 新闭环测试 ×3（`npx vitest run tests/integration/web-hub-outdated-reload-loop.test.ts`）                 | ✅ 三次均 `Test Files 1 passed (1)` · `Tests 8 passed (8)`（exit 0）                                                                 | `/tmp/pc-loop-run{1,2,3}.log` |
| `npx vitest run tests/web-hub/ui tests/web-hub/hub tests/web-hub/boundary.test.ts`                       | ✅ `Test Files 523 passed (523)` · `Tests 11740 passed (11740)` EXIT=0（P-A/P-B 的 ui+hub 套件含在内，无回归）                       | `/tmp/pc-vitest-gate.log`     |
| `npm run build:web`                                                                                      | ✅ `✓ built in 30.94s` EXIT=0                                                                                                        | `/tmp/pc-buildweb.log`        |
| `npm run check:web`                                                                                      | ✅ `✓ check:web — dist/web-hub-ui/ OK (85 files, first-screen JS 385062B gz/524288B, …)` EXIT=0                                      | `/tmp/pc-checkweb.log`        |
| `npx prettier --check docs/dev/web-hub/README.md tests/integration/web-hub-outdated-reload-loop.test.ts` | ✅ `All matched files use Prettier code style!`                                                                                      | —                             |
| `git diff --quiet HEAD -- tests/fixtures/`                                                               | ✅ exit 0（A 级 golden 与全部 fixture 零改动）                                                                                       | —                             |
| `npm run typecheck`（额外；plan 归 P-C 合流门禁，提前记录）                                              | ✅ exit 0（#20 在途补丁已在共享树补齐，`src/fabric/xs/activate.ts` 早前的 TS2339 已消失；本包不涉 src，测试目录不在 tsc include 内） | `/tmp/pc-typecheck.log`       |

## 5 遗留与交接

1. **全量 `npm test` 未跑**（任务约束：root 收尾统一跑）。P-C 合流门禁剩余项（`npm run format:check` →
   `typecheck` → 全量 `PI_TOOLKIT_TEST_WORKERS=4 npm test | tee` → `npm run build` → `build:web` →
   `check:web` → `git diff --stat origin/dev -- tests/fixtures/` 只允许 P-B 那一份 golden）待 root 在
   两包（#23 三包 + #20 包）全部合入后的完整树上执行。
2. 闭环测试未暴露任何实现 bug：P-A/P-B 已提交实现在全部 8 个场景下行为与 plan §2.1/§2.2/§2.3 预期一致，
   无需 message root。
3. 共享树在途改动（`src/fabric/xs/**`、`src/web-hub/agent/{index,xs}.ts`、`src/memory/**`、
   `src/config/settings.ts`、`src/index.ts` 等）属 #20 / memory 包，本包未触碰；`npm run typecheck`
   在当前树上已全绿。
4. PA-report 遗留 2（`CHIP_FAILED_STYLE`/`RESULT_*` 内联样式是否迁回 `styles/outdated-reload.css`）
   仍待 root 裁定（该文件不在任何包文件域）。
