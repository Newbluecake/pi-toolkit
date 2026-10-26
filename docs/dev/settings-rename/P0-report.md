# #54 P0：agentDir 收敛 + 测试环境卫生

## 交付范围

依据 `plan.md` r3（含用户补拍④），只实施 §6.2 P0。未进行任何仓库 git 写操作；未触碰 `tests/fixtures/`，未输出设置文件内容，未修改并行 schedule 包。

- 新增 pi-free `resolveAgentDir(env, home)` 权威实现和 protocol 镜像；launcher 在原 `piAgentDir` 区域提供同契约镜像。
- 未设/空串/默认等价值回到原 `home/.pi/agent` 字面公式；展开 `~`、`~/` 和 file URL，不 trim、不 realpath，相对值回落默认并返回 `ignored`。
- 损坏 file URL 不抛异常，同样回落默认（对应方案 §4.6 解析器永不抛契约）。
- measure-store、provider-evidence、dup-detect 改用 core；hub 在 `startHub` 中计算一次，六个消费点共用 protocol resolver。没有扩大 hub 外部导入白名单；closure 表精确钉住 core/protocol 的 `node:path`、`node:url`。
- helper 向 convert context 显式传 `agentDir`；`convert.mjs`、memoryRoot 公式、设置定位/文件名/锁协议、traffic DB 默认公式、hub 状态路径/wire 均未改。
- setup 捕获解析后的真实 agentDir 后删除 override；`sandboxHome()` 保存、清空、还原 override（包括空串）。
- setup 包装同步 fs 写 API 及写/创建 open 标志，通过 `syncBuiltinESMExports` 覆盖 ESM 导入；真实 agentDir 和真实 HOME 默认目录下的设置、临时文件、锁及 records 路径在调用点拒绝并记录违规，由原有 afterEach 兜底失败。覆盖 Buffer/URL 路径、rename/link/symlink 两端，沿用 `withRealHomeAllowed`。
- spawn/fork 同时处理有/无 args 数组的 overload；检查显式或继承 env 中的非空 agentDir override 是否解析到真实 agentDir。没有 override 的普通子进程不因该新检查被拒绝，仍依靠沙箱 HOME 和原有 hub config 检查。

## 测试取证

| 项目                          | 命令/证明                                                                                                                                          | 结果                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 类型                          | `npm run typecheck`                                                                                                                                | PASS（TS 两套 + vue-tsc；初次和收尾各一次）            |
| 构建                          | `npm run build`                                                                                                                                    | PASS                                                   |
| 指定定向套件                  | `npx vitest run tests/config tests/cache-ttl tests/traffic tests/web-hub/boundary.test.ts tests/secure --maxWorkers=3`                             | PASS：146 文件；3638 通过 / 1 跳过；500.06 秒          |
| T-AD2                         | `npx vitest run tests/conformance/agent-dir.test.ts --maxWorkers=3`                                                                                | PASS：1 文件 / 11 测试；仅用 pi 公开导出               |
| T-AD1 / T-ID1 P0 / T-SB1 / I8 | `npx vitest run tests/config/agent-dir-*.test.ts tests/setup/sandbox-home-guard.test.ts tests/boundary/pi-free.test.ts --maxWorkers=3`             | PASS：5 文件 / 63 测试                                 |
| 带外部 override 的卫生测试    | `PI_CODING_AGENT_DIR=<mktemp 沙箱目录> npx vitest run tests/config/agent-dir-sandbox.test.ts tests/config/agent-dir-parity.test.ts --maxWorkers=3` | PASS：2 文件 / 23 测试；沙箱目录保持为空，`rmdir` 成功 |
| Prettier                      | `npx prettier --write <P0 文件清单>`，随后 `npx prettier --check <P0 文件清单及本报告>`                                                            | PASS（代码与报告均通过）                               |
| 冻结物                        | `git diff --quiet HEAD -- tests/fixtures/`                                                                                                         | PASS（改前、改后）                                     |
| 差异空白                      | `git diff --check`                                                                                                                                 | PASS                                                   |

T-AD1 的单一内联表驱动三份实现，含未设、空串、空白、tilde、绝对/相对、默认等价、尾斜杠、file URL、编码空格、不 trim 与词法规范化。

T-ID1 在沙箱 HOME 下断言实际设置默认函数、traffic 默认函数、measure、dup-detect、helper 设置/锁/piAgentDir 和 hub resolver 与原字面公式相等；provider-evidence 通过真实持久化后 `stat` 断言落点，不靠恒真 stub。hub 六处共用以及 convert ctx 传值另有源码结构断言。

T-SB1 逐一验证所有同步写包装和 open 写标志的调用点拒绝、违规记录、沙箱可写与还原、spawn env 的绝对/尾斜杠/file URL/tilde 形式以及豁免。没有开发机快照比对。

首次局部测试的 provider-evidence namespace spy 未捕获调用，已改为真实沙箱持久化断言并通过复跑。指定大套件首次 240 秒预算不足（退出 124，不是测试失败），重跑预算提升为 900 秒，退出 0。secure off-golden、launcher-off-golden 和 config-parity 均通过，冻结物无变化。构建/测试可能在各自临时沙箱中初始化 Git 仓库，未对本仓库执行 git add/commit/reset/stash/checkout 等写操作。

## 遗留与后续边界

- `settingsLocation().scope`、设置改名/迁移/继承、launcher 诊断/secure fail-closed 增强、traffic 根目录选择分别属于 P1/P2/P3；T-ID1 的这些后续部分不能在 P0 宣称已完成。当前不存在 `settingsLocation()`，故没有新增假测试或提前实现。
- 相对 override 的每次 activate 告警和 launcher status 提示属于后续接线；P0 仅产出 `ignored` 信息。
- AGENTS peer bump 清单更新按用户文件域限制留给 P5；新增 conformance 文件已可直接运行。
- 同步 fs 包装不覆盖 promises API、原生 sqlite 或绕开 Node 包装的子进程写盘；按方案以注入 dbPath/沙箱 HOME 保证，未扩大到新的安全模型。
- 本会话工具没有 `Agent` 派发能力，未完成 dev-flow 要求的异源独立 verifier；已完成真实命令自验和差异复核，建议由调度方派独立验收。

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/core/agent-dir.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/agent-dir.ts`
- `/home/bluecake/ai/pi-toolkit/src/cache-ttl/measure-store.ts`
- `/home/bluecake/ai/pi-toolkit/src/cache-ttl/provider-evidence.ts`
- `/home/bluecake/ai/pi-toolkit/src/traffic/dup-detect.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/hub.ts`
- `/home/bluecake/ai/pi-toolkit/src/secure/bin/helper.mjs`
- `/home/bluecake/ai/pi-toolkit/tests/setup/sandbox-home.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/helpers/home-sandbox.ts`
- `/home/bluecake/ai/pi-toolkit/tests/config/agent-dir-parity.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/config/agent-dir-identity.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/config/agent-dir-sandbox.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/conformance/agent-dir.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/boundary.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/settings-rename/P0-report.md`

建议 commit message（仅建议，未提交）：

```text
refactor(config): unify agentDir resolution and isolate test environments
```
