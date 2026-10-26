# #54 P4 hub 诊断实施报告

日期：2026-10-27。依据：`plan.md` §3.7、§6.2 P4、§6.4 T-HB1 与文末拍板/r2/r3；P0/P1 已提交。未执行任何 git 写操作，未改 fixtures，未改 P2/P3 文件域。

## 实现

- `HubRecord.agentDir?: string` 为追加式可选磁盘字段；hub 首次写 `hub.json` 时，仅解析来源为 `env` 才追加已收敛的 `hubAgentDir`。默认、空串、显式默认目录、相对值回退均不追加字段。既有 patch 保留字段。
- agent 的 `readHubJsonRecord` 读取非空字符串，其他形状当缺失；无记录/损坏文件不诊断。
- `/webhub status` 使用已有 `alias.statusLines()` status-only warning 通道（该通道原本已经在命令中以 warning 输出），追加中文目录诊断，不改 `src/commands/webhub.ts`，不增加注册/工具/wire/cap/PROTO：
  - hub 字段缺失 + 本会话 env 来源：提示「hub 的 agentDir 未知（旧版 hub 或默认）」；
  - hub 目录（缺字段按默认 H）与本会话不同：展示两侧目录，说明网页新建会话使用 hub 的目录，建议从目标环境 `/webhub restart`；
  - 展示时剥除控制字符，原 alias degraded 提示保持。
- paths 注释与 web-hub README 明确：hub 状态固定在 HOME、一机一 hub / hub 级单一 agentDir，session discovery / children env 跟随 hub；`PI_WEBHUB_CONFIG` 仍来自拉起会话。
- I8：未改 hub 外部导入白名单；新 agent 导入的是既有 protocol 镜像。I10：只追加可选磁盘字段，旧 hub × 新 agent 按缺字段处理，新 hub × 旧 agent 按既有字段挑选读取忽略新键。

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/hub-json.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/hub.ts`（仅 hub.json 写入处）
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/paths.ts`（仅注释）
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/agent-dir-status.test.ts`（新增）
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/hub.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/hub-json.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/README.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/settings-rename/P4-report.md`

## 自验与证据

| 命令                                                                                                                                          | 结果                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                                                                           | PASS：TS 两套配置 + vue-tsc；日志 `/tmp/settings-P4-typecheck.log`                                                                                                                                             |
| `npm run build`                                                                                                                               | PASS                                                                                                                                                                                                           |
| `npx vitest run tests/web-hub/agent/agent-dir-status.test.ts tests/web-hub/hub/hub.test.ts tests/web-hub/hub/hub-json.test.ts --maxWorkers=4` | PASS：3 文件、50 tests                                                                                                                                                                                         |
| `npx vitest run tests/web-hub --maxWorkers=4`                                                                                                 | 第一轮外层 240s 超时；第二轮 242.84s 完整结束：706 文件通过、1 文件失败；15853 tests 通过、1 失败、3 skipped。唯一失败为 P2 新增设置值导入未同步 closure pin，见下文；日志 `/tmp/settings-P4-webhub-rerun.log` |
| `npx vitest run tests/web-hub/boundary.test.ts --maxWorkers=4`                                                                                | 19 PASS / 1 FAIL，同一 P2 closure 差异；hub 边界其余断言通过                                                                                                                                                   |
| `npx prettier --write` / `npx prettier --check`（仅本报告所列 P4 文件）                                                                       | PASS                                                                                                                                                                                                           |
| `git diff --check`                                                                                                                            | PASS                                                                                                                                                                                                           |
| `git diff --quiet HEAD -- tests/fixtures/`                                                                                                    | PASS，exit 0                                                                                                                                                                                                   |

T-HB1 真实断言覆盖：startHub 默认字段缺席/env 写入、writer 默认记录精确字节/patch 保留字段、真实 `/webhub status` warning 输出、default/default 与 env/env 匹配静默、双方非默认 mismatch、旧/缺失/非法字段 fallback、坏文件静默、控制字符剥除及 alias 提示共存。不生成/修改任何 fixture。

## 遗留与汇总门禁

- 全量 web-hub 尚未全绿：`tests/web-hub/boundary.test.ts:325` 的 `SYSLOAD_FILE_CLOSURE["src/config/settings.ts"]` 缺 `../core/agent-dir.js`，而并行 P2 已向 `settings.ts` 加入该值导入。方案 §6.3 明确要求消费方同步此 agent-side closure；与 hub 外部白名单无关。已向 root 通报，P4 不擅自修改 P2 closure。汇总/P2 同步已批准的精确 closure 后需重跑该 gate 及全量 web-hub。
- 本包未执行真实 tmux E2E（方案 §6.6 hub 场景）或独立异源 verifier；交给汇总验收。默认记录兼容由真实 writer 精确字节与 startHub 字段缺席断言覆盖，不声称已实跑旧版本二进制。
- 工作区有并行包修改，本报告只交付上述 P4 文件，不归属或提交其他改动。

建议 commit message（仅建议，未提交）：

```text
feat(web-hub): diagnose hub and session agentDir mismatches
```
