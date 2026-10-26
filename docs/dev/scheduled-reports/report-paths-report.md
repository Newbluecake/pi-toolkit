# #62 报告路径与短文件名交付报告

- 日期：2026-10-26（Asia/Shanghai）。工作目录：`/home/bluecake/ai/pi-toolkit`。
- 开始基线：`dev` / `5f3ed9d2`（v0.9.0），工作区干净。本包没有执行任何 git 写操作，没有 commit、stash、checkout、reset、add、mv、rm，没有触碰 `docs/dev/result-tool-rename/`。期间观察到其它并发改动和 HEAD 前移至 `a4151048`，不是本包操作；不撤销或改写外部变更。
- 实现与自验完成；当前工具面没有 Agent 派发能力，**本报告不代表独立异源 verifier 已验收**，已向 root 报告该限制。

## 1. 实现

1. `note.ts` 的全文入口互斥：有 runId 只写 `全文：get_subagent_result <runId>`；没有 runId、有报告时只写绝对路径；两者都没有则不写。`result-reference.ts` 集中维护 `SCHEDULE_RESULT_TOOL` 与绝对路径组合逻辑，便于 #64 改工具名。
2. digest、schedule get/history、`/schedule show/log`（包括 `--all` 的外部归属会话）展示 `<store.root.real>/<store.dirName>/<reportFile>`；不修改账本。截断提示带真实 runId，无 runId 时不虚构工具全文入口。
3. `reportFileOf(taskId, scheduledAt, tz?)` 以 occurrence/manual trigger 的 `run.scheduledAt` 生成 `reports/<taskId>-<YYYYMMDD-HHmm>.md`。时间采用任务 tz，没有 tz 则用本地时区。background 和 message writer 使用 `allocateUnique` 在原有 writer 锁内分配同分钟冲突的 `-2`、`-3`，同时避开磁盘条目、runs 和 pendingReports 中的已用路径。
4. `writeReportLocked` 将实际分配的路径传给 commit 回调，terminal run 与 pendingReports 同一事务写入，pendingReportFor 不再根据哈希推导文件名。账本继续存相对路径。新旧 filename 白名单统一用于 reader 和 writer inventory/GC；旧报告不迁移，按既有 14 天 GC 清理（pending 索引保护与 grace 均不变）。
5. `reportIdOf(sessionId, runKey)` 的哈希、receipts 键、`sch:<reportId>` outbox 去重键不改；hub 继续只读账本，按实际 reportFile 读文件。hub 向投递器传递已验证的 reportFile，超长报告的新短名 basename 传给 renderer，由同一 fileName 生成卡片 fileNote 与上传元数据；旧 64-hex 名回退 `reply-<sid6>.md`。没有新增 wire 字段、cap、PROTO 或 off 表面。
6. 不改 pendingReports ≤64、24 h 报告窗口、receipts 清索引与 hub restart 对账语义；更新运行中实例需 `/reload` + `/webhub restart`，旧 hub 本身不认识新文件名，不能只更新 agent。

## 2. 行为断言证据

- note：runId+reportFile 同时存在时只展示工具；没有 runId 时新旧文件都转绝对路径；都没有则省略全文行；展示不改变原 reportFile。
- digest controller：实际账本中的新旧报告都显示绝对路径，去掉原来的「对应 reportFile」歧义。
- tool get/history 与 command show/log：新旧文件名正确展示；`--all` 使用 foreign store，不错误拼接当前会话目录。
- spec：UTC、Asia/Shanghai 跨日、America/New_York、系统本地回退、DST 重复分钟；writer：多个真实 store handle 并发写入同一基名，实际产生无覆盖的基名/-2/-3，逐一断言文件内容与返回路径；background：同分钟多次 manual claim/完成，run 和 pendingReports 保存实际路径；message：已存在短名不被覆盖，账本记录 -2，重入不改正文/不增加索引。
- GC：旧哈希名与新短名参数化测试均清理过期未引用报告、保留 pending 引用报告；读取仍走原有只读 fd-anchored 链路。
- hub H1 × F1：旧哈希名、新短名、新带 -3 的短名均从真实磁盘账本发现、读取并上传，断言上传文件名和正文、稳定 receipts/outbox key、重复 rescan 与 coordinator/F1 重建不二次排入 outbox，且 state.json 字节完全不变。这里复用真实生产 H1/F1、真实磁盘和既有模拟 outbox/receipt seam，**不冒充真实飞书租户验收**。

## 3. 改动文件清单（绝对路径）

- `/home/bluecake/ai/pi-toolkit/docs/dev/scheduled-reports/README.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/scheduled-reports/report-paths-report.md`
- `/home/bluecake/ai/pi-toolkit/src/commands/schedule.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/agent/digest.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/agent/message.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/agent/note.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/agent/report-file.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/agent/result-reference.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/agent/view.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/core/paths.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/core/reader.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/core/spec.ts`
- `/home/bluecake/ai/pi-toolkit/src/schedule/core/writer.ts`
- `/home/bluecake/ai/pi-toolkit/src/tools/schedule-tool.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/render.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/schedule.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/schedule/service.ts`
- `/home/bluecake/ai/pi-toolkit/tests/commands/schedule.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/schedule/agent/digest.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/schedule/agent/message.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/schedule/agent/note.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/schedule/agent/report-file.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/schedule/core/fixtures.ts`
- `/home/bluecake/ai/pi-toolkit/tests/schedule/core/reader.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/schedule/core/spec.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/schedule/core/writer.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/tools/schedule-tool.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/render.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/schedule-push.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/schedule-f1.test.ts`

## 4. 自验命令与真实结果（尾部）

### 指定 schedule / Feishu 单测

```sh
npx vitest run tests/schedule tests/web-hub/hub/schedule tests/web-hub/hub/feishu --maxWorkers=4
```

```text
Test Files  71 passed (71)
     Tests  1955 passed (1955)
  Duration  43.29s
```

### 四个指定集成门禁

```sh
npx vitest run tests/integration/schedule-wiring.test.ts tests/integration/schedule-hub.test.ts tests/integration/schedule-fault-matrix.test.ts tests/integration/schedule-off-golden.test.ts
```

```text
Test Files  4 passed (4)
     Tests  30 passed (30)
  Duration  12.64s
```

日志中的 quota 无凭据 / registerEntryRenderer 不可用提示为现有 fake-pi 测试环境诊断，不是失败；集成使用本地 fake Feishu/模型 seam，不调用真实服务。

### 补充实际 hub suite、工具/命令与边界

用户给定的 `tests/web-hub/hub/schedule/` 目录本身只有 `http-stub.ts`，实际 hub 测试位于同级的 `schedule-*.test.ts`。核对首轮完整日志后确认：Vitest 采用路径子串筛选，首轮指定命令已包含这 9 个同级 suite；以下命令是额外的独立核验，不是补漏（更正早期对筛选语义的说明）：

```sh
npx vitest run tests/web-hub/hub/schedule-*.test.ts tests/tools/schedule-tool.test.ts tests/commands/schedule.test.ts tests/web-hub/boundary.test.ts tests/boundary/pi-free.test.ts --maxWorkers=4
```

```text
Test Files  13 passed (13)
     Tests  186 passed (186)
  Duration  3.86s
```

### 类型检查与构建

```sh
npm run typecheck 2>&1 | tail -3
npm run build
```

```text
> pi-toolkit@0.9.0 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json

> pi-toolkit@0.9.0 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json
```

均 exit 0；执行 typecheck 时开启 pipefail 并保留完整日志，避免 tail 隐藏退出码。

### 格式、差异与冻结 fixture

```sh
npx prettier --check <第 3 节列出的全部改动文件>
git diff --check
git diff --quiet -- tests/fixtures/ && echo fixtures-ok
```

首轮结果（当时 28 文件）：全部格式检查通过，diff whitespace 检查通过，输出 `fixtures-ok`；`schedule-off-golden.json` 和其余 fixtures 未修改、未重生。

## 5. 遗留与验收边界

- 已接受残留：`allocateUnique` 并发/崩溃窗口可能留下尚未进入账本索引的孤儿 `-n` 报告文件；本轮不改变写入/去重协议，由既有 grace 与 14 天 GC 自然清理，不迁移旧文件。
- 实现范围内无已知阻塞；没有执行全仓 17,000+ 测试、全仓 format:check 或真实飞书租户验收，不将本包定向测试冒充这些门禁。
- 首轮已收到用户的有条件验收意见；本轮修复仅有自验，不宣称已完成独立复验（当前工具未暴露 Agent），root 可据本报告和工作区 diff 派只读复验；首轮测试日志保存在 `/tmp/schedule-paths-{required-tests,integration,extra,typecheck,build}.log`。

## 6. 有条件验收反馈修复（2026-10-26 09:10 之后）

- 新格式 reportFile 的短 basename 通过 `ReplyInput.attachmentFileName` 传给 `renderReply`。renderer 的同一 `fileName` 同时构造 fileNote 与 `overflow.fileName`，schedule 上传直接消费后者，不再在渲染后单独改名；默认参数未传时保持原有行为。显式 basename 限为有界 ASCII md 名。
- 旧 64-hex reportFile 不覆盖 renderer 默认值，恢复可读的 `reply-<sid6>.md`，不再直接上传 64-hex 文件名。F1/H1 和单独 F1 测试对新名、旧名逐一断言卡片提示名与实际上传名一致，renderer 也补同源断言。
- `tests/schedule/agent/note.test.ts` 使用固定 root `/var/tmp/pi-toolkit-schedules`、dirName `session-fixed` 与固定报告名，手写期望 `/var/tmp/pi-toolkit-schedules/session-fixed/reports/s_aaaaaaaa-20261026-0852.md`，不再全部依赖与实现相同的 join 公式。
- 已接受的孤儿 `-n` 文件由 GC 清理，见 §5；未为此改动 writer。仍未执行 git 写操作，未触碰本包之外的并发文件。

### 本轮自验

```sh
npx vitest run tests/web-hub/hub/feishu tests/schedule --maxWorkers=4
# Test Files 62 passed (62); Tests 1861 passed (1861); Duration 42.50s

npx vitest run tests/web-hub/hub/feishu/render.test.ts tests/web-hub/hub/feishu/schedule-push.test.ts tests/web-hub/hub/schedule-f1.test.ts tests/schedule/agent/note.test.ts --maxWorkers=4
# Test Files 4 passed (4); Tests 103 passed (103); Duration 2.04s

npm run typecheck 2>&1 | tail -3
# exit 0（开启 pipefail）
npm run build
# exit 0
npx prettier --check <本轮 8 个改动文件>
# All matched files use Prettier code style!
git diff --check
# exit 0
git diff --quiet -- tests/fixtures/ && echo fixtures-ok
# fixtures-ok
```

本轮改动路径：§3 中的 `README.md`、本报告、`feishu/render.ts`、`feishu/schedule.ts`、`tests/schedule/agent/note.test.ts`、`tests/web-hub/hub/feishu/{render,schedule-push}.test.ts`、`tests/web-hub/hub/schedule-f1.test.ts`（8 个文件）；本包总清单现为 30 项。日志为 `/tmp/schedule-paths-followup-{tests,targeted,typecheck,build}.log`。
